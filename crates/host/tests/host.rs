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
use floti_host::platform::process_tree::{Native as NativeTree, ProcessTree};
use floti_host::platform::socket::{self, Endpoint, LocalSocket, Native as NativeSocket};
use floti_host::platform::startup;
use floti_host::server::{Host, HostConfig, SOCKET_NAME, Stopper, unserved};
use floti_host::store::Store;
use floti_host::testkit::{
    FakeAgent, FakeAgentRecord, PATIENCE, TestClient, TestDirs, names_unserved_channel,
};
use floti_host::{Error, Result, fake_agent};
use floti_protocol::channel::{from_payload, to_payload};
use floti_protocol::channels::common::{SessionRecord, SessionStatus};
use floti_protocol::channels::host::{HostStop, HostStopReason, HostStopRequest};
use floti_protocol::channels::sessions::{
    CloseSessionRequest, LaunchSessionRequest, RestoreSessionsRequest, SessionClose, SessionExit,
    SessionLaunch, SessionList, SessionRestorable, SessionRestore, SessionStart, SessionToRestore,
    StartSessionRequest,
};
use floti_protocol::message::ErrorCode;
use floti_protocol::{BackendId, Catalogue, ChannelKind, EventChannel, Knowable, Message};
use serde_json::{Value, json};
use tokio::task::JoinHandle;

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
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: vec![Arc::new(agent.backend(args.iter().copied())) as Arc<dyn AgentBackend>],
        inherited_env: std::env::vars_os().collect(),
    }
}

/// A host running in this process.
struct InProcess {
    stopper: Stopper,
    running: JoinHandle<Result<HostStopReason>>,
}

impl InProcess {
    fn start(config: HostConfig) -> Self {
        let host = Host::start(config).expect("start the host");
        let stopper = host.stopper();
        Self {
            stopper,
            running: tokio::spawn(host.run_until_stopped()),
        }
    }

    /// Waits for the host to finish stopping, however it was asked.
    async fn stopped(self) -> HostStopReason {
        tokio::time::timeout(PATIENCE, self.running)
            .await
            .expect("the host stops in time")
            .expect("the host's task")
            .expect("the host stops cleanly")
    }

    async fn stop(self, reason: HostStopReason) -> HostStopReason {
        self.stopper.stop(reason);
        self.stopped().await
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

/// Waits until every process in `pids` has ended.
async fn assert_all_end(pids: &[u32]) {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let alive: Vec<u32> = pids
            .iter()
            .copied()
            .filter(|pid| NativeTree.is_alive(*pid) != Knowable::Known(false))
            .collect();
        if alive.is_empty() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "processes still running after {PATIENCE:?}: {alive:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
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

/// The `floti host` executable, with every folder in `dirs`.
fn floti_host_command(dirs: &TestDirs) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_floti"));
    command
        .arg("host")
        .env(DATA_DIR_VAR, &dirs.data)
        .env(LOG_DIR_VAR, &dirs.logs)
        .env(CONFIG_DIR_VAR, &dirs.config)
        .env(RUNTIME_DIR_VAR, &dirs.runtime)
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

/// Where the `floti host` executable listens with `dirs`' folders.
fn binary_endpoint(dirs: &TestDirs) -> Endpoint {
    NativeSocket.endpoint(&dirs.runtime, SOCKET_NAME)
}

/// Waits for `child` to exit, killing it after [`PATIENCE`].
fn wait_exit(child: &mut Child) -> ExitStatus {
    let deadline = Instant::now() + PATIENCE;
    loop {
        if let Some(status) = child.try_wait().expect("poll the host") {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            panic!("the host did not exit within {PATIENCE:?}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn output_of(child: Child) -> (String, String) {
    let output = child.wait_with_output().expect("read the host's output");
    (
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

/// The command line that runs the fake agent with a child of its own, typed
/// at a shell prompt.
fn fake_agent_command_line(agent: &FakeAgent) -> String {
    format!("\"{}\" --fake-child\r", agent.exe().display())
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

    let mut host = floti_host_command(&dirs).spawn().expect("run floti host");
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
    let mut first = floti_host_command(&dirs).spawn().expect("run floti host");
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
    let first = InProcess::start(fake_config(&dirs, &endpoint, &agent, &[]));
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
    let first = InProcess::start(fake_config(&dirs, &endpoint, &agent, &[]));
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
    let host = InProcess::start(fake_config(&dirs, &endpoint, &agent, &["--fake-tick=100"]));
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
    tokio::time::sleep(Duration::from_millis(800)).await;
    let pid = run_of(&agent, &folder)[0];
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
    let host = InProcess::start(fake_config(&dirs, &endpoint, &agent, &["--fake-child"]));
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

    let again = InProcess::start(fake_config(&dirs, &endpoint, &agent, &[]));
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
    let mut host = floti_host_command(&dirs)
        .env(log_var, log_dir)
        .spawn()
        .expect("run floti host");
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
        .type_into(1, fake_agent_command_line(&agent).as_bytes())
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

    let again = InProcess::start(fake_config(&dirs, &endpoint, &agent, &[]));
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
    let host = InProcess::start(fake_config(dirs, endpoint, agent, &["--fake-child"]));
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

    let host = InProcess::start(fake_config(&dirs, &endpoint, &agent, &[]));
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
    let again = InProcess::start(fake_config(&dirs, &endpoint, &agent, &[]));
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
    let mut host = floti_host_command(&dirs).spawn().expect("run floti host");
    let endpoint = binary_endpoint(&dirs);
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let folder = dirs.folder("a project");
    let session = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    drop(client);

    // Killed: no stop, nothing recorded.
    host.kill().expect("kill the host");
    host.wait().expect("reap the host");
    assert_eq!(rows(&dirs.data)[0].status, "running");

    let again = InProcess::start(fake_config(&dirs, &endpoint, &agent, &[]));
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

    let host = InProcess::start(fake_config(&dirs, &endpoint, &agent, &[]));
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

    let host = InProcess::start(fake_config(&dirs, &endpoint, &agent, &[]));
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
        program: "node".into(),
        leading_args: vec![fake_claude().into_os_string()],
        config_dir: claude_config.to_path_buf(),
        pass_config_dir: true,
        api_key_set: false,
    };
    HostConfig {
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
    let host = InProcess::start(todays_backends(&dirs, &endpoint, &claude_config));
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
    let host = InProcess::start(todays_backends(&dirs, &endpoint, &claude_config));
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

    let host = InProcess::start(todays_backends(&dirs, &endpoint, &claude_config));
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
    let host = InProcess::start(todays_backends(&dirs, &endpoint, &claude_config));
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
    let host = Host::start(fake_config(&dirs, &endpoint, &agent, &[])).expect("start the host");

    let drift = unserved::drift(&Catalogue::protocol(), &host.served_channels());
    assert!(
        drift.is_empty(),
        "the not-yet-served list and the host disagree:\n{drift}"
    );

    host.stop(HostStopReason::Stop);
    tokio::time::timeout(PATIENCE, host.run_until_stopped())
        .await
        .expect("the host stops in time")
        .expect("the host stops cleanly");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_channel_not_served_yet_is_refused_naming_it_and_every_client_is_served_on() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = InProcess::start(fake_config(&dirs, &endpoint, &agent, &[]));
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
    assert!(!listed.is_empty());
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
    let host = InProcess::start(fake_config(&dirs, &endpoint, &agent, &[]));
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
