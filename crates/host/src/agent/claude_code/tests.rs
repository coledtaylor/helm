//! Claude Code behind the trait, against today's app: the cases core's tests
//! check for launch, resume, overlays, agent tool registration, session
//! records, history, usage, config files and sign-in, with the same inputs and
//! expectations. A launch is run through the fake `claude`
//! (`test/fake-agents/claude-code.mjs`, under Node), which reads its argv as
//! the real parser does and logs what it loaded. Every folder is temporary:
//! the home, the config folder and Floti's data folder.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use floti_protocol::channels::common::PermissionMode;
use floti_protocol::channels::sessions::{
    EffortLevel, SessionActivity, UsageGroup, UsageProblemKind,
};
use floti_protocol::channels::workspace::ConfigFileKind;
use floti_protocol::{BackendFeature, HarnessPart, Knowable};
use serde_json::{Value, json};

use super::*;
use crate::agent::{BackendAnswers, Composition, sweep_launch_folders};
use crate::platform::links::is_link;
use crate::platform::process_tree::{self, Ending, ProcessTree};
use crate::testkit::TestDirs;

// ---------------------------------------------------------------------------
// The world a test runs in
// ---------------------------------------------------------------------------

/// A machine whose processes answer as the test says; any other is gone.
#[derive(Default)]
struct Machine(Mutex<BTreeMap<u32, Knowable<bool>>>);

impl Machine {
    fn set(&self, pid: u32, alive: Knowable<bool>) {
        self.0.lock().unwrap().insert(pid, alive);
    }
}

impl ProcessTree for Machine {
    fn end_tree(&self, _: u32, _: Ending) -> crate::Result<()> {
        Ok(())
    }

    fn is_alive(&self, pid: u32) -> Knowable<bool> {
        self.0
            .lock()
            .unwrap()
            .get(&pid)
            .cloned()
            .unwrap_or(Knowable::Known(false))
    }
}

/// The fake `claude`.
fn fake_claude() -> PathBuf {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("test")
        .join("fake-agents")
        .join("claude-code.mjs");
    real(&path)
}

/// `path` with links resolved, in the form a process reports its own folder
/// in (no `\\?\` on Windows), so a test compares what the fake logs.
fn real(path: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = canonical.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(plain) => PathBuf::from(plain),
        None => canonical,
    }
}

fn text(path: impl AsRef<Path>) -> String {
    path.as_ref().display().to_string()
}

fn write(path: &Path, contents: impl AsRef<[u8]>) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

struct World {
    dirs: TestDirs,
    /// Claude Code's config folder, `CLAUDE_CONFIG_DIR` for every run.
    config: PathBuf,
    machine: Arc<Machine>,
    backend: ClaudeCodeBackend,
}

impl World {
    fn new() -> Self {
        Self::with(|_| {})
    }

    /// A world whose backend settings `adjust` changes.
    fn with(adjust: impl FnOnce(&mut ClaudeCodeSettings)) -> Self {
        let machine = Arc::new(Machine::default());
        Self::build(
            adjust,
            Arc::clone(&machine) as Arc<dyn ProcessTree + Send + Sync>,
            machine,
        )
    }

    /// A world whose backend asks the OS whether a process is running.
    fn native() -> Self {
        Self::build(
            |_| {},
            Arc::new(process_tree::Native),
            Arc::new(Machine::default()),
        )
    }

    fn build(
        adjust: impl FnOnce(&mut ClaudeCodeSettings),
        tree: Arc<dyn ProcessTree + Send + Sync>,
        machine: Arc<Machine>,
    ) -> Self {
        let dirs = TestDirs::new();
        let config = real(&dirs.folder("claude config"));
        let mut settings = ClaudeCodeSettings {
            program: "node".into(),
            leading_args: vec![fake_claude().into_os_string()],
            config_dir: config.clone(),
            pass_config_dir: true,
            api_key_set: false,
        };
        adjust(&mut settings);
        Self {
            backend: ClaudeCodeBackend::new(settings, tree),
            dirs,
            config,
            machine,
        }
    }

    /// A new folder in the test tree, as a process started there reports it.
    fn folder(&self, name: &str) -> PathBuf {
        real(&self.dirs.folder(name))
    }

    fn launch_folder(&self) -> LaunchFolder {
        LaunchFolder::create(&self.dirs.data).unwrap()
    }

    fn launch(&self, request: &LaunchRequest) -> (Launch, LaunchFolder) {
        let folder = self.launch_folder();
        let launch = self.backend.launch(request, &folder).unwrap();
        (launch, folder)
    }

    fn resume(&self, request: &ResumeRequest) -> (Launch, LaunchFolder) {
        let folder = self.launch_folder();
        let launch = self
            .backend
            .resumer()
            .expect("Claude Code resumes")
            .resume(request, &folder)
            .unwrap();
        (launch, folder)
    }

    /// `claude`'s own arguments in a launch, after the fake's script.
    fn args(&self, launch: &Launch) -> Vec<String> {
        let leading = self.backend.settings().leading_args.len();
        launch.spec.args[leading..]
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    /// The launch as the session module would start it, with the test's
    /// home and nothing of this machine's Claude Code.
    fn command(&self, spec: &LaunchSpec) -> Command {
        let mut command = Command::new(&spec.program);
        command.args(&spec.args).current_dir(&spec.cwd);
        for leaky in [
            "CLAUDE_CONFIG_DIR",
            "ANTHROPIC_API_KEY",
            "FAKE_AGENT_VERSION",
            "CLAUDECODE",
        ] {
            command.env_remove(leaky);
        }
        command
            .env("HOME", &self.dirs.home)
            .env("USERPROFILE", &self.dirs.home)
            .envs(spec.env.iter().map(|(name, value)| (name, value)));
        command
    }

    /// Runs `launch` to its end with `input` typed, and answers its output and
    /// the fake's run log.
    fn run(&self, launch: &Launch, input: &str) -> (Output, Value) {
        self.run_spec(&launch.spec, input)
    }

    fn run_spec(&self, spec: &LaunchSpec, input: &str) -> (Output, Value) {
        let mut child = self
            .command(spec)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("run node");
        let pid = child.id();
        // A run that fails at once has closed its input already.
        let _ = child.stdin.take().unwrap().write_all(input.as_bytes());
        let output = child.wait_with_output().unwrap();
        (output, self.run_log(pid))
    }

    fn run_log(&self, pid: u32) -> Value {
        let file = self.config.join("fake-agent").join(format!("{pid}.json"));
        let bytes = std::fs::read(&file)
            .unwrap_or_else(|err| panic!("the fake left no run log at {}: {err}", file.display()));
        serde_json::from_slice(&bytes).unwrap()
    }
}

fn strings(log: &Value, key: &str) -> Vec<String> {
    log[key]
        .as_array()
        .unwrap_or_else(|| panic!("{key} is a list in {log}"))
        .iter()
        .map(|item| item.as_str().unwrap().to_owned())
        .collect()
}

/// The instruction files a run loaded, resolved, so they compare with
/// folders a test made.
fn loaded_instructions(log: &Value) -> Vec<PathBuf> {
    strings(log, "instructionFiles")
        .iter()
        .map(|file| real(Path::new(file)))
        .collect()
}

fn succeeded(output: &Output) {
    assert!(
        output.status.success(),
        "the fake claude failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn server(name: &str, token: &str) -> AgentToolServer {
    AgentToolServer {
        name: name.to_owned(),
        url: format!("http://127.0.0.1:41000/mcp/{name}"),
        token: token.to_owned(),
    }
}

/// Every file under `root` with its size and modified time, links not
/// followed: what "nothing was written there" is checked against.
fn tree_state(root: &Path) -> BTreeMap<PathBuf, (u64, Option<SystemTime>)> {
    fn walk(dir: &Path, out: &mut BTreeMap<PathBuf, (u64, Option<SystemTime>)>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                walk(&path, out);
            }
            out.insert(path, (meta.len(), meta.modified().ok()));
        }
    }
    let mut out = BTreeMap::new();
    walk(root, &mut out);
    out
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// `ms` as the ISO timestamp the CLI writes.
fn iso(ms: u64) -> String {
    let (secs, millis) = (ms / 1000, ms % 1000);
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// A transcript row as the CLI writes one.
fn transcript_row(kind: &str, uuid: &str, cwd: &Path, at_ms: u64, content: Value) -> String {
    let mut row = json!({
        "type": kind,
        "uuid": uuid,
        "cwd": text(cwd),
        "timestamp": iso(at_ms),
        "message": { "role": kind, "content": content },
    });
    if kind == "assistant" {
        row["message"]["model"] = json!("claude-opus-5");
        row["message"]["usage"] = json!({
            "input_tokens": 1000,
            "output_tokens": 100,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
        });
    }
    format!("{row}\n")
}

/// A harness in Claude's shape: a `CLAUDE.md` and `.claude` with a skill,
/// a command, a subagent and a workflow.
fn claude_shaped_harness(world: &World, name: &str, rules: &str) -> PathBuf {
    let root = world.folder(name);
    write(&root.join("CLAUDE.md"), rules);
    write(
        &root
            .join(".claude")
            .join("skills")
            .join("think")
            .join("SKILL.md"),
        "---\ndescription: think it through\n---\nthink",
    );
    write(
        &root.join(".claude").join("commands").join("recap.md"),
        "recap",
    );
    write(
        &root.join(".claude").join("agents").join("reviewer.md"),
        "review",
    );
    write(
        &root.join(".claude").join("workflows").join("ship.js"),
        "export const meta = { name: 'ship' }",
    );
    root
}

// ---------------------------------------------------------------------------
// Launch (plan.ts, session.ts)
// ---------------------------------------------------------------------------

#[test]
fn a_launch_runs_in_its_folder_with_the_flags_today_passes_and_the_prompt_last() {
    let world = World::new();
    let project = world.folder("work/cloud sync");
    let a = world.folder("repos/a");
    let b = world.folder("repos/b");
    let request = LaunchRequest {
        folder: project.clone(),
        name: "cloud\tsync ".into(),
        prompt: Some("review this".into()),
        composition: Composition {
            // Each access folder is passed once, however often it is listed.
            extra_folders: vec![a.clone(), b.clone(), a.clone()],
            model: Some("opus".into()),
            effort: Some(EffortLevel::High),
            agent: Some("reviewer".into()),
            ..Composition::default()
        },
    };
    let (launch, folder) = world.launch(&request);
    let id = launch.spec.conversation_id.clone().expect("a fresh id");
    assert_eq!(id.len(), 36);

    assert_eq!(
        world.args(&launch),
        vec![
            "--add-dir".to_owned(),
            text(&a),
            text(&b),
            "-n".into(),
            "cloud sync".into(),
            "--settings".into(),
            text(folder.path().join("settings.json")),
            "--session-id".into(),
            id.clone(),
            "--model".into(),
            "opus".into(),
            "--effort".into(),
            "high".into(),
            "--agent".into(),
            "reviewer".into(),
            "--".into(),
            "review this".into(),
        ]
    );
    assert_eq!(launch.spec.cwd, project);

    let (output, log) = world.run(&launch, "/exit\n");
    succeeded(&output);
    assert_eq!(real(Path::new(log["cwd"].as_str().unwrap())), project);
    assert_eq!(log["openingPrompt"], "review this");
    assert_eq!(log["sessionId"], id.as_str());
    assert_eq!(log["resumed"], false);
}

#[test]
fn a_choice_left_empty_passes_no_flag() {
    let world = World::new();
    let project = world.folder("plain");
    let (launch, folder) = world.launch(&LaunchRequest {
        folder: project,
        name: "plain".into(),
        prompt: Some("   ".into()),
        composition: Composition {
            model: Some("  ".into()),
            agent: Some(String::new()),
            ..Composition::default()
        },
    });
    let id = launch.spec.conversation_id.clone().unwrap();
    assert_eq!(
        world.args(&launch),
        vec![
            "-n".to_owned(),
            "plain".into(),
            "--settings".into(),
            text(folder.path().join("settings.json")),
            "--session-id".into(),
            id,
        ]
    );
}

/// `--add-dir` and `--mcp-config` are variadic, and a launch with nothing
/// single-valued after them once handed the prompt to the last one. Behind
/// `--`, the CLI's parser reads it as the prompt, whatever comes before it.
#[test]
fn the_prompt_arrives_as_the_prompt_after_every_variadic_list() {
    let world = World::new();
    let project = world.folder("work");
    let access = world.folder("repos/access");
    let overlay = world.folder("harness only skills");
    write(
        &overlay
            .join(".claude")
            .join("skills")
            .join("plan")
            .join("SKILL.md"),
        "plan",
    );
    let (launch, _folder) = world.launch(&LaunchRequest {
        folder: project,
        name: "variadic".into(),
        prompt: Some("/recap".into()),
        composition: Composition {
            extra_folders: vec![access.clone()],
            overlays: vec![overlay],
            agent_tools: vec![server("floti-browser", "token-1")],
            ..Composition::default()
        },
    });
    let args = world.args(&launch);
    let at = args.iter().position(|arg| arg == "--mcp-config").unwrap();
    assert_eq!(&args[at + 2..], ["--", "/recap"]);

    let (output, log) = world.run(&launch, "/exit\n");
    succeeded(&output);
    assert_eq!(log["openingPrompt"], "/recap");
    assert_eq!(
        log["mcpServers"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        ["floti-browser"]
    );
}

#[test]
fn a_session_name_is_made_safe_before_it_reaches_the_cli() {
    assert_eq!(sanitize_session_name("cloud sync"), "cloud sync");
    assert_eq!(sanitize_session_name("a\u{200b}b\u{0007}c"), "a b c");
    assert_eq!(sanitize_session_name("  two \t\n words  "), "two words");
    assert_eq!(sanitize_session_name(" \u{200b}\t"), "session");
    let long = "x".repeat(80);
    assert_eq!(sanitize_session_name(&long).chars().count(), 60);
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

#[test]
fn a_permission_choice_is_passed_exactly_and_no_choice_passes_no_flag() {
    let world = World::new();
    let project = world.folder("work");
    let launch_with = |mode: Option<PermissionMode>| {
        world
            .launch(&LaunchRequest {
                folder: project.clone(),
                name: "perm".into(),
                composition: Composition {
                    permission_mode: mode,
                    ..Composition::default()
                },
                ..LaunchRequest::default()
            })
            .0
    };

    let planned = launch_with(Some(PermissionMode::Plan));
    let args = world.args(&planned);
    let at = args
        .iter()
        .position(|arg| arg == "--permission-mode")
        .unwrap();
    assert_eq!(args[at + 1], "plan");
    assert_eq!(
        args.iter()
            .filter(|arg| *arg == "--permission-mode")
            .count(),
        1
    );
    let (output, log) = world.run(&planned, "/exit\n");
    succeeded(&output);
    assert!(
        strings(&log, "argv")
            .windows(2)
            .any(|pair| pair == ["--permission-mode", "plan"])
    );

    let none = launch_with(None);
    assert!(
        !world
            .args(&none)
            .iter()
            .any(|arg| arg == "--permission-mode")
    );

    let permissions = world
        .backend
        .permissions()
        .expect("Claude Code maps permissions");
    for (mode, name) in [
        (PermissionMode::AcceptEdits, "acceptEdits"),
        (PermissionMode::Auto, "auto"),
        (PermissionMode::BypassPermissions, "bypassPermissions"),
        (PermissionMode::Manual, "manual"),
        (PermissionMode::DontAsk, "dontAsk"),
        (PermissionMode::Plan, "plan"),
    ] {
        assert_eq!(
            permissions.arguments(mode),
            vec![OsString::from("--permission-mode"), OsString::from(name)]
        );
    }
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

#[test]
fn a_conversation_resumes_in_the_folder_its_transcript_recorded() {
    let world = World::new();
    let recorded = world.folder("projects/payroll");
    let elsewhere = world.folder("somewhere else");
    let id = "0f6c2a8e-91d4-4b7a-8e33-5d2f1c9a7b40";
    // The project folder's name is the CLI's business: nothing derives it.
    write(
        &world
            .config
            .join("projects")
            .join("not-derived-from-the-path")
            .join(format!("{id}.jsonl")),
        transcript_row(
            "user",
            "u1",
            &recorded,
            now_ms() - 60_000,
            json!("fix the payroll export"),
        ),
    );

    // Wherever the request came from, the folder is the one history recorded.
    let found = world
        .backend
        .history()
        .unwrap()
        .transcript(id)
        .unwrap()
        .unwrap();
    let folder = PathBuf::from(found.conversation.folder.clone().unwrap());
    assert_eq!(folder, recorded);

    let (launch, launch_folder) = world.resume(&ResumeRequest {
        conversation_id: id.into(),
        folder: folder.clone(),
        composition: Composition {
            agent_tools: vec![server("floti-browser", "resume-token")],
            permission_mode: Some(PermissionMode::Plan),
            ..Composition::default()
        },
    });
    assert_eq!(
        world.args(&launch),
        vec![
            "--resume".to_owned(),
            id.into(),
            "--settings".into(),
            text(launch_folder.path().join("settings.json")),
            "--mcp-config".into(),
            text(launch_folder.path().join("mcp.json")),
            "--permission-mode".into(),
            "plan".into(),
        ]
    );
    assert_eq!(launch.spec.cwd, recorded);
    assert_eq!(launch.spec.conversation_id.as_deref(), Some(id));

    let (output, log) = world.run(&launch, "/exit\n");
    succeeded(&output);
    assert_eq!(log["resumed"], true);
    assert_eq!(log["sessionId"], id);
    assert!(log["mcpServers"]["floti-browser"].is_object());

    // The CLI finds no conversation anywhere else, which is why the folder
    // matters.
    let mut misplaced = launch.spec.clone();
    misplaced.cwd = elsewhere;
    let (output, _) = world.run_spec(&misplaced, "/exit\n");
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stdout).contains("No conversation found"));
}

#[test]
fn a_resume_drops_what_belongs_to_a_new_conversation_and_keeps_its_overlays() {
    let world = World::new();
    let project = world.folder("work");
    let overlay = claude_shaped_harness(&world, "harness a", "# a rules\n");
    let id = "0f6c2a8e-91d4-4b7a-8e33-5d2f1c9a7b40";
    let (launch, _) = world.resume(&ResumeRequest {
        conversation_id: id.into(),
        folder: project,
        composition: Composition {
            overlays: vec![overlay],
            ..Composition::default()
        },
    });
    let args = world.args(&launch);
    assert_eq!(&args[..2], ["--resume", id]);
    assert!(args.contains(&"--plugin-dir".to_owned()));
    assert!(args.contains(&"--append-system-prompt-file".to_owned()));
    for absent in ["-n", "--session-id", "--"] {
        assert!(!args.contains(&absent.to_owned()), "{absent} in {args:?}");
    }

    let err = world
        .backend
        .resumer()
        .unwrap()
        .resume(
            &ResumeRequest {
                conversation_id: " ".into(),
                ..ResumeRequest::default()
            },
            &world.launch_folder(),
        )
        .unwrap_err();
    assert!(err.to_string().contains("resume a conversation with no id"));
}

// ---------------------------------------------------------------------------
// Status (registry.ts)
// ---------------------------------------------------------------------------

const RECORD_ID: &str = "e9227e28-600c-43a5-a28b-b27d4a1aae30";

/// Records as 2.1.238 wrote them, from core's registry tests.
fn measured(status: Option<&str>, waiting_for: Option<&str>) -> String {
    let mut record = json!({
        "pid": 28160, "sessionId": RECORD_ID, "cwd": "C:\\probe", "startedAt": 1787270375972u64,
        "procStart": "134317439745798131", "version": "2.1.238", "kind": "interactive",
        "entrypoint": "cli", "name": "registry-probe", "updatedAt": 1787270376185u64,
    });
    if let Some(status) = status {
        record["status"] = json!(status);
        record["statusUpdatedAt"] = json!(1787270376185u64);
    }
    if let Some(waiting) = waiting_for {
        record["waitingFor"] = json!(waiting);
    }
    record.to_string()
}

#[test]
fn a_session_is_busy_idle_or_waiting_as_its_record_says() {
    let world = World::new();
    world.machine.set(28160, Knowable::Known(true));
    let records = world.config.join("sessions");
    let by_id = SessionRef {
        pid: 999,
        conversation_id: Some(RECORD_ID.into()),
    };
    let by_pid = SessionRef {
        pid: 28160,
        conversation_id: None,
    };
    for (status, waiting, expected) in [
        ("idle", None, SessionActivity::Idle),
        ("busy", None, SessionActivity::Busy),
        ("shell", None, SessionActivity::Shell),
        ("waiting", Some("dialog open"), SessionActivity::Waiting),
        (
            "waiting",
            Some("permission prompt"),
            SessionActivity::Waiting,
        ),
    ] {
        write(&records.join("28160.json"), measured(Some(status), waiting));
        assert_eq!(
            world.backend.read_status(&by_id),
            Knowable::Known(Some(expected))
        );
        assert_eq!(
            world.backend.read_status(&by_pid),
            Knowable::Known(Some(expected))
        );
    }
}

#[test]
fn a_record_from_a_process_that_is_gone_is_ignored_and_one_that_cannot_be_read_is_unknown() {
    let world = World::new();
    let records = world.config.join("sessions");
    let session = SessionRef {
        pid: 28160,
        conversation_id: Some(RECORD_ID.into()),
    };
    // No folder at all: a CLI that never ran a session.
    assert_eq!(world.backend.read_status(&session), Knowable::Known(None));

    // A hard kill leaves the file behind, still claiming `busy`.
    write(&records.join("28160.json"), measured(Some("busy"), None));
    assert_eq!(world.backend.read_status(&session), Knowable::Known(None));
    // A process the OS will not say anything about is not believed either.
    world.machine.set(28160, Knowable::Unknown);
    assert_eq!(world.backend.read_status(&session), Knowable::Known(None));

    // Alive, but its record says nothing yet, or something unrecognised: a
    // plain tab, never a guess.
    world.machine.set(28160, Knowable::Known(true));
    write(&records.join("28160.json"), measured(None, None));
    assert_eq!(world.backend.read_status(&session), Knowable::Unknown);
    write(
        &records.join("28160.json"),
        r#"{"pid":28160,"status":"thinking"}"#,
    );
    assert_eq!(world.backend.read_status(&session), Knowable::Unknown);

    // The session's own record, unreadable mid-write.
    std::fs::remove_file(records.join("28160.json")).unwrap();
    write(&records.join("28160.json"), r#"{"pid":28160,"status":"idl"#);
    assert_eq!(world.backend.read_status(&session), Knowable::Unknown);
    // Someone else's unusable record costs nothing.
    std::fs::remove_file(records.join("28160.json")).unwrap();
    write(&records.join("31.json"), "not json");
    write(&records.join("notes.txt"), "ignored");
    assert_eq!(world.backend.read_status(&session), Knowable::Known(None));
}

#[test]
fn a_running_session_is_read_from_the_record_its_cli_keeps_and_the_key_beside_it_is_named_never_read()
 {
    let world = World::native();
    let project = world.folder("work");
    let (launch, _folder) = world.launch(&LaunchRequest {
        folder: project,
        name: "live".into(),
        ..LaunchRequest::default()
    });
    let mut child = world
        .command(&launch.spec)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    // Drain the screen so the fake never blocks on a full pipe.
    let mut stdout = child.stdout.take().unwrap();
    let drain = std::thread::spawn(move || std::io::copy(&mut stdout, &mut std::io::sink()));
    let session = SessionRef {
        pid: child.id(),
        conversation_id: launch.spec.conversation_id.clone(),
    };

    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if world.backend.read_status(&session) == Knowable::Known(Some(SessionActivity::Idle)) {
            break;
        }
        assert!(Instant::now() < deadline, "the session never read as idle");
        std::thread::sleep(Duration::from_millis(50));
    }
    let keys: Vec<PathBuf> = world
        .backend
        .credential_paths()
        .into_iter()
        .filter(|path| path.extension().is_some_and(|ext| ext == "key"))
        .collect();
    assert_eq!(keys.len(), 1, "the record's key is named as a credential");
    assert!(keys[0].starts_with(world.config.join("sessions")));

    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(b"/exit\n").unwrap();
    drop(stdin);
    assert!(child.wait().unwrap().success());
    drain.join().unwrap().unwrap();
    // A clean exit removes the record: a plain tab, not a stale status.
    assert_eq!(world.backend.read_status(&session), Knowable::Known(None));
}

// ---------------------------------------------------------------------------
// Agent tools (mcp.ts)
// ---------------------------------------------------------------------------

#[test]
fn agent_tools_are_one_file_per_launch_with_the_sessions_token_and_never_on_a_command_line() {
    let world = World::new();
    let project = world.folder("work");
    let (launch, folder) = world.launch(&LaunchRequest {
        folder: project.clone(),
        name: "tools".into(),
        composition: Composition {
            agent_tools: vec![
                server("floti-browser", "secret-token-123"),
                server("floti-sessions", "secret-token-123"),
            ],
            ..Composition::default()
        },
        ..LaunchRequest::default()
    });
    let file = folder.path().join("mcp.json");
    assert!(
        file.starts_with(&world.dirs.data),
        "under Floti's data folder"
    );
    let args = world.args(&launch);
    let at = args.iter().position(|arg| arg == "--mcp-config").unwrap();
    assert_eq!(args[at + 1], text(&file));
    assert_eq!(args.iter().filter(|arg| *arg == "--mcp-config").count(), 1);

    let document: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    for name in ["floti-browser", "floti-sessions"] {
        assert_eq!(
            document["mcpServers"][name],
            json!({
                "type": "http",
                "url": format!("http://127.0.0.1:41000/mcp/{name}"),
                "headers": { "Authorization": "Bearer secret-token-123" },
            })
        );
    }
    let command_line = launch
        .spec
        .args
        .iter()
        .chain(launch.spec.env.iter().map(|(_, value)| value))
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ");
    assert!(!command_line.contains("secret-token-123"));

    let home_before = tree_state(&world.dirs.home);
    let (output, log) = world.run(&launch, "/exit\n");
    succeeded(&output);
    assert_eq!(
        log["mcpServers"]["floti-sessions"]["headers"]["Authorization"],
        "Bearer secret-token-123"
    );
    // No `claude mcp add-json`: the user's config files hold no token.
    assert_eq!(tree_state(&world.dirs.home), home_before);
    for config in [
        world.config.join(".claude.json"),
        world.dirs.home.join(".claude.json"),
        project.join(".mcp.json"),
    ] {
        assert!(!config.exists(), "{} was written", config.display());
    }

    // The file goes with its launch folder when the session ends.
    folder.remove().unwrap();
    assert!(!file.exists());
}

#[test]
fn with_every_tool_family_off_there_is_no_file_no_token_and_no_flag() {
    let world = World::new();
    let (launch, folder) = world.launch(&LaunchRequest {
        folder: world.folder("work"),
        name: "no tools".into(),
        ..LaunchRequest::default()
    });
    assert!(!world.args(&launch).contains(&"--mcp-config".to_owned()));
    assert!(!folder.path().join("mcp.json").exists());
    assert_eq!(
        world
            .backend
            .agent_tools()
            .unwrap()
            .register(&[], &folder)
            .unwrap(),
        Registration::default()
    );
}

#[test]
fn a_leftover_launch_folder_with_its_tool_file_goes_only_when_its_owner_is_provably_gone() {
    let world = World::new();
    let (_launch, folder) = world.launch(&LaunchRequest {
        folder: world.folder("work"),
        name: "left over".into(),
        composition: Composition {
            agent_tools: vec![server("floti-browser", "t")],
            ..Composition::default()
        },
        ..LaunchRequest::default()
    });
    folder.add_owner(4242).unwrap();
    let file = folder.path().join("mcp.json");

    // This process owns it too and is running.
    world.machine.set(std::process::id(), Knowable::Known(true));
    world.machine.set(4242, Knowable::Known(false));
    assert!(sweep_launch_folders(&world.dirs.data, world.machine.as_ref()).is_empty());
    // Access denied answers alive, and unknown means keep.
    world
        .machine
        .set(std::process::id(), Knowable::Known(false));
    world.machine.set(4242, Knowable::Unknown);
    assert!(sweep_launch_folders(&world.dirs.data, world.machine.as_ref()).is_empty());
    assert!(file.exists());

    world.machine.set(4242, Knowable::Known(false));
    assert_eq!(
        sweep_launch_folders(&world.dirs.data, world.machine.as_ref()),
        vec![folder.path().to_path_buf()]
    );
    assert!(!file.exists());
}

// ---------------------------------------------------------------------------
// Overlays and instructions (overlay.ts, B15)
// ---------------------------------------------------------------------------

#[test]
fn a_claude_shaped_harness_becomes_a_linked_overlay_and_only_non_ancestor_claude_md_is_composed() {
    let world = World::new();
    let harness = claude_shaped_harness(&world, "harness", "# harness rules\n");
    let repo = world.folder("harness/repos/acme");
    let other = claude_shaped_harness(&world, "other project", "# other rules\n");

    let (launch, folder) = world.launch(&LaunchRequest {
        folder: repo.clone(),
        name: "overlaid".into(),
        composition: Composition {
            overlays: vec![harness.clone(), other.clone()],
            ..Composition::default()
        },
        ..LaunchRequest::default()
    });
    assert_eq!(launch.overlays, ["harness", "other-project"]);
    assert!(launch.composed_instructions);
    assert!(launch.not_taken.is_empty());

    let args = world.args(&launch);
    let plugin_dirs: Vec<&String> = args
        .windows(2)
        .filter(|pair| pair[0] == "--plugin-dir")
        .map(|pair| &pair[1])
        .collect();
    assert_eq!(plugin_dirs.len(), 2);
    for (dir, source, name) in [
        (plugin_dirs[0], &harness, "harness"),
        (plugin_dirs[1], &other, "other-project"),
    ] {
        let dir = PathBuf::from(dir);
        assert!(dir.starts_with(folder.path().join("overlays")));
        let manifest: Value = serde_json::from_slice(
            &std::fs::read(dir.join(".claude-plugin").join("plugin.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["name"], name);
        for (part, target) in [
            ("skills", "skills"),
            ("commands", "commands"),
            ("agents", "agents"),
            ("workflows", "workflows"),
        ] {
            assert!(is_link(&dir.join(part)), "{part} is a link");
            assert_eq!(real(&dir.join(part)), source.join(".claude").join(target));
        }
        assert!(!dir.join("hooks").exists());
    }

    let (output, log) = world.run(&launch, "/exit\n");
    succeeded(&output);
    let composed = log["composedInstructions"].as_str().unwrap();
    assert!(composed.contains("# other rules"));
    assert!(composed.contains(&text(&other)));
    // The ancestor's arrives once, through the CLI's own walk.
    assert!(!composed.contains("# harness rules"));
    let loaded = loaded_instructions(&log);
    assert_eq!(
        loaded
            .iter()
            .filter(|file| **file == harness.join("CLAUDE.md"))
            .count(),
        1
    );
}

#[test]
fn removing_an_overlay_unlinks_it_and_leaves_the_repository_untouched() {
    let world = World::new();
    let harness = claude_shaped_harness(&world, "harness", "# rules\n");
    let before = tree_state(&harness);
    let (_launch, folder) = world.launch(&LaunchRequest {
        folder: world.folder("work"),
        name: "removed".into(),
        composition: Composition {
            overlays: vec![harness.clone()],
            ..Composition::default()
        },
        ..LaunchRequest::default()
    });
    folder.remove().unwrap();
    assert!(!folder.path().exists());
    assert_eq!(tree_state(&harness), before);
}

#[test]
fn a_harness_in_the_shared_shape_reaches_the_session_with_nothing_written_into_it() {
    let world = World::new();
    let harness = world.folder("shared harness");
    write(&harness.join("AGENTS.md"), "# shared rules\n");
    write(
        &harness
            .join(".agents")
            .join("skills")
            .join("plan")
            .join("SKILL.md"),
        "plan",
    );
    let repo = world.folder("shared harness/repo");
    let harness_before = tree_state(&harness);
    let config_before = tree_state(&world.config);

    let (launch, folder) = world.launch(&LaunchRequest {
        folder: repo.clone(),
        name: "shared".into(),
        composition: Composition {
            overlays: vec![harness.clone()],
            ..Composition::default()
        },
        ..LaunchRequest::default()
    });
    assert_eq!(tree_state(&harness), harness_before);
    assert_eq!(tree_state(&world.config), config_before);
    assert!(
        launch
            .warnings
            .iter()
            .all(|warning| !warning.contains("both"))
    );

    let skills = folder
        .path()
        .join("overlays")
        .join("shared-harness")
        .join("skills");
    assert!(is_link(&skills));
    assert_eq!(real(&skills), harness.join(".agents").join("skills"));
    // The harness is above the repo, so the CLI's walk brings its AGENTS.md.
    assert!(!launch.composed_instructions);

    let (output, log) = world.run(&launch, "/exit\n");
    succeeded(&output);
    assert_eq!(
        loaded_instructions(&log)
            .iter()
            .filter(|file| **file == harness.join("AGENTS.md"))
            .count(),
        1
    );
}

#[test]
fn with_both_shapes_the_claude_skill_wins_a_name_clash_and_the_launch_says_so() {
    let world = World::new();
    let harness = world.folder("both");
    write(
        &harness
            .join(".claude")
            .join("skills")
            .join("think")
            .join("SKILL.md"),
        "claude think",
    );
    write(
        &harness
            .join(".agents")
            .join("skills")
            .join("think")
            .join("SKILL.md"),
        "shared think",
    );
    write(
        &harness
            .join(".agents")
            .join("skills")
            .join("plan")
            .join("SKILL.md"),
        "plan",
    );
    let (launch, folder) = world.launch(&LaunchRequest {
        folder: world.folder("work"),
        name: "both".into(),
        composition: Composition {
            overlays: vec![harness.clone()],
            ..Composition::default()
        },
        ..LaunchRequest::default()
    });
    let skills = folder.path().join("overlays").join("both").join("skills");
    assert!(!is_link(&skills), "a real folder of per-skill links");
    assert_eq!(
        std::fs::read_to_string(skills.join("think").join("SKILL.md")).unwrap(),
        "claude think"
    );
    assert_eq!(
        std::fs::read_to_string(skills.join("plan").join("SKILL.md")).unwrap(),
        "plan"
    );
    assert!(
        launch
            .warnings
            .iter()
            .any(|warning| warning.contains("The skill think")),
        "{:?}",
        launch.warnings
    );
}

#[test]
fn an_overlaid_projects_agents_md_is_composed_like_its_claude_md() {
    let world = World::new();
    let other = world.folder("agents only");
    write(&other.join("AGENTS.md"), "# agents rules\n");
    let (launch, _folder) = world.launch(&LaunchRequest {
        folder: world.folder("work"),
        name: "composed".into(),
        composition: Composition {
            overlays: vec![other],
            ..Composition::default()
        },
        ..LaunchRequest::default()
    });
    assert!(launch.composed_instructions);
    let (output, log) = world.run(&launch, "/exit\n");
    succeeded(&output);
    let composed = log["composedInstructions"].as_str().unwrap();
    assert!(composed.contains("(AGENTS.md)") && composed.contains("# agents rules"));
}

#[test]
fn an_overlay_that_has_gone_is_skipped_and_said() {
    let world = World::new();
    let gone = world.dirs.root().join("never made");
    let (launch, _folder) = world.launch(&LaunchRequest {
        folder: world.folder("work"),
        name: "gone".into(),
        composition: Composition {
            overlays: vec![gone.clone()],
            ..Composition::default()
        },
        ..LaunchRequest::default()
    });
    assert!(launch.overlays.is_empty());
    assert!(!world.args(&launch).contains(&"--plugin-dir".to_owned()));
    assert!(
        launch
            .warnings
            .iter()
            .any(|warning| warning.contains("not there any more"))
    );
}

#[test]
fn overlay_names_are_the_repo_name_made_safe_and_distinct() {
    assert_eq!(overlay_plugin_name(Path::new("/repos/My Repo!")), "my-repo");
    assert_eq!(overlay_plugin_name(Path::new("/repos/---")), "overlay");
    assert_eq!(
        overlay_plugin_names(&[
            PathBuf::from("/a/dev"),
            PathBuf::from("/b/dev"),
            PathBuf::from("/c/dev")
        ]),
        ["dev", "dev-2", "dev-3"]
    );
}

// ---------------------------------------------------------------------------
// CLAUDE.md and AGENTS.md together (B15)
// ---------------------------------------------------------------------------

#[test]
fn a_harness_and_repo_in_different_shapes_both_load_once_through_the_launchs_own_settings() {
    for (outer, inner) in [("CLAUDE.md", "AGENTS.md"), ("AGENTS.md", "CLAUDE.md")] {
        let world = World::new();
        let user_settings = world.config.join("settings.json");
        write(&user_settings, r#"{"model":"sonnet"}"#);
        let harness = world.folder("harness");
        write(&harness.join(outer), "# outer\n");
        let repo = world.folder("harness/repo");
        write(&repo.join(inner), "# inner\n");

        let (launch, folder) = world.launch(&LaunchRequest {
            folder: repo.clone(),
            name: "both files".into(),
            ..LaunchRequest::default()
        });
        let settings = folder.path().join("settings.json");
        assert!(settings.starts_with(&world.dirs.data));
        assert_eq!(std::fs::read_to_string(&settings).unwrap(), LAUNCH_SETTINGS);
        let args = world.args(&launch);
        let at = args.iter().position(|arg| arg == "--settings").unwrap();
        assert_eq!(args[at + 1], text(&settings));

        let (output, log) = world.run(&launch, "/exit\n");
        succeeded(&output);
        let loaded = loaded_instructions(&log);
        for file in [harness.join(outer), repo.join(inner)] {
            assert_eq!(
                loaded.iter().filter(|seen| **seen == file).count(),
                1,
                "{} loads once of {loaded:?}",
                file.display()
            );
        }
        assert_eq!(
            std::fs::read_to_string(&user_settings).unwrap(),
            r#"{"model":"sonnet"}"#
        );

        // Without the launch's settings the CLI drops an AGENTS.md below or
        // beside a CLAUDE.md: this is what the file is for.
        let mut bare = launch.spec.clone();
        let leading = world.backend.settings().leading_args.len();
        bare.args.drain(leading + at..leading + at + 2);
        let (output, log) = world.run_spec(&bare, "/exit\n");
        succeeded(&output);
        if outer == "CLAUDE.md" {
            assert!(!loaded_instructions(&log).contains(&repo.join("AGENTS.md")));
        }

        folder.remove().unwrap();
        assert!(!settings.exists());
    }
}

#[test]
fn a_resume_gets_the_settings_file_too() {
    let world = World::new();
    let (launch, folder) = world.resume(&ResumeRequest {
        conversation_id: "0f6c2a8e-91d4-4b7a-8e33-5d2f1c9a7b40".into(),
        folder: world.folder("work"),
        composition: Composition::default(),
    });
    let args = world.args(&launch);
    let at = args.iter().position(|arg| arg == "--settings").unwrap();
    assert_eq!(args[at + 1], text(folder.path().join("settings.json")));
}

// ---------------------------------------------------------------------------
// Tested versions (setup.ts)
// ---------------------------------------------------------------------------

fn fake_version(world: &World, asked: &str) -> String {
    let output = Command::new("node")
        .arg(fake_claude())
        .arg("--version")
        .env("FAKE_AGENT_VERSION", asked)
        .env("CLAUDE_CONFIG_DIR", &world.config)
        .output()
        .unwrap();
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn the_installed_version_passes_quietly_inside_the_range_and_warns_outside_it() {
    let world = World::new();
    assert_eq!(fake_version(&world, ""), "2.1.999 (Claude Code)\n");
    assert_eq!(
        world.backend.version_check(),
        VersionCheck::Tested(Version(2, 1, 999))
    );
    assert_eq!(world.backend.tested_range(), Some(TESTED_VERSIONS));

    assert_eq!(
        TESTED_VERSIONS.check(&fake_version(&world, "2.1.277")),
        VersionCheck::Tested(Version(2, 1, 277))
    );
    for outside in ["2.1.276", "2.2.0"] {
        assert!(matches!(
            TESTED_VERSIONS.check(&fake_version(&world, outside)),
            VersionCheck::Untested { .. }
        ));
    }

    // An untested version warns, naming the range, and still launches.
    let untested = World::with(|settings| {
        settings.leading_args = vec![
            "-e".into(),
            "process.stdout.write('2.2.0 (Claude Code)\\n')".into(),
            "--".into(),
        ];
    });
    let (launch, _) = untested.launch(&LaunchRequest {
        folder: untested.folder("work"),
        name: "untested".into(),
        ..LaunchRequest::default()
    });
    assert!(
        launch
            .warnings
            .iter()
            .any(|warning| warning.contains("2.2.0")
                && warning.contains("from 2.1.277 up to but not including 2.2.0")),
        "{:?}",
        launch.warnings
    );
}

#[test]
fn a_version_that_cannot_be_read_is_unknown_and_still_launches() {
    let world = World::with(|settings| {
        settings.program = "floti-no-such-claude-anywhere".into();
        settings.leading_args = Vec::new();
    });
    assert_eq!(world.backend.version_check(), VersionCheck::Unknown);
    let (launch, _) = world.launch(&LaunchRequest {
        folder: world.folder("work"),
        name: "unknown".into(),
        ..LaunchRequest::default()
    });
    assert!(launch.warnings.is_empty(), "{:?}", launch.warnings);
}

// ---------------------------------------------------------------------------
// Sign-in (setup.ts)
// ---------------------------------------------------------------------------

#[test]
fn signed_in_is_judged_from_artefacts_existing() {
    let world = World::new();
    let check = |world: &World| world.backend.read_sign_in().known().unwrap();

    let no = check(&world);
    assert_eq!(no.signed_in, Knowable::Known(false));
    assert!(no.signal.contains("Run claude"), "{}", no.signal);

    // An empty credentials file is not a sign-in.
    write(&world.config.join(".credentials.json"), "");
    assert_eq!(check(&world).signed_in, Knowable::Known(false));
    write(
        &world.config.join(".credentials.json"),
        "{\"claudeAiOauth\":{}}",
    );
    let yes = check(&world);
    assert_eq!(yes.signed_in, Knowable::Known(true));
    assert_eq!(yes.signal, ".credentials.json is present");
    std::fs::remove_file(world.config.join(".credentials.json")).unwrap();

    // A keychain login leaves the onboarding record behind.
    write(
        &world.config.join(".claude.json"),
        r#"{"hasCompletedOnboarding":true,"userID":"abc"}"#,
    );
    assert_eq!(
        check(&world).signal,
        ".claude.json records a completed sign-in"
    );
    write(
        &world.config.join(".claude.json"),
        r#"{"hasCompletedOnboarding":true}"#,
    );
    assert_eq!(check(&world).signed_in, Knowable::Known(false));

    let keyed = World::with(|settings| settings.api_key_set = true);
    assert_eq!(check(&keyed).signal, "ANTHROPIC_API_KEY is set");
}

#[test]
fn a_config_folder_that_cannot_be_read_is_unknown_for_sign_in() {
    let world = World::new();
    let not_a_folder = world.dirs.root().join("config is a file");
    write(&not_a_folder, "x");
    let blocked = World::with(|settings| settings.config_dir = not_a_folder.clone());
    let answer = blocked.backend.read_sign_in().known().unwrap();
    assert_eq!(answer.signed_in, Knowable::Unknown);
    drop(world);
}

// ---------------------------------------------------------------------------
// Credentials are never opened (S12)
// ---------------------------------------------------------------------------

#[test]
fn no_answer_carries_a_credential_and_every_credential_path_is_named() {
    const MARKER: &str = "MARKER-credential-7f3a";
    let world = World::new();
    world.machine.set(28160, Knowable::Known(true));
    write(
        &world.config.join(".credentials.json"),
        format!("{{\"token\":\"{MARKER}\"}}"),
    );
    let key = world.config.join("sessions").join("28160.0a1b2c.key");
    write(&key, MARKER);
    write(
        &world.config.join("sessions").join("28160.json"),
        measured(Some("idle"), None),
    );
    let project = world.folder("work");
    let id = "7b3d1c20-4a55-4f18-9c21-8e0c5a6d1f01";
    write(
        &world
            .config
            .join("projects")
            .join("p")
            .join(format!("{id}.jsonl")),
        transcript_row("user", "u1", &project, now_ms() - 1000, json!("hello")),
    );

    let answers = format!(
        "{:?}{:?}{:?}{:?}{:?}{:?}",
        world.backend.read_status(&SessionRef {
            pid: 28160,
            conversation_id: Some(RECORD_ID.into())
        }),
        world.backend.read_conversations(),
        world.backend.history().unwrap().transcript(id).unwrap(),
        world.backend.read_usage(now_ms(), 0),
        world.backend.read_config_files(Some(&project)),
        world.backend.read_sign_in(),
    );
    assert!(!answers.contains(MARKER));

    let files = world
        .backend
        .read_config_files(Some(&project))
        .known()
        .unwrap();
    assert!(
        files
            .iter()
            .all(|file| !file.path.ends_with(".credentials.json") && !file.path.ends_with(".key")),
        "{files:?}"
    );
    let named = world.backend.credential_paths();
    assert!(named.contains(&world.config.join(".credentials.json")));
    assert!(named.contains(&key));
}

// ---------------------------------------------------------------------------
// History (history.ts, transcript.ts)
// ---------------------------------------------------------------------------

#[test]
fn history_comes_from_the_transcripts_read_only() {
    let world = World::new();
    let alpha = world.folder("alpha");
    let beta = world.folder("beta");
    let older = "11111111-2222-4333-8444-555555555555";
    let newer = "7b3d1c20-4a55-4f18-9c21-8e0c5a6d1f01";
    let now = now_ms();
    let projects = world.config.join("projects");
    write(
        &projects.join("a").join(format!("{older}.jsonl")),
        [
            transcript_row("user", "o1", &alpha, now - 7_200_000, json!("/recap")),
            transcript_row("user", "o2", &alpha, now - 7_100_000, json!("tidy the alpha build")),
            transcript_row(
                "assistant",
                "o3",
                &alpha,
                now - 7_000_000,
                json!([{"type": "text", "text": "Done."}, {"type": "tool_use", "name": "Bash", "input": {}}]),
            ),
            "not json\n".to_owned(),
        ]
        .concat(),
    );
    write(
        &projects.join("b").join(format!("{newer}.jsonl")),
        transcript_row("user", "n1", &beta, now - 60_000, json!("fix beta")),
    );
    // A subagent's transcript and a file that is not a conversation.
    write(
        &projects
            .join("b")
            .join(newer)
            .join("subagents")
            .join("agent-1.jsonl"),
        transcript_row("user", "s1", &beta, now, json!("sub")),
    );
    write(&projects.join("b").join("notes.jsonl"), "{}");
    let before = tree_state(&world.config);

    let conversations = world.backend.read_conversations().known().unwrap();
    assert_eq!(
        conversations
            .iter()
            .map(|c| (c.id.as_str(), c.folder.clone(), c.title.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (newer, Some(text(&beta)), "fix beta"),
            (older, Some(text(&alpha)), "tidy the alpha build"),
        ]
    );

    let transcript = world
        .backend
        .history()
        .unwrap()
        .transcript(older)
        .unwrap()
        .unwrap();
    assert_eq!(
        transcript
            .messages
            .iter()
            .map(|m| m.text.as_str())
            .collect::<Vec<_>>(),
        ["/recap", "tidy the alpha build", "Done.\n\n[tool: Bash]"]
    );
    assert!(
        world
            .backend
            .history()
            .unwrap()
            .transcript("00000000-0000-4000-8000-000000000000")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        tree_state(&world.config),
        before,
        "nothing under the config folder was written"
    );
}

#[test]
fn history_with_no_projects_folder_is_known_and_empty() {
    let world = World::new();
    assert_eq!(
        world.backend.read_conversations(),
        Knowable::Known(Vec::new())
    );
}

// ---------------------------------------------------------------------------
// Usage (usage/read.ts, shape.ts, transcripts.ts, prices.ts)
// ---------------------------------------------------------------------------

fn usage_file(world: &World, fetched_at_ms: u64, now: u64) {
    write(
        &world.config.join(".claude.json"),
        json!({
            "cachedUsageUtilization": {
                "fetchedAtMs": fetched_at_ms,
                "utilization": { "limits": [
                    { "kind": "five_hour", "group": "session", "percent": 42.0, "severity": "normal",
                      "resets_at": iso(now + 2 * 3_600_000) },
                    { "kind": "seven_day", "group": "weekly", "percent": 10.0, "severity": "warning",
                      "resets_at": iso(now + 3 * 86_400_000) },
                    { "kind": "seven_day_opus", "group": "weekly", "percent": 55.0,
                      "scope": { "model": { "display_name": "Opus" } },
                      "resets_at": iso(now + 3 * 86_400_000) },
                ]},
            },
        })
        .to_string(),
    );
}

#[test]
fn usage_reads_the_plan_windows_and_token_counts_with_dollars_as_an_estimate() {
    let world = World::new();
    let now = now_ms();
    usage_file(&world, now - 60_000, now);
    let project = world.folder("work");
    write(
        &world
            .config
            .join("projects")
            .join("w")
            .join("7b3d1c20-4a55-4f18-9c21-8e0c5a6d1f01.jsonl"),
        [
            transcript_row("user", "u1", &project, now - 120_000, json!("go")),
            transcript_row("assistant", "a1", &project, now - 110_000, json!("ok")),
            // A forked conversation repeats its parent's rows.
            transcript_row("assistant", "a1", &project, now - 110_000, json!("ok")),
        ]
        .concat(),
    );

    let snapshot = world
        .backend
        .read_usage(now, now - 3_600_000)
        .known()
        .unwrap();
    assert_eq!(snapshot.backend, floti_protocol::BackendId::claude_code());
    assert!(snapshot.problem.is_none());
    let view = usage_view(&snapshot, now);
    assert!(!view.at_least);
    assert_eq!(
        view.buckets
            .iter()
            .map(|bucket| (
                bucket.group,
                bucket.label,
                bucket.percent,
                bucket.scope.clone()
            ))
            .collect::<Vec<_>>(),
        vec![
            (UsageGroup::Session, "Session", 42.0, None),
            // The binding weekly limit is the one closest to its cap.
            (UsageGroup::Weekly, "Week", 55.0, Some("Opus".to_owned())),
        ]
    );

    let spend = snapshot.spend.expect("the transcripts were readable");
    assert_eq!(spend.priced_at, PRICE_TABLE_DATE);
    for window in [&spend.session, &spend.today, &spend.week] {
        assert_eq!(window.messages, 1);
        assert_eq!(window.tokens.input, 1000);
        assert_eq!(window.tokens.output, 100);
        // claude-opus-5 at $5 in and $25 out per million.
        assert!((window.dollars - 0.0075).abs() < 1e-12);
    }
    assert!(spend.unpriced_models.is_empty());
}

#[test]
fn a_stale_reading_of_a_running_window_is_a_lower_bound_and_a_rolled_over_one_paints_nothing() {
    let world = World::new();
    let now = now_ms();
    usage_file(&world, now - 45 * 60_000, now);
    let snapshot = world.backend.read_usage(now, now).known().unwrap();
    let view = usage_view(&snapshot, now);
    assert!(view.at_least);
    assert_eq!(view.buckets.len(), 2);

    // Roll-over is judged before age: every window has reset.
    let later = now + 4 * 86_400_000;
    let view = usage_view(&snapshot, later);
    assert!(view.buckets.is_empty());
    assert_eq!(view.problem.unwrap().kind, UsageProblemKind::RolledOver);
}

#[test]
fn usage_that_cannot_be_read_is_no_number_never_zero() {
    let world = World::new();
    let now = now_ms();
    let missing = world.backend.read_usage(now, now).known().unwrap();
    assert!(missing.limits.is_empty());
    assert_eq!(
        missing.problem.as_ref().unwrap().kind,
        UsageProblemKind::NoFile
    );
    assert!(usage_view(&missing, now).buckets.is_empty());

    write(&world.config.join(".claude.json"), "{\"cachedUsageUtil");
    let half = world.backend.read_usage(now, now).known().unwrap();
    assert_eq!(half.problem.unwrap().kind, UsageProblemKind::NotJson);

    // A projects folder that cannot be listed is no spend, not a spend of 0.
    write(&world.config.join("projects"), "not a folder");
    usage_file(&world, now - 60_000, now);
    assert!(
        world
            .backend
            .read_usage(now, now)
            .known()
            .unwrap()
            .spend
            .is_none()
    );
}

// ---------------------------------------------------------------------------
// Config files (config/tree.ts)
// ---------------------------------------------------------------------------

#[test]
fn config_files_are_the_ones_the_console_lists_with_its_summaries_and_never_a_credential() {
    let world = World::new();
    let user = &world.config;
    write(&user.join("CLAUDE.md"), "# me");
    write(&user.join("settings.json"), "{}");
    write(
        &user.join("skills").join("think").join("SKILL.md"),
        "---\nname: think\ndescription: \"Think it through\"\n---\nbody",
    );
    write(
        &user.join("commands").join("spec").join("plan.md"),
        "---\ndescription: Plan a spec\n---\n",
    );
    write(
        &user.join("agents").join("reviewer.md"),
        "---\ndescription: Reviews\n---\n",
    );
    write(
        &user.join("workflows").join("ship.js"),
        "export const meta = { name: 'release', description: 'Ship it' }\n",
    );
    write(&user.join(".credentials.json"), "{}");
    write(&user.join("sessions").join("1.json"), "{}");
    write(&user.join("sessions").join("1.abc.key"), "secret");
    write(&user.join("projects").join("p").join("x.jsonl"), "{}");
    let project = world.folder("work");
    write(&project.join("CLAUDE.md"), "# project");
    write(&project.join(".mcp.json"), "{}");
    write(&project.join(".claude").join("settings.local.json"), "{}");

    let files = world
        .backend
        .read_config_files(Some(&project))
        .known()
        .unwrap();
    let listed: Vec<(ConfigFileKind, &str, Option<&str>)> = files
        .iter()
        .map(|file| (file.kind, file.name.as_str(), file.description.as_deref()))
        .collect();
    assert_eq!(
        listed,
        vec![
            (ConfigFileKind::ClaudeMd, "CLAUDE.md", None),
            (ConfigFileKind::Settings, "settings.json", None),
            (ConfigFileKind::Skill, "think", Some("Think it through")),
            (ConfigFileKind::Command, "spec:plan", Some("Plan a spec")),
            (ConfigFileKind::Agent, "reviewer", Some("Reviews")),
            (ConfigFileKind::Workflow, "release", Some("Ship it")),
            (ConfigFileKind::ClaudeMd, "CLAUDE.md", None),
            (ConfigFileKind::SettingsLocal, "settings.local.json", None),
            (ConfigFileKind::Mcp, ".mcp.json", None),
        ]
    );
    assert!(files.iter().all(|file| !file.path.contains(".credentials")));
}

// ---------------------------------------------------------------------------
// What Claude Code declares (S17, S18)
// ---------------------------------------------------------------------------

#[test]
fn claude_code_declares_all_eight_features_and_answers_each() {
    let world = World::new();
    let descriptor = world.backend.capabilities();
    let mut all = BackendFeature::ALL.to_vec();
    all.sort();
    assert_eq!(descriptor.features, all);
    assert_eq!(descriptor.name, "Claude Code");

    let session = SessionRef {
        pid: 1,
        conversation_id: None,
    };
    assert!(world.backend.read_status(&session).is_known());
    assert!(world.backend.read_conversations().is_known());
    assert!(world.backend.read_usage(now_ms(), 0).is_known());
    assert!(world.backend.read_config_files(None).is_known());
    assert!(world.backend.read_sign_in().is_known());
    assert!(world.backend.resumer().is_some() && world.backend.agent_tools().is_some());
}

#[test]
fn claude_code_takes_every_part_of_a_harness_and_its_launch_names_nothing_it_could_not_take() {
    let world = World::new();
    let harness = world.backend.capabilities().harness;
    assert_eq!(harness.instruction_files, ["CLAUDE.md", "AGENTS.md"]);
    assert_eq!(harness.takes, HarnessPart::ALL.to_vec());
    assert!(harness.cannot_take.is_empty());

    let overlay = claude_shaped_harness(&world, "harness", "# rules\n");
    let (launch, _) = world.launch(&LaunchRequest {
        folder: world.folder("work"),
        name: "harness".into(),
        composition: Composition {
            overlays: vec![overlay],
            ..Composition::default()
        },
        ..LaunchRequest::default()
    });
    assert!(launch.not_taken.is_empty());
}

// ---------------------------------------------------------------------------
// The fake is as strict as the CLI (test/fake-agents/claude-code.mjs)
// ---------------------------------------------------------------------------

/// Runs the fake in `cwd` with `args` and nothing typed.
fn run_fake(world: &World, cwd: &Path, args: &[&str]) -> (Output, Value) {
    let spec = LaunchSpec {
        program: "node".into(),
        args: std::iter::once(fake_claude().into_os_string())
            .chain(args.iter().map(OsString::from))
            .collect(),
        cwd: cwd.to_path_buf(),
        env: vec![(
            "CLAUDE_CONFIG_DIR".into(),
            world.config.clone().into_os_string(),
        )],
        conversation_id: None,
        launch_folder: None,
    };
    world.run_spec(&spec, "/exit\n")
}

#[test]
fn the_fake_fails_as_the_cli_does_on_a_missing_file_and_reads_variadic_lists_as_its_parser_does() {
    let world = World::new();
    let work = world.folder("work");
    let missing = work.join("missing.json");

    for (flag, message) in [
        ("--mcp-config", "MCP config file not found"),
        ("--settings", "Settings file not found"),
        (
            "--append-system-prompt-file",
            "Append system prompt file not found",
        ),
    ] {
        let (output, log) = run_fake(&world, &work, &[flag, missing.to_str().unwrap()]);
        assert_eq!(output.status.code(), Some(1), "{flag}");
        assert!(
            String::from_utf8_lossy(&output.stdout).contains(message),
            "{flag}"
        );
        assert_eq!(log["exitCode"], 1);
    }

    // Without `--`, a variadic list takes the prompt as one more value.
    let (output, log) = run_fake(
        &world,
        &work,
        &["--add-dir", work.to_str().unwrap(), "hello"],
    );
    succeeded(&output);
    assert!(log["openingPrompt"].is_null(), "{log}");
    let (output, log) = run_fake(
        &world,
        &work,
        &["--add-dir", work.to_str().unwrap(), "--", "hello"],
    );
    succeeded(&output);
    assert_eq!(log["openingPrompt"], "hello");

    // An option the CLI does not know is the CLI's error, not a pass.
    let output = Command::new("node")
        .arg(fake_claude())
        .arg("--no-such-option")
        .env("CLAUDE_CONFIG_DIR", &world.config)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("error:"));
}
