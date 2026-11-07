//! Running sessions: a program in a pty, its screen, and the clients
//! attached to it.
//!
//! A session's pty is held one of two ways. Run here, the program is in a
//! pty of this process, tied to its life, with two threads: one reads the pty
//! and hands every byte to the screen and to each attached client, under the
//! same lock an attach takes, so a client attaching gets the screen as of one
//! byte and the live output from the next, with nothing missing or repeated;
//! the other waits for the program to exit, then releases the pty, lets the
//! output drain, records the exit, tells the clients and drops the screen.
//! That is how the session keeper runs every program it holds.
//!
//! Run in the keeper, which is how the host runs them, the program's pty and
//! tree are the keeper's ([`crate::keeper`]), and outlive this process. The
//! keeper sends every byte the program writes, which reaches the screen and
//! the clients here the same way, and says when the program has ended; what
//! is typed, a resize and an ending go to the keeper.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use floti_protocol::BackendId;
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::sync::watch;

use super::env::session_env;
use super::ledger::{NewSessionRow, SessionId, SessionLedger, SessionOrigin};
use super::person::is_a_person_typing;
use super::report::{ProgramStatus, ReportedStatus};
use super::screen::{Screen, TermSize};
use crate::agent::LaunchSpec;
use crate::agent::launch_folder::remove_launch_folder;
use crate::keeper::{Held, HeldKind, Keeper, KeeperLink, KeptTerminal, Label, StartPty};
use crate::platform::process_tree::{Ending, ProcessTree};
use crate::{Error, Result};

/// How long a program has to end after it is asked politely, before its
/// whole tree is ended. Today's app gives the same.
pub const GRACE: Duration = Duration::from_millis(1500);

/// What a closed session's grace thread does: waits up to [`GRACE`] for the
/// program to exit (`exited_within`), and ends its tree outright (`force`)
/// when it has not. Apart from the waiting, so a test can step it.
pub(super) fn end_after_grace(exited_within: impl FnOnce(Duration) -> bool, force: impl FnOnce()) {
    if !exited_within(GRACE) {
        force();
    }
}

/// How long the output of a program that has exited may keep arriving
/// before the session is reported ended without the rest. A child that kept
/// the terminal open would otherwise hold the session open.
const DRAIN: Duration = Duration::from_secs(2);

/// How many of the last lines of text on a screen are handed on when its
/// session ends: what a command child's parent is told with its exit.
pub const LAST_LINES: usize = 40;

const READ_CHUNK: usize = 64 * 1024;

/// A request for the cursor's position (DSR 6), and the answer for an empty
/// screen.
const CURSOR_REQUEST: &[u8] = b"\x1b[6n";
const CURSOR_AT_START: &[u8] = b"\x1b[1;1R";

/// What a session whose keeper died is recorded as having ended with: the
/// host never learned how it ended.
const LOST_EXIT: SessionExit = SessionExit {
    code: 1,
    signal: None,
};

enum Opening {
    /// Too little output yet to tell whether it opens with the request.
    Pending,
    /// Settled; what is left is ordinary output.
    Done,
}

/// One client of the host, as the server numbers them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ClientId(pub u64);

/// What an attached client is sent, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionOutput {
    /// Bytes the program wrote, exactly as the pty gave them.
    Data(Arc<[u8]>),
    /// The session now has this size: a client typed at another size.
    Resized(TermSize),
    /// The program exited. Nothing follows.
    Exited(SessionExit),
}

/// How a session's program ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionExit {
    pub code: u32,
    /// The signal that ended it, where the OS reports one.
    pub signal: Option<String>,
}

/// What a client attaching to a session gets.
#[derive(Debug)]
pub struct Attachment {
    /// Bytes that draw the session's current screen in an empty terminal of
    /// `size`.
    pub redraw: Vec<u8>,
    /// The session's size when the screen was drawn.
    pub size: TermSize,
    /// Everything after the screen.
    pub output: UnboundedReceiver<SessionOutput>,
}

/// A session to start.
#[derive(Debug, Clone)]
pub struct StartSession {
    /// What to run, from the session's agent backend.
    pub spec: LaunchSpec,
    /// The session's name.
    pub name: String,
    /// The starting client's terminal size.
    pub size: TermSize,
    /// The client that started it, whose size it has until another types.
    pub client: Option<ClientId>,
    /// The agent's own id for the conversation, when the launch chose one.
    pub conversation_id: Option<String>,
    /// The agent backend that composed `spec`, recorded in the row.
    pub backend: BackendId,
    /// Where the launch came from, recorded in the row.
    pub origin: SessionOrigin,
    /// The fingerprint of the device that started it, kept with it in the
    /// keeper so a host that took it back knows whose quit ends it.
    pub opened_by: Option<String>,
}

/// The sessions running on this host.
#[derive(Clone)]
pub struct SessionHost {
    shared: Arc<Shared>,
}

struct Shared {
    inherited_env: Vec<(OsString, OsString)>,
    ledger: Arc<dyn SessionLedger>,
    spawner: Spawner,
    sessions: Mutex<BTreeMap<SessionId, Arc<Session>>>,
    /// Told whenever a session's reported status changes.
    status_watchers: Mutex<Vec<StatusWatcher>>,
}

type StatusWatcher = Box<dyn Fn() + Send + Sync>;

impl Shared {
    fn status_changed(&self) {
        for watcher in lock(&self.status_watchers).iter() {
            watcher();
        }
    }
}

/// Where a host's programs run.
enum Spawner {
    /// In ptys of this process, each tree ended through `tree` and tied to
    /// this process's life.
    Here(Arc<dyn ProcessTree + Send + Sync>),
    /// In the session keeper, labelled as `kind`.
    Keeper { keeper: Arc<Keeper>, kind: HeldKind },
}

impl SessionHost {
    /// A host whose sessions run in this process, inherit `inherited_env`
    /// (the host's own environment, less what [`session_env`] removes),
    /// record themselves in `ledger` and are ended through `tree`.
    pub fn new(
        inherited_env: Vec<(OsString, OsString)>,
        ledger: Arc<dyn SessionLedger>,
        tree: Arc<dyn ProcessTree + Send + Sync>,
    ) -> Self {
        Self::with(inherited_env, ledger, Spawner::Here(tree))
    }

    /// A host whose sessions run in `keeper`, labelled as `kind`, and record
    /// themselves in `ledger`. Their environment is the keeper's own, which
    /// is the one `keeper` was made with.
    pub fn kept(ledger: Arc<dyn SessionLedger>, keeper: Arc<Keeper>, kind: HeldKind) -> Self {
        Self::with(Vec::new(), ledger, Spawner::Keeper { keeper, kind })
    }

    fn with(
        inherited_env: Vec<(OsString, OsString)>,
        ledger: Arc<dyn SessionLedger>,
        spawner: Spawner,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                inherited_env,
                ledger,
                spawner,
                sessions: Mutex::new(BTreeMap::new()),
                status_watchers: Mutex::new(Vec::new()),
            }),
        }
    }

    /// Calls `watcher` each time a session's reported status changes, from
    /// the thread that read the report. It must not block.
    pub fn on_status_change(&self, watcher: impl Fn() + Send + Sync + 'static) {
        lock(&self.shared.status_watchers).push(Box::new(watcher));
    }

    /// Tells the status watchers that something a session's status read is
    /// judged against has moved though no program reported anything, such as
    /// a child's report to its parent, which its card shows.
    pub fn status_moved(&self) {
        self.shared.status_changed();
    }

    /// Starts a session: its program in a new pty in its folder, its row
    /// written once it has spawned.
    pub fn start(&self, request: StartSession) -> Result<Arc<Session>> {
        match &self.shared.spawner {
            Spawner::Here(tree) => self
                .start_here(request, Arc::clone(tree), None)
                .map(|(session, _)| session),
            Spawner::Keeper { keeper, kind } => self.start_kept(request, keeper, *kind),
        }
    }

    /// Starts a session here with `client` attached from its first byte, so
    /// that client is sent everything the program writes and no screen.
    pub fn start_attached(
        &self,
        request: StartSession,
        client: ClientId,
    ) -> Result<(Arc<Session>, Attachment)> {
        let Spawner::Here(tree) = &self.shared.spawner else {
            return Err(Error::Refused(
                "Sessions held by the session keeper are attached through it.".to_owned(),
            ));
        };
        let (session, attachment) = self.start_here(request, Arc::clone(tree), Some(client))?;
        let attachment = attachment.ok_or_else(|| {
            Error::Refused(format!("Session {} could not be attached.", session.id))
        })?;
        Ok((session, attachment))
    }

    /// Takes back a program the keeper held when this host started: a
    /// session, or a plain terminal, running under the id its label gives,
    /// with the screen the keeper drew and its output from then on.
    pub fn adopt(&self, held: Held, label: &Label) -> Result<Arc<Session>> {
        let Spawner::Keeper { keeper, .. } = &self.shared.spawner else {
            return Err(Error::Refused(
                "Only sessions run in the session keeper are taken back.".to_owned(),
            ));
        };
        let link = keeper.link()?;
        let mut screen = Screen::new(held.size);
        screen.feed(&held.redraw);
        let session = Arc::new(Session {
            id: SessionId(label.id),
            pid: held.pid,
            name: label.name.clone(),
            host: Arc::downgrade(&self.shared),
            ender: Ender::Kept {
                link: Arc::clone(&link),
                handle: held.handle,
            },
            launch_folder: label.launch_folder.clone(),
            state: Mutex::new(State {
                screen: Some(screen),
                clients: BTreeMap::new(),
                size: held.size,
                typist: None,
                exit: None,
                status: ProgramStatus::default(),
                opening: None,
            }),
            ended: Condvar::new(),
            typed: watch::Sender::new(0),
            person_typed: AtomicBool::new(false),
            pty: Mutex::new(Some(Pty::Kept {
                link: Arc::clone(&link),
                handle: held.handle,
            })),
        });
        lock(&self.shared.sessions).insert(session.id, Arc::clone(&session));
        link.route(held.handle, kept_terminal(&session));
        Ok(session)
    }

    fn start_here(
        &self,
        request: StartSession,
        tree: Arc<dyn ProcessTree + Send + Sync>,
        attach: Option<ClientId>,
    ) -> Result<(Arc<Session>, Option<Attachment>)> {
        let StartSession {
            spec,
            name,
            size,
            client,
            conversation_id,
            backend,
            origin,
            opened_by: _,
        } = request;
        let program = spec.program.to_string_lossy().into_owned();
        let launch_folder = spec.launch_folder.clone();

        let pair = native_pty_system()
            .openpty(pty_size(size))
            .map_err(|err| Error::io("open a pty", io::Error::other(err)))?;
        let mut command = CommandBuilder::new(&spec.program);
        command.args(&spec.args);
        command.cwd(&spec.cwd);
        command.env_clear();
        for (key, value) in session_env(
            self.shared.inherited_env.iter().cloned(),
            spec.env.iter().cloned(),
        ) {
            command.env(key, value);
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|err| Error::io(format!("start {program}"), io::Error::other(err)))?;
        // The program holds the terminal's other end now; the host keeps only
        // its own, so the output ends when the program's side closes.
        drop(pair.slave);
        let master = pair.master;
        let pid = child.process_id().unwrap_or(0);
        let tied = TiedTree::new(Arc::clone(&tree), pid);

        let opened = master
            .try_clone_reader()
            .and_then(|reader| Ok((reader, master.take_writer()?)))
            .map_err(|err| Error::io("open the session's pty", io::Error::other(err)));
        let (reader, writer) = match opened {
            Ok(ends) => ends,
            Err(err) => {
                let _ = child.kill();
                return Err(err);
            }
        };

        let row = new_row(&spec, name.clone(), conversation_id, backend, origin);
        let id = match self.shared.ledger.started(&row) {
            Ok(id) => id,
            Err(err) => {
                let _ = tree.end_tree(pid, Ending::Forced);
                let _ = child.kill();
                return Err(err);
            }
        };

        let session = Arc::new(Session {
            id,
            pid,
            name,
            host: Arc::downgrade(&self.shared),
            ender: Ender::Here(Arc::clone(&tree)),
            launch_folder,
            state: Mutex::new(State {
                screen: Some(Screen::new(size)),
                clients: BTreeMap::new(),
                size,
                typist: client,
                exit: None,
                status: ProgramStatus::default(),
                opening: Some(Vec::new()),
            }),
            ended: Condvar::new(),
            typed: watch::Sender::new(0),
            person_typed: AtomicBool::new(false),
            pty: Mutex::new(Some(Pty::Here { master, writer })),
        });
        // Before the output thread starts: a client attached here misses
        // nothing the program writes.
        let attachment = match attach {
            Some(client) => Some(session.attach(client, size)?),
            None => None,
        };
        lock(&self.shared.sessions).insert(id, Arc::clone(&session));

        let (drained_tx, drained) = mpsc::channel();
        let output = Arc::clone(&session);
        spawn_thread(format!("session {id} output"), move || {
            output.read_output(reader);
            let _ = drained_tx.send(());
        })?;
        let waiting = Arc::clone(&session);
        spawn_thread(format!("session {id} exit"), move || {
            let waited = child.wait();
            drop(tied);
            let exit = match waited {
                Ok(status) => SessionExit {
                    code: status.exit_code(),
                    signal: status.signal().map(str::to_owned),
                },
                Err(_) => SessionExit {
                    code: 1,
                    signal: None,
                },
            };
            waiting.finish(exit, Some(&drained), Finish::Exited);
        })?;
        Ok((session, attachment))
    }

    /// Starts a session in the keeper: the keeper spawns it, then its row is
    /// written and the keeper is told what it is.
    fn start_kept(
        &self,
        request: StartSession,
        keeper: &Keeper,
        kind: HeldKind,
    ) -> Result<Arc<Session>> {
        let StartSession {
            spec,
            name,
            size,
            client,
            conversation_id,
            backend,
            origin,
            opened_by,
        } = request;
        let link = keeper.link()?;
        let (handle, pid) = link.start(StartPty {
            program: spec.program.clone(),
            args: spec.args.clone(),
            cwd: spec.cwd.clone(),
            env: spec.env.clone(),
            size,
        })?;
        let row = new_row(&spec, name.clone(), conversation_id, backend, origin);
        let id = match self.shared.ledger.started(&row) {
            Ok(id) => id,
            Err(err) => {
                link.discard(handle);
                return Err(err);
            }
        };
        // A keeper that has gone takes the program with it, which routing it
        // below then reports as lost.
        if let Err(err) = link.label(
            handle,
            Label {
                kind,
                id: id.0,
                name: name.clone(),
                cwd: spec.cwd.clone(),
                launch_folder: spec.launch_folder.clone(),
                opened_by,
            },
        ) {
            log_line!("floti host: {err}");
        }
        let session = Arc::new(Session {
            id,
            pid,
            name,
            host: Arc::downgrade(&self.shared),
            ender: Ender::Kept {
                link: Arc::clone(&link),
                handle,
            },
            launch_folder: spec.launch_folder,
            state: Mutex::new(State {
                screen: Some(Screen::new(size)),
                clients: BTreeMap::new(),
                size,
                typist: client,
                exit: None,
                status: ProgramStatus::default(),
                // The keeper answers a request that opens the output.
                opening: None,
            }),
            ended: Condvar::new(),
            typed: watch::Sender::new(0),
            person_typed: AtomicBool::new(false),
            pty: Mutex::new(Some(Pty::Kept {
                link: Arc::clone(&link),
                handle,
            })),
        });
        lock(&self.shared.sessions).insert(id, Arc::clone(&session));
        link.route(handle, kept_terminal(&session));
        Ok(session)
    }

    /// The session `id`, while it runs.
    pub fn get(&self, id: SessionId) -> Option<Arc<Session>> {
        lock(&self.shared.sessions).get(&id).cloned()
    }

    /// Every running session, oldest first.
    pub fn list(&self) -> Vec<Arc<Session>> {
        lock(&self.shared.sessions).values().cloned().collect()
    }
}

/// The row a new session's spawn writes.
fn new_row(
    spec: &LaunchSpec,
    name: String,
    conversation_id: Option<String>,
    backend: BackendId,
    origin: SessionOrigin,
) -> NewSessionRow {
    NewSessionRow {
        name,
        cwd: spec.cwd.clone(),
        argv: spec
            .args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect(),
        conversation_id,
        backend,
        origin,
    }
}

fn kept_terminal(session: &Arc<Session>) -> Weak<dyn KeptTerminal> {
    let terminal: Arc<dyn KeptTerminal> = Arc::clone(session) as Arc<dyn KeptTerminal>;
    Arc::downgrade(&terminal)
}

/// A program the host started, its tree tied to the host's life
/// ([`ProcessTree::tie_tree`]) until this is dropped: once the program has
/// been reaped, or its start has failed.
struct TiedTree {
    tree: Arc<dyn ProcessTree + Send + Sync>,
    pid: u32,
}

impl TiedTree {
    fn new(tree: Arc<dyn ProcessTree + Send + Sync>, pid: u32) -> Self {
        tree.tie_tree(pid);
        Self { tree, pid }
    }
}

impl Drop for TiedTree {
    fn drop(&mut self) {
        self.tree.untie_tree(self.pid);
    }
}

/// One running session.
pub struct Session {
    id: SessionId,
    pid: u32,
    name: String,
    /// The sessions it is one of, which it leaves when it ends.
    host: Weak<Shared>,
    /// How its tree is ended.
    ender: Ender,
    /// The launch's own folder, removed when the session ends.
    launch_folder: Option<PathBuf>,
    state: Mutex<State>,
    ended: Condvar,
    /// Counts the times a client has typed into it, so a wait on news can end
    /// at once when a person does.
    typed: watch::Sender<u64>,
    /// Whether a client has typed into it since its last turn ended
    /// ([`Session::person_typed`]). Only [`Session::input`] sets it.
    person_typed: AtomicBool,
    /// Taken when the session is closed or its program exits. Lock order:
    /// `state`, then `pty`.
    pty: Mutex<Option<Pty>>,
}

/// Who ends a session's tree.
enum Ender {
    /// This process, through the OS.
    Here(Arc<dyn ProcessTree + Send + Sync>),
    /// The keeper that holds it.
    Kept { link: Arc<KeeperLink>, handle: u64 },
}

/// A session's way to its terminal.
enum Pty {
    Here {
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
    },
    Kept {
        link: Arc<KeeperLink>,
        handle: u64,
    },
}

impl Pty {
    fn write(&mut self, bytes: &[u8]) -> io::Result<()> {
        match self {
            Self::Here { writer, .. } => writer.write_all(bytes).and_then(|()| writer.flush()),
            Self::Kept { link, handle } => link.input(*handle, bytes),
        }
    }

    fn resize(&self, size: TermSize) -> io::Result<()> {
        match self {
            Self::Here { master, .. } => master.resize(pty_size(size)).map_err(io::Error::other),
            Self::Kept { link, handle } => link.resize(*handle, size),
        }
    }
}

/// How a session came to an end.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Finish {
    /// Its program exited.
    Exited,
    /// Its keeper died, taking it along, and how it ended is not known.
    Lost,
}

struct State {
    /// Dropped when the program exits.
    screen: Option<Screen>,
    clients: BTreeMap<ClientId, Attached>,
    size: TermSize,
    /// The client that typed last, whose size the session has. None until a
    /// client types into a session none started.
    typist: Option<ClientId>,
    exit: Option<SessionExit>,
    /// What the program last reported about itself; cleared when it exits.
    status: ProgramStatus,
    /// The output so far, until it is known whether it opens with a cursor
    /// position request ([`Session::opening_request`]).
    opening: Option<Vec<u8>>,
}

struct Attached {
    size: TermSize,
    output: UnboundedSender<SessionOutput>,
}

impl Session {
    pub fn id(&self) -> SessionId {
        self.id
    }

    /// The program's process id.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// The size of the session's pty and screen.
    pub fn size(&self) -> TermSize {
        lock(&self.state).size
    }

    /// How the program ended, once it has.
    pub fn exit(&self) -> Option<SessionExit> {
        lock(&self.state).exit.clone()
    }

    /// The status its program last reported (OSC 7501), while it runs and
    /// until it clears it. A session taken back after a host restart has
    /// none until the program reports again.
    pub fn reported_status(&self) -> Option<ReportedStatus> {
        lock(&self.state).status.current().cloned()
    }

    /// Whether the session has let go of its pty and its screen.
    pub fn released(&self) -> bool {
        lock(&self.state).screen.is_none() && lock(&self.pty).is_none()
    }

    /// Attaches `client`, whose terminal is `size`: it is sent the current
    /// screen, then everything after it. Attaching again replaces the
    /// earlier attachment. Attaching does not resize the session; typing
    /// does, and so does a terminal reporting its size before anyone has
    /// typed ([`Session::resize`]).
    pub fn attach(&self, client: ClientId, size: TermSize) -> Result<Attachment> {
        let mut state = lock(&self.state);
        let session_size = state.size;
        let Some(screen) = state.screen.as_mut() else {
            return Err(self.has_ended());
        };
        let redraw = screen.redraw();
        let (output, receiver) = unbounded_channel();
        state.clients.insert(client, Attached { size, output });
        Ok(Attachment {
            redraw,
            size: session_size,
            output: receiver,
        })
    }

    /// Detaches `client`. The session runs on.
    pub fn detach(&self, client: ClientId) {
        lock(&self.state).clients.remove(&client);
    }

    /// `client`'s terminal is now `size`. The session takes it when that
    /// client is the one that typed last, or when nobody has typed yet: a
    /// session no client started (a child an agent started, one taken back
    /// from the keeper) has no size of a client's, and the terminal that
    /// reports one first is the one its program is laid out for.
    pub fn resize(&self, client: ClientId, size: TermSize) -> Result<()> {
        let mut state = lock(&self.state);
        if let Some(attached) = state.clients.get_mut(&client) {
            attached.size = size;
        }
        if state.typist.is_none_or(|typist| typist == client) {
            self.apply_size(&mut state, size)?;
        }
        Ok(())
    }

    /// Sends the keys `client` typed to the program, first giving the
    /// session that client's size.
    pub fn input(&self, client: ClientId, bytes: &[u8]) -> Result<()> {
        if is_a_person_typing(bytes) {
            self.person_typed.store(true, Ordering::SeqCst);
        }
        {
            let mut state = lock(&self.state);
            if state.exit.is_some() {
                return Err(self.has_ended());
            }
            state.typist = Some(client);
            if let Some(size) = state.clients.get(&client).map(|attached| attached.size) {
                self.apply_size(&mut state, size)?;
            }
        }
        let mut pty = lock(&self.pty);
        let pty = pty.as_mut().ok_or_else(|| self.has_ended())?;
        pty.write(bytes)
            .map_err(|err| Error::io(format!("type into session {}", self.id), err))?;
        self.typed.send_modify(|typed| *typed += 1);
        Ok(())
    }

    /// Sends `bytes` to the program as a parent's turn for it, which no
    /// client types: the session keeps the size it has, and it does not count
    /// as a person typing ([`Session::typing`]), so a wait of the child's own
    /// is not cut short by what its parent sent. Only `agents_send` calls it.
    pub fn type_for_parent(&self, bytes: &[u8]) -> Result<()> {
        if lock(&self.state).exit.is_some() {
            return Err(self.has_ended());
        }
        let mut pty = lock(&self.pty);
        let pty = pty.as_mut().ok_or_else(|| self.has_ended())?;
        pty.write(bytes)
            .map_err(|err| Error::io(format!("type into session {}", self.id), err))
    }

    /// Whether a client has typed into the session since its last turn ended
    /// ([`Session::turn_ended`]): what a client's terminal answers its program
    /// with is not typing. A parent's send is refused while this holds,
    /// because a person's keys come first and may be half a line in the
    /// prompt. It is set here, for the bytes a client sent, and nowhere else.
    pub fn person_typed(&self) -> bool {
        self.person_typed.load(Ordering::SeqCst)
    }

    /// The session's turn has ended: what a person typed before it is spent,
    /// so a parent's send goes through again.
    pub fn turn_ended(&self) {
        self.person_typed.store(false, Ordering::SeqCst);
    }

    /// Changes each time a client types into the session. What the host
    /// types itself (a prompt at launch) goes in another way and never moves
    /// it.
    pub fn typing(&self) -> watch::Receiver<u64> {
        self.typed.subscribe()
    }

    /// Asks the program to end, as closing its tab does: its tree is asked
    /// politely and its terminal is closed, and whatever is still running
    /// after [`GRACE`] is ended outright. A session in the keeper is closed
    /// there, so the grace runs out even if this host does not.
    pub fn close(self: &Arc<Self>) {
        if self.exit().is_some() {
            return;
        }
        self.mark_ending();
        match &self.ender {
            Ender::Here(tree) => {
                let _ = tree.end_tree(self.pid, Ending::Polite);
                drop(lock(&self.pty).take());
                let session = Arc::clone(self);
                let _ = spawn_thread(format!("session {} grace", self.id), move || {
                    end_after_grace(
                        |grace| session.wait_exit(grace).is_some(),
                        || {
                            if let Ender::Here(tree) = &session.ender {
                                let _ = tree.end_tree(session.pid, Ending::Forced);
                            }
                        },
                    );
                });
            }
            Ender::Kept { link, handle } => {
                link.close(*handle);
                drop(lock(&self.pty).take());
            }
        }
    }

    /// Ends the program and everything it started, now, as stopping the
    /// host does. The tree is ended before the terminal is closed, while it
    /// is still whole: once the program has gone its children are no longer
    /// found under it.
    pub fn end_now(&self) -> Result<()> {
        if self.exit().is_some() {
            return Ok(());
        }
        self.mark_ending();
        let ended = match &self.ender {
            Ender::Here(tree) => tree.end_tree(self.pid, Ending::Forced),
            Ender::Kept { link, handle } => {
                link.end_now(*handle);
                Ok(())
            }
        };
        drop(lock(&self.pty).take());
        ended
    }

    /// Writes down, before the program is touched, that the host is the one
    /// ending it: an exit that follows is then the host's doing, and an exit
    /// nobody asked for is the program finishing on its own.
    fn mark_ending(&self) {
        if let Some(shared) = self.host.upgrade() {
            shared.ledger.ending(self.id);
        }
    }

    /// Waits up to `timeout` for the program to exit and the session to be
    /// reported ended.
    pub fn wait_exit(&self, timeout: Duration) -> Option<SessionExit> {
        let deadline = Instant::now() + timeout;
        let mut state = lock(&self.state);
        loop {
            if let Some(exit) = &state.exit {
                return Some(exit.clone());
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            state = self
                .ended
                .wait_timeout(state, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    /// The size the pty itself reports, for a pty of this process.
    #[cfg(test)]
    pub(crate) fn pty_size(&self) -> Option<TermSize> {
        let pty = lock(&self.pty);
        let Some(Pty::Here { master, .. }) = pty.as_ref() else {
            return None;
        };
        let size = master.get_size().ok()?;
        Some(TermSize::new(size.cols, size.rows))
    }

    /// Runs `f` on the session's screen while it has one.
    #[cfg(test)]
    pub(crate) fn with_screen<R>(&self, f: impl FnOnce(&mut Screen) -> R) -> Option<R> {
        lock(&self.state).screen.as_mut().map(f)
    }

    fn apply_size(&self, state: &mut State, size: TermSize) -> Result<()> {
        if state.size == size {
            return Ok(());
        }
        if let Some(pty) = lock(&self.pty).as_ref() {
            pty.resize(size)
                .map_err(|err| Error::io(format!("resize session {}", self.id), err))?;
        }
        if let Some(screen) = state.screen.as_mut() {
            screen.resize(size);
        }
        state.size = size;
        broadcast(state, SessionOutput::Resized(size));
        Ok(())
    }

    fn read_output(&self, mut reader: Box<dyn Read + Send>) {
        let mut buf = vec![0; READ_CHUNK];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => return,
                Ok(n) => self.output(&buf[..n]),
                Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
                // A closed pty reads as an error on some systems: the end.
                Err(_) => return,
            }
        }
    }

    fn output(&self, bytes: &[u8]) {
        let mut state = lock(&self.state);
        let bytes = match state.opening.take() {
            None => bytes.to_vec(),
            Some(mut opening) => {
                opening.extend_from_slice(bytes);
                match self.opening_request(&mut opening) {
                    Opening::Pending => {
                        state.opening = Some(opening);
                        return;
                    }
                    Opening::Done => opening,
                }
            }
        };
        if bytes.is_empty() {
            return;
        }
        let Some(screen) = state.screen.as_mut() else {
            return;
        };
        screen.feed(&bytes);
        // Read only: the bytes the clients get are the ones the screen got.
        let reported = state.status.feed(&bytes, now_ms());
        broadcast(&mut state, SessionOutput::Data(Arc::from(bytes)));
        drop(state);
        if reported && let Some(shared) = self.host.upgrade() {
            shared.status_changed();
        }
    }

    /// Answers a cursor position request that opens the output, and takes it
    /// out of `opening`.
    ///
    /// A Windows pseudoconsole asks where the cursor is before it runs the
    /// program, and runs nothing until it is told. A session has to start
    /// with no client attached, so the host answers from its screen, which
    /// is empty: the top left. A request that comes later is the program's
    /// own and reaches the clients like any other output; so does one that
    /// opens a program's output where no pseudoconsole is involved, answered
    /// here just as a new terminal would.
    fn opening_request(&self, opening: &mut Vec<u8>) -> Opening {
        if opening.len() < CURSOR_REQUEST.len() && CURSOR_REQUEST.starts_with(opening) {
            return Opening::Pending;
        }
        if opening.starts_with(CURSOR_REQUEST) {
            opening.drain(..CURSOR_REQUEST.len());
            if let Some(pty) = lock(&self.pty).as_mut() {
                let _ = pty.write(CURSOR_AT_START);
            }
        }
        Opening::Done
    }

    /// The program has ended: the pty is released and its output drained,
    /// the end recorded, the clients told, the screen dropped and the
    /// launch's own folder removed. Once only.
    fn finish(&self, exit: SessionExit, drained: Option<&mpsc::Receiver<()>>, how: Finish) {
        if self.exit().is_some() {
            return;
        }
        // Closing the pty ends the output on every OS, including a Windows
        // pseudoconsole, which keeps it open after its program has gone.
        drop(lock(&self.pty).take());
        if let Some(drained) = drained {
            let _ = drained.recv_timeout(DRAIN);
        }

        // The screen goes with the program; what a command child last printed
        // is handed on first, for its parent to be told.
        if let Some(shared) = self.host.upgrade() {
            let last_lines = lock(&self.state)
                .screen
                .as_ref()
                .map(|screen| screen.last_lines(LAST_LINES));
            if let Some(last_lines) = last_lines {
                shared.ledger.screen_ended(self.id, last_lines);
            }
        }

        // Unlisted first: recording the end tells the clients, and one that
        // lists again on hearing it must not find the session still there.
        if let Some(shared) = self.host.upgrade() {
            lock(&shared.sessions).remove(&self.id);
            let recorded = match how {
                Finish::Exited => shared.ledger.finished(self.id, &exit),
                Finish::Lost => shared.ledger.lost(self.id),
            };
            if let Err(err) = recorded {
                log_line!("floti host: {err}");
            }
        }

        {
            let mut state = lock(&self.state);
            if let Some(opening) = state.opening.take().filter(|bytes| !bytes.is_empty()) {
                broadcast(&mut state, SessionOutput::Data(Arc::from(opening)));
            }
            state.screen = None;
            state.status = ProgramStatus::default();
            state.exit = Some(exit.clone());
            broadcast(&mut state, SessionOutput::Exited(exit));
            state.clients.clear();
            self.ended.notify_all();
        }
        // The launch's files, the agent tool token among them, go with it.
        if let Some(folder) = &self.launch_folder
            && let Err(err) = remove_launch_folder(folder)
        {
            log_line!("floti host: {err}");
        }
    }

    fn has_ended(&self) -> Error {
        Error::Refused(format!("Session {} has ended.", self.id))
    }
}

impl KeptTerminal for Session {
    fn output(&self, bytes: &[u8]) {
        Session::output(self, bytes);
    }

    fn exited(&self, exit: SessionExit) {
        self.finish(exit, None, Finish::Exited);
    }

    fn lost(&self) {
        self.finish(LOST_EXIT, None, Finish::Lost);
    }
}

/// Sends `output` to every attached client, letting go of any that has
/// stopped listening.
fn broadcast(state: &mut State, output: SessionOutput) {
    state
        .clients
        .retain(|_, attached| attached.output.send(output.clone()).is_ok());
}

fn pty_size(size: TermSize) -> PtySize {
    PtySize {
        rows: size.rows,
        cols: size.cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn spawn_thread(name: String, run: impl FnOnce() + Send + 'static) -> Result<()> {
    thread::Builder::new()
        .name(name)
        .spawn(run)
        .map(drop)
        .map_err(|err| Error::io("start a session thread", err))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
