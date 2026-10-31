//! The host process and its sessions' lifetime, end to end: a real host on a
//! real local socket with a real store, clients speaking the protocol, and
//! the fake agent in real ptys. Some tests run the `floti` executable itself;
//! the rest run the host in this process, which is the same code.
//!
//! Every folder and socket is in a temporary tree; nothing reaches the real
//! data folders, and no real agent runs.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::agent::claude_code::ClaudeCodeSettings;
use floti_host::platform::folders::{CONFIG_DIR_VAR, DATA_DIR_VAR, LOG_DIR_VAR, RUNTIME_DIR_VAR};
use floti_host::platform::node_runtime::NODE_VAR;
use floti_host::platform::process_tree::{Native as NativeTree, ProcessTree, descendants};
use floti_host::platform::socket::{self, Endpoint, LocalSocket, Native as NativeSocket};
use floti_host::platform::startup;
use floti_host::server::{Host, HostConfig, SOCKET_NAME, unserved};
use floti_host::store::Store;
use floti_host::testkit::{
    FakeAgent, FakeAgentRecord, PATIENCE, RunningHost, TestClient, TestDirs,
    names_unserved_channel, pair_test_device,
};
use floti_host::{Error, fake_agent};
use floti_protocol::channel::{from_payload, to_payload};
use floti_protocol::channels::common::{SessionRecord, SessionStatus};
use floti_protocol::channels::host::{HostStop, HostStopReason, HostStopRequest};
use floti_protocol::channels::plugins::{
    PluginAddRequest, PluginServiceState, PluginsAdd, PluginsList,
};
use floti_protocol::channels::sessions::{
    CloseSessionRequest, HistoryRefresh, LaunchSessionRequest, ProfileDelete, ProfileExport,
    ProfileImport, ProfileList, ProfilePin, ProfileSave, ProfilesChanged, PtermOpen,
    PtermOpenRequest, PtermStreamOpen, ReadUsage, RestoreSessionsRequest, SessionClose,
    SessionExit, SessionLaunch, SessionList, SessionRestorable, SessionRestore, SessionStart,
    SessionToRestore, StartSessionRequest, UsageSnapshot,
};
use floti_protocol::channels::workspace;
use floti_protocol::message::ErrorCode;
use floti_protocol::{
    BackendId, Catalogue, ChannelKind, EventChannel, Knowable, Message, RequestChannel,
};
use jiff::Timestamp;
use jiff::tz::TimeZone;
use serde_json::{Value, json};

const TERMINAL: &[&str] = &["terminal"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A host config whose every folder is in `dirs`, running the fake agent.
fn fake_config(
    dirs: &TestDirs,
    endpoint: &Endpoint,
    agent: &FakeAgent,
    args: &[&str],
) -> HostConfig {
    HostConfig {
        run: Default::default(),
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: vec![Arc::new(agent.backend(args.iter().copied())) as Arc<dyn AgentBackend>],
        inherited_env: std::env::vars_os().collect(),
    }
}

fn start_request(folder: &Path) -> StartSessionRequest {
    StartSessionRequest {
        cwd: folder.to_string_lossy().into_owned(),
        project_path: None,
        name: None,
        backend: None,
        cols: 80,
        rows: 24,
        ..StartSessionRequest::default()
    }
}

/// One row of the sessions table, as the tests look at it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Row {
    id: i64,
    status: String,
    ended_at: Option<String>,
    exit_code: Option<i64>,
    cwd: String,
    conversation_id: Option<String>,
}

fn rows(data: &Path) -> Vec<Row> {
    let db = rusqlite::Connection::open(data.join("floti.db")).expect("open floti.db");
    let mut statement = db
        .prepare(
            "SELECT id, status, ended_at, exit_code, cwd, claude_session_id FROM sessions ORDER BY id",
        )
        .unwrap();
    statement
        .query_map([], |row| {
            Ok(Row {
                id: row.get(0)?,
                status: row.get(1)?,
                ended_at: row.get(2)?,
                exit_code: row.get(3)?,
                cwd: row.get(4)?,
                conversation_id: row.get(5)?,
            })
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

/// The processes in `pids` still running once every one has ended or
/// [`PATIENCE`] has passed, whichever comes first.
async fn running_after_patience(pids: &[u32]) -> Vec<u32> {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let alive: Vec<u32> = pids
            .iter()
            .copied()
            .filter(|pid| NativeTree.is_alive(*pid) != Knowable::Known(false))
            .collect();
        if alive.is_empty() || Instant::now() >= deadline {
            return alive;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Waits until every process in `pids` has ended.
async fn assert_all_end(pids: &[u32]) {
    let alive = running_after_patience(pids).await;
    assert!(
        alive.is_empty(),
        "processes still running after {PATIENCE:?}: {alive:?}"
    );
}

/// Ends what a test left behind, so a failure does not leave processes.
fn end_all(pids: &[u32]) {
    for pid in pids {
        let _ = NativeTree.end_tree(*pid, floti_host::platform::process_tree::Ending::Forced);
    }
}

/// The pids of a fake agent run and every child it started.
fn tree_of(agent: &FakeAgent, pid: u32) -> Vec<u32> {
    let record = agent.wait_for_record(pid, PATIENCE, |record| !record.children.is_empty());
    std::iter::once(record.pid).chain(record.children).collect()
}

/// The fake agent's run in `cwd` once it has started `count` children.
fn run_with_children_in(agent: &FakeAgent, cwd: &Path, count: usize) -> Option<FakeAgentRecord> {
    let real = resolved(cwd);
    agent.records().into_iter().find(|record| {
        (Path::new(&record.cwd) == cwd || Path::new(&record.cwd) == real)
            && record.children.len() >= count
    })
}

/// The pids of the fake agent's runs in `cwd`, its children aside; waits
/// for one.
fn run_of(agent: &FakeAgent, cwd: &Path) -> Vec<u32> {
    runs_in(agent, cwd, &[])
        .iter()
        .map(|record| record.pid)
        .collect()
}

/// The fake agent's runs in `cwd` other than `except`, its children aside;
/// waits for one.
fn runs_in(agent: &FakeAgent, cwd: &Path, except: &[u32]) -> Vec<FakeAgentRecord> {
    let deadline = Instant::now() + PATIENCE;
    // A process reports its folder with links resolved: on macOS the temp
    // folder is /var/..., and the fake logs /private/var/....
    let real = resolved(cwd);
    loop {
        let runs: Vec<FakeAgentRecord> = agent
            .records()
            .into_iter()
            .filter(|record| {
                (Path::new(&record.cwd) == cwd || Path::new(&record.cwd) == real)
                    && !except.contains(&record.pid)
                    && !record
                        .argv
                        .iter()
                        .any(|arg| arg.starts_with("--fake-sleep"))
            })
            .collect();
        if !runs.is_empty() {
            return runs;
        }
        assert!(Instant::now() < deadline, "no run in {}", cwd.display());
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The `floti host` executable, with every folder in `dirs`, and the
/// testkit's device paired with the host it will be, so a [`TestClient`] at
/// [`binary_endpoint`] is let in.
fn floti_host_command(dirs: &TestDirs) -> Command {
    pair_test_device(&binary_endpoint(dirs), &dirs.data);
    let mut command = Command::new(env!("CARGO_BIN_EXE_floti"));
    command
        .arg("host")
        .env(DATA_DIR_VAR, &dirs.data)
        .env(LOG_DIR_VAR, &dirs.logs)
        .env(CONFIG_DIR_VAR, &dirs.config)
        .env(RUNTIME_DIR_VAR, &dirs.runtime)
        // The home the host finds the agent's folder in: `HOME` on macOS and
        // Linux, `USERPROFILE` on Windows. Never the real one, whose history
        // and usage are the user's.
        .env("HOME", &dirs.home)
        .env("USERPROFILE", &dirs.home)
        .env_remove("CLAUDE_CONFIG_DIR")
        .env_remove("SSH_CONNECTION")
        .env_remove("SSH_CLIENT")
        .env_remove("SSH_TTY")
        // The shell sessions run: `%COMSPEC%` where it is set, which is
        // Windows, and otherwise this, rather than the user's own shell and
        // whatever its start-up files print.
        .env("SHELL", "/bin/sh")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    startup::stoppable(&mut command);
    command
}

/// A `floti host` executable a test started. One still running when it is
/// dropped, because the test failed before it stopped the host, is killed
/// and reaped there, and what it started goes with it, which the host
/// arranges itself. So no host outlives its test, and none holds a file
/// open in the `TestDirs` declared before it, which drops after it.
///
/// A test that ends without stopping or killing its host, and is not
/// already failing, fails saying so once the host is killed.
struct HostProcess(Option<Child>);

impl HostProcess {
    fn spawn(command: &mut Command) -> Self {
        Self(Some(command.spawn().expect("run floti host")))
    }

    /// The host's process, for a test that reads all of its output, which
    /// waits for it to exit.
    fn into_child(mut self) -> Child {
        self.0.take().expect("the host's process")
    }
}

impl std::ops::Deref for HostProcess {
    type Target = Child;

    fn deref(&self) -> &Child {
        self.0.as_ref().expect("the host's process")
    }
}

impl std::ops::DerefMut for HostProcess {
    fn deref_mut(&mut self) -> &mut Child {
        self.0.as_mut().expect("the host's process")
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        let Some(mut child) = self.0.take() else {
            return;
        };
        let running = !matches!(child.try_wait(), Ok(Some(_)));
        if running {
            let _ = child.kill();
            let _ = child.wait();
            if !std::thread::panicking() {
                panic!("the test ended without stopping its floti host, which was killed");
            }
        }
    }
}

/// Where the `floti host` executable listens with `dirs`' folders.
fn binary_endpoint(dirs: &TestDirs) -> Endpoint {
    NativeSocket.endpoint(&dirs.runtime, SOCKET_NAME)
}

/// Kills the host `child` and nothing else, as a crash takes a host down: no
/// stop runs and nothing is recorded. What the host started goes with it,
/// which the host arranges itself.
fn kill_alone(child: &mut Child) {
    let _ = child.kill();
    child.wait().expect("reap the host");
}

/// Every process the host `child` started that is still running, and every
/// process those started: its sessions' and terminals' programs, what they
/// started and, on Windows, each pseudoconsole's `conhost.exe`.
fn started_by(child: &Child) -> Vec<u32> {
    match descendants(child.id()) {
        Knowable::Known(pids) => pids,
        Knowable::Unknown => panic!("the OS would not list what the host started"),
    }
}

/// Kills the host `child` alone, then waits until every process in
/// `started` has ended with it. One still running after [`PATIENCE`] fails
/// the test, and is ended here rather than outliving it.
async fn kill_host(child: &mut Child, started: &[u32]) {
    kill_alone(child);
    let left = running_after_patience(started).await;
    if !left.is_empty() {
        end_all(&left);
        panic!("the killed host left what it started running after {PATIENCE:?}: {left:?}");
    }
}

/// Waits for `child` to exit, killing it after [`PATIENCE`], which takes
/// what it started with it.
fn wait_exit(child: &mut Child) -> ExitStatus {
    let deadline = Instant::now() + PATIENCE;
    loop {
        if let Some(status) = child.try_wait().expect("poll the host") {
            return status;
        }
        if Instant::now() >= deadline {
            kill_alone(child);
            panic!("the host did not exit within {PATIENCE:?}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn output_of(host: HostProcess) -> (String, String) {
    let output = host
        .into_child()
        .wait_with_output()
        .expect("read the host's output");
    (
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// The command line that runs the fake agent with `args`, typed at a shell
/// prompt.
fn fake_agent_command_line(agent: &FakeAgent, args: &str) -> String {
    format!("\"{}\" {args}\r", agent.exe().display())
}

fn id_of(record: &SessionRecord) -> u64 {
    record.id
}

fn has_tick(bytes: &[u8], n: u64) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let needle = format!("tick {n}");
    text.match_indices(&needle).any(|(at, _)| {
        !text[at + needle.len()..]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_digit())
    })
}

fn ticks(bytes: &[u8]) -> Vec<u64> {
    let text = String::from_utf8_lossy(bytes);
    text.split("tick ")
        .skip(1)
        .filter_map(|rest| {
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            digits.parse().ok()
        })
        .collect()
}

// ---------------------------------------------------------------------------
// S1: one executable that serves clients
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s1_floti_host_is_one_executable_that_starts_and_serves_clients() {
    let dirs = TestDirs::new();
    let exe = PathBuf::from(env!("CARGO_BIN_EXE_floti"));
    assert_eq!(
        exe.file_stem().and_then(|stem| stem.to_str()),
        Some("floti"),
        "{}",
        exe.display()
    );

    let mut host = HostProcess::spawn(&mut floti_host_command(&dirs));
    let pid = host.id();
    let endpoint = binary_endpoint(&dirs);
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    assert_eq!(client.welcome.host_version, env!("CARGO_PKG_VERSION"));
    assert!(
        client
            .welcome
            .backends
            .iter()
            .any(|backend| backend.id.as_str() == "shell"),
        "{:?}",
        client.welcome.backends
    );

    assert_eq!(client.request::<SessionList>(&()).await.unwrap(), vec![]);
    let folder = dirs.folder("a project");
    let started = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .expect("start a shell session");
    assert_eq!(started.status, SessionStatus::Running);
    assert_eq!(started.backend.as_str(), "shell");
    assert_eq!(
        client.request::<SessionList>(&()).await.unwrap(),
        vec![started.clone()]
    );

    // The launcher's launch runs on the backend it names, named uniquely
    // against the session already running in the folder.
    let launched = client
        .request::<SessionLaunch>(&LaunchSessionRequest {
            cwd: folder.to_string_lossy().into_owned(),
            project_path: None,
            name: None,
            profile_id: None,
            permission_mode: None,
            resume: None,
            backend: Some(BackendId::new("shell")),
            cols: 80,
            rows: 24,
        })
        .await
        .expect("launch a shell session");
    assert_eq!(launched.session.backend.as_str(), "shell");
    assert_eq!(launched.session.status, SessionStatus::Running);
    assert_ne!(launched.session.name, started.name);

    // Its only listener for clients is the local socket.
    let listeners = socket::network_listeners(pid).expect("list the host's sockets");
    assert!(
        listeners.is_empty(),
        "the host listens on the network: {listeners:?}"
    );

    client
        .request::<HostStop>(&HostStopRequest {
            reason: HostStopReason::Stop,
        })
        .await
        .expect("stop the host");
    assert!(wait_exit(&mut host).success());
    let (stdout, stderr) = output_of(host);
    assert!(
        stdout.contains("Floti host is listening at"),
        "{stdout}{stderr}"
    );
    assert!(stdout.contains("Floti host stopped."), "{stdout}{stderr}");
}

#[test]
fn a_test_that_fails_while_its_floti_host_runs_leaves_neither_the_host_nor_its_folders_behind() {
    let (started, ran) = std::sync::mpsc::channel();
    let failed = std::thread::spawn(move || {
        let dirs = TestDirs::new();
        let host = HostProcess::spawn(&mut floti_host_command(&dirs));
        let runtime = tokio::runtime::Runtime::new().unwrap();
        // Serving, so it has its store and socket open in the folders.
        let _client = runtime.block_on(TestClient::connect(&binary_endpoint(&dirs), TERMINAL));
        started
            .send((dirs.root().to_path_buf(), host.id()))
            .unwrap();
        panic!("a test failing while its host runs");
    })
    .join();
    assert!(failed.is_err(), "the test was meant to fail");

    let (root, pid) = ran.recv().expect("the host was started");
    assert_eq!(
        NativeTree.is_alive(pid),
        Knowable::Known(false),
        "the failed test's host {pid} is still running"
    );
    assert!(!root.exists(), "the failed test left {}", root.display());
}

// ---------------------------------------------------------------------------
// The executable's home: the agent folder it reads, and its local day
// ---------------------------------------------------------------------------

/// US Eastern as a POSIX rule, which needs no time zone database on any OS.
const EASTERN: &str = "EST5EDT,M3.2.0,M11.1.0";

fn iso(ms: u64) -> String {
    Timestamp::from_millisecond(i64::try_from(ms).unwrap())
        .unwrap()
        .to_string()
}

fn now_ms() -> u64 {
    u64::try_from(Timestamp::now().as_millisecond()).unwrap()
}

/// A conversation in Claude Code's shape under `home`: its prompt in
/// `history.jsonl`, and a transcript with one assistant message at each of
/// `assistant_at` (epoch ms).
fn claude_conversation(home: &Path, cwd: &Path, assistant_at: &[u64]) {
    let config = home.join(".claude");
    let id = "7b3d1c20-4a55-4f18-9c21-8e0c5a6d1f01";
    let asked = assistant_at
        .iter()
        .copied()
        .min()
        .unwrap_or(0)
        .saturating_sub(1_000);
    let mut transcript = format!(
        "{}\n",
        json!({
            "type": "user", "uuid": "u1", "cwd": cwd, "timestamp": iso(asked),
            "message": { "role": "user", "content": "go" },
        })
    );
    for (n, &at) in assistant_at.iter().enumerate() {
        let row = json!({
            "type": "assistant", "uuid": format!("a{n}"), "cwd": cwd, "timestamp": iso(at),
            "message": {
                "role": "assistant", "content": "ok", "model": "claude-opus-5",
                "usage": {
                    "input_tokens": 1000, "output_tokens": 100,
                    "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
                },
            },
        });
        transcript.push_str(&format!("{row}\n"));
    }
    let project = config.join("projects").join("a-project");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join(format!("{id}.jsonl")), transcript).unwrap();
    let prompt = json!({
        "display": "go", "pastedContents": {}, "timestamp": asked,
        "project": cwd, "sessionId": id,
    });
    std::fs::write(config.join("history.jsonl"), format!("{prompt}\n")).unwrap();
    std::fs::write(
        home.join(".claude.json"),
        json!({ "numStartups": 1 }).to_string(),
    )
    .unwrap();
}

async fn stop_executable(client: &mut TestClient, mut host: HostProcess) {
    client
        .request::<HostStop>(&HostStopRequest {
            reason: HostStopReason::Stop,
        })
        .await
        .expect("stop the host");
    assert!(wait_exit(&mut host).success());
}

/// Runs the executable with `dirs` and `TZ` set to `zone`, reads usage once
/// and stops it. Claude Code's reading of it.
async fn claude_usage_from_executable(dirs: &TestDirs, zone: &str) -> UsageSnapshot {
    let host = HostProcess::spawn(floti_host_command(dirs).env("TZ", zone));
    let mut client = TestClient::connect(&binary_endpoint(dirs), &[]).await;
    let readings = client.request::<ReadUsage>(&()).await.expect("read usage");
    stop_executable(&mut client, host).await;
    readings
        .into_iter()
        .find(|reading| reading.backend == BackendId::claude_code())
        .expect("Claude Code declares usage")
}

#[tokio::test(flavor = "multi_thread")]
async fn the_executable_reads_only_the_agent_folder_under_its_home() {
    let dirs = TestDirs::new();
    let cwd = dirs.folder("a project");
    claude_conversation(&dirs.home, &cwd, &[now_ms() - 60_000]);
    let config = dirs.home.join(".claude");

    let host = HostProcess::spawn(&mut floti_host_command(&dirs));
    let mut client = TestClient::connect(&binary_endpoint(&dirs), &[]).await;
    let summary = client
        .request::<HistoryRefresh>(&())
        .await
        .expect("index history");
    assert!(
        Path::new(&summary.history_file).starts_with(&config),
        "{summary:?}"
    );
    // The one conversation under the test home, and nothing of the user's.
    assert_eq!(summary.sessions, 1, "{summary:?}");
    assert_eq!(summary.prompts, 1, "{summary:?}");

    let readings = client.request::<ReadUsage>(&()).await.expect("read usage");
    let files: Vec<&str> = readings
        .iter()
        .filter(|reading| reading.backend == BackendId::claude_code())
        .map(|reading| reading.file.as_str())
        .collect();
    assert_eq!(
        files,
        vec![dirs.home.join(".claude.json").to_string_lossy()],
        "{readings:?}"
    );
    stop_executable(&mut client, host).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_executable_estimates_today_from_local_midnight_in_its_own_zone() {
    let dirs = TestDirs::new();
    let midnight = u64::try_from(
        Timestamp::now()
            .to_zoned(TimeZone::posix(EASTERN).unwrap())
            .start_of_day()
            .unwrap()
            .timestamp()
            .as_millisecond(),
    )
    .unwrap();
    // One message at local midnight, which is today's, and one the
    // millisecond before, which is the day before's.
    claude_conversation(
        &dirs.home,
        &dirs.folder("a project"),
        &[midnight - 1, midnight],
    );

    let reading = claude_usage_from_executable(&dirs, EASTERN).await;
    let spend = reading
        .spend
        .expect("a host that knows its zone estimates the spend");
    assert_eq!(spend.today.messages, 1, "{spend:?}");
    assert_eq!(spend.week.messages, 2, "{spend:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_executable_leaves_the_spend_out_when_it_cannot_tell_its_zone() {
    let dirs = TestDirs::new();
    let now = now_ms();
    claude_conversation(&dirs.home, &dirs.folder("a project"), &[now - 60_000]);
    std::fs::write(
        dirs.home.join(".claude.json"),
        json!({
            "numStartups": 1,
            "cachedUsageUtilization": {
                "fetchedAtMs": now - 60_000,
                "utilization": { "limits": [
                    { "kind": "session", "group": "session", "percent": 51,
                      "resets_at": iso(now + 3_600_000) },
                ]},
            },
        })
        .to_string(),
    )
    .unwrap();

    let reading = claude_usage_from_executable(&dirs, "Not/A_Zone").await;
    assert_eq!(reading.spend, None, "{reading:?}");
    assert_eq!(reading.limits.len(), 1, "{reading:?}");
    assert_eq!(reading.problem, None, "{reading:?}");
}

// ---------------------------------------------------------------------------
// S5: refused from SSH, before anything is opened
// ---------------------------------------------------------------------------

#[test]
fn s5_floti_host_started_from_ssh_refuses_in_one_sentence_and_opens_nothing() {
    let dirs = TestDirs::new();
    // Folders that do not exist yet: the host must not make them.
    let untouched = dirs.root().join("never made");
    let mut command = floti_host_command(&dirs);
    command
        .env(DATA_DIR_VAR, untouched.join("data"))
        .env(LOG_DIR_VAR, untouched.join("logs"))
        .env(CONFIG_DIR_VAR, untouched.join("config"))
        .env(RUNTIME_DIR_VAR, untouched.join("run"))
        .env("SSH_CONNECTION", "203.0.113.9 50022 192.0.2.1 22");
    let output = command.output().expect("run floti host");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    let lines: Vec<&str> = stderr.lines().collect();
    assert_eq!(lines.len(), 1, "{stderr}");
    assert!(
        lines[0].contains("The Floti host starts at your sign-in, not from an SSH session"),
        "{stderr}"
    );
    assert_eq!(lines[0].matches(". ").count(), 0, "one sentence: {stderr}");
    assert!(
        !untouched.exists(),
        "the refused host made {}",
        untouched.display()
    );
    // No socket: nothing answers where it would have listened.
    let endpoint = NativeSocket.endpoint(&untouched.join("run"), SOCKET_NAME);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    assert!(runtime.block_on(NativeSocket.connect(&endpoint)).is_err());
}

// ---------------------------------------------------------------------------
// S8: one host per data folder and socket
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s8_a_second_floti_host_exits_saying_one_is_running_and_the_first_keeps_serving() {
    let dirs = TestDirs::new();
    let mut first = HostProcess::spawn(&mut floti_host_command(&dirs));
    let endpoint = binary_endpoint(&dirs);
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let folder = dirs.folder("a project");
    let session = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();

    let second = floti_host_command(&dirs)
        .output()
        .expect("run a second host");
    assert!(!second.status.success());
    let stderr = String::from_utf8_lossy(&second.stderr);
    assert!(
        stderr.contains("A Floti host is already running for this user"),
        "{stderr}"
    );

    // The first still serves the client it had, and new ones.
    assert_eq!(
        client.request::<SessionList>(&()).await.unwrap(),
        vec![session.clone()]
    );
    let mut later = TestClient::connect(&endpoint, TERMINAL).await;
    assert_eq!(
        later.request::<SessionList>(&()).await.unwrap(),
        vec![session]
    );

    later
        .request::<HostStop>(&HostStopRequest {
            reason: HostStopReason::Stop,
        })
        .await
        .unwrap();
    assert!(wait_exit(&mut first).success());
}

#[tokio::test(flavor = "multi_thread")]
async fn s8_a_second_host_on_the_same_data_folder_is_refused_without_taking_its_socket() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let first = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &[]));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let folder = dirs.folder("a project");
    let session = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();

    let other_endpoint = dirs.endpoint();
    let refused = Host::start(fake_config(&dirs, &other_endpoint, &agent, &[]))
        .err()
        .expect("a second host on the same data folder is refused");
    assert!(
        matches!(&refused, Error::Refused(why) if why.contains("already running")),
        "{refused}"
    );
    // It did not take its socket: the endpoint is still free.
    drop(
        NativeSocket
            .bind(&other_endpoint)
            .expect("the endpoint is free"),
    );

    assert_eq!(
        client.request::<SessionList>(&()).await.unwrap(),
        vec![session]
    );
    first.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s8_a_second_host_on_the_same_socket_is_refused_without_opening_floti_db() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let first = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &[]));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;

    let other = TestDirs::new();
    let refused = Host::start(fake_config(&other, &endpoint, &agent, &[]))
        .err()
        .expect("a second host on the same socket is refused");
    assert!(
        matches!(&refused, Error::Refused(why) if why.contains("already running")),
        "{refused}"
    );
    assert!(
        !other.data.join("floti.db").exists(),
        "the refused host opened floti.db"
    );

    assert_eq!(client.request::<SessionList>(&()).await.unwrap(), vec![]);
    first.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S10: sessions outlive their clients
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s10_a_session_outlives_every_client_and_a_later_client_finds_and_attaches_to_it() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &["--fake-tick=100"]));
    let folder = dirs.folder("a project");

    let mut first = TestClient::connect(&endpoint, TERMINAL).await;
    let session = first
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    first.attach(1, session.id).await;
    first.type_into(1, b"hello\r").await;
    let seen = first
        .read_stream_until(1, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: hello")
        })
        .await;
    let last_seen = ticks(&seen).into_iter().max().unwrap_or(0);
    drop(first);

    // Nobody is attached; the program keeps running and writing.
    let pid = run_of(&agent, &folder)[0];
    let deadline = Instant::now() + PATIENCE;
    while agent.ticks(pid).unwrap_or(0) < last_seen + 4 {
        assert!(
            Instant::now() < deadline,
            "tick {} unwritten within {PATIENCE:?}; the last was {:?}",
            last_seen + 4,
            agent.ticks(pid)
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(NativeTree.is_alive(pid), Knowable::Known(true));

    let mut later = TestClient::connect(&endpoint, TERMINAL).await;
    let listed = later.request::<SessionList>(&()).await.unwrap();
    assert_eq!(
        listed.iter().map(id_of).collect::<Vec<_>>(),
        vec![session.id]
    );
    assert_eq!(listed[0].status, SessionStatus::Running);
    later.attach(7, session.id).await;
    // Ticks written while no client was attached arrive with the screen,
    // then the live output follows.
    let bytes = later
        .read_stream_until(7, |bytes| {
            (last_seen + 1..=last_seen + 4).all(|n| has_tick(bytes, n))
                && has_tick(bytes, last_seen + 10)
        })
        .await;
    assert!(String::from_utf8_lossy(&bytes).contains("echo: hello"));
    later.type_into(7, b"again\r").await;
    later
        .read_stream_until(7, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: again")
        })
        .await;
    let record = agent.wait_for_record(pid, PATIENCE, |record| record.input.len() == 2);
    assert_eq!(record.input, ["hello", "again"]);

    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S11: stopping the host ends every tree and records the rows exited
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s11_a_stop_from_a_client_ends_every_tree_records_rows_exited_and_offers_none() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &["--fake-child"]));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let folders = [dirs.folder("project one"), dirs.folder("project two")];
    let mut pids = Vec::new();
    for folder in &folders {
        client
            .request::<SessionStart>(&start_request(folder))
            .await
            .unwrap();
        pids.extend(tree_of(&agent, run_of(&agent, folder)[0]));
    }
    assert_eq!(pids.len(), 4, "two agents, each with a child");

    client
        .request::<HostStop>(&HostStopRequest {
            reason: HostStopReason::Stop,
        })
        .await
        .expect("the stop is answered");
    assert!(client.wait_closed(PATIENCE).await, "the connection closes");
    assert_eq!(host.stopped().await, HostStopReason::Stop);
    assert_all_end(&pids).await;

    let after = rows(&dirs.data);
    assert_eq!(after.len(), 2);
    for row in &after {
        assert_eq!(row.status, "exited", "{row:?}");
        assert!(row.ended_at.is_some(), "{row:?}");
    }

    let again = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &[]));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    assert_eq!(
        client.request::<SessionRestorable>(&()).await.unwrap(),
        None
    );
    assert_eq!(client.request::<SessionList>(&()).await.unwrap(), vec![]);
    assert_eq!(rows(&dirs.data), after, "the next start changes no row");
    again.stop(HostStopReason::Stop).await;
}

/// Starts the `floti` executable with a shell session running the fake
/// agent and its child, then stops it with `signal` and checks what S11
/// says.
async fn stop_floti_host_with(signal: fn(u32) -> std::io::Result<()>) {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let (log_var, log_dir) = agent.log_env();
    let mut host = HostProcess::spawn(floti_host_command(&dirs).env(log_var, log_dir));
    let endpoint = binary_endpoint(&dirs);
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let folder = dirs.folder("a project");
    let session = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    client.attach(1, session.id).await;
    // The shell's prompt first, so what is typed reaches a shell reading it.
    client.read_stream_until(1, |bytes| !bytes.is_empty()).await;
    client
        .type_into(
            1,
            fake_agent_command_line(&agent, "--fake-child").as_bytes(),
        )
        .await;
    let has_child = || {
        agent
            .records()
            .into_iter()
            .find(|record| !record.children.is_empty())
    };
    client.read_stream_until(1, |_| has_child().is_some()).await;
    let record = has_child().expect("the shell ran the fake agent");
    let pids: Vec<u32> = std::iter::once(record.pid).chain(record.children).collect();

    signal(host.id()).expect("signal the host");
    let status = wait_exit(&mut host);
    let (stdout, stderr) = output_of(host);
    if !status.success() {
        end_all(&pids);
        panic!("the host exited with {status}: {stdout}{stderr}");
    }
    assert!(
        stdout.contains("Floti host is stopping"),
        "{stdout}{stderr}"
    );
    assert_all_end(&pids).await;

    let after = rows(&dirs.data);
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].status, "exited", "{after:?}");
    assert!(after[0].ended_at.is_some(), "{after:?}");

    let again = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &[]));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    assert_eq!(
        client.request::<SessionRestorable>(&()).await.unwrap(),
        None
    );
    again.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s11_ctrl_c_ends_every_tree_and_records_rows_exited() {
    stop_floti_host_with(startup::interrupt).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s11_sigterm_ends_every_tree_and_records_rows_exited() {
    stop_floti_host_with(startup::terminate).await;
}

// ---------------------------------------------------------------------------
// A host that ends with the program that started it
// ---------------------------------------------------------------------------

/// `floti host --until-stdin-closes` with every folder in `dirs`, its
/// standard input a pipe the test holds.
fn host_until_stdin_closes(dirs: &TestDirs) -> HostProcess {
    HostProcess::spawn(
        floti_host_command(dirs)
            .arg("--until-stdin-closes")
            .stdin(Stdio::piped()),
    )
}

/// Starts a shell session in a new folder through `client`, and every
/// process the host `child` has started once it has started one.
async fn a_session_and_its_processes(
    dirs: &TestDirs,
    client: &mut TestClient,
    child: &Child,
) -> (SessionRecord, Vec<u32>) {
    let folder = dirs.folder("a project");
    let session = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    let deadline = Instant::now() + PATIENCE;
    loop {
        let started = started_by(child);
        if !started.is_empty() {
            return (session, started);
        }
        assert!(
            Instant::now() < deadline,
            "the host started nothing for its session within {PATIENCE:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn s16_a_host_asked_to_stop_before_its_stdin_closes_stops_as_a_plain_stop() {
    let dirs = TestDirs::new();
    let mut host = host_until_stdin_closes(&dirs);
    let mut client = TestClient::connect(&binary_endpoint(&dirs), TERMINAL).await;
    let (_, pids) = a_session_and_its_processes(&dirs, &mut client, &host).await;

    client
        .request::<HostStop>(&HostStopRequest {
            reason: HostStopReason::Stop,
        })
        .await
        .expect("the stop is answered");
    drop(host.stdin.take());
    let status = wait_exit(&mut host);
    let (stdout, stderr) = output_of(host);
    assert!(status.success(), "{status}: {stdout}{stderr}");
    assert!(
        stdout
            .lines()
            .next()
            .is_some_and(|line| line.starts_with("Floti host is listening at ")),
        "{stdout}{stderr}"
    );
    assert!(stdout.contains("Floti host stopped."), "{stdout}{stderr}");
    assert!(
        !stdout.contains("the program that started it"),
        "{stdout}{stderr}"
    );
    assert_all_end(&pids).await;
    let after = rows(&dirs.data);
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].status, "exited", "{after:?}");
    assert!(after[0].ended_at.is_some(), "{after:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn s16_a_host_whose_stdin_closes_ends_every_tree_and_its_next_start_offers_the_sessions_once()
{
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let mut host = host_until_stdin_closes(&dirs);
    let endpoint = binary_endpoint(&dirs);
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let (session, pids) = a_session_and_its_processes(&dirs, &mut client, &host).await;

    drop(host.stdin.take());
    assert!(client.wait_closed(PATIENCE).await, "the connection closes");
    let status = wait_exit(&mut host);
    let (stdout, stderr) = output_of(host);
    assert!(status.success(), "{status}: {stdout}{stderr}");
    assert!(
        stdout
            .lines()
            .next()
            .is_some_and(|line| line.starts_with("Floti host is listening at ")),
        "{stdout}{stderr}"
    );
    assert!(
        stdout.contains("Floti host is stopping: the program that started it has gone."),
        "{stdout}{stderr}"
    );
    assert!(!stdout.contains("Floti host stopped."), "{stdout}{stderr}");
    assert_all_end(&pids).await;
    assert_eq!(rows(&dirs.data)[0].status, "running");

    let again = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &[]));
    let mut first = TestClient::connect(&endpoint, TERMINAL).await;
    let offer = first
        .request::<SessionRestorable>(&())
        .await
        .unwrap()
        .expect("the sessions are offered back");
    assert_eq!(
        offer
            .sessions
            .iter()
            .map(|lost| lost.id)
            .collect::<Vec<_>>(),
        [session.id]
    );
    assert_eq!(rows(&dirs.data)[0].status, "lost");
    assert_eq!(first.request::<SessionList>(&()).await.unwrap(), vec![]);
    first
        .request::<SessionRestore>(&RestoreSessionsRequest { sessions: vec![] })
        .await
        .unwrap();
    let mut second = TestClient::connect(&endpoint, TERMINAL).await;
    assert_eq!(
        second.request::<SessionRestorable>(&()).await.unwrap(),
        None,
        "offered once"
    );
    again.stop(HostStopReason::Stop).await;
}

/// A host that goes away without a stop, as one whose run a panic dropped
/// does, still ends every process it started. Its rows are left running, as
/// a stop for an update leaves them, for the next start to offer.
#[test]
fn a_host_dropped_without_a_stop_ends_every_tree_it_started() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let folder = dirs.folder("a project");
    let runtime = tokio::runtime::Runtime::new().expect("a runtime");
    let pids = runtime.block_on(async {
        let host = Host::start(fake_config(&dirs, &endpoint, &agent, &["--fake-child"]))
            .expect("start the host");
        tokio::spawn(host.run_until_stopped());
        let mut client = TestClient::connect(&endpoint, TERMINAL).await;
        client
            .request::<SessionStart>(&start_request(&folder))
            .await
            .unwrap();
        tree_of(&agent, run_of(&agent, &folder)[0])
    });
    let ended = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // Its run and every task holding it go with the runtime, unstopped.
        drop(runtime);
        tokio::runtime::Runtime::new()
            .expect("a runtime")
            .block_on(assert_all_end(&pids));
    }));
    end_all(&pids);
    if let Err(panic) = ended {
        std::panic::resume_unwind(panic);
    }
    let after = rows(&dirs.data);
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].status, "running", "{after:?}");
}

/// What a host test that never stopped its host left: how it failed, its
/// temporary root and every process its session started.
struct UnstoppedHostTest {
    panic: Box<dyn std::any::Any + Send>,
    root: PathBuf,
    pids: Vec<u32>,
}

const ON_PURPOSE: &str = "the host test failed on purpose";

/// Runs, on `runtime`, a host test that starts a host over its temporary
/// folders, connects a client and starts a session whose process and child
/// run in one of those folders, then never stops the host: it panics when
/// `panics` is set and otherwise just ends. Its locals drop as any test's do,
/// the host before its `TestDirs`.
fn run_unstopped_host_test(runtime: tokio::runtime::Runtime, panics: bool) -> UnstoppedHostTest {
    let seen = std::sync::Mutex::new((None::<PathBuf>, Vec::<u32>::new()));
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        runtime.block_on(async {
            let dirs = TestDirs::new();
            seen.lock().unwrap().0 = Some(dirs.root().to_path_buf());
            let agent = fake_agent!(&dirs);
            let endpoint = dirs.endpoint();
            let folder = dirs.folder("a project");
            let mut config = fake_config(&dirs, &endpoint, &agent, &["--fake-child"]);
            config
                .inherited_env
                .retain(|(key, _)| key != std::ffi::OsStr::new("SHELL"));
            config
                .inherited_env
                .push(("SHELL".into(), "/bin/sh".into()));
            let _host = RunningHost::start(config);
            let mut client = TestClient::connect(&endpoint, TERMINAL).await;
            client
                .request::<SessionStart>(&start_request(&folder))
                .await
                .unwrap();
            seen.lock().unwrap().1 = tree_of(&agent, run_of(&agent, &folder)[0]);
            if panics {
                panic!("{ON_PURPOSE}");
            }
        });
    }));
    drop(runtime);
    let (root, pids) = seen.into_inner().unwrap();
    UnstoppedHostTest {
        panic: outcome.expect_err("a host test that never stops its host fails"),
        root: root.expect("the test made its folders"),
        pids,
    }
}

/// The panic's message, whether it was formatted or not.
fn panic_message(panic: &(dyn std::any::Any + Send)) -> &str {
    panic
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| panic.downcast_ref::<&str>().copied())
        .expect("the failure is a message")
}

/// Checks that `test` left no folder and no process behind, ending any
/// process it left so the check itself leaves nothing.
fn assert_nothing_left(test: &UnstoppedHostTest) {
    assert!(!test.pids.is_empty(), "the session's processes were seen");
    let alive = tokio::runtime::Runtime::new()
        .expect("a runtime")
        .block_on(running_after_patience(&test.pids));
    end_all(&test.pids);
    let root_left = test.root.exists();
    if root_left {
        let _ = std::fs::remove_dir_all(&test.root);
    }
    assert!(alive.is_empty(), "processes still running: {alive:?}");
    assert!(!root_left, "{} was left behind", test.root.display());
}

fn current_thread_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime")
}

fn multi_thread_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("a runtime")
}

fn assert_a_panicking_host_test_leaves_nothing_behind(runtime: tokio::runtime::Runtime) {
    let test = run_unstopped_host_test(runtime, true);
    assert_nothing_left(&test);
    assert_eq!(panic_message(&*test.panic), ON_PURPOSE);
}

fn assert_an_unstopped_host_test_fails_after_leaving_nothing_behind(
    runtime: tokio::runtime::Runtime,
) {
    let test = run_unstopped_host_test(runtime, false);
    assert_nothing_left(&test);
    let message = panic_message(&*test.panic);
    assert!(
        message.starts_with("the test did not stop its host"),
        "{message}"
    );
}

#[test]
fn a_host_test_that_panics_on_a_single_threaded_runtime_fails_with_its_own_message_and_leaves_nothing_behind()
 {
    assert_a_panicking_host_test_leaves_nothing_behind(current_thread_runtime());
}

#[test]
fn a_host_test_that_panics_on_a_multi_threaded_runtime_fails_with_its_own_message_and_leaves_nothing_behind()
 {
    assert_a_panicking_host_test_leaves_nothing_behind(multi_thread_runtime());
}

#[test]
fn a_host_test_on_a_single_threaded_runtime_that_never_stops_its_host_leaves_nothing_behind_and_still_fails()
 {
    assert_an_unstopped_host_test_fails_after_leaving_nothing_behind(current_thread_runtime());
}

#[test]
fn a_host_test_on_a_multi_threaded_runtime_that_never_stops_its_host_leaves_nothing_behind_and_still_fails()
 {
    assert_an_unstopped_host_test_fails_after_leaving_nothing_behind(multi_thread_runtime());
}

/// A host that is killed, with no stop and nothing recorded, takes with it
/// every process its sessions and plain terminals started, as a stop does:
/// their programs, each terminal's own host process, and what the programs
/// started, among them a program with no console, which on Windows the
/// pseudoconsole closing does not reach.
#[tokio::test(flavor = "multi_thread")]
async fn a_killed_floti_host_takes_every_process_its_sessions_and_terminals_started_with_it() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let (log_var, log_dir) = agent.log_env();
    let mut host = HostProcess::spawn(floti_host_command(&dirs).env(log_var, log_dir));
    let mut client = TestClient::connect(&binary_endpoint(&dirs), TERMINAL).await;

    // A session: the shell, running the fake agent, which starts a child on
    // its console and one with none.
    let in_session = dirs.folder("a project");
    let session = client
        .request::<SessionStart>(&start_request(&in_session))
        .await
        .unwrap();
    client.attach(1, session.id).await;
    client.read_stream_until(1, |bytes| !bytes.is_empty()).await;
    client
        .type_into(
            1,
            fake_agent_command_line(&agent, "--fake-child --fake-gui-child").as_bytes(),
        )
        .await;
    client
        .read_stream_until(1, |_| {
            run_with_children_in(&agent, &in_session, 2).is_some()
        })
        .await;

    // A plain terminal running the fake agent itself, told to do the same.
    let in_terminal = dirs.folder("another project");
    let terminal = client
        .request::<PtermOpen>(&PtermOpenRequest {
            path: in_terminal.to_string_lossy().into_owned(),
            cols: 80,
            rows: 24,
            shell: Some(agent.exe().to_string_lossy().into_owned()),
            separate: false,
        })
        .await
        .unwrap();
    assert_eq!(terminal.problem, None, "{terminal:?}");
    client
        .open_on(
            2,
            "pterm:data",
            to_payload(&PtermStreamOpen { id: terminal.id }).unwrap(),
        )
        .await;
    client.type_into(2, b"/child\r/gui-child\r").await;
    client
        .read_stream_until(2, |_| {
            run_with_children_in(&agent, &in_terminal, 2).is_some()
        })
        .await;

    let started = started_by(&host);
    for folder in [&in_session, &in_terminal] {
        let run = run_with_children_in(&agent, folder, 2).expect("the fake agent started both");
        for pid in std::iter::once(run.pid).chain(run.children) {
            assert!(
                started.contains(&pid),
                "{pid} is not among what the host started: {started:?}"
            );
        }
    }
    drop(client);

    kill_host(&mut host, &started).await;
}

/// The owner watch every fake uses, put beside a plugin's service script.
const FAKE_COMMON: &str = include_str!("../../../test/fake-agents/common.mjs");

/// A plugin service that listens on the port it is told and starts a child
/// of its own; both exit once the test process is gone.
const LISTENING_SERVICE: &str = r"
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { childScript, watchOwner } from './common.mjs'

watchOwner(process.cwd(), () => process.exit(0))
spawn(process.execPath, ['-e', childScript(process.cwd())], { stdio: 'ignore' })
createServer((request, response) => response.end('ok'))
  .listen(Number(process.env.HELM_SERVICE_PORT), '127.0.0.1')
";

/// The Node running these tests: the first `node` on `PATH`.
fn node_on_path() -> PathBuf {
    let path = std::env::var_os("PATH").expect("PATH is set");
    std::env::split_paths(&path)
        .flat_map(|dir| [dir.join("node.exe"), dir.join("node")])
        .find(|candidate| candidate.is_file())
        .expect("the tests run with Node on PATH")
}

/// A host that is killed takes a plugin's service with it, as a stop does:
/// the service, run on the Node `FLOTI_NODE` names, and what it started.
#[tokio::test(flavor = "multi_thread")]
async fn a_killed_floti_host_takes_a_plugins_service_run_on_the_node_floti_node_names_with_it() {
    let dirs = TestDirs::new();
    let mut host = HostProcess::spawn(floti_host_command(&dirs).env(NODE_VAR, node_on_path()));
    let mut client = TestClient::connect(&binary_endpoint(&dirs), &[]).await;
    let manifest = json!({
        "apiVersion": 2,
        "id": "eager",
        "name": "Eager",
        "service": { "node": "service.mjs", "start": "enable" },
    });
    let folder = dirs.plugin_folder(
        "plugin eager",
        &manifest.to_string(),
        &[
            ("service.mjs", LISTENING_SERVICE),
            ("common.mjs", FAKE_COMMON),
        ],
    );
    client
        .request::<PluginsAdd>(&PluginAddRequest {
            path: folder.to_string_lossy().into_owned(),
        })
        .await
        .unwrap();

    // It starts with the plugin, with no fetch, and listens.
    let deadline = Instant::now() + PATIENCE;
    let service = loop {
        let listed = client.request::<PluginsList>(&()).await.unwrap();
        let service = listed
            .into_iter()
            .find_map(|plugin| plugin.service)
            .expect("the plugin declares a service");
        if service.state == PluginServiceState::Running {
            break service;
        }
        assert!(
            Instant::now() < deadline,
            "the service never ran: {service:?}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let pid = service.pid.expect("a running service has a pid");
    let started = started_by(&host);
    assert!(
        started.contains(&pid),
        "{pid} is not among what the host started: {started:?}"
    );
    assert!(
        started.len() >= 2,
        "the service's own child is among them: {started:?}"
    );
    drop(client);

    kill_host(&mut host, &started).await;
}

// ---------------------------------------------------------------------------
// S12: an update or a kill leaves sessions lost, offered once
// ---------------------------------------------------------------------------

/// Starts sessions in `folders` on a fake-agent host, stops it for an
/// update and returns their rows' ids and the agents' process trees.
async fn sessions_stopped_for_an_update(
    dirs: &TestDirs,
    endpoint: &Endpoint,
    agent: &FakeAgent,
    folders: &[PathBuf],
) -> Vec<SessionRecord> {
    let host = RunningHost::start(fake_config(dirs, endpoint, agent, &["--fake-child"]));
    let mut client = TestClient::connect(endpoint, TERMINAL).await;
    let mut started = Vec::new();
    let mut pids = Vec::new();
    for folder in folders {
        started.push(
            client
                .request::<SessionStart>(&start_request(folder))
                .await
                .unwrap(),
        );
        pids.extend(tree_of(agent, run_of(agent, folder)[0]));
    }
    client
        .request::<HostStop>(&HostStopRequest {
            reason: HostStopReason::Update,
        })
        .await
        .unwrap();
    assert_eq!(host.stopped().await, HostStopReason::Update);
    // The sessions end with the host, whole trees included...
    assert_all_end(&pids).await;
    // ...but their rows are left for the next start.
    assert!(
        rows(&dirs.data).iter().all(|row| row.status == "running"),
        "{:?}",
        rows(&dirs.data)
    );
    started
}

#[tokio::test(flavor = "multi_thread")]
async fn s12_after_a_stop_for_an_update_the_next_start_offers_the_sessions_once_and_starts_none() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let folders = [dirs.folder("project one"), dirs.folder("project two")];
    let started = sessions_stopped_for_an_update(&dirs, &endpoint, &agent, &folders).await;
    let runs_before = agent.records().len();

    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &[]));
    let mut first = TestClient::connect(&endpoint, TERMINAL).await;
    let offer = first
        .request::<SessionRestorable>(&())
        .await
        .unwrap()
        .expect("the lost sessions are offered");
    assert_eq!(
        offer
            .sessions
            .iter()
            .map(|lost| lost.id)
            .collect::<Vec<_>>(),
        started.iter().map(id_of).collect::<Vec<_>>()
    );
    for (lost, folder) in offer.sessions.iter().zip(&folders) {
        assert_eq!(lost.cwd, folder.to_string_lossy());
        assert_eq!(lost.blocked, None, "{lost:?}");
    }
    assert!(rows(&dirs.data).iter().all(|row| row.status == "lost"));
    // Nothing was started by itself.
    assert_eq!(first.request::<SessionList>(&()).await.unwrap(), vec![]);
    assert_eq!(agent.records().len(), runs_before);

    // Every client that connects is offered it until one answers.
    let mut second = TestClient::connect(&endpoint, TERMINAL).await;
    assert_eq!(
        second.request::<SessionRestorable>(&()).await.unwrap(),
        Some(offer)
    );
    let answer = second
        .request::<SessionRestore>(&RestoreSessionsRequest { sessions: vec![] })
        .await
        .unwrap();
    assert!(answer.restored.is_empty() && answer.failed.is_empty());
    assert_eq!(first.request::<SessionRestorable>(&()).await.unwrap(), None);
    assert_eq!(agent.records().len(), runs_before);
    host.stop(HostStopReason::Stop).await;

    // Not offered again at the next start either.
    let again = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &[]));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    assert_eq!(
        client.request::<SessionRestorable>(&()).await.unwrap(),
        None
    );
    again.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s12_after_floti_host_is_killed_the_next_start_offers_its_sessions_and_starts_none() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let mut host = HostProcess::spawn(&mut floti_host_command(&dirs));
    let endpoint = binary_endpoint(&dirs);
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let folder = dirs.folder("a project");
    let session = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    drop(client);

    // Killed: no stop, nothing recorded, and nothing it started left running.
    let started = started_by(&host);
    kill_host(&mut host, &started).await;
    assert_eq!(rows(&dirs.data)[0].status, "running");

    let again = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &[]));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let offer = client
        .request::<SessionRestorable>(&())
        .await
        .unwrap()
        .expect("the killed host's session is offered");
    assert_eq!(offer.sessions.len(), 1);
    assert_eq!(offer.sessions[0].id, session.id);
    // A shell session has no conversation to reopen, and the offer says so
    // before anything runs.
    assert!(offer.sessions[0].blocked.is_some(), "{offer:?}");
    assert_eq!(rows(&dirs.data)[0].status, "lost");
    assert_eq!(client.request::<SessionList>(&()).await.unwrap(), vec![]);
    assert!(agent.records().is_empty(), "nothing was started");
    again.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S13: restore relaunches what was chosen through the backend's resume
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s13_restoring_some_sessions_resumes_each_in_its_recorded_folder_and_answers_the_offer() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let folders = [
        dirs.folder("project one"),
        dirs.folder("project two"),
        dirs.folder("project three"),
    ];
    let started = sessions_stopped_for_an_update(&dirs, &endpoint, &agent, &folders).await;
    let runs_before: Vec<u32> = agent.records().iter().map(|record| record.pid).collect();

    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &[]));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    assert!(
        client
            .request::<SessionRestorable>(&())
            .await
            .unwrap()
            .is_some()
    );
    let chosen = [&started[0], &started[2]];
    let result = client
        .request::<SessionRestore>(&RestoreSessionsRequest {
            sessions: chosen
                .iter()
                .map(|record| SessionToRestore {
                    id: record.id,
                    cols: 100,
                    rows: 30,
                })
                .collect(),
        })
        .await
        .unwrap();
    assert!(result.failed.is_empty(), "{:?}", result.failed);
    assert_eq!(
        result
            .restored
            .iter()
            .map(|restored| restored.from)
            .collect::<Vec<_>>(),
        chosen.iter().map(|record| record.id).collect::<Vec<_>>()
    );

    // Each runs through the backend's resume, in the folder its row recorded.
    for (restored, original) in result.restored.iter().zip(chosen) {
        let session = &restored.launched.session;
        assert_eq!(session.status, SessionStatus::Running);
        assert_eq!(session.cwd, original.cwd);
        assert_eq!(session.conversation_id, original.conversation_id);
        let conversation = original.conversation_id.clone().expect("a conversation id");
        let runs = runs_in(&agent, Path::new(&original.cwd), &runs_before);
        assert_eq!(runs.len(), 1, "{runs:?}");
        assert_eq!(runs[0].argv, ["--resume".to_owned(), conversation]);
    }
    // None it was not asked for.
    let new_runs = agent
        .records()
        .into_iter()
        .filter(|record| !runs_before.contains(&record.pid))
        .filter(|record| {
            !record
                .argv
                .iter()
                .any(|arg| arg.starts_with("--fake-sleep"))
        })
        .count();
    assert_eq!(new_runs, 2);
    assert_eq!(client.request::<SessionList>(&()).await.unwrap().len(), 2);

    // The offer is answered: not offered again, and a second answer
    // reopens nothing.
    assert_eq!(
        client.request::<SessionRestorable>(&()).await.unwrap(),
        None
    );
    let late = client
        .request::<SessionRestore>(&RestoreSessionsRequest {
            sessions: vec![SessionToRestore {
                id: started[1].id,
                cols: 80,
                rows: 24,
            }],
        })
        .await
        .unwrap();
    assert!(late.restored.is_empty());
    assert_eq!(late.failed.len(), 1);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s13_choosing_none_answers_the_offer_and_reopens_nothing() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let folders = [dirs.folder("a project")];
    sessions_stopped_for_an_update(&dirs, &endpoint, &agent, &folders).await;
    let runs_before = agent.records().len();

    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &[]));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    assert!(
        client
            .request::<SessionRestorable>(&())
            .await
            .unwrap()
            .is_some()
    );
    let result = client
        .request::<SessionRestore>(&RestoreSessionsRequest { sessions: vec![] })
        .await
        .unwrap();
    assert!(result.restored.is_empty() && result.failed.is_empty());
    assert_eq!(
        client.request::<SessionRestorable>(&()).await.unwrap(),
        None
    );
    assert_eq!(client.request::<SessionList>(&()).await.unwrap(), vec![]);
    assert_eq!(agent.records().len(), runs_before);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Claude Code on today's backends: the shell first, then the fake `claude`
// ---------------------------------------------------------------------------

/// The fake `claude` (`test/fake-agents/claude-code.mjs`), run by Node.
fn fake_claude() -> PathBuf {
    resolved(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("test")
            .join("fake-agents")
            .join("claude-code.mjs"),
    )
}

/// `path` with links resolved, in the form a process reports its own folder
/// in (no `\\?\` on Windows), so it compares with what the fake logs.
fn resolved(path: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = canonical.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(plain) => PathBuf::from(plain),
        None => canonical,
    }
}

/// A host with today's backends in today's order, the shell first and then
/// Claude Code, whose `claude` is the fake keeping its records in
/// `claude_config`.
fn todays_backends(dirs: &TestDirs, endpoint: &Endpoint, claude_config: &Path) -> HostConfig {
    let claude = ClaudeCodeSettings {
        search_first: Vec::new(),
        program: "node".into(),
        leading_args: vec![fake_claude().into_os_string()],
        config_dir: claude_config.to_path_buf(),
        pass_config_dir: true,
        api_key_set: false,
    };
    HostConfig {
        run: Default::default(),
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: floti_host::server::backends(&dirs.user_env(), Some(claude)),
        inherited_env: std::env::vars_os().collect(),
    }
}

fn claude_code_start(folder: &Path) -> StartSessionRequest {
    StartSessionRequest {
        backend: Some(BackendId::claude_code()),
        ..start_request(folder)
    }
}

/// Every run log the fake `claude` has written in `claude_config`.
fn claude_runs(claude_config: &Path) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(claude_config.join("fake-agent")) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension()? != "json" {
                return None;
            }
            serde_json::from_slice(&std::fs::read(path).ok()?).ok()
        })
        .collect()
}

fn argv_of(run: &Value) -> Vec<String> {
    run["argv"]
        .as_array()
        .map(|args| {
            args.iter()
                .filter_map(|arg| arg.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// The fake `claude`'s run whose arguments `matches`, waiting for it.
fn wait_for_claude_run(claude_config: &Path, matches: impl Fn(&[String]) -> bool) -> Value {
    let deadline = Instant::now() + PATIENCE;
    loop {
        if let Some(run) = claude_runs(claude_config)
            .into_iter()
            .find(|run| matches(&argv_of(run)))
        {
            return run;
        }
        assert!(
            Instant::now() < deadline,
            "the fake claude logged no such run: {:?}",
            claude_runs(claude_config)
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn resumes(argv: &[String], conversation: &str) -> bool {
    argv.windows(2)
        .any(|pair| pair[0] == "--resume" && pair[1] == conversation)
}

/// What S3 asks of a resume the fake `claude` logged: it ran in `folder`,
/// found `conversation` there, and was given a settings file of its own and
/// nothing that belongs to a new conversation.
fn assert_resumed_in(run: &Value, conversation: &str, folder: &Path) {
    assert_eq!(run["exitCode"], Value::Null, "the resume failed: {run}");
    assert_eq!(run["resumed"], true, "{run}");
    assert_eq!(run["sessionId"], conversation, "{run}");
    assert_eq!(
        resolved(Path::new(run["cwd"].as_str().expect("the run's folder"))),
        folder
    );
    let argv = argv_of(run);
    assert!(argv.iter().any(|arg| arg == "--settings"), "{argv:?}");
    for new_only in ["-n", "--session-id"] {
        assert!(!argv.iter().any(|arg| arg == new_only), "{argv:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn s3_restoring_a_claude_code_conversation_on_todays_backends_resumes_it_in_its_recorded_folder()
 {
    let dirs = TestDirs::new();
    let endpoint = dirs.endpoint();
    let claude_config = resolved(&dirs.folder("claude config"));
    let project = resolved(&dirs.folder("a project"));

    // A Claude Code conversation with a prompt in it, left running by a stop
    // for an update.
    let host = RunningHost::start(todays_backends(&dirs, &endpoint, &claude_config));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let started = client
        .request::<SessionStart>(&claude_code_start(&project))
        .await
        .unwrap();
    assert_eq!(started.backend, BackendId::claude_code());
    let conversation = started
        .conversation_id
        .clone()
        .expect("Claude Code chose the conversation's id");
    client.attach(1, started.id).await;
    client.type_into(1, b"fix the export\r").await;
    client
        .read_stream_until(1, |bytes| {
            String::from_utf8_lossy(bytes).contains("You said: fix the export")
        })
        .await;
    client
        .request::<HostStop>(&HostStopRequest {
            reason: HostStopReason::Update,
        })
        .await
        .unwrap();
    assert_eq!(host.stopped().await, HostStopReason::Update);

    // The next start offers it, reopenable through the backend its row
    // recorded rather than the default shell.
    let host = RunningHost::start(todays_backends(&dirs, &endpoint, &claude_config));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let offer = client
        .request::<SessionRestorable>(&())
        .await
        .unwrap()
        .expect("the conversation is offered");
    assert_eq!(offer.sessions.len(), 1);
    assert_eq!(offer.sessions[0].blocked, None, "{offer:?}");

    let result = client
        .request::<SessionRestore>(&RestoreSessionsRequest {
            sessions: vec![SessionToRestore {
                id: started.id,
                cols: 100,
                rows: 30,
            }],
        })
        .await
        .unwrap();
    assert!(result.failed.is_empty(), "{:?}", result.failed);
    assert_eq!(result.restored.len(), 1);
    let session = &result.restored[0].launched.session;
    assert_eq!(session.backend, BackendId::claude_code());
    assert_eq!(Path::new(&session.cwd), project);
    assert_eq!(
        session.conversation_id.as_deref(),
        Some(conversation.as_str())
    );

    // `claude --resume <id>` ran in the recorded folder and found the
    // conversation there.
    let resumed = wait_for_claude_run(&claude_config, |argv| resumes(argv, &conversation));
    assert_resumed_in(&resumed, &conversation, &project);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s3_a_row_with_no_backend_recorded_reopens_through_claude_code_and_a_missing_backend_is_named()
 {
    let dirs = TestDirs::new();
    let endpoint = dirs.endpoint();
    let claude_config = resolved(&dirs.folder("claude config"));
    let todays = resolved(&dirs.folder("todays project"));
    let tomorrows = resolved(&dirs.folder("tomorrows project"));
    let conversation = "6d1f3c52-8a4e-4f0b-9c7d-2e5a8b1f4c90";

    // A conversation Claude Code recorded in `todays`. The folder its
    // transcript is in is the CLI's business; nothing derives it.
    let transcript = claude_config
        .join("projects")
        .join("not-derived-from-the-path")
        .join(format!("{conversation}.jsonl"));
    std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
    let line = json!({
        "type": "user",
        "uuid": "u1",
        "sessionId": conversation,
        "cwd": todays,
        "timestamp": "2026-10-01T09:00:00.000Z",
        "message": { "role": "user", "content": "fix the payroll export" },
    });
    std::fs::write(&transcript, format!("{line}\n")).unwrap();

    // The rows a crash left running: one as today's app writes it, with no
    // backend, and one naming a backend this host does not have.
    Store::open(&dirs.data).unwrap().close().unwrap();
    {
        let db = rusqlite::Connection::open(dirs.data.join("floti.db")).unwrap();
        db.execute(
            "INSERT INTO sessions (name, cwd, argv, claude_session_id, status) \
             VALUES ('from today', ?1, '[]', ?2, 'running')",
            rusqlite::params![todays.to_string_lossy(), conversation],
        )
        .unwrap();
        db.execute(
            "INSERT INTO sessions (name, cwd, argv, claude_session_id, status, backend) \
             VALUES ('from tomorrow', ?1, '[]', 'c-tomorrow', 'running', 'tomorrows-agent')",
            rusqlite::params![tomorrows.to_string_lossy()],
        )
        .unwrap();
    }

    let host = RunningHost::start(todays_backends(&dirs, &endpoint, &claude_config));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let offer = client
        .request::<SessionRestorable>(&())
        .await
        .unwrap()
        .expect("both are offered");
    assert_eq!(offer.sessions.len(), 2, "{offer:?}");
    let (today, tomorrow) = (&offer.sessions[0], &offer.sessions[1]);
    assert_eq!(today.blocked, None, "{today:?}");
    let blocked = tomorrow
        .blocked
        .clone()
        .expect("a backend this host does not have blocks the restore");
    assert!(blocked.contains("`tomorrows-agent`"), "{blocked}");

    let result = client
        .request::<SessionRestore>(&RestoreSessionsRequest {
            sessions: [today.id, tomorrow.id]
                .map(|id| SessionToRestore {
                    id,
                    cols: 80,
                    rows: 24,
                })
                .to_vec(),
        })
        .await
        .unwrap();
    assert_eq!(
        result
            .restored
            .iter()
            .map(|restored| restored.from)
            .collect::<Vec<_>>(),
        [today.id]
    );
    assert_eq!(
        result.restored[0].launched.session.backend,
        BackendId::claude_code()
    );
    assert_eq!(result.failed.len(), 1, "{:?}", result.failed);
    assert_eq!(result.failed[0].id, tomorrow.id);
    assert_eq!(result.failed[0].reason, blocked);

    // The row with no backend was Claude Code's: `claude --resume` ran in its
    // folder. Nothing ran for the other.
    let resumed = wait_for_claude_run(&claude_config, |argv| resumes(argv, conversation));
    assert_resumed_in(&resumed, conversation, &todays);
    assert_eq!(claude_runs(&claude_config).len(), 1);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S5, S9: a launch's own files go when its session ends
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s5_s9_a_claude_code_sessions_launch_folder_is_removed_when_the_session_ends() {
    let dirs = TestDirs::new();
    let endpoint = dirs.endpoint();
    let claude_config = resolved(&dirs.folder("claude config"));
    let project = resolved(&dirs.folder("a project"));
    let host = RunningHost::start(todays_backends(&dirs, &endpoint, &claude_config));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let session = client
        .request::<SessionStart>(&claude_code_start(&project))
        .await
        .unwrap();

    // Its settings file is in a launch folder of its own under Floti's data
    // folder.
    let run = wait_for_claude_run(&claude_config, |argv| {
        argv.iter().any(|arg| arg == "--settings")
    });
    let argv = argv_of(&run);
    let at = argv.iter().position(|arg| arg == "--settings").unwrap();
    let settings = PathBuf::from(&argv[at + 1]);
    let launch_folder = settings.parent().expect("a launch folder").to_path_buf();
    assert!(
        launch_folder.starts_with(&dirs.data),
        "{}",
        launch_folder.display()
    );
    assert!(settings.is_file(), "{}", settings.display());

    // The session ends, and its launch folder goes with it.
    client.attach(1, session.id).await;
    client.type_into(1, b"/exit\r").await;
    let deadline = Instant::now() + PATIENCE;
    while launch_folder.exists() {
        assert!(
            Instant::now() < deadline,
            "{} is still there after the session ended",
            launch_folder.display()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let row = rows(&dirs.data)
        .into_iter()
        .find(|row| u64::try_from(row.id) == Ok(session.id))
        .expect("the session's row");
    assert_eq!(row.status, "exited", "{row:?}");
    assert_eq!(row.exit_code, Some(0), "{row:?}");
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// What the host serves, and the channels it does not serve yet
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn every_protocol_host_channel_is_served_or_listed_with_the_feature_that_will_serve_it() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let (host, served) = RunningHost::start_with(
        fake_config(&dirs, &endpoint, &agent, &[]),
        Host::served_channels,
    );
    host.stop(HostStopReason::Stop).await;

    let drift = unserved::drift(&Catalogue::protocol(), &served);
    assert!(
        drift.is_empty(),
        "the not-yet-served list and the host disagree:\n{drift}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_calling_subscribing_to_or_opening_any_workspace_channel_is_served_rather_than_refused()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let mut config = fake_config(&dirs, &endpoint, &agent, &[]);
    config
        .inherited_env
        .retain(|(key, _)| key != std::ffi::OsStr::new("SHELL"));
    config
        .inherited_env
        .push(("SHELL".into(), "/bin/sh".into()));
    let host = RunningHost::start(config);
    let mut client = TestClient::connect(&endpoint, &["files", "terminal"]).await;

    // Every channel the workspace declares, so one added there is swept too,
    // and the profile channels the sessions domain declares for it. Launching
    // a profile starts a session, which the sessions tests cover.
    let mut declared = Catalogue::new();
    workspace::declare(&mut declared);
    let names: Vec<&str> = declared
        .channels()
        .map(|decl| decl.name())
        .chain([
            ProfileList::NAME,
            ProfileSave::NAME,
            ProfileDelete::NAME,
            ProfilePin::NAME,
            ProfileExport::NAME,
            ProfileImport::NAME,
            ProfilesChanged::NAME,
        ])
        .collect();
    assert!(!declared.is_empty());
    let protocol = Catalogue::protocol();
    let null = || to_payload(&()).unwrap();
    for (n, name) in (100_u64..).zip(names) {
        let decl = protocol
            .get(name)
            .unwrap_or_else(|| panic!("`{name}` is not in the protocol"));
        match decl.kind() {
            // A refusal to parse a null payload is the channel's own answer.
            ChannelKind::Request => {
                if let Err(error) = client.request_on(name, null()).await {
                    assert!(
                        !names_unserved_channel(&error, name),
                        "`{name}` was refused as not served: {error:?}"
                    );
                }
            }
            ChannelKind::Event { snapshot: true } => match client.subscribe_on(n, name).await {
                Message::Snapshot(_) => {}
                other => {
                    panic!("a subscription to `{name}` did not start with a snapshot: {other:?}")
                }
            },
            ChannelKind::Event { snapshot: false } => {
                client.subscribe_quietly(n, name).await;
                // Anything the host says about the subscription comes before
                // its answer to a request sent after it.
                client.request::<SessionList>(&()).await.unwrap();
                while let Some(message) = client.next(Duration::ZERO).await {
                    if let Message::SubscriptionError(refused) = message {
                        assert_ne!(refused.subscription, n, "`{name}` was refused: {refused:?}");
                    }
                }
            }
            ChannelKind::Stream => {
                client.open_on(n, name, null()).await;
                client.request::<SessionList>(&()).await.unwrap();
                if let Some(Some(reason)) = client.stream_closed(n) {
                    assert!(
                        !reason.contains("does not serve"),
                        "`{name}` was refused as not served: {reason}"
                    );
                }
            }
        }
    }

    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_channel_not_served_yet_is_refused_naming_it_and_every_client_is_served_on() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &[]));
    let folder = dirs.folder("a project");

    let mut other = TestClient::connect(&endpoint, TERMINAL).await;
    let session = other
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    other.attach(1, session.id).await;

    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let catalogue = Catalogue::protocol();
    let listed: Vec<_> = catalogue
        .channels()
        .filter_map(|decl| unserved::later(decl.name()).map(|later| (decl, later)))
        .collect();
    // While every channel is served the list is empty, and this checks only
    // that the clients are served on.
    let null = || to_payload(&()).unwrap();
    for (n, (decl, later)) in (100_u64..).zip(&listed) {
        let name = decl.name();
        match decl.kind() {
            ChannelKind::Request => {
                let refused = client
                    .request_on(name, null())
                    .await
                    .expect_err("a channel not served yet is refused");
                assert!(names_unserved_channel(&refused, name), "{refused:?}");
                assert!(refused.message.contains(later.feature), "{refused:?}");
            }
            ChannelKind::Event { .. } => match client.subscribe_on(n, name).await {
                Message::SubscriptionError(refused) => {
                    assert_eq!(refused.code, ErrorCode::Unavailable, "{refused:?}");
                    assert_eq!(refused.channel, name);
                    assert!(
                        refused.message.contains(&format!("`{name}`"))
                            && refused.message.contains(later.feature),
                        "{refused:?}"
                    );
                }
                other => panic!("a subscription to `{name}` was not refused: {other:?}"),
            },
            ChannelKind::Stream => {
                client.open_on(n, name, null()).await;
                let reason = client.wait_stream_closed(n).await.unwrap_or_default();
                assert!(
                    reason.contains(&format!("`{name}`")) && reason.contains(later.feature),
                    "{reason}"
                );
            }
        }
        // Each refusal leaves the client served.
        assert_eq!(
            client.request::<SessionList>(&()).await.unwrap(),
            vec![session.clone()]
        );
    }

    // And every other client too: its session still takes input and answers.
    other.type_into(1, b"still here\r").await;
    other
        .read_stream_until(1, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: still here")
        })
        .await;
    assert_eq!(
        other.request::<SessionList>(&()).await.unwrap(),
        vec![session]
    );

    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn every_subscriber_to_session_exit_gets_a_sessions_finished_row_when_it_ends() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &[]));
    let folder = dirs.folder("a project");

    let mut watching = TestClient::connect(&endpoint, TERMINAL).await;
    watching.subscribe_quietly(5, SessionExit::NAME).await;
    let mut closing = TestClient::connect(&endpoint, TERMINAL).await;
    closing.subscribe_quietly(9, SessionExit::NAME).await;
    // Answered in order, so both subscriptions are held by now.
    watching.request::<SessionList>(&()).await.unwrap();
    let session = closing
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    closing
        .request::<SessionClose>(&CloseSessionRequest {
            id: session.id,
            force: true,
        })
        .await
        .unwrap();

    for (client, subscription) in [(&mut watching, 5), (&mut closing, 9)] {
        let event = loop {
            match client.next(PATIENCE).await {
                Some(Message::Event(event)) => break event,
                Some(_) => {}
                None => panic!("no session:exit within {PATIENCE:?}"),
            }
        };
        assert_eq!(event.subscription, subscription);
        assert_eq!(event.seq, 1);
        let record: SessionRecord = from_payload(&event.payload).unwrap();
        assert_eq!(record.id, session.id);
        assert_eq!(record.status, SessionStatus::Exited);
        assert!(record.ended_at.is_some(), "{record:?}");
    }

    host.stop(HostStopReason::Stop).await;
}
