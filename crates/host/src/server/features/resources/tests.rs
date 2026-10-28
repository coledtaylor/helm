//! The pass behind the sessions pane, against a machine arranged by hand:
//! which sessions it reports and at which pid, and when it is allowed to
//! cost anything at all. Today's service cases, with the same inputs and
//! expectations, and the per-client watching the host adds.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

use floti_protocol::channels::sessions::{SessionPort, SessionResources};
use tokio::sync::broadcast;

use super::{LiveRoot, Passes};
use crate::platform::process_table::{PortRow, ProcessRow, ProcessTable};
use crate::server::events::{Events, Publication};
use crate::session::ClientId;
use crate::{Error, Result};

const A: ClientId = ClientId(1);
const B: ClientId = ClientId(2);
/// Listens to the events, as a connection would.
const LISTENER: ClientId = ClientId(99);

/// Long enough that no interval falls inside a test that does not want one.
const NEVER: Duration = Duration::from_secs(600);
/// Short enough that a test sees several intervals.
const BRISK: Duration = Duration::from_millis(200);

/// What the arranged machine answers.
#[derive(Clone)]
enum Answer {
    Rows(Vec<ProcessRow>, Vec<PortRow>),
    /// Neither half could be read.
    Unknown,
    /// The reader fails outright.
    Panic,
}

/// A machine arranged by hand, counting its reads, which a test can hold
/// shut to keep a pass running.
struct Machine {
    answer: Mutex<Answer>,
    reads: AtomicUsize,
    running: AtomicUsize,
    most_at_once: AtomicUsize,
    open: Mutex<bool>,
    opened: Condvar,
}

impl Machine {
    fn new(answer: Answer) -> Arc<Self> {
        Arc::new(Self {
            answer: Mutex::new(answer),
            reads: AtomicUsize::new(0),
            running: AtomicUsize::new(0),
            most_at_once: AtomicUsize::new(0),
            open: Mutex::new(true),
            opened: Condvar::new(),
        })
    }

    fn answer(&self, answer: Answer) {
        *self.answer.lock().unwrap_or_else(PoisonError::into_inner) = answer;
    }

    fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }

    fn hold(&self) {
        *self.open.lock().unwrap() = false;
    }

    fn release(&self) {
        *self.open.lock().unwrap() = true;
        self.opened.notify_all();
    }

    fn current(&self) -> Answer {
        self.answer
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl ProcessTable for Machine {
    fn processes(&self) -> Result<Vec<ProcessRow>> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let now = self.running.fetch_add(1, Ordering::SeqCst) + 1;
        self.most_at_once.fetch_max(now, Ordering::SeqCst);
        let mut open = self.open.lock().unwrap();
        while !*open {
            open = self.opened.wait(open).unwrap();
        }
        drop(open);
        self.running.fetch_sub(1, Ordering::SeqCst);
        match self.current() {
            Answer::Rows(processes, _) => Ok(processes),
            Answer::Unknown => Err(Error::unsupported("the process table")),
            Answer::Panic => panic!("the arranged reader fails outright"),
        }
    }

    fn listening(&self) -> Result<Vec<PortRow>> {
        match self.current() {
            Answer::Rows(_, ports) => Ok(ports),
            Answer::Unknown | Answer::Panic => Err(Error::unsupported("the listening sockets")),
        }
    }
}

fn proc(pid: u32, parent_pid: u32, name: &str, command_line: Option<&str>) -> ProcessRow {
    ProcessRow {
        pid,
        parent_pid,
        name: name.to_owned(),
        command_line: command_line.map(str::to_owned),
    }
}

fn port(pid: u32, port: u16, address: &str) -> PortRow {
    PortRow {
        pid,
        port,
        address: Some(address.to_owned()),
    }
}

/// Two hosted sessions alive (terminals 100 and 200), one ended (terminal
/// 300, which is not running so is not a root), and a `claude` the host did
/// not start (999) holding the same port as a child of the first session.
fn machine() -> Answer {
    Answer::Rows(
        vec![
            proc(100, 4, "cmd.exe", Some("cmd.exe /c claude.cmd")),
            proc(101, 100, "node.exe", Some("node claude.js")),
            proc(102, 101, "vite.exe", Some("vite --port 5173")),
            proc(200, 4, "cmd.exe", Some("cmd.exe /c claude.cmd")),
            proc(201, 200, "node.exe", None),
            proc(300, 4, "cmd.exe", Some("cmd.exe /c claude.cmd")),
            proc(999, 4, "claude.exe", Some("claude")),
        ],
        vec![port(102, 5173, "127.0.0.1"), port(999, 5173, "0.0.0.0")],
    )
}

/// The running hosted sessions, as the host holds them.
fn roots() -> Vec<LiveRoot> {
    vec![LiveRoot { id: 1, pid: 100 }, LiveRoot { id: 2, pid: 200 }]
}

struct World {
    passes: Arc<Passes>,
    machine: Arc<Machine>,
    heard: broadcast::Receiver<Publication>,
}

impl World {
    fn new(answer: Answer, every: Duration) -> Self {
        let machine = Machine::new(answer);
        let events = Arc::new(Events::new());
        let passes = Passes::new(
            roots,
            Arc::clone(&machine) as Arc<dyn ProcessTable>,
            Arc::clone(&events),
            every,
        )
        .unwrap();
        let heard = events.listen(LISTENER);
        Self {
            passes,
            machine,
            heard,
        }
    }

    /// Every `sessions:resources` push since the last call.
    fn pushes(&mut self) -> Vec<Vec<SessionResources>> {
        let mut pushes = Vec::new();
        while let Ok(publication) = self.heard.try_recv() {
            if publication.channel == "sessions:resources" {
                pushes.push(floti_protocol::channel::from_payload(&publication.payload).unwrap());
            }
        }
        pushes
    }

    fn stop(&self) {
        self.passes.stopped_watching(A);
        self.passes.stopped_watching(B);
        self.machine.release();
    }
}

/// Waits until `done` holds, and fails naming `what` when it never does.
async fn until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// A session's id, root and each process's (pid, depth).
type Shape = (u64, u32, Vec<(u32, u32)>);

fn shape(resources: &[SessionResources]) -> Vec<Shape> {
    resources
        .iter()
        .map(|session| {
            (
                session.id,
                session.root_pid,
                session
                    .processes
                    .iter()
                    .flatten()
                    .map(|process| (process.pid, process.depth))
                    .collect(),
            )
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn s12_each_running_session_is_reported_once_at_its_terminals_pid_and_only_a_change_is_sent()
{
    let mut world = World::new(machine(), NEVER);
    world.passes.watch(A, true);
    let landed = world.passes.one_pass().await;

    // Watching started a pass, and the ask joined it.
    assert_eq!(world.machine.reads(), 1);
    assert_eq!(
        shape(&landed),
        [
            (1, 100, vec![(100, 0), (101, 1), (102, 2)]),
            (2, 200, vec![(200, 0), (201, 1)]),
        ]
    );
    // The port the outside `claude` holds is not this session's, whatever
    // its number.
    assert_eq!(
        landed[0].ports,
        Some(vec![SessionPort {
            port: 5173,
            pid: 102,
            process: "vite.exe".into(),
            addresses: vec!["127.0.0.1".into()],
        }])
    );
    assert_eq!(landed[1].ports, Some(Vec::new()));
    assert_eq!(landed[1].opaque, 1);
    assert_eq!(world.pushes(), std::slice::from_ref(&landed));

    // The same machine again, read later, moves nothing, so nothing is sent.
    tokio::time::sleep(Duration::from_millis(5)).await;
    let again = world.passes.one_pass().await;
    assert_eq!(world.machine.reads(), 2);
    assert!(world.pushes().is_empty());
    assert_eq!(shape(&again), shape(&landed));

    // A new port is a change, and the whole set is sent.
    let Answer::Rows(processes, mut ports) = machine() else {
        unreachable!()
    };
    ports.push(port(201, 3000, "::1"));
    world.machine.answer(Answer::Rows(processes, ports));
    let moved = world.passes.one_pass().await;
    assert_eq!(
        moved[1].processes.as_ref().unwrap()[1].ports,
        Some(vec![3000])
    );
    assert_eq!(world.pushes(), [moved]);

    // So is a half turning Unknown.
    world.machine.answer(Answer::Unknown);
    let unknown = world.passes.one_pass().await;
    let pushed = world.pushes();
    assert_eq!(pushed, std::slice::from_ref(&unknown));
    assert!(unknown.iter().all(|session| session.ports.is_none()));
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn s6_s7_s8_nothing_is_read_unwatched_a_running_pass_is_joined_and_passes_run_while_any_client_watches()
 {
    let world = World::new(machine(), BRISK);

    // Sessions running, nobody looking: the machine is not read.
    tokio::time::sleep(BRISK * 4).await;
    assert_eq!(world.machine.reads(), 0);

    // Watching starts a pass at once. While it runs, an ask, a second
    // watcher and the interval all join it.
    world.machine.hold();
    world.passes.watch(A, true);
    until("the first pass", || world.machine.reads() == 1).await;
    let asked = tokio::spawn({
        let passes = Arc::clone(&world.passes);
        async move { passes.one_pass().await }
    });
    world.passes.watch(B, true);
    world.passes.session_ended();
    tokio::time::sleep(BRISK * 3).await;
    assert_eq!(world.machine.reads(), 1, "a second pass started");
    world.machine.release();
    let landed = asked.await.unwrap();
    assert_eq!(shape(&landed).len(), 2);

    // Every interval while somebody watches.
    let from = world.machine.reads();
    until("passes on the interval", || {
        world.machine.reads() >= from + 3
    })
    .await;

    // One client stopping never stops the passes the other is watching.
    world.passes.watch(B, false);
    let from = world.machine.reads();
    until("passes for the client still watching", || {
        world.machine.reads() >= from + 2
    })
    .await;

    // The last watcher leaving stops them, and the last result is kept.
    world.passes.stopped_watching(A);
    tokio::time::sleep(BRISK).await;
    let stopped_at = world.machine.reads();
    tokio::time::sleep(BRISK * 4).await;
    assert_eq!(world.machine.reads(), stopped_at);
    assert_eq!(shape(&world.passes.current()).len(), 2);
    assert_eq!(world.machine.most_at_once.load(Ordering::SeqCst), 1);
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn s9_a_session_detail_ask_with_nobody_watching_runs_exactly_one_pass() {
    let world = World::new(machine(), BRISK);
    let landed = world.passes.one_pass().await;
    assert_eq!(world.machine.reads(), 1);
    assert_eq!(
        landed.iter().map(|session| session.id).collect::<Vec<_>>(),
        [1, 2]
    );
    assert_eq!(landed, world.passes.current());

    // It costs nothing afterwards.
    tokio::time::sleep(BRISK * 4).await;
    assert_eq!(world.machine.reads(), 1);

    // A session ending with nobody looking reads nothing either.
    world.passes.session_ended();
    tokio::time::sleep(BRISK).await;
    assert_eq!(world.machine.reads(), 1);
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn s8_a_session_ending_runs_a_pass_while_somebody_watches() {
    let world = World::new(machine(), NEVER);
    world.passes.watch(A, true);
    // Joins the pass watching started, or starts one if that has landed.
    // Either way no pass is in flight once it returns, so the ending below
    // cannot join one and must start its own.
    world.passes.one_pass().await;
    let before = world.machine.reads();
    world.passes.session_ended();
    until("a pass for the ended session", || {
        world.machine.reads() > before
    })
    .await;
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn s13_a_machine_that_could_not_be_asked_is_unknown_and_a_reader_that_fails_outright_changes_nothing()
 {
    let mut world = World::new(Answer::Unknown, BRISK);
    world.passes.watch(A, true);
    let unknown = world.passes.one_pass().await;
    let halves: Vec<(u64, bool, bool)> = unknown
        .iter()
        .map(|session| {
            (
                session.id,
                session.processes.is_none(),
                session.ports.is_none(),
            )
        })
        .collect();
    assert_eq!(halves, [(1, true, true), (2, true, true)]);
    world.pushes();

    // A reader that fails outright says nothing and changes nothing.
    world.machine.answer(Answer::Panic);
    let failed = world.passes.one_pass().await;
    assert_eq!(failed, unknown);
    assert_eq!(world.passes.current(), unknown);
    assert!(world.pushes().is_empty());

    // The next interval's pass still runs.
    world.machine.answer(machine());
    until("a pass after the failed one", || {
        world
            .passes
            .current()
            .iter()
            .all(|session| session.processes.is_some())
    })
    .await;
    world.stop();
}
