//! The supervisor, driven with a fake launcher on paused Tokio time: every
//! delay, deadline and window is stepped, never waited out, and no process
//! is started.

use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use floti_protocol::channels::plugins::{
    PluginErrorCode, PluginServiceKind, PluginServiceStart, PluginServiceState,
};
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;

use super::launcher::{AcceptsFuture, ServiceChild, ServiceCommand, ServiceLauncher};
use super::supervisor::{
    BACKOFF_MAX, BACKOFF_MIN, CRASH_LIMIT, PLUGIN_VAR, PORT_VAR, SERVICE_READY, Supervisor,
    TOKEN_VAR,
};
use super::*;
use crate::plugins::manifest::ServiceSpec;
use crate::plugins::net::service::ServiceEndpoint;
use crate::plugins::secrets::NoSecrets;
use crate::testkit::TestDirs;

const PLUGIN: &str = "board";
const REVISION: u64 = 7;
const SCRIPT: &str = "service/main.mjs";

/// Longer than any delay the supervisor steps through. Time is paused, so
/// this is how far the clock may be moved, not a wait.
const VIRTUAL_PATIENCE: Duration = Duration::from_secs(600);

/// One process the fake launcher started.
struct Launched {
    program: OsString,
    args: Vec<OsString>,
    folder: PathBuf,
    env: HashMap<String, String>,
    at: Instant,
    exit: Arc<Mutex<Option<oneshot::Sender<Option<i32>>>>>,
    ended: Arc<AtomicBool>,
}

impl Launched {
    fn var(&self, name: &str) -> &str {
        self.env.get(name).map_or("", String::as_str)
    }
}

/// Starts nothing: records each launch, and says the port accepts
/// connections only while `listening`.
struct Fake {
    listening: AtomicBool,
    launches: Mutex<Vec<Launched>>,
    events: watch::Sender<u64>,
}

impl Fake {
    fn bump(&self) {
        self.events.send_modify(|count| *count += 1);
    }

    fn count(&self) -> usize {
        self.launches.lock().unwrap().len()
    }

    /// The launch at `index` exits on its own with `code`.
    fn exit(&self, index: usize, code: i32) {
        let launches = self.launches.lock().unwrap();
        let sender = launches[index].exit.lock().unwrap().take();
        if let Some(sender) = sender {
            let _ = sender.send(Some(code));
        }
    }

    fn ended(&self, index: usize) -> bool {
        self.launches.lock().unwrap()[index]
            .ended
            .load(Ordering::SeqCst)
    }

    fn with<T>(&self, index: usize, read: impl FnOnce(&Launched) -> T) -> T {
        read(&self.launches.lock().unwrap()[index])
    }
}

impl ServiceLauncher for Fake {
    fn launch(&self, command: &ServiceCommand) -> std::io::Result<ServiceChild> {
        let (send, receive) = oneshot::channel();
        let exit = Arc::new(Mutex::new(Some(send)));
        let ended = Arc::new(AtomicBool::new(false));
        let pid = {
            let mut launches = self.launches.lock().unwrap();
            launches.push(Launched {
                program: command.program.program.clone(),
                args: command.program.args.clone(),
                folder: command.folder.clone(),
                env: command
                    .env
                    .iter()
                    .map(|(name, value)| {
                        (
                            name.to_string_lossy().into_owned(),
                            value.to_string_lossy().into_owned(),
                        )
                    })
                    .collect(),
                at: Instant::now(),
                exit: Arc::clone(&exit),
                ended: Arc::clone(&ended),
            });
            u32::try_from(launches.len()).unwrap() + 1000
        };
        self.bump();
        let events = self.events.clone();
        Ok(ServiceChild {
            pid: Some(pid),
            exited: Box::pin(async move { receive.await.unwrap_or(None) }),
            end: Box::new(move || {
                ended.store(true, Ordering::SeqCst);
                if let Some(sender) = exit.lock().unwrap().take() {
                    let _ = sender.send(None);
                }
                events.send_modify(|count| *count += 1);
            }),
        })
    }

    fn accepts(&self, _port: u16) -> AcceptsFuture {
        let listening = self.listening.load(Ordering::SeqCst);
        Box::pin(async move { listening })
    }
}

struct World {
    fake: Arc<Fake>,
    services: ProcessServices,
    events: watch::Sender<u64>,
    logs: Arc<Mutex<Vec<String>>>,
    folder: PathBuf,
    /// Last: the plugin folder goes once nothing uses it.
    dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        Self::with_node(Some(PathBuf::from("/shipped/node/bin/node")))
    }

    fn with_node(node: Option<PathBuf>) -> Self {
        let dirs = TestDirs::new();
        let folder = dirs.plugin_folder("plugin board", "{}", &[(SCRIPT, "")]);
        let folder = std::fs::canonicalize(folder).unwrap();
        let (events, _) = watch::channel(0);
        let fake = Arc::new(Fake {
            listening: AtomicBool::new(true),
            launches: Mutex::new(Vec::new()),
            events: events.clone(),
        });
        let logs = Arc::new(Mutex::new(Vec::new()));
        let services = ProcessServices::new(ServicesConfig {
            node,
            secrets: Arc::new(NoSecrets),
            launcher: Arc::clone(&fake) as Arc<dyn ServiceLauncher>,
            inherited: Arc::new(|| {
                [
                    ("PATH", "/usr/bin"),
                    ("FLOTI_DATA_DIR", "/data"),
                    ("CLAUDECODE", "1"),
                    ("ELECTRON_RUN_AS_NODE", "1"),
                ]
                .iter()
                .map(|(name, value)| (OsString::from(name), OsString::from(value)))
                .collect()
            }),
            log: {
                let logs = Arc::clone(&logs);
                Arc::new(move |plugin, line| {
                    logs.lock().unwrap().push(format!("{plugin}: {line}"));
                })
            },
        });
        Self {
            fake,
            services,
            events,
            logs,
            folder,
            dirs,
        }
    }

    fn spec(kind: PluginServiceKind, command: &str, start: PluginServiceStart) -> ServiceSpec {
        ServiceSpec {
            kind,
            command: command.to_owned(),
            args: vec!["--serve".into(), "a b".into()],
            env: BTreeMap::from([
                ("GREETING".to_owned(), "hello".to_owned()),
                (TOKEN_VAR.to_owned(), "chosen by the plugin".to_owned()),
            ]),
            start,
        }
    }

    fn open(&self, spec: ServiceSpec) -> Supervisor {
        self.open_at(REVISION, spec)
    }

    fn open_at(&self, revision: u64, spec: ServiceSpec) -> Supervisor {
        let events = self.events.clone();
        self.services.open(ServicePlugin {
            plugin: PLUGIN.into(),
            revision,
            folder: self.folder.clone(),
            spec,
            secrets: Vec::new(),
            changed: Arc::new(move || events.send_modify(|count| *count += 1)),
        });
        self.services.supervisor(PLUGIN, revision).unwrap()
    }

    fn node_service(&self) -> Supervisor {
        self.open(Self::spec(
            PluginServiceKind::Node,
            SCRIPT,
            PluginServiceStart::Demand,
        ))
    }

    fn status(&self) -> ServiceStatus {
        self.services.status(PLUGIN, REVISION).unwrap_or_default()
    }

    /// Waits until `done` holds, on every change the supervisor or the fake
    /// reports; the clock moves only as far as the supervisor's own timers.
    async fn until(&self, what: &str, done: impl Fn(&Self) -> bool) {
        let mut events = self.events.subscribe();
        let waited = tokio::time::timeout(VIRTUAL_PATIENCE, async {
            loop {
                if done(self) {
                    return;
                }
                events.changed().await.unwrap();
            }
        })
        .await;
        assert!(waited.is_ok(), "never: {what}; now {:?}", self.status());
    }

    async fn until_state(&self, state: PluginServiceState) {
        self.until(&format!("{state:?}"), |world| world.status().state == state)
            .await;
    }

    async fn until_launches(&self, count: usize) {
        self.until(&format!("{count} launches"), |world| {
            world.fake.count() == count
        })
        .await;
    }

    fn logs(&self) -> Vec<String> {
        self.logs.lock().unwrap().clone()
    }
}

fn spawn_ensure(
    supervisor: &Supervisor,
) -> tokio::task::JoinHandle<Result<ServiceEndpoint, PluginCallError>> {
    let supervisor = supervisor.clone();
    tokio::spawn(async move { supervisor.ensure().await })
}

#[tokio::test(start_paused = true)]
async fn s1_a_demand_service_nothing_has_fetched_from_runs_nothing_and_shows_stopped() {
    let world = World::new();
    world.node_service();
    tokio::time::sleep(Duration::from_secs(120)).await;
    assert_eq!(world.fake.count(), 0);
    assert_eq!(world.status(), ServiceStatus::default());
    assert_eq!(world.status().pid, None);
    assert_eq!(world.status().port, None);
}

#[tokio::test(start_paused = true)]
async fn s2_the_first_fetch_starts_the_script_on_the_hosts_node_with_its_port_token_and_id() {
    let world = World::new();
    let service = world.node_service();
    let endpoint = service.ensure().await.unwrap();
    assert_eq!(world.fake.count(), 1);

    let (program, args, folder, port, token, plugin, greeting, env) = world.fake.with(0, |run| {
        (
            run.program.clone(),
            run.args.clone(),
            run.folder.clone(),
            run.var(PORT_VAR).to_owned(),
            run.var(TOKEN_VAR).to_owned(),
            run.var(PLUGIN_VAR).to_owned(),
            run.var("GREETING").to_owned(),
            run.env.clone(),
        )
    });
    assert_eq!(program, OsString::from("/shipped/node/bin/node"));
    let script = crate::plugins::exec::program::plain(
        &std::fs::canonicalize(world.folder.join(SCRIPT)).unwrap(),
    );
    assert_eq!(
        args,
        vec![
            script.into_os_string(),
            OsString::from("--serve"),
            OsString::from("a b")
        ]
    );
    assert_eq!(folder, crate::plugins::exec::program::plain(&world.folder));
    assert_eq!(plugin, PLUGIN);
    assert_eq!(greeting, "hello");
    // The token is the host's, minted for the run: 32 random bytes in hex.
    assert_eq!(token.len(), 64);
    assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_eq!(endpoint.token, token);
    assert_eq!(
        endpoint.origin.as_str(),
        format!("http://127.0.0.1:{port}/")
    );
    // The host's own variables are not the service's.
    assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
    for own in ["FLOTI_DATA_DIR", "CLAUDECODE", "ELECTRON_RUN_AS_NODE"] {
        assert!(!env.contains_key(own), "{own} reached the service");
    }

    let status = world.status();
    assert_eq!(status.state, PluginServiceState::Running);
    assert_eq!(status.pid, Some(1001));
    assert_eq!(status.port.map(|port| port.to_string()), Some(port));

    // A second fetch reaches the same run.
    assert_eq!(service.ensure().await.unwrap(), endpoint);
    assert_eq!(world.fake.count(), 1);
}

#[tokio::test(start_paused = true)]
async fn s2_fetches_made_together_start_one_process() {
    let world = World::new();
    let service = world.node_service();
    let calls: Vec<_> = (0..4).map(|_| spawn_ensure(&service)).collect();
    let mut endpoints = Vec::new();
    for call in calls {
        endpoints.push(call.await.unwrap().unwrap());
    }
    assert_eq!(world.fake.count(), 1);
    assert!(endpoints.windows(2).all(|pair| pair[0] == pair[1]));
}

#[tokio::test(start_paused = true)]
async fn s3_an_enable_service_starts_when_the_plugin_is_read_with_no_fetch() {
    let world = World::new();
    world.open(World::spec(
        PluginServiceKind::Node,
        SCRIPT,
        PluginServiceStart::Enable,
    ));
    world.until_state(PluginServiceState::Running).await;
    assert_eq!(world.fake.count(), 1);
    assert_eq!(world.fake.with(0, |run| run.var(TOKEN_VAR).len()), 64);
    assert!(!world.fake.with(0, |run| run.var(PORT_VAR).is_empty()));
}

#[tokio::test(start_paused = true)]
async fn s4_closing_the_read_ends_its_tree_and_refuses_a_waiting_fetch_as_unavailable() {
    let world = World::new();
    world.fake.listening.store(false, Ordering::SeqCst);
    let service = world.node_service();
    let waiting = spawn_ensure(&service);
    world.until_launches(1).await;

    world.services.close(PLUGIN, REVISION);
    let refused = waiting.await.unwrap().unwrap_err();
    assert_eq!(refused.code, PluginErrorCode::Unavailable);
    assert!(world.fake.ended(0));
    assert_eq!(world.services.status(PLUGIN, REVISION), None);

    // Nothing starts it again: not its own exit, not time passing.
    tokio::time::sleep(BACKOFF_MAX * 4).await;
    assert_eq!(world.fake.count(), 1);
    let after = service.ensure().await.unwrap_err();
    assert_eq!(after.code, PluginErrorCode::Unavailable);
}

#[tokio::test(start_paused = true)]
async fn s4_a_read_of_another_revision_neither_closes_nor_answers_for_this_one() {
    let world = World::new();
    let service = world.node_service();
    service.ensure().await.unwrap();
    // A disabled folder's stale read closing changes nothing.
    world.services.close(PLUGIN, REVISION - 1);
    assert!(!world.fake.ended(0));
    assert_eq!(world.services.status(PLUGIN, REVISION - 1), None);

    // A new read replaces it, ending the old run.
    world.open_at(
        REVISION + 1,
        World::spec(PluginServiceKind::Node, SCRIPT, PluginServiceStart::Demand),
    );
    assert!(world.fake.ended(0));
    assert_eq!(world.services.status(PLUGIN, REVISION), None);
}

#[tokio::test(start_paused = true)]
async fn s5_an_exit_starts_it_again_after_a_second_with_a_new_port_and_token() {
    let world = World::new();
    let service = world.node_service();
    let first = service.ensure().await.unwrap();
    let exited_at = Instant::now();
    world.fake.exit(0, 3);
    world.until_launches(2).await;

    assert_eq!(world.fake.with(1, |run| run.at) - exited_at, BACKOFF_MIN);
    world.until_state(PluginServiceState::Running).await;
    let second = service.ensure().await.unwrap();
    assert_ne!(second.token, first.token);
    assert_eq!(world.status().restarts, 1);
    assert_eq!(world.status().error, None);
    assert!(
        world
            .logs()
            .iter()
            .any(|line| line.contains("exited with code 3; starting it again in 1s"))
    );
}

#[tokio::test(start_paused = true)]
async fn s5_the_delay_doubles_to_thirty_seconds_and_starts_over_after_a_stable_run() {
    let world = World::new();
    let service = world.node_service();
    service.ensure().await.unwrap();
    // Each run lasts 20s: never stable, and never 5 exits inside a minute.
    let mut delays = Vec::new();
    for index in 0..7 {
        tokio::time::sleep(Duration::from_secs(20)).await;
        let exited_at = Instant::now();
        world.fake.exit(index, 1);
        world.until_launches(index + 2).await;
        delays.push(world.fake.with(index + 1, |run| run.at) - exited_at);
        world.until_state(PluginServiceState::Running).await;
    }
    let secs = |list: &[u64]| -> Vec<Duration> {
        list.iter().map(|secs| Duration::from_secs(*secs)).collect()
    };
    assert_eq!(delays, secs(&[1, 2, 4, 8, 16, 30, 30]));

    // A run that lasted 30s starts the backoff again from the bottom.
    tokio::time::sleep(Duration::from_secs(30)).await;
    let exited_at = Instant::now();
    world.fake.exit(7, 1);
    world.until_launches(9).await;
    assert_eq!(world.fake.with(8, |run| run.at) - exited_at, BACKOFF_MIN);
    assert_eq!(world.status().restarts, 8);
}

#[tokio::test(start_paused = true)]
async fn s5_five_exits_in_a_minute_fail_it_until_the_plugin_is_read_again() {
    let world = World::new();
    let service = world.node_service();
    service.ensure().await.unwrap();
    for index in 0..CRASH_LIMIT {
        world.until_state(PluginServiceState::Running).await;
        world.fake.exit(index, 9);
        if index + 1 < CRASH_LIMIT {
            world.until_launches(index + 2).await;
        }
    }
    world.until_state(PluginServiceState::Failed).await;
    let status = world.status();
    assert_eq!(status.pid, None);
    assert_eq!(status.port, None);
    let reason = status.error.unwrap();
    assert!(reason.contains("exited with code 9"), "{reason}");
    assert!(reason.contains("5 times in a minute"), "{reason}");

    let refused = service.ensure().await.unwrap_err();
    assert_eq!(refused.code, PluginErrorCode::Service);
    assert!(refused.message.contains("5 times in a minute"));
    tokio::time::sleep(BACKOFF_MAX * 4).await;
    assert_eq!(world.fake.count(), CRASH_LIMIT);

    // Read again, it is a new service.
    let again = world.open_at(
        REVISION + 1,
        World::spec(PluginServiceKind::Node, SCRIPT, PluginServiceStart::Demand),
    );
    again.ensure().await.unwrap();
    assert_eq!(world.fake.count(), CRASH_LIMIT + 1);
}

#[tokio::test(start_paused = true)]
async fn s5_a_service_that_does_not_listen_within_twenty_seconds_is_ended_and_counted() {
    let world = World::new();
    world.fake.listening.store(false, Ordering::SeqCst);
    let service = world.node_service();
    let waiting = spawn_ensure(&service);
    world.until_launches(1).await;
    let started = world.fake.with(0, |run| run.at);
    world.until_state(PluginServiceState::Crashed).await;
    assert_eq!(Instant::now() - started, SERVICE_READY);
    assert!(world.fake.ended(0));
    assert_eq!(world.status().restarts, 1);
    assert!(
        world
            .logs()
            .iter()
            .any(|line| line.contains("did not listen") && line.contains("within 20s")),
        "{:?}",
        world.logs()
    );

    // Its exit, which ending it caused, is not counted again; the restart
    // comes once, a second later, and the waiting fetch gets that run.
    world.fake.listening.store(true, Ordering::SeqCst);
    let endpoint = waiting.await.unwrap().unwrap();
    assert_eq!(world.fake.count(), 2);
    assert_eq!(
        world.fake.with(1, |run| run.at) - started,
        SERVICE_READY + BACKOFF_MIN
    );
    assert_eq!(
        endpoint.token,
        world.fake.with(1, |run| run.var(TOKEN_VAR).to_owned())
    );
    assert_eq!(world.status().restarts, 1);
}

#[tokio::test(start_paused = true)]
async fn s5_an_exit_from_an_older_run_changes_nothing() {
    let world = World::new();
    let service = world.node_service();
    service.ensure().await.unwrap();
    world.fake.exit(0, 1);
    world.until_launches(2).await;
    world.until_state(PluginServiceState::Running).await;
    // The first run's exit has been counted; its sender is spent. The second
    // run is ended by a close, and its late exit starts nothing.
    world.services.close(PLUGIN, REVISION);
    assert!(world.fake.ended(1));
    tokio::time::sleep(BACKOFF_MAX * 2).await;
    assert_eq!(world.fake.count(), 2);
    assert_eq!(service.status().state, PluginServiceState::Stopped);
    assert_eq!(service.status().restarts, 1);
}

#[tokio::test(start_paused = true)]
async fn s6_the_token_is_in_no_log_line_status_error_or_debug_print() {
    let world = World::new();
    let service = world.node_service();
    let endpoint = service.ensure().await.unwrap();
    world.fake.exit(0, 2);
    world.until_launches(2).await;
    world.until_state(PluginServiceState::Running).await;
    let second = service.ensure().await.unwrap();
    world.services.close(PLUGIN, REVISION);

    let tokens = [endpoint.token.clone(), second.token.clone()];
    let mut said = world.logs();
    said.push(format!("{:?}", world.status()));
    said.push(format!("{endpoint:?}"));
    said.push(format!("{second:?}"));
    said.push(format!("{:?}", service.ensure().await.unwrap_err()));
    let command = ServiceCommand {
        program: crate::platform::launcher::Program {
            program: "node".into(),
            args: Vec::new(),
            env: Vec::new(),
        },
        folder: world.folder.clone(),
        env: vec![(TOKEN_VAR.into(), tokens[0].clone().into())],
    };
    said.push(format!("{command:?}"));
    assert!(said.len() > 5);
    for line in &said {
        for token in &tokens {
            assert!(!line.contains(token.as_str()), "the token is in {line}");
        }
    }
    // What it does say: started, its port, its exit and its stop.
    assert!(
        said.iter()
            .any(|line| line.contains("started service/main.mjs, listening on 127.0.0.1:"))
    );
    assert!(said.iter().any(|line| line.ends_with(": stopped")));
}

#[tokio::test(start_paused = true)]
async fn s6_the_plugin_list_shows_state_pid_port_restarts_and_the_last_error() {
    let world = World::new();
    let service = world.node_service();
    service.ensure().await.unwrap();
    let running = world.status();
    assert_eq!(running.state, PluginServiceState::Running);
    assert!(running.pid.is_some() && running.port.is_some());

    world.fake.listening.store(false, Ordering::SeqCst);
    world.fake.exit(0, 4);
    world.until_state(PluginServiceState::Crashed).await;
    let crashed = world.status();
    assert_eq!(crashed.restarts, 1);
    assert_eq!(crashed.error.as_deref(), Some("it exited with code 4"));
    assert_eq!((crashed.pid, crashed.port), (None, None));

    world
        .until("started again", |world| world.status().pid.is_some())
        .await;
    let starting = world.status();
    assert_eq!(starting.state, PluginServiceState::Starting);
    assert_eq!(starting.pid, Some(1002));
    assert_eq!(starting.restarts, 1);
}

#[tokio::test(start_paused = true)]
async fn s7_a_script_outside_the_plugin_folder_or_missing_starts_nothing() {
    let world = World::new();
    std::fs::write(world.dirs.root().join("outside.mjs"), "").unwrap();
    for (script, sentence) in [
        (
            "../outside.mjs",
            "../outside.mjs is not a file in the plugin folder",
        ),
        (
            "missing.mjs",
            "missing.mjs is not a file in the plugin folder",
        ),
    ] {
        let service = world.open(World::spec(
            PluginServiceKind::Node,
            script,
            PluginServiceStart::Demand,
        ));
        let refused = service.ensure().await.unwrap_err();
        assert_eq!(refused.code, PluginErrorCode::Service);
        assert_eq!(refused.message, sentence);
        assert_eq!(world.status().state, PluginServiceState::Failed);
        assert_eq!(world.status().error.as_deref(), Some(sentence));
    }
    assert_eq!(world.fake.count(), 0);
}

#[tokio::test(start_paused = true)]
async fn s7_a_host_with_no_node_runtime_starts_nothing_and_says_so() {
    let world = World::with_node(None);
    let service = world.node_service();
    let refused = service.ensure().await.unwrap_err();
    assert_eq!(refused.code, PluginErrorCode::Service);
    assert_eq!(
        refused.message,
        "this host has no Node runtime to run service/main.mjs on"
    );
    assert_eq!(world.fake.count(), 0);
}

#[tokio::test(start_paused = true)]
async fn s7_a_declared_secret_that_cannot_be_filled_starts_nothing() {
    let world = World::new();
    let mut spec = World::spec(PluginServiceKind::Node, SCRIPT, PluginServiceStart::Demand);
    spec.env.insert("API_KEY".into(), "{{api-key}}".into());
    let service = world.open(spec);
    let refused = service.ensure().await.unwrap_err();
    assert_eq!(refused.code, PluginErrorCode::Service);
    assert!(
        refused.message.starts_with("the service was not started: "),
        "{}",
        refused.message
    );
    assert_eq!(world.fake.count(), 0);
}

#[tokio::test(start_paused = true)]
async fn s8_a_command_service_runs_its_program_found_as_exec_finds_it() {
    let world = World::new();
    let program = std::env::current_exe().unwrap();
    let command = program.to_string_lossy().into_owned();
    let service = world.open(World::spec(
        PluginServiceKind::Command,
        &command,
        PluginServiceStart::Demand,
    ));
    let endpoint = service.ensure().await.unwrap();
    let (ran, args, token) = world.fake.with(0, |run| {
        (
            run.program.clone(),
            run.args.clone(),
            run.var(TOKEN_VAR).to_owned(),
        )
    });
    assert_eq!(
        PathBuf::from(ran),
        crate::plugins::exec::program::find_program(&world.folder, &command).unwrap()
    );
    assert_eq!(args, vec![OsString::from("--serve"), OsString::from("a b")]);
    assert_eq!(endpoint.token, token);

    // The same restart rules.
    world.fake.exit(0, 1);
    world.until_launches(2).await;
    assert_eq!(world.status().restarts, 1);
}

#[tokio::test(start_paused = true)]
async fn s8_a_command_that_is_not_on_this_computer_starts_nothing() {
    let world = World::new();
    let service = world.open(World::spec(
        PluginServiceKind::Command,
        "no-such-program-anywhere",
        PluginServiceStart::Demand,
    ));
    let refused = service.ensure().await.unwrap_err();
    assert_eq!(refused.code, PluginErrorCode::Service);
    assert_eq!(
        refused.message,
        "no-such-program-anywhere was not found on this computer"
    );
    assert_eq!(world.fake.count(), 0);
}

#[test]
fn the_backoff_starts_and_ends_where_todays_does() {
    assert_eq!(BACKOFF_MIN, Duration::from_secs(1));
    assert_eq!(BACKOFF_MAX, Duration::from_secs(30));
    assert_eq!(SERVICE_READY, Duration::from_secs(20));
    assert_eq!(CRASH_LIMIT, 5);
}
