//! Processes and ports as a client of the host sees them: a client watching
//! the sessions pane is sent each hosted session's process tree, with command
//! lines, and the ports its processes listen on, read from the machine
//! through the OS's own calls. Driven against the fake agent, whose
//! `--fake-listen` child listens on a port on 127.0.0.1, never a real agent.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::fake_agent;
use floti_host::platform::process_tree::{Native as NativeTree, ProcessTree};
use floti_host::platform::socket::Endpoint;
use floti_host::server::{Host, HostConfig};
use floti_host::testkit::{FakeAgent, PATIENCE, RunningHost, TestClient, TestDirs};
use floti_protocol::channel::from_payload;
use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    CloseSessionRequest, SessionClose, SessionPort, SessionResources, SessionStart, SessionsWatch,
    SessionsWatchRequest, StartSessionRequest,
};
use floti_protocol::{Knowable, Message};

const TERMINAL: &[&str] = &["terminal"];
const RESOURCES: u64 = 5;

/// A host whose one backend is the fake agent, run with `args`.
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
        inherited_env: std::env::vars_os()
            .filter(|(key, _)| key != "SHELL")
            .chain([(OsString::from("SHELL"), OsString::from("/bin/sh"))])
            .collect(),
    }
}

fn start_request(folder: &Path) -> StartSessionRequest {
    StartSessionRequest {
        cwd: folder.to_string_lossy().into_owned(),
        cols: 80,
        rows: 24,
        ..StartSessionRequest::default()
    }
}

/// `path` with links resolved, in the form a process reports its own folder
/// in (no `\\?\` on Windows).
fn resolved(path: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = canonical.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(plain) => PathBuf::from(plain),
        None => canonical,
    }
}

/// The fake agent's run in `folder`.
fn run_in(agent: &FakeAgent, folder: &Path, with_child: bool) -> (u32, Vec<u32>) {
    let deadline = Instant::now() + PATIENCE;
    let real = resolved(folder);
    loop {
        if let Some(run) = agent.records().into_iter().find(|record| {
            (Path::new(&record.cwd) == folder || Path::new(&record.cwd) == real)
                && record.children.is_empty() != with_child
                && !record
                    .argv
                    .iter()
                    .any(|arg| arg.starts_with("--fake-serve"))
        }) {
            return (run.pid, run.children);
        }
        assert!(
            Instant::now() < deadline,
            "no run in {} as expected",
            folder.display()
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The next `sessions:resources` set, snapshot or event, that `wanted`
/// accepts.
async fn next_set(
    client: &mut TestClient,
    wanted: impl Fn(&[SessionResources]) -> bool,
) -> Vec<SessionResources> {
    let deadline = Instant::now() + PATIENCE;
    let mut seen = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let payload = match client.next(left).await {
            Some(Message::Event(event)) if event.subscription == RESOURCES => event.payload,
            Some(Message::Snapshot(snapshot)) if snapshot.subscription == RESOURCES => {
                snapshot.state
            }
            Some(_) => continue,
            None => panic!("no wanted set of resources; saw {seen:#?}"),
        };
        let set: Vec<SessionResources> = from_payload(&payload).expect("decode a set");
        if wanted(&set) {
            return set;
        }
        seen.push(set);
    }
}

fn session_in(set: &[SessionResources], id: u64) -> Option<&SessionResources> {
    set.iter().find(|session| session.id == id)
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

/// What a session whose program started a listening child should show:
/// the program at depth 0, the child at depth 1 with its full command line,
/// and the child's port on it and in the session's ports, on 127.0.0.1.
fn assert_program_and_listening_child(
    session: &SessionResources,
    program: u32,
    child: u32,
    port: u16,
) {
    assert_eq!(session.root_pid, program, "{session:#?}");
    assert!(session.root_seen, "{session:#?}");
    let processes = session.processes.as_ref().expect("the tree");
    assert_eq!(processes.len(), 2, "{processes:#?}");
    let (root, listener) = (&processes[0], &processes[1]);
    assert_eq!((root.pid, root.depth), (program, 0));
    assert_eq!(root.ports, Some(Vec::new()));
    assert_eq!(
        (listener.pid, listener.parent_pid, listener.depth),
        (child, program, 1)
    );
    assert!(
        format!("floti-fake-agent{}", std::env::consts::EXE_SUFFIX).starts_with(&listener.name),
        "{listener:?}"
    );
    let line = listener
        .command_line
        .as_deref()
        .expect("the child's command line");
    assert!(line.contains("floti-fake-agent"), "{line}");
    assert!(line.contains("--fake-serve="), "{line}");
    assert_eq!(listener.ports, Some(vec![port]));
    assert_eq!(
        session.ports,
        Some(vec![SessionPort {
            port,
            pid: child,
            process: listener.name.clone(),
            addresses: vec!["127.0.0.1".into()],
        }])
    );
    assert_eq!(session.opaque, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn s1_s14_a_watching_client_sees_the_programs_child_its_command_line_and_the_port_it_listens_on()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &["--fake-listen"]));
    let folder = dirs.folder("a project");
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;

    // Served, not refused: the subscription starts with the set, empty.
    match client.subscribe_on(RESOURCES, "sessions:resources").await {
        Message::Snapshot(snapshot) => {
            let set: Vec<SessionResources> = from_payload(&snapshot.state).unwrap();
            assert_eq!(set, vec![]);
        }
        other => panic!("not served: {other:?}"),
    }
    client
        .request::<SessionsWatch>(&SessionsWatchRequest { watching: true })
        .await
        .expect("watching is served");

    let session: SessionRecord = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    let (program, children) = run_in(&agent, &folder, true);
    let child = children[0];
    let port = agent
        .wait_for_record(child, PATIENCE, |record| record.listening.is_some())
        .listening
        .unwrap();

    let set = next_set(&mut client, |set| {
        session_in(set, session.id).is_some_and(|session| {
            session
                .processes
                .iter()
                .flatten()
                .any(|process| process.pid == child && process.ports == Some(vec![port]))
        })
    })
    .await;
    assert_eq!(set.len(), 1, "{set:#?}");
    assert_program_and_listening_child(&set[0], program, child, port);

    client
        .request::<SessionClose>(&CloseSessionRequest {
            id: session.id,
            force: true,
        })
        .await
        .unwrap();
    host.stop(HostStopReason::Stop).await;
    assert_all_end(&[program, child]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s4_s12_a_program_that_started_nothing_is_its_whole_tree_and_an_ended_session_leaves_the_set()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(fake_config(&dirs, &endpoint, &agent, &[]));
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    client.subscribe_on(RESOURCES, "sessions:resources").await;

    let folder = dirs.folder("a project");
    let session: SessionRecord = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    let other_folder = dirs.folder("another project");
    let other: SessionRecord = client
        .request::<SessionStart>(&start_request(&other_folder))
        .await
        .unwrap();
    let (program, _) = run_in(&agent, &folder, false);
    let (other_program, _) = run_in(&agent, &other_folder, false);
    client
        .request::<SessionsWatch>(&SessionsWatchRequest { watching: true })
        .await
        .unwrap();

    // Each running session once, rooted at its terminal's pid: the program
    // alone, holding nothing, which is an empty list and not Unknown.
    let set = next_set(&mut client, |set| set.len() == 2).await;
    for (id, pid) in [(session.id, program), (other.id, other_program)] {
        let found = session_in(&set, id).unwrap_or_else(|| panic!("{id} in {set:#?}"));
        assert_eq!(found.root_pid, pid);
        assert!(found.root_seen);
        let processes = found.processes.as_ref().unwrap();
        assert_eq!(
            processes
                .iter()
                .map(|process| (process.pid, process.depth, process.ports.clone()))
                .collect::<Vec<_>>(),
            [(pid, 0, Some(Vec::new()))]
        );
        assert_eq!(found.ports, Some(Vec::new()));
    }

    // An ended session is not reported, without waiting for the interval.
    client
        .request::<SessionClose>(&CloseSessionRequest {
            id: session.id,
            force: true,
        })
        .await
        .unwrap();
    let after = next_set(&mut client, |set| session_in(set, session.id).is_none()).await;
    assert_eq!(
        after.iter().map(|found| found.id).collect::<Vec<_>>(),
        [other.id]
    );

    // Stopping watching keeps the last set.
    client
        .request::<SessionsWatch>(&SessionsWatchRequest { watching: false })
        .await
        .unwrap();
    let mut late = TestClient::connect(&endpoint, TERMINAL).await;
    match late.subscribe_on(RESOURCES, "sessions:resources").await {
        Message::Snapshot(snapshot) => {
            let kept: Vec<SessionResources> = from_payload(&snapshot.state).unwrap();
            assert_eq!(
                kept.iter().map(|found| found.id).collect::<Vec<_>>(),
                [other.id]
            );
        }
        other => panic!("not served: {other:?}"),
    }
    host.stop(HostStopReason::Stop).await;
    assert_all_end(&[program, other_program]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s9_a_session_detail_ask_inside_the_host_gets_one_pass_with_nobody_watching() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = Host::start(fake_config(&dirs, &endpoint, &agent, &["--fake-listen"]))
        .expect("start the host");
    let folder = dirs.folder("a project");
    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    let session: SessionRecord = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .unwrap();
    let (program, children) = run_in(&agent, &folder, true);
    let child = children[0];
    let port = agent
        .wait_for_record(child, PATIENCE, |record| record.listening.is_some())
        .listening
        .unwrap();

    let set = host.session_resources().await;
    assert_eq!(set.len(), 1, "{set:#?}");
    assert_eq!(set[0].id, session.id);
    assert_program_and_listening_child(&set[0], program, child, port);

    drop(client);
    host.stop(HostStopReason::Stop);
    tokio::time::timeout(PATIENCE, host.run_until_stopped())
        .await
        .expect("the host stops in time")
        .expect("the host stops cleanly");
    assert_all_end(&[program, child]).await;
}
