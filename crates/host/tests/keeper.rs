//! The session keeper, end to end: real `floti host` and `floti keeper`
//! processes on real local sockets, with the fake agent behind their
//! sessions and plain terminals.
//!
//! A host the test kills is a `floti host` process it started, killed by its
//! own pid; a host it only stops runs in this process ([`RunningHost`]). Each
//! test ends with a deliberate stop, which ends the keeper and everything it
//! holds; a keeper a failed test leaves exits once this process has gone.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output};
use std::sync::Arc;
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::client::ClientKeys;
use floti_host::fake_agent;
use floti_host::keeper::{KEEPER_LOG, TEST_KEEPER_LINK_VERSION, TEST_KEEPER_VERSION};
use floti_host::platform::process_table::{self, ProcessTable};
use floti_host::platform::process_tree::{Ending, Native as NativeTree, ProcessTree};
use floti_host::platform::socket::network_listeners;
use floti_host::server::{HostConfig, HostRun, TEST_HOST_PROTOCOL, host_public_key};
use floti_host::testkit::{
    FakeAgent, PATIENCE, RunningHost, TestClient, TestDirs, floti_exe, record_test_host,
};
use floti_protocol::channel::to_payload;
use floti_protocol::channels::common::{SessionRecord, SessionStatus};
use floti_protocol::channels::host::{
    DeviceSession, HostDeviceSessions, HostQuit, HostQuitRequest, HostStopReason,
};
use floti_protocol::channels::sessions::{
    PtermClose, PtermCloseRequest, PtermExit, PtermExited, PtermOpen, PtermOpenRequest,
    PtermStreamOpen, SessionExit, SessionList, SessionResize, SessionResizeRequest,
    SessionRestorable, SessionStart, StartSessionRequest,
};
use floti_protocol::message::RestartState;
use floti_protocol::{
    EventChannel, KEEPER_LINK_VERSION, Knowable, PROTOCOL_VERSION, ProtocolVersion,
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
        Self::start_with(dirs, agent, |_| {})
    }

    /// `floti host --desktop`: a host a desktop started, here one that is
    /// never run, which exits by itself once idle.
    fn start_desktop(dirs: &TestDirs, agent: &FakeAgent) -> Self {
        let app = dirs.folder("Helm app");
        Self::start_with(dirs, agent, |command| {
            command
                .arg("--desktop")
                .arg(app.join("Helm.exe"))
                .arg("--desktop-arg")
                .arg(app.join("resources app"));
        })
    }

    fn start_with(dirs: &TestDirs, agent: &FakeAgent, more: impl FnOnce(&mut Command)) -> Self {
        record_test_host(&dirs.floti_endpoint(), &dirs.data);
        let (log_var, log_dir) = agent.log_env();
        let mut command: Command = dirs.floti_command(env!("CARGO_BIN_EXE_floti"));
        command.arg("host").env(log_var, log_dir);
        more(&mut command);
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

    /// Whether the host is still running.
    fn is_running(&mut self) -> bool {
        self.0
            .as_mut()
            .is_some_and(|child| child.try_wait().expect("poll the host").is_none())
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
        // A plain terminal running the fake agent logs its run too.
        inherited_env: std::env::vars_os()
            .chain(std::iter::once(agent.log_env()))
            .collect(),
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
// S1, S2, S3 and S7: a killed host leaves its sessions and terminals running,
// the next host takes them back with their screens, input, sizes and ids, and
// a deliberate stop ends them
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s1_s2_s3_a_killed_host_leaves_sessions_and_terminals_running_and_the_next_takes_them_back()
{
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
    // The client that typed last sets the size, and it reaches the program's
    // terminal in the keeper.
    client
        .request::<SessionResize>(&SessionResizeRequest {
            id: session,
            cols: 101,
            rows: 31,
        })
        .await
        .unwrap();
    client.type_into(3, b"/size\r").await;
    client
        .read_stream_until(3, |bytes| {
            String::from_utf8_lossy(bytes).contains("size: 101x31")
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
    let in_other = dirs.folder("a third project");
    let other = fake_terminal(&mut client, &agent, &in_other, 5).await;
    assert!(other > terminal, "{other} after {terminal}");
    let other_pid = run_in(&agent, &in_other).await;
    // Closing the terminal taken back ends its program.
    client
        .request::<PtermClose>(&PtermCloseRequest { id: terminal })
        .await
        .unwrap();
    until("the closed terminal's program ended", || {
        !alive(terminal_pid)
    })
    .await;
    assert!(alive(session_pid), "closing a terminal ends no session");

    // A deliberate stop ends everything, what was taken back included, and
    // the keeper with it.
    second.stop(HostStopReason::Stop).await;
    until("the keeper and its programs ended", || {
        !alive(keeper) && !alive(session_pid) && !alive(other_pid)
    })
    .await;
    assert_eq!(rows(&dirs.data)[0].1, "exited");
}

// ---------------------------------------------------------------------------
// S4: a session that ends while no host runs is recorded with its exit code
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_session_that_ends_while_no_host_runs_is_recorded_exited_with_its_code() {
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
// S12: a keeper that dies while the host runs loses its sessions, which are
// offered back, and the next session starts a new keeper
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s12_a_keeper_killed_while_the_host_runs_loses_its_sessions_and_offers_them_back() {
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
// S14: the keeper's greeting names its link version; a host takes back a
// keeper that speaks its link version whatever floti version built it, a
// keeper that names none (2.4.1-preview.7's) included, which speaks link
// version 1, and ends one of a link version it does not speak, offering its
// sessions back once
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s14_a_keeper_another_floti_version_built_is_taken_back_when_it_speaks_the_hosts_link_version()
 {
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
    let mut client = TestClient::connect(&dirs.floti_endpoint(), TERMINAL).await;
    let listed = client.request::<SessionList>(&()).await.unwrap();
    assert_eq!(listed.iter().map(|s| s.id).collect::<Vec<_>>(), [session]);
    assert!(
        alive(keeper) && alive(pid),
        "the keeper was taken back, not ended"
    );
    assert_eq!(
        client.request::<SessionRestorable>(&()).await.unwrap(),
        None
    );
    second.stop(HostStopReason::Stop).await;
    until("the keeper and its session ended", || {
        !alive(keeper) && !alive(pid)
    })
    .await;
}

/// A host whose keeper speaks link version `link`, killed with a session
/// running, then a host of this build's link version: the keeper is ended,
/// and its session offered back once.
async fn a_keeper_of_link_version_is_ended_and_its_sessions_offered_back(link: &str) {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let marker = dirs.data.join(TEST_KEEPER_LINK_VERSION);
    std::fs::write(&marker, link).unwrap();
    let mut first = KillableHost::start(&dirs, &agent);
    let mut client = TestClient::connect(&dirs.floti_endpoint(), TERMINAL).await;
    let folder = dirs.folder("a project");
    let (session, pid) = fake_session(&mut client, &agent, &folder, "", 1).await;
    let keeper = keeper_above(pid);
    drop(client);
    first.kill();
    std::fs::remove_file(&marker).unwrap();

    let second = in_process(&dirs, &agent, &[]);
    assert!(!alive(keeper), "the other link version's keeper was ended");
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

#[tokio::test(flavor = "multi_thread")]
async fn s14_a_keeper_of_another_link_version_is_ended_and_its_sessions_offered_back() {
    let other = (KEEPER_LINK_VERSION + 1).to_string();
    a_keeper_of_link_version_is_ended_and_its_sessions_offered_back(&other).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s14_a_keeper_that_names_no_link_version_is_taken_back_by_this_releases_host() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    // A keeper whose greeting leaves its link version out, as
    // 2.4.1-preview.7's does, from a host of that floti version.
    let link = dirs.data.join(TEST_KEEPER_LINK_VERSION);
    std::fs::write(&link, "none").unwrap();
    let version = dirs.data.join(TEST_KEEPER_VERSION);
    std::fs::write(&version, "2.4.1-preview.7").unwrap();
    let mut first = KillableHost::start(&dirs, &agent);
    let endpoint = dirs.floti_endpoint();
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let in_session = dirs.folder("a project");
    let (session, session_pid) = fake_session(&mut client, &agent, &in_session, "", 1).await;
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
    drop(client);
    first.kill();
    std::fs::remove_file(&link).unwrap();
    std::fs::remove_file(&version).unwrap();

    let second = in_process(&dirs, &agent, &[]);
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let listed = client.request::<SessionList>(&()).await.unwrap();
    assert_eq!(listed.iter().map(|s| s.id).collect::<Vec<_>>(), [session]);
    assert_eq!(listed[0].status, SessionStatus::Running);
    assert!(
        alive(keeper) && alive(session_pid) && alive(terminal_pid),
        "the keeper was taken back with its session and terminal, not ended"
    );
    assert_eq!(
        client.request::<SessionRestorable>(&()).await.unwrap(),
        None,
        "nothing taken back is offered"
    );
    // The folder's terminal is the same one, with its screen, and answers.
    assert_eq!(
        fake_terminal(&mut client, &agent, &in_terminal, 3).await,
        terminal
    );
    client
        .read_stream_until(3, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: before")
        })
        .await;
    client.type_into(3, b"after\r").await;
    client
        .read_stream_until(3, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: after")
        })
        .await;
    let state = TestClient::restart_frame(&endpoint, false).await;
    assert_eq!(
        state.keeper_link,
        Some(1),
        "a keeper naming none speaks link 1"
    );
    second.stop(HostStopReason::Stop).await;
    until("the keeper and what it held ended", || {
        !alive(keeper) && !alive(session_pid) && !alive(terminal_pid)
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_restart_ask_on_a_keeper_that_names_no_link_version_answers_link_version_1() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    std::fs::write(dirs.data.join(TEST_KEEPER_LINK_VERSION), "none").unwrap();
    let host = in_process(&dirs, &agent, &[]);
    let endpoint = dirs.floti_endpoint();
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let folder = dirs.folder("a project");
    client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    run_in(&agent, &folder).await;
    let state = TestClient::restart_frame(&endpoint, false).await;
    assert_eq!((state.sessions, state.keeper_link), (1, Some(1)));
    drop(client);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Restart for an update: the ask answers what the host runs, and a restart
// lets go of the keeper so the next host takes back every session and
// terminal, or, with a link version it does not speak, ends them and offers
// the sessions back once
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn the_restart_ask_answers_the_floti_version_the_session_count_and_the_keepers_link_version()
{
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let host = in_process(&dirs, &agent, &[]);
    let endpoint = dirs.floti_endpoint();
    // Wait until it answers.
    drop(TestClient::connect(&endpoint, TERMINAL).await);

    let idle = TestClient::restart_frame(&endpoint, false).await;
    assert_eq!(
        idle,
        RestartState {
            host_version: floti_host::version::FLOTI_VERSION.to_owned(),
            protocol: PROTOCOL_VERSION,
            sessions: 0,
            keeper_link: None,
        },
        "no keeper runs before the first session"
    );

    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    for name in ["a project", "another project"] {
        let folder = dirs.folder(name);
        client
            .request::<SessionStart>(&start_request(&folder))
            .await
            .unwrap();
        run_in(&agent, &folder).await;
    }
    let busy = TestClient::restart_frame(&endpoint, false).await;
    assert_eq!(busy.sessions, 2);
    assert_eq!(busy.keeper_link, Some(KEEPER_LINK_VERSION));

    // Asking changes nothing: the host still serves, both sessions running.
    let listed = client.request::<SessionList>(&()).await.unwrap();
    assert_eq!(listed.len(), 2);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_leaves_every_session_and_terminal_running_in_the_keeper_and_the_next_host_takes_them_back()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let first = in_process(&dirs, &agent, &[]);
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

    let state = TestClient::restart_frame(&endpoint, true).await;
    assert_eq!(
        (state.sessions, state.keeper_link),
        (1, Some(KEEPER_LINK_VERSION))
    );
    assert_eq!(first.stopped().await, HostStopReason::Restart);
    drop(client);
    assert!(
        alive(session_pid) && alive(terminal_pid) && alive(keeper),
        "the restart ended nothing"
    );
    assert_eq!(rows(&dirs.data)[0].1, "running");

    let second = in_process(&dirs, &agent, &[]);
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let listed = client.request::<SessionList>(&()).await.unwrap();
    assert_eq!(listed.iter().map(|s| s.id).collect::<Vec<_>>(), [session]);
    assert_eq!(listed[0].status, SessionStatus::Running);
    assert_eq!(
        client.request::<SessionRestorable>(&()).await.unwrap(),
        None,
        "nothing is offered back: nothing ended"
    );
    // Its screen is what it was, and it is live.
    client.attach(3, session).await;
    client
        .read_stream_until(3, |bytes| String::from_utf8_lossy(bytes).contains("echo: "))
        .await;
    client.type_into(3, b"after\r").await;
    client
        .read_stream_until(3, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: after")
        })
        .await;
    assert_eq!(
        fake_terminal(&mut client, &agent, &in_terminal, 4).await,
        terminal
    );
    client
        .read_stream_until(4, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: before")
        })
        .await;
    assert_eq!(keeper_above(session_pid), keeper);
    second.stop(HostStopReason::Stop).await;
    until("the keeper and its programs ended", || {
        !alive(keeper) && !alive(session_pid) && !alive(terminal_pid)
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn after_a_restart_a_host_that_does_not_speak_the_keepers_link_version_ends_it_and_offers_its_sessions_back_once()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let marker = dirs.data.join(TEST_KEEPER_LINK_VERSION);
    let older = KEEPER_LINK_VERSION + 1;
    std::fs::write(&marker, older.to_string()).unwrap();
    let first = in_process(&dirs, &agent, &[]);
    let endpoint = dirs.floti_endpoint();
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let folder = dirs.folder("a project");
    let (session, pid) = fake_session(&mut client, &agent, &folder, "", 1).await;
    let keeper = keeper_above(pid);
    drop(client);

    // The ask says the keeper's link version, which the next host does not
    // speak: a client can say beforehand that the restart ends the session.
    let state = TestClient::restart_frame(&endpoint, true).await;
    assert_eq!((state.sessions, state.keeper_link), (1, Some(older)));
    assert_eq!(first.stopped().await, HostStopReason::Restart);
    assert!(alive(pid) && alive(keeper));
    std::fs::remove_file(&marker).unwrap();

    let second = in_process(&dirs, &agent, &[]);
    assert!(!alive(keeper), "the keeper it does not speak to was ended");
    until("its session ended", || !alive(pid)).await;
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let offer = client
        .request::<SessionRestorable>(&())
        .await
        .unwrap()
        .expect("its session is offered");
    assert_eq!(
        offer.sessions.iter().map(|s| s.id).collect::<Vec<_>>(),
        [session]
    );
    second.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S15: `floti end-old-host` ends a protocol-1.x host's process alone, as a
// crash would, so its keeper and every program in it run on and the next host
// takes them back; it ends nothing for a host of any other protocol
// ---------------------------------------------------------------------------

/// Helm's client folder, with a device key of its own and the host on
/// `dirs`' data folder pinned, as Helm's is once it has connected.
async fn helm_client(dirs: &TestDirs) -> PathBuf {
    let folder = dirs.root().join("Helm data").join("host-client");
    let mut keys = ClientKeys::open(&folder).expect("set up Helm's client keys");
    let mut host = None;
    until("the host made its key", || {
        host = host_public_key(&dirs.data).ok().flatten();
        host.is_some()
    })
    .await;
    keys.pin_host(host.expect("a host key"))
        .expect("pin the host key");
    folder
}

/// Runs `floti end-old-host <folder>` over `dirs`' folders and waits for it
/// to end, for at most [`PATIENCE`].
async fn end_old_host(dirs: &TestDirs, folder: &Path) -> Output {
    let mut command = dirs.floti_command(env!("CARGO_BIN_EXE_floti"));
    command.arg("end-old-host").arg(folder);
    let mut child = command.spawn().expect("run floti end-old-host");
    let deadline = Instant::now() + PATIENCE;
    while child.try_wait().expect("poll floti end-old-host").is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("floti end-old-host did not end within {PATIENCE:?}");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    child.wait_with_output().expect("read floti end-old-host")
}

#[tokio::test(flavor = "multi_thread")]
async fn s15_ending_a_protocol_1_host_leaves_its_keeper_running_and_the_next_host_takes_it_back() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    // 2.4.1-preview.7's host: protocol 1.4, and a keeper whose greeting
    // names no link version.
    let protocol = dirs.data.join(TEST_HOST_PROTOCOL);
    std::fs::write(&protocol, "1.4").unwrap();
    let link = dirs.data.join(TEST_KEEPER_LINK_VERSION);
    std::fs::write(&link, "none").unwrap();
    let mut old = KillableHost::start(&dirs, &agent);
    let endpoint = dirs.floti_endpoint();
    let mut client = TestClient::connect_at(&endpoint, ProtocolVersion::new(1, 4), TERMINAL).await;
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
    drop(client);
    let folder = helm_client(&dirs).await;

    let ended = end_old_host(&dirs, &folder).await;
    assert_eq!(
        ended.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&ended.stderr)
    );
    old.ended().await;
    assert!(
        alive(keeper) && alive(session_pid) && alive(terminal_pid),
        "only the host ended: its keeper and what it holds run on"
    );
    assert_eq!(rows(&dirs.data)[0].1, "running", "nothing recorded an end");

    // The carried floti's host starts on the same folders.
    std::fs::remove_file(&protocol).unwrap();
    std::fs::remove_file(&link).unwrap();
    let new = in_process(&dirs, &agent, &[]);
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let listed = client.request::<SessionList>(&()).await.unwrap();
    assert_eq!(listed.iter().map(|s| s.id).collect::<Vec<_>>(), [session]);
    assert_eq!(listed[0].status, SessionStatus::Running);
    assert_eq!(
        client.request::<SessionRestorable>(&()).await.unwrap(),
        None,
        "nothing is offered back: nothing ended"
    );
    client.attach(3, session).await;
    client.type_into(3, b"after\r").await;
    client
        .read_stream_until(3, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: after")
        })
        .await;
    assert_eq!(
        fake_terminal(&mut client, &agent, &in_terminal, 4).await,
        terminal
    );
    client
        .read_stream_until(4, |bytes| {
            String::from_utf8_lossy(bytes).contains("echo: before")
        })
        .await;
    assert_eq!(keeper_above(session_pid), keeper);
    new.stop(HostStopReason::Stop).await;
    until("the keeper and its programs ended", || {
        !alive(keeper) && !alive(session_pid) && !alive(terminal_pid)
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s15_after_ending_a_protocol_1_host_whose_keeper_the_next_host_cannot_take_back_its_sessions_are_offered_back_once()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let protocol = dirs.data.join(TEST_HOST_PROTOCOL);
    std::fs::write(&protocol, "1.4").unwrap();
    let link = dirs.data.join(TEST_KEEPER_LINK_VERSION);
    std::fs::write(&link, (KEEPER_LINK_VERSION + 1).to_string()).unwrap();
    let mut old = KillableHost::start(&dirs, &agent);
    let endpoint = dirs.floti_endpoint();
    let mut client = TestClient::connect_at(&endpoint, ProtocolVersion::new(1, 4), TERMINAL).await;
    let in_session = dirs.folder("a project");
    let (session, session_pid) = fake_session(&mut client, &agent, &in_session, "", 1).await;
    let keeper = keeper_above(session_pid);
    drop(client);
    let folder = helm_client(&dirs).await;

    let ended = end_old_host(&dirs, &folder).await;
    assert_eq!(
        ended.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&ended.stderr)
    );
    old.ended().await;
    assert!(alive(keeper) && alive(session_pid), "only the host ended");

    std::fs::remove_file(&protocol).unwrap();
    std::fs::remove_file(&link).unwrap();
    let new = in_process(&dirs, &agent, &[]);
    assert!(!alive(keeper), "the keeper it does not speak to was ended");
    until("its session ended", || !alive(session_pid)).await;
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let offer = client
        .request::<SessionRestorable>(&())
        .await
        .unwrap()
        .expect("its session is offered back");
    assert_eq!(
        offer.sessions.iter().map(|s| s.id).collect::<Vec<_>>(),
        [session]
    );
    new.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s15_end_old_host_ends_nothing_for_a_host_of_this_protocol() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let mut host = KillableHost::start(&dirs, &agent);
    let endpoint = dirs.floti_endpoint();
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let folder = dirs.folder("a project");
    let (session, pid) = fake_session(&mut client, &agent, &folder, "", 1).await;
    let helm = helm_client(&dirs).await;

    let left = end_old_host(&dirs, &helm).await;
    assert_eq!(left.status.code(), Some(9));
    let said = String::from_utf8_lossy(&left.stderr);
    assert!(
        said.starts_with("floti end-old-host: ") && said.trim_end().lines().count() == 1,
        "one line on standard error: {said:?}"
    );
    assert!(host.is_running(), "the host was left running");
    assert!(alive(pid));
    let listed = client.request::<SessionList>(&()).await.unwrap();
    assert_eq!(listed.iter().map(|s| s.id).collect::<Vec<_>>(), [session]);
    drop(client);
    // A deliberate stop ends the keeper and the session in it.
    host.kill();
    in_process(&dirs, &agent, &[])
        .stop(HostStopReason::Stop)
        .await;
    until("the session ended", || !alive(pid)).await;
}

// ---------------------------------------------------------------------------
// S11: a host that aborts with sessions running leaves them in the keeper
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s11_a_host_that_fails_an_allocation_after_starting_a_session_leaves_it_running_for_the_next()
 {
    a_host_that_aborts_after_starting_a_session_leaves_it_running("abort").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s11_a_host_whose_panic_aborts_after_starting_a_session_leaves_it_running_for_the_next() {
    a_host_that_aborts_after_starting_a_session_leaves_it_running("panic").await;
}

/// A `floti host` that aborts, as `crash` in its marker says, once it has
/// started a session: the session runs on, and the next host takes it back.
async fn a_host_that_aborts_after_starting_a_session_leaves_it_running(crash: &str) {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let marker = dirs
        .data
        .join(floti_host::host_log::TEST_CRASH_AFTER_SESSION_MARKER);
    std::fs::write(&marker, crash).unwrap();
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
    // The session's shell outlived the host that started it.
    let mut shell = None;
    until("the session's shell running in a keeper", || {
        shell = keeper_children(&dirs);
        shell.is_some()
    })
    .await;
    let (keeper, shell) = shell.expect("a keeper with a program");
    assert!(alive(shell));

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
    until("the keeper and the session ended", || {
        !alive(keeper) && !alive(shell)
    })
    .await;
    assert_eq!(rows(&dirs.data)[0].1, "exited");
}

/// The session keeper on `dirs`' data folder and a program it runs, once
/// it runs one: the keeper's command line names that folder. On macOS and
/// Linux the keeper's guard is a fork of it with the same command line, so
/// the keeper is the one whose parent is not such a process, and its
/// program is a child that is not.
fn keeper_children(dirs: &TestDirs) -> Option<(u32, u32)> {
    let table = process_table::Native
        .processes()
        .expect("read the process table");
    let data = dirs.data.to_string_lossy().into_owned();
    let is_keeper = |pid: u32| {
        table.iter().any(|row| {
            row.pid == pid
                && row
                    .command_line
                    .as_deref()
                    .is_some_and(|line| line.contains(" keeper ") && line.contains(&data))
        })
    };
    let keeper = table
        .iter()
        .find(|row| is_keeper(row.pid) && !is_keeper(row.parent_pid))?;
    let program = table
        .iter()
        .find(|row| row.parent_pid == keeper.pid && !is_keeper(row.pid))?;
    Some((keeper.pid, program.pid))
}

// ---------------------------------------------------------------------------
// S9: a host a desktop started is not idle while its keeper holds a session
// it took back, and its idle exit takes the keeper with it
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s9_a_desktop_host_is_not_idle_while_its_keeper_holds_a_session_and_its_idle_exit_ends_the_keeper()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let mut first = KillableHost::start(&dirs, &agent);
    let endpoint = dirs.floti_endpoint();
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let folder = dirs.folder("a project");
    let release = dirs.root().join("release");
    let args = format!("--fake-exit-on=\"{}\" && exit 0", release.to_string_lossy());
    let (session, pid) = fake_session(&mut client, &agent, &folder, &args, 1).await;
    let keeper = keeper_above(pid);
    drop(client);
    first.kill();

    let mut second = KillableHost::start_desktop(&dirs, &agent);
    let ids = |listed: Vec<SessionRecord>| listed.iter().map(|s| s.id).collect::<Vec<_>>();
    let client = TestClient::connect(&endpoint, TERMINAL).await;
    drop(client);
    // Its only client left with nothing but the session it took back
    // running: it stays, and the next client finds that session there.
    let mut later = TestClient::connect(&endpoint, TERMINAL).await;
    assert_eq!(
        ids(later.request::<SessionList>(&()).await.unwrap()),
        [session]
    );
    drop(later);

    // The session ends with nobody attached: the host goes, and its keeper.
    std::fs::write(&release, "").unwrap();
    second.ended().await;
    until("the keeper ended with the host", || {
        !alive(keeper) && !alive(pid)
    })
    .await;
    assert_eq!(rows(&dirs.data)[0].1, "exited");
}

// ---------------------------------------------------------------------------
// S7: a stop for an update ends the keeper too and leaves the rows for the
// next start's one restore offer
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s7_a_stop_for_an_update_ends_the_keeper_and_the_next_start_offers_its_sessions() {
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
// S11: a host dropped without a stop leaves its sessions in the keeper
// ---------------------------------------------------------------------------

#[test]
fn s11_a_host_dropped_without_a_stop_leaves_its_sessions_running_in_the_keeper() {
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
    record_test_host(&dirs.floti_endpoint(), &dirs.data);
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

// ---------------------------------------------------------------------------
// S8: after a crash, a device's quit ends what it started, as before it, and
// leaves what other devices started
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s8_a_reattached_session_ends_with_its_devices_quit_and_another_devices_keeps_running() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.floti_endpoint();
    let first = in_process(&dirs, &agent, &[]);
    let theirs = dirs.folder("their project");
    let mine = dirs.folder("my project");
    let my_shell = dirs.folder("my shell");

    let mut other = TestClient::connect(&endpoint, TERMINAL).await;
    let kept = other
        .request::<SessionStart>(&start_request(&theirs))
        .await
        .unwrap();
    let laptop = TestClient::new_device();
    let mut quitting = TestClient::connect_device(&endpoint, &laptop, TERMINAL).await;
    let ended = quitting
        .request::<SessionStart>(&start_request(&mine))
        .await
        .unwrap();
    let terminal = fake_terminal(&mut quitting, &agent, &my_shell, 1).await;
    let kept_pid = run_in(&agent, &theirs).await;
    let ended_pid = run_in(&agent, &mine).await;
    let terminal_pid = run_in(&agent, &my_shell).await;
    drop(other);
    drop(quitting);

    first.crash().await;
    for pid in [kept_pid, ended_pid, terminal_pid] {
        assert!(alive(pid), "{pid} ended with the crashed host");
    }

    let second = in_process(&dirs, &agent, &[]);
    let mut other = TestClient::connect(&endpoint, TERMINAL).await;
    let mut quitting = TestClient::connect_device(&endpoint, &laptop, TERMINAL).await;
    // Each device is still told only what it started.
    let ids = |sessions: Vec<DeviceSession>| sessions.iter().map(|s| s.id).collect::<Vec<_>>();
    assert_eq!(
        ids(quitting.request::<HostDeviceSessions>(&()).await.unwrap()),
        [ended.id]
    );
    assert_eq!(
        ids(other.request::<HostDeviceSessions>(&()).await.unwrap()),
        [kept.id]
    );

    other.subscribe_quietly(1, SessionExit::NAME).await;
    other.subscribe_quietly(2, PtermExit::NAME).await;
    // A barrier: the subscriptions are in place once this is answered.
    other.request::<SessionList>(&()).await.unwrap();
    quitting
        .request::<HostQuit>(&HostQuitRequest { end: true })
        .await
        .unwrap();
    let exit = other
        .event_on::<SessionRecord>(1, "the quitting device's session ending", |_| true)
        .await;
    assert_eq!(exit.id, ended.id);
    other
        .event_on::<PtermExited>(2, "the quitting device's terminal ending", |exited| {
            exited.id == terminal
        })
        .await;
    until("the quitting device's session and terminal ended", || {
        !alive(ended_pid) && !alive(terminal_pid)
    })
    .await;
    assert!(alive(kept_pid), "another device's session ended");
    let status = |id: u64| {
        rows(&dirs.data)
            .into_iter()
            .find(|row| u64::try_from(row.0).ok() == Some(id))
            .map(|row| row.1)
    };
    assert_eq!(status(ended.id).as_deref(), Some("exited"));
    assert_eq!(status(kept.id).as_deref(), Some("running"));
    assert_eq!(
        other
            .request::<SessionList>(&())
            .await
            .unwrap()
            .iter()
            .map(|s| s.id)
            .collect::<Vec<_>>(),
        [kept.id]
    );

    second.stop(HostStopReason::Stop).await;
    until("the other device's session ended with the stop", || {
        !alive(kept_pid)
    })
    .await;
}
