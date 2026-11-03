//! The session keeper, end to end: real `floti host` and `floti keeper`
//! processes on real local sockets, with the fake agent behind their
//! sessions and plain terminals.
//!
//! A host the test kills is a `floti host` process it started, killed by its
//! own pid; a host it only stops runs in this process ([`RunningHost`]). Each
//! test ends with a deliberate stop, which ends the keeper and everything it
//! holds; a keeper a failed test leaves exits once this process has gone.

use std::path::Path;
use std::process::{Child, Command};
use std::sync::Arc;
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::fake_agent;
use floti_host::keeper::{KEEPER_LOG, TEST_KEEPER_VERSION};
use floti_host::platform::process_table::{self, ProcessTable};
use floti_host::platform::process_tree::{Ending, Native as NativeTree, ProcessTree};
use floti_host::platform::socket::network_listeners;
use floti_host::server::{HostConfig, HostRun};
use floti_host::testkit::{
    FakeAgent, PATIENCE, RunningHost, TestClient, TestDirs, floti_exe, pair_test_device,
};
use floti_protocol::Knowable;
use floti_protocol::channel::to_payload;
use floti_protocol::channels::common::SessionStatus;
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    PtermOpen, PtermOpenRequest, PtermStreamOpen, SessionList, SessionRestorable, SessionStart,
    StartSessionRequest,
};

const TERMINAL: &[&str] = &["terminal"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A `floti host` process the test kills by its own pid; one still running
/// when the test ends is killed then.
struct KillableHost(Option<Child>);

impl KillableHost {
    fn start(dirs: &TestDirs, agent: &FakeAgent) -> Self {
        pair_test_device(&dirs.floti_endpoint(), &dirs.data);
        let (log_var, log_dir) = agent.log_env();
        let mut command: Command = dirs.floti_command(env!("CARGO_BIN_EXE_floti"));
        command.arg("host").env(log_var, log_dir);
        Self(Some(command.spawn().expect("run floti host")))
    }

    /// Kills this host alone, as a crash ends it: nothing is stopped and
    /// nothing recorded.
    fn kill(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            child.wait().expect("reap the host");
        }
    }

    /// Waits for the host to end by itself.
    async fn ended(&mut self) {
        let child = self.0.as_mut().expect("a running host");
        let deadline = Instant::now() + PATIENCE;
        while child.try_wait().expect("poll the host").is_none() {
            assert!(Instant::now() < deadline, "the host did not end");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        self.0 = None;
    }
}

impl Drop for KillableHost {
    fn drop(&mut self) {
        self.kill();
    }
}

/// A host in this process on `dirs`' folders, at the endpoint a `floti host`
/// over them listens at, whose one backend is the fake agent with `args`.
fn in_process(dirs: &TestDirs, agent: &FakeAgent, args: &[&str]) -> RunningHost {
    RunningHost::start(HostConfig {
        run: HostRun {
            keeper: floti_exe(),
            ..HostRun::default()
        },
        folders: dirs.folders(),
        endpoint: dirs.floti_endpoint(),
        backends: vec![Arc::new(agent.backend(args.iter().copied())) as Arc<dyn AgentBackend>],
        inherited_env: std::env::vars_os().collect(),
    })
}

fn start_request(folder: &Path) -> StartSessionRequest {
    StartSessionRequest {
        cwd: folder.to_string_lossy().into_owned(),
        cols: 80,
        rows: 24,
        ..StartSessionRequest::default()
    }
}

/// The command line that runs the fake agent with `args`, typed at a shell.
fn fake_line(agent: &FakeAgent, args: &str) -> String {
    format!("\"{}\" {args}\r", agent.exe().display())
}

/// Each session row's id, status and exit code.
fn rows(data: &Path) -> Vec<(i64, String, Option<i64>)> {
    let db = rusqlite::Connection::open(data.join("floti.db")).expect("open floti.db");
    let mut statement = db
        .prepare("SELECT id, status, exit_code FROM sessions ORDER BY id")
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

/// Waits until `done` holds, failing after [`PATIENCE`] naming `what`.
async fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + PATIENCE;
    while !done() {
        assert!(Instant::now() < deadline, "{what} within {PATIENCE:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn alive(pid: u32) -> bool {
    NativeTree.is_alive(pid) != Knowable::Known(false)
}

/// The fake agent's one run in `folder` once it has started.
async fn run_in(agent: &FakeAgent, folder: &Path) -> u32 {
    let name = folder.file_name().expect("a named folder").to_owned();
    let mut found = None;
    until("the fake agent ran", || {
        found = agent
            .records()
            .into_iter()
            .find(|record| Path::new(&record.cwd).file_name() == Some(name.as_os_str()))
            .map(|record| record.pid);
        found.is_some()
    })
    .await;
    found.expect("a run")
}

/// The session keeper whose tree `pid` is in: the nearest process above it
/// run as `floti keeper`.
fn keeper_above(pid: u32) -> u32 {
    let table = process_table::Native
        .processes()
        .expect("read the process table");
    let mut at = pid;
    for _ in 0..16 {
        let row = table
            .iter()
            .find(|row| row.pid == at)
            .unwrap_or_else(|| panic!("process {at} is not in the table"));
        if row
            .command_line
            .as_deref()
            .is_some_and(|line| line.contains(" keeper "))
        {
            return row.pid;
        }
        at = row.parent_pid;
    }
    panic!("no session keeper above {pid}");
}

/// Opens a plain terminal running the fake agent in `folder`, on `stream`.
async fn fake_terminal(
    client: &mut TestClient,
    agent: &FakeAgent,
    folder: &Path,
    stream: u64,
) -> u64 {
    let opened = client
        .request::<PtermOpen>(&PtermOpenRequest {
            path: folder.to_string_lossy().into_owned(),
            cols: 80,
            rows: 24,
            shell: Some(agent.exe().to_string_lossy().into_owned()),
            separate: false,
        })
        .await
        .unwrap();
    assert_eq!(opened.problem, None, "{opened:?}");
    client
        .open_on(
            stream,
            "pterm:data",
            to_payload(&PtermStreamOpen { id: opened.id }).unwrap(),
        )
        .await;
    opened.id
}

/// Starts a session that runs the fake agent with `args` in `folder`, and
/// returns its id and the fake agent's pid.
async fn fake_session(
    client: &mut TestClient,
    agent: &FakeAgent,
    folder: &Path,
    args: &str,
    stream: u64,
) -> (u64, u32) {
    let session = client
        .request::<SessionStart>(&start_request(folder))
        .await
        .unwrap();
    client.attach(stream, session.id).await;
    // The shell's prompt first, so what is typed reaches a shell reading it.
    client
        .read_stream_until(stream, |bytes| !bytes.is_empty())
        .await;
    client
        .type_into(stream, fake_line(agent, args).as_bytes())
        .await;
    (session.id, run_in(agent, folder).await)
}

// ---------------------------------------------------------------------------
// S1 and S2: a killed host leaves its sessions and terminals running, and the
// next host takes them back with their screens, input and ids
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s1_a_killed_host_leaves_sessions_and_terminals_running_and_the_next_takes_them_back() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let mut first = KillableHost::start(&dirs, &agent);
    let endpoint = dirs.floti_endpoint();
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let in_session = dirs.folder("a project");
    let (session, session_pid) =
        fake_session(&mut client, &agent, &in_session, "--fake-tick=100", 1).await;
    let in_terminal = dirs.folder("another project");
    let terminal = fake_terminal(&mut client, &agent, &in_terminal, 2).await;
    let terminal_pid = run_in(&agent, &in_terminal).await;
    client.type_into(2, b"before\r").await;
    client
        .read_stream_until(2, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: before")
        })
        .await;
    let keeper = keeper_above(session_pid);
    assert_eq!(keeper_above(terminal_pid), keeper);
    drop(client);

    first.kill();
    // With no host, the programs run on and the keeper keeps reading them.
    let killed_at = agent.ticks(session_pid).unwrap_or(0);
    until("ticks written while no host ran", || {
        agent.ticks(session_pid).unwrap_or(0) >= killed_at + 4
    })
    .await;
    assert!(alive(session_pid) && alive(terminal_pid) && alive(keeper));

    let second = in_process(&dirs, &agent, &[]);
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let listed = client.request::<SessionList>(&()).await.unwrap();
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!(listed[0].id, session);
    assert_eq!(listed[0].status, SessionStatus::Running);
    assert_eq!(Path::new(&listed[0].cwd), in_session);
    assert_eq!(
        client.request::<SessionRestorable>(&()).await.unwrap(),
        None,
        "a session taken back is not offered"
    );

    // Its screen holds what was written while no host ran; what follows is
    // live, and what is typed reaches it.
    client.attach(3, session).await;
    let seen = client
        .read_stream_until(3, |bytes| {
            let text = String::from_utf8_lossy(bytes);
            text.contains(&format!("tick {}", killed_at + 2))
                && text.contains(&format!("tick {}", killed_at + 6))
        })
        .await;
    assert!(!seen.is_empty());
    client.type_into(3, b"after\r").await;
    client
        .read_stream_until(3, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: after")
        })
        .await;

    // The folder's plain terminal is the same one, under the same id.
    assert_eq!(
        fake_terminal(&mut client, &agent, &in_terminal, 4).await,
        terminal
    );
    let screen = client
        .read_stream_until(4, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: before")
        })
        .await;
    assert!(!screen.is_empty());
    client.type_into(4, b"again\r").await;
    client
        .read_stream_until(4, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: again")
        })
        .await;
    let record = agent.wait_for_record(terminal_pid, PATIENCE, |record| record.input.len() == 2);
    assert_eq!(record.input, ["before", "again"]);
    // A new terminal's number continues past it.
    let other = client
        .request::<PtermOpen>(&PtermOpenRequest {
            path: in_terminal.to_string_lossy().into_owned(),
            cols: 80,
            rows: 24,
            shell: Some(agent.exe().to_string_lossy().into_owned()),
            separate: true,
        })
        .await
        .unwrap();
    assert!(other.id > terminal, "{} after {terminal}", other.id);

    // A deliberate stop ends everything, the keeper with it.
    second.stop(HostStopReason::Stop).await;
    until("the keeper and its programs ended", || {
        !alive(keeper) && !alive(session_pid) && !alive(terminal_pid)
    })
    .await;
    assert_eq!(rows(&dirs.data)[0].1, "exited");
}

// ---------------------------------------------------------------------------
// S3: a session that ends while no host runs is recorded with its exit code
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s3_a_session_that_ends_while_no_host_runs_is_recorded_exited_with_its_code() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let mut first = KillableHost::start(&dirs, &agent);
    let mut client = TestClient::connect(&dirs.floti_endpoint(), TERMINAL).await;
    let folder = dirs.folder("a project");
    let release = dirs.root().join("release");
    let args = format!("--fake-exit-on=\"{}\" && exit 5", release.to_string_lossy());
    let (session, pid) = fake_session(&mut client, &agent, &folder, &args, 1).await;
    let keeper = keeper_above(pid);
    drop(client);
    first.kill();

    std::fs::write(&release, "").unwrap();
    until("the fake agent ended", || !alive(pid)).await;
    // The keeper holds how the session ended until a host records it.
    assert!(alive(keeper));

    let second = in_process(&dirs, &agent, &[]);
    let mut client = TestClient::connect(&dirs.floti_endpoint(), TERMINAL).await;
    let mut ended = Vec::new();
    until("the session's end recorded", || {
        ended = rows(&dirs.data);
        ended.first().is_some_and(|row| row.1 != "running")
    })
    .await;
    assert_eq!(
        ended,
        [(
            i64::try_from(session).unwrap(),
            "exited".to_owned(),
            Some(5)
        )]
    );
    assert_eq!(client.request::<SessionList>(&()).await.unwrap(), []);
    assert_eq!(
        client.request::<SessionRestorable>(&()).await.unwrap(),
        None
    );
    second.stop(HostStopReason::Stop).await;
    until("the keeper ended", || !alive(keeper)).await;
}

// ---------------------------------------------------------------------------
// S4: a keeper that dies while the host runs loses its sessions, which are
// offered back, and the next session starts a new keeper
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_keeper_killed_while_the_host_runs_loses_its_sessions_and_offers_them_back() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let host = in_process(&dirs, &agent, &["--fake-tick=100"]);
    let mut client = TestClient::connect(&dirs.floti_endpoint(), TERMINAL).await;
    let folder = dirs.folder("a project");
    let session = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    let pid = run_in(&agent, &folder).await;
    let keeper = keeper_above(pid);

    NativeTree
        .end_tree(keeper, Ending::Forced)
        .expect("end the keeper");
    until("the keeper and its session ended", || {
        !alive(keeper) && !alive(pid)
    })
    .await;
    until("the session recorded lost", || {
        rows(&dirs.data).first().is_some_and(|row| row.1 == "lost")
    })
    .await;
    assert_eq!(client.request::<SessionList>(&()).await.unwrap(), []);
    let offer = client
        .request::<SessionRestorable>(&())
        .await
        .unwrap()
        .expect("the lost session is offered");
    assert_eq!(
        offer.sessions.iter().map(|s| s.id).collect::<Vec<_>>(),
        [session.id]
    );

    // The next session starts a keeper of its own.
    let other = dirs.folder("another project");
    client
        .request::<SessionStart>(&start_request(&other))
        .await
        .unwrap();
    let next = run_in(&agent, &other).await;
    let new_keeper = keeper_above(next);
    assert_ne!(new_keeper, keeper);
    host.stop(HostStopReason::Stop).await;
    until("the new keeper ended", || {
        !alive(new_keeper) && !alive(next)
    })
    .await;
}

// ---------------------------------------------------------------------------
// S7: a keeper of another version is ended, its sessions lost and offered,
// and one of this version starts
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s7_a_keeper_of_another_version_is_ended_and_its_sessions_offered_back() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let marker = dirs.data.join(TEST_KEEPER_VERSION);
    std::fs::write(&marker, "0.0.0-older").unwrap();
    let mut first = KillableHost::start(&dirs, &agent);
    let mut client = TestClient::connect(&dirs.floti_endpoint(), TERMINAL).await;
    let folder = dirs.folder("a project");
    let (session, pid) = fake_session(&mut client, &agent, &folder, "", 1).await;
    let keeper = keeper_above(pid);
    drop(client);
    first.kill();
    std::fs::remove_file(&marker).unwrap();

    let second = in_process(&dirs, &agent, &[]);
    assert!(!alive(keeper), "the other version's keeper was ended");
    until("its session ended", || !alive(pid)).await;
    let mut client = TestClient::connect(&dirs.floti_endpoint(), TERMINAL).await;
    let offer = client
        .request::<SessionRestorable>(&())
        .await
        .unwrap()
        .expect("its session is offered");
    assert_eq!(
        offer.sessions.iter().map(|s| s.id).collect::<Vec<_>>(),
        [session]
    );
    assert_eq!(rows(&dirs.data)[0].1, "lost");

    let other = dirs.folder("another project");
    client
        .request::<SessionStart>(&start_request(&other))
        .await
        .unwrap();
    let next = run_in(&agent, &other).await;
    assert_ne!(keeper_above(next), keeper);
    second.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S9: a host that aborts with sessions running leaves them in the keeper
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s9_a_host_that_aborts_after_starting_a_session_leaves_it_running_for_the_next() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let marker = dirs
        .data
        .join(floti_host::host_log::TEST_CRASH_AFTER_SESSION_MARKER);
    std::fs::write(&marker, "").unwrap();
    let mut first = KillableHost::start(&dirs, &agent);
    let mut client = TestClient::connect(&dirs.floti_endpoint(), TERMINAL).await;
    let folder = dirs.folder("a project");
    // The host aborts before it answers.
    client
        .send_request(
            "session:start",
            to_payload(&start_request(&folder)).unwrap(),
        )
        .await;
    first.ended().await;
    std::fs::remove_file(&marker).unwrap();

    let second = in_process(&dirs, &agent, &[]);
    let mut client = TestClient::connect(&dirs.floti_endpoint(), TERMINAL).await;
    let listed = client.request::<SessionList>(&()).await.unwrap();
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!(listed[0].status, SessionStatus::Running);
    assert_eq!(
        client.request::<SessionRestorable>(&()).await.unwrap(),
        None
    );
    second.stop(HostStopReason::Stop).await;
    assert_eq!(rows(&dirs.data)[0].1, "exited");
}

// ---------------------------------------------------------------------------
// S11: a stop for an update ends the keeper too and leaves the rows for the
// next start's one restore offer
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s11_a_stop_for_an_update_ends_the_keeper_and_the_next_start_offers_its_sessions() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let host = in_process(&dirs, &agent, &[]);
    let mut client = TestClient::connect(&dirs.floti_endpoint(), TERMINAL).await;
    let folder = dirs.folder("a project");
    let session = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    let pid = run_in(&agent, &folder).await;
    let keeper = keeper_above(pid);
    drop(client);
    host.stop(HostStopReason::Update).await;
    until("the keeper and its session ended", || {
        !alive(keeper) && !alive(pid)
    })
    .await;
    assert_eq!(rows(&dirs.data)[0].1, "running");

    let again = in_process(&dirs, &agent, &[]);
    let mut client = TestClient::connect(&dirs.floti_endpoint(), TERMINAL).await;
    let offer = client
        .request::<SessionRestorable>(&())
        .await
        .unwrap()
        .expect("offered once");
    assert_eq!(
        offer.sessions.iter().map(|s| s.id).collect::<Vec<_>>(),
        [session.id]
    );
    again.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S10: the keeper holds no network port, keeps nothing of the host's, and
// its endpoint and log carry no secret
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s10_the_keeper_listens_on_no_network_port_and_logs_no_token() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let host = in_process(&dirs, &agent, &[]);
    let mut client = TestClient::connect(&dirs.floti_endpoint(), TERMINAL).await;
    let folder = dirs.folder("a project");
    client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    let pid = run_in(&agent, &folder).await;
    let keeper = keeper_above(pid);
    assert_eq!(
        network_listeners(keeper).expect("read the listening sockets"),
        Vec::<String>::new()
    );
    host.stop(HostStopReason::Stop).await;
    let log = std::fs::read_to_string(dirs.logs.join(KEEPER_LOG)).unwrap_or_default();
    for secret in ["token", "Bearer", "key"] {
        assert!(!log.contains(secret), "{log}");
    }
}

#[test]
fn s10_the_keeper_opens_no_store_and_runs_no_plugin_history_usage_or_listener() {
    let folder = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/keeper");
    for entry in std::fs::read_dir(&folder).unwrap() {
        let path = entry.unwrap().path();
        let source = std::fs::read_to_string(&path).unwrap();
        for reached in [
            "crate::store",
            "crate::plugins",
            "crate::history",
            "crate::usage",
            "crate::agent_tools",
            "TcpListener",
            "crate::server",
        ] {
            assert!(
                !source.contains(reached),
                "{} reaches {reached}",
                path.display()
            );
        }
    }
}

// ---------------------------------------------------------------------------
// S9: a host dropped without a stop leaves its sessions in the keeper
// ---------------------------------------------------------------------------

#[test]
fn s9_a_host_dropped_without_a_stop_leaves_its_sessions_running_in_the_keeper() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let folder = dirs.folder("a project");
    let config = || HostConfig {
        run: HostRun {
            keeper: floti_exe(),
            ..HostRun::default()
        },
        folders: dirs.folders(),
        endpoint: dirs.floti_endpoint(),
        backends: vec![Arc::new(agent.backend(Vec::<&str>::new())) as Arc<dyn AgentBackend>],
        inherited_env: std::env::vars_os().collect(),
    };
    pair_test_device(&dirs.floti_endpoint(), &dirs.data);
    let runtime = tokio::runtime::Runtime::new().expect("a runtime");
    let (session, pid) = runtime.block_on(async {
        let host = floti_host::server::Host::start(config()).expect("start the host");
        tokio::spawn(host.run_until_stopped());
        let mut client = TestClient::connect(&dirs.floti_endpoint(), TERMINAL).await;
        let session = client
            .request::<SessionStart>(&start_request(&folder))
            .await
            .unwrap();
        (session.id, run_in(&agent, &folder).await)
    });
    // Its run and every task holding it go with the runtime, unstopped.
    drop(runtime);
    assert!(alive(pid), "the session ended with the dropped host");

    tokio::runtime::Runtime::new()
        .expect("a runtime")
        .block_on(async {
            let again = RunningHost::start(config());
            let mut client = TestClient::connect(&dirs.floti_endpoint(), TERMINAL).await;
            let listed = client.request::<SessionList>(&()).await.unwrap();
            assert_eq!(listed.iter().map(|s| s.id).collect::<Vec<_>>(), [session]);
            again.stop(HostStopReason::Stop).await;
            until("the session ended with the stop", || !alive(pid)).await;
        });
}
