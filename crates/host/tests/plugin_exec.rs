//! `floti.exec` on the host: a program the manifest names, run with the
//! call's arguments and no shell, through the call layer every `floti.*`
//! method goes through.
//!
//! Each test builds a registry over a store of its own, with `floti.exec`
//! registered on it and a stand-in for the secret store, and calls the
//! method as a background script's call arrives. The program is the fake in
//! `testkit/fake_program.rs`, which reports what it was given.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

use floti_host::platform::launcher::{self, ProgramLauncher};
use floti_host::platform::process_tree::{self, ProcessTree};
use floti_host::plugins::background::NoBackground;
use floti_host::plugins::call::{CancelToken, ExecResult, PluginCallError};
use floti_host::plugins::exec::{
    EXEC_TIMEOUT_DEFAULT_MS, EXEC_TIMEOUT_MAX_MS, read_request, register_methods,
};
use floti_host::plugins::secrets::{SecretUse, SecretValue, SecretsAccess};
use floti_host::plugins::{PluginCall, Registry, RegistryParts};
use floti_host::store::Store;
use floti_host::testkit::{PATIENCE, TestDirs};
use floti_protocol::Knowable;
use floti_protocol::Payload;
use floti_protocol::channels::plugins::{PluginErrorCode, PluginSecretState, PluginSurfaceKind};
use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// The world each test runs in
// ---------------------------------------------------------------------------

fn fake_program() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_floti-fake-program"))
}

/// The fake program's folder on `PATH`, and variables in the environment
/// the host passes on: one of the user's, and some that are the host's own.
/// Once, before any test of this file starts a program.
fn prepare_environment() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let folder = fake_program().parent().unwrap().to_path_buf();
        let path = std::env::var_os("PATH").unwrap_or_default();
        let joined =
            std::env::join_paths(std::iter::once(folder).chain(std::env::split_paths(&path)))
                .unwrap();
        // SAFETY: every test in this file calls this before it starts
        // anything, and `Once` holds the others until it has returned, so
        // nothing reads the environment while it changes.
        unsafe {
            std::env::set_var("PATH", joined);
            std::env::set_var("PLUGIN_EXEC_INHERITED", "from the user");
            std::env::set_var("CLAUDECODE", "1");
            std::env::set_var("FLOTI_DATA_DIR", "the host's own");
            std::env::set_var("ELECTRON_RUN_AS_NODE", "1");
        }
    });
}

/// A stored secret: its value, and the plugins it may be used for.
struct Stored {
    value: String,
    plugins: Vec<String>,
}

/// The secret store's stand-in: what it was given, refused as the store
/// refuses.
#[derive(Default)]
struct TestSecrets {
    stored: Mutex<HashMap<String, Stored>>,
}

impl TestSecrets {
    fn store(&self, key: &str, value: &str, plugins: &[&str]) {
        self.stored.lock().unwrap().insert(
            key.to_owned(),
            Stored {
                value: value.to_owned(),
                plugins: plugins.iter().map(|plugin| (*plugin).to_owned()).collect(),
            },
        );
    }
}

fn secret_refusal(message: String) -> PluginCallError {
    PluginCallError::new(PluginErrorCode::Secret, message)
}

impl SecretsAccess for TestSecrets {
    fn state(&self, plugin: &str, key: &str) -> PluginSecretState {
        match self.stored.lock().unwrap().get(key) {
            Some(stored) if stored.plugins.iter().any(|p| p == plugin) => PluginSecretState::Ready,
            Some(_) => PluginSecretState::NotAllowed,
            None => PluginSecretState::Missing,
        }
    }

    fn reveal(
        &self,
        plugin: &str,
        declared: &[String],
        key: &str,
        use_: SecretUse<'_>,
    ) -> Result<SecretValue, PluginCallError> {
        if !declared.iter().any(|name| name == key) {
            return Err(secret_refusal(format!(
                "{{{{{key}}}}} is not one of the secrets the manifest declares"
            )));
        }
        let stored = self.stored.lock().unwrap();
        let Some(secret) = stored.get(key) else {
            return Err(secret_refusal(format!("{{{{{key}}}}} is not stored")));
        };
        if !secret.plugins.iter().any(|p| p == plugin) {
            return Err(secret_refusal(format!(
                "{{{{{key}}}}} is not allowed for this plugin"
            )));
        }
        assert_eq!(use_, SecretUse::Program, "exec reveals for a program");
        Ok(SecretValue::new(secret.value.clone()))
    }
}

struct World {
    registry: Registry,
    secrets: Arc<TestSecrets>,
    store: Arc<Mutex<Store>>,
    /// Last: the store is closed before its folder goes.
    dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        prepare_environment();
        let dirs = TestDirs::new();
        let store = Arc::new(Mutex::new(Store::open(&dirs.data).unwrap()));
        let secrets = Arc::new(TestSecrets::default());
        let registry = Registry::new(RegistryParts {
            store: Arc::clone(&store),
            background: Arc::new(NoBackground),
            secrets: Arc::clone(&secrets) as Arc<dyn SecretsAccess>,
            publish: Box::new(|_| ()),
        });
        register_methods(
            registry.methods(),
            Arc::clone(&secrets) as Arc<dyn SecretsAccess>,
        );
        registry.start().unwrap();
        Self {
            registry,
            secrets,
            store,
            dirs,
        }
    }

    /// A plugin `id` whose manifest's `exec` is `exec`, registered.
    fn plugin(&self, id: &str, exec: &Value, secrets: &[&str]) -> PathBuf {
        let manifest = json!({
            "apiVersion": 2,
            "id": id,
            "name": id,
            "secrets": secrets,
            "exec": exec,
        });
        let folder = self
            .dirs
            .plugin_folder(&format!("plugin {id}"), &manifest.to_string(), &[]);
        self.registry.add(&text(&folder)).unwrap();
        folder
    }

    fn call(&self, plugin: &str, args: Vec<Payload>, cancel: CancelToken) -> Call {
        let registry = self.registry.clone();
        let call = PluginCall {
            plugin: plugin.to_owned(),
            surface: PluginSurfaceKind::Background,
            method: "exec".into(),
            args,
            cancel,
        };
        tokio::spawn(async move {
            registry
                .call(call)
                .await
                .map(|answer| answer.deserialized::<ExecResult>().unwrap())
        })
    }

    async fn exec(
        &self,
        plugin: &str,
        name: &str,
        args: &[&str],
        options: Value,
    ) -> Result<ExecResult, PluginCallError> {
        self.call(plugin, exec_args(name, args, options), CancelToken::new())
            .await
            .unwrap()
    }

    fn stop(self) {
        self.registry.shutdown();
        drop(self.registry);
        let store = Arc::try_unwrap(self.store)
            .unwrap_or_else(|_| panic!("nothing else holds the store"))
            .into_inner()
            .unwrap();
        store.close().unwrap();
    }
}

type Call = tokio::task::JoinHandle<Result<ExecResult, PluginCallError>>;

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn payload(value: &Value) -> Payload {
    Payload::serialized(value).unwrap()
}

fn exec_args(name: &str, args: &[&str], options: Value) -> Vec<Payload> {
    vec![
        Payload::Text(name.to_owned()),
        payload(&json!(args)),
        payload(&options),
    ]
}

/// The fake program's report: the first line it wrote.
fn report(result: &ExecResult) -> Value {
    let line = result.stdout.lines().next().expect("a report line");
    serde_json::from_str(line).unwrap()
}

fn same_folder(reported: &Value, folder: &Path) -> bool {
    let reported = PathBuf::from(reported.as_str().unwrap());
    std::fs::canonicalize(reported).unwrap() == std::fs::canonicalize(folder).unwrap()
}

/// The pids the fake program wrote to `path`, once it has.
async fn pids(path: &Path) -> (u32, Option<u32>) {
    let started = Instant::now();
    loop {
        if let Ok(text) = std::fs::read_to_string(path) {
            let ids: Value = serde_json::from_str(&text).unwrap();
            let pid = u32::try_from(ids["pid"].as_u64().unwrap()).unwrap();
            let child = ids["child"]
                .as_u64()
                .map(|child| u32::try_from(child).unwrap());
            return (pid, child);
        }
        assert!(
            started.elapsed() < PATIENCE,
            "the program never wrote {}",
            path.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Waits for every one of `pids` to have ended.
async fn ended(pids: &[u32]) {
    let started = Instant::now();
    loop {
        let running: Vec<u32> = pids
            .iter()
            .copied()
            .filter(|pid| process_tree::Native.is_alive(*pid) != Knowable::Known(false))
            .collect();
        if running.is_empty() {
            return;
        }
        assert!(started.elapsed() < PATIENCE, "still running: {running:?}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn with_pid_file<'a>(args: &mut Vec<&'a str>, path: &'a str) {
    args.extend(["--pid-file", path]);
}

// ---------------------------------------------------------------------------
// S15: a declared program runs as the manifest says, with no shell
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_declared_program_runs_in_its_folder_with_no_shell_declared_args_first_and_the_users_env_less_the_hosts_own_plus_its_env_with_secrets_filled()
 {
    let world = World::new();
    let shown = [
        "TOKEN",
        "PLAIN",
        "PLUGIN_EXEC_INHERITED",
        "CLAUDECODE",
        "FLOTI_DATA_DIR",
        "ELECTRON_RUN_AS_NODE",
    ];
    let mut declared = vec!["--declared".to_owned()];
    for name in shown {
        declared.extend(["--show-env".to_owned(), name.to_owned()]);
    }
    let folder = world.plugin(
        "runner",
        &json!({
            "tool": {
                "command": text(&fake_program()),
                "args": declared,
                "env": { "TOKEN": "Bearer {{api-key}}", "PLAIN": "as written" },
            }
        }),
        &["api-key"],
    );
    let secret = r#"s3cr$t "quoted" & %PATH%"#;
    world.secrets.store("api-key", secret, &["runner"]);

    let call_args = [
        "two words",
        "a&b|c",
        "$HOME",
        "*",
        "%PATH%",
        "",
        "\"quoted\"",
    ];
    let result = world
        .exec(
            "runner",
            "tool",
            &call_args,
            json!({ "stdin": "first line\nsecond line" }),
        )
        .await
        .unwrap();

    assert_eq!(result.exit_code, Some(0), "{result:?}");
    assert!(!result.timed_out);
    assert_eq!(result.stderr, "");
    let report = report(&result);
    let expected: Vec<String> = declared
        .iter()
        .cloned()
        .chain(call_args.iter().map(|arg| (*arg).to_owned()))
        .collect();
    assert_eq!(
        report["args"],
        json!(expected),
        "each argument as it is, declared first"
    );
    assert!(same_folder(&report["cwd"], &folder), "{report}");
    assert_eq!(report["stdin"], "first line\nsecond line");
    assert_eq!(report["env"]["TOKEN"], format!("Bearer {secret}"));
    assert_eq!(report["env"]["PLAIN"], "as written");
    assert_eq!(report["env"]["PLUGIN_EXEC_INHERITED"], "from the user");
    for hosts_own in ["CLAUDECODE", "FLOTI_DATA_DIR", "ELECTRON_RUN_AS_NODE"] {
        assert_eq!(
            report["env"][hosts_own],
            Value::Null,
            "{hosts_own} reached the program"
        );
    }
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_program_on_path_and_a_script_inside_the_plugin_folder_a_batch_file_on_windows_each_get_every_argument_as_it_is()
 {
    let world = World::new();
    let scripts = world.dirs.folder("plugin wrapped");
    let script = launcher::Native.write_wrapper_script(&scripts, "wrapped", &fake_program());
    world.plugin(
        "wrapped",
        &json!({
            "by-name": "floti-fake-program",
            "wrapped": { "command": format!("./{script}"), "args": ["--declared", "two words"] },
        }),
        &[],
    );
    let call_args = [
        "two words",
        "a&b",
        "(x)",
        "<y>",
        "1|2",
        "plain",
        "trailing\\",
    ];

    let by_name = world
        .exec("wrapped", "by-name", &call_args, Value::Null)
        .await
        .unwrap();
    assert_eq!(by_name.exit_code, Some(0), "{by_name:?}");
    assert_eq!(report(&by_name)["args"], json!(call_args));

    let wrapped = world
        .exec("wrapped", "wrapped", &call_args, Value::Null)
        .await
        .unwrap();
    assert_eq!(wrapped.exit_code, Some(0), "{wrapped:?}");
    let mut expected = vec!["--declared", "two words"];
    expected.extend(call_args);
    assert_eq!(report(&wrapped)["args"], json!(expected));
    assert!(same_folder(&report(&wrapped)["cwd"], &scripts));
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_non_zero_exit_is_an_answer_not_a_failure() {
    let world = World::new();
    world.plugin("exits", &json!({ "tool": text(&fake_program()) }), &[]);
    let result = world
        .exec(
            "exits",
            "tool",
            &["--stderr-bytes", "5", "--exit", "3"],
            json!({}),
        )
        .await
        .unwrap();
    assert_eq!(result.exit_code, Some(3));
    assert!(!result.timed_out);
    assert_eq!(result.stderr, "xxxxx");
    assert!(result.stdout.starts_with('{'), "{result:?}");
    world.stop();
}

// ---------------------------------------------------------------------------
// S16: what exec refuses, starting nothing
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn an_undeclared_name_a_missing_program_a_path_leaving_the_folder_or_arguments_exec_does_not_take_reject_and_start_nothing()
 {
    let world = World::new();
    let outside = world.dirs.folder("not the plugin");
    let outside_script =
        launcher::Native.write_wrapper_script(&outside, "outside", &fake_program());
    let marker = world.dirs.root().join("started.json");
    let marker_text = text(&marker);
    world.plugin(
        "refuser",
        &json!({
            "tool": { "command": text(&fake_program()), "args": ["--pid-file", marker_text] },
            "nowhere": "floti-no-such-program-anywhere",
            "missing": "./missing-program",
            "outside": format!("../not the plugin/{outside_script}"),
        }),
        &[],
    );

    let refused = |result: Result<ExecResult, PluginCallError>| result.unwrap_err();
    let undeclared = refused(world.exec("refuser", "nope", &[], Value::Null).await);
    assert_eq!(undeclared.code, PluginErrorCode::NotDeclared);
    assert_eq!(
        undeclared.message,
        "\"nope\" is not one of the programs the manifest's exec lists"
    );

    for (name, message) in [
        (
            "nowhere",
            "floti-no-such-program-anywhere was not found on this computer",
        ),
        (
            "missing",
            "./missing-program was not found on this computer",
        ),
    ] {
        let missing = refused(world.exec("refuser", name, &[], Value::Null).await);
        assert_eq!(missing.code, PluginErrorCode::NotFound, "{missing:?}");
        assert_eq!(missing.message, message);
    }
    let leaving = refused(world.exec("refuser", "outside", &[], Value::Null).await);
    assert_eq!(leaving.code, PluginErrorCode::NotFound, "{leaving:?}");
    assert!(
        leaving.message.ends_with("is outside the plugin folder"),
        "{leaving:?}"
    );

    let too_many: Vec<String> = (0..257).map(|n| n.to_string()).collect();
    let cases: Vec<(Vec<Payload>, &str)> = vec![
        (
            vec![Payload::Integer(5.into())],
            "exec needs a program name",
        ),
        (
            vec![Payload::Text("Bad Name".into())],
            "exec needs a program name",
        ),
        (
            vec![Payload::Text("tool".into()), payload(&json!("not a list"))],
            "exec arguments must be an array of strings",
        ),
        (
            vec![Payload::Text("tool".into()), payload(&json!(["ok", 1]))],
            "exec arguments must be an array of strings",
        ),
        (
            vec![Payload::Text("tool".into()), payload(&json!(["nul\u{0}"]))],
            "exec arguments must be an array of strings",
        ),
        (
            vec![Payload::Text("tool".into()), payload(&json!(too_many))],
            "exec takes at most 256 arguments",
        ),
        (
            vec![
                Payload::Text("tool".into()),
                payload(&json!([])),
                payload(&json!("x")),
            ],
            "exec options must be an object",
        ),
        (
            vec![
                Payload::Text("tool".into()),
                payload(&json!([])),
                payload(&json!({ "stdin": 5 })),
            ],
            "stdin must be a string",
        ),
        (
            vec![
                Payload::Text("tool".into()),
                payload(&json!([])),
                payload(&json!({ "timeoutMs": -1 })),
            ],
            "timeoutMs must be a positive number",
        ),
        (
            vec![
                Payload::Text("tool".into()),
                payload(&json!([])),
                payload(&json!({ "timeoutMs": "soon" })),
            ],
            "timeoutMs must be a positive number",
        ),
    ];
    for (args, message) in cases {
        let invalid = world
            .call("refuser", args, CancelToken::new())
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(invalid.code, PluginErrorCode::Invalid, "{invalid:?}");
        assert_eq!(invalid.message, message);
    }
    assert!(!marker.exists(), "a refused call started the program");
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_plugin_with_eight_programs_running_is_refused_a_ninth_as_unavailable_and_it_starts_nothing()
 {
    let world = World::new();
    world.plugin("busy", &json!({ "tool": text(&fake_program()) }), &[]);
    let files: Vec<String> = (0..9)
        .map(|n| text(&world.dirs.root().join(format!("program {n}.json"))))
        .collect();
    let mut running = Vec::new();
    for file in &files[..8] {
        let cancel = CancelToken::new();
        let mut args = vec!["--sleep", "600000"];
        with_pid_file(&mut args, file);
        running.push((
            cancel.clone(),
            world.call("busy", exec_args("tool", &args, Value::Null), cancel),
        ));
    }
    let mut pids_started = Vec::new();
    for file in &files[..8] {
        pids_started.push(pids(Path::new(file)).await.0);
    }

    let mut ninth = vec!["--sleep", "600000"];
    with_pid_file(&mut ninth, &files[8]);
    let refused = world
        .exec("busy", "tool", &ninth, Value::Null)
        .await
        .unwrap_err();
    assert_eq!(refused.code, PluginErrorCode::Unavailable, "{refused:?}");
    assert_eq!(
        refused.message,
        "this plugin already has 8 programs running"
    );
    assert!(!Path::new(&files[8]).exists(), "the ninth program started");

    for (cancel, call) in running {
        cancel.cancel();
        let aborted = call.await.unwrap().unwrap_err();
        assert_eq!(aborted.code, PluginErrorCode::Aborted);
    }
    ended(&pids_started).await;

    // A place is free again once a program has ended.
    let again = world.exec("busy", "tool", &[], Value::Null).await.unwrap();
    assert_eq!(again.exit_code, Some(0));
    world.stop();
}

// ---------------------------------------------------------------------------
// S17: ending a program's whole tree
// ---------------------------------------------------------------------------

#[test]
fn the_timeout_is_60_s_unless_the_call_says_otherwise_and_at_most_600_s() {
    let options = |value: Value| {
        read_request(None, Some(&payload(&value)))
            .unwrap()
            .timeout_ms
    };
    assert_eq!(EXEC_TIMEOUT_DEFAULT_MS, 60_000);
    assert_eq!(EXEC_TIMEOUT_MAX_MS, 600_000);
    assert_eq!(read_request(None, None).unwrap().timeout_ms, 60_000);
    assert_eq!(options(json!({})), 60_000);
    assert_eq!(options(json!({ "timeoutMs": 1500 })), 1500);
    assert_eq!(options(json!({ "timeoutMs": 2.5 })), 3);
    assert_eq!(options(json!({ "timeoutMs": 600_001 })), 600_000);
    assert_eq!(options(json!({ "timeoutMs": 1e12 })), 600_000);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_timeout_ends_the_whole_tree_and_resolves_timed_out_with_no_exit_code() {
    let world = World::new();
    world.plugin("slow", &json!({ "tool": text(&fake_program()) }), &[]);
    let file = text(&world.dirs.root().join("slow.json"));
    let mut args = vec!["--child", "--sleep", "600000"];
    with_pid_file(&mut args, &file);
    let started = Instant::now();
    let result = world
        .exec("slow", "tool", &args, json!({ "timeoutMs": 1000 }))
        .await
        .unwrap();
    assert!(result.timed_out, "{result:?}");
    assert_eq!(result.exit_code, None);
    assert!(started.elapsed() < PATIENCE, "the timeout did not end it");
    let (pid, child) = pids(Path::new(&file)).await;
    assert_eq!(
        report(&result)["child"],
        json!(child),
        "what it wrote comes back"
    );
    ended(&[pid, child.unwrap()]).await;
    world.stop();
}

/// Starts a program that starts a child and sleeps, waits until both run,
/// does `end` to it, and checks the call rejects as aborted and the whole
/// tree is gone.
async fn ended_by(world: &World, plugin: &str, file: &str, end: impl FnOnce(&CancelToken)) {
    let cancel = CancelToken::new();
    let mut args = vec!["--child", "--sleep", "600000"];
    with_pid_file(&mut args, file);
    let call = world.call(
        plugin,
        exec_args("tool", &args, Value::Null),
        cancel.clone(),
    );
    let (pid, child) = pids(Path::new(file)).await;
    end(&cancel);
    let aborted = tokio::time::timeout(PATIENCE, call)
        .await
        .expect("the call answered")
        .unwrap()
        .unwrap_err();
    assert_eq!(aborted.code, PluginErrorCode::Aborted, "{aborted:?}");
    ended(&[pid, child.unwrap()]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_call_a_plugin_switched_off_or_the_host_stopping_ends_the_whole_tree_and_rejects_as_aborted()
 {
    let world = World::new();
    let folder = world.plugin("ending", &json!({ "tool": text(&fake_program()) }), &[]);
    let file = |name: &str| text(&world.dirs.root().join(name));

    ended_by(
        &world,
        "ending",
        &file("cancelled.json"),
        CancelToken::cancel,
    )
    .await;

    let registry = world.registry.clone();
    let path = text(&folder);
    ended_by(&world, "ending", &file("switched off.json"), |_| {
        registry.set_enabled(&path, false).unwrap();
    })
    .await;

    registry.set_enabled(&path, true).unwrap();
    ended_by(&world, "ending", &file("host stopped.json"), |_| {
        registry.shutdown();
    })
    .await;
    drop(registry);
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn writing_more_than_16_mb_on_stdout_or_stderr_ends_the_tree_and_rejects_saying_so() {
    let world = World::new();
    world.plugin("chatty", &json!({ "tool": text(&fake_program()) }), &[]);
    let over = (16 * 1024 * 1024 + 1).to_string();
    for stream in ["--stdout-bytes", "--stderr-bytes"] {
        let file = text(&world.dirs.root().join(format!("{stream}.json")));
        let mut args = vec!["--child", stream, over.as_str(), "--sleep", "600000"];
        with_pid_file(&mut args, &file);
        let refused = world
            .exec("chatty", "tool", &args, Value::Null)
            .await
            .unwrap_err();
        assert_eq!(refused.code, PluginErrorCode::Invalid, "{refused:?}");
        assert_eq!(refused.message, "the program wrote more than 16 MB");
        let (pid, child) = pids(Path::new(&file)).await;
        ended(&[pid, child.unwrap()]).await;
    }
    world.stop();
}
