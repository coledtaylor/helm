//! Running sessions: a program in a pty, its screen, and the clients
//! attached to it.
//!
//! Each session has two threads. One reads the pty and hands every byte to
//! the screen and to each attached client, under the same lock an attach
//! takes, so a client attaching gets the screen as of one byte and the live
//! output from the next, with nothing missing or repeated. The other waits
//! for the program to exit, then releases the pty, lets the output drain,
//! records the exit, tells the clients and drops the screen.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use floti_protocol::BackendId;
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use super::env::session_env;
use super::ledger::{NewSessionRow, SessionId, SessionLedger, SessionOrigin};
use super::screen::{Screen, TermSize};
use crate::agent::LaunchSpec;
use crate::agent::launch_folder::remove_launch_folder;
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

const READ_CHUNK: usize = 64 * 1024;

/// A request for the cursor's position (DSR 6), and the answer for an empty
/// screen.
const CURSOR_REQUEST: &[u8] = b"\x1b[6n";
const CURSOR_AT_START: &[u8] = b"\x1b[1;1R";

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
}

/// The sessions running on this host.
#[derive(Clone)]
pub struct SessionHost {
    shared: Arc<Shared>,
}

struct Shared {
    inherited_env: Vec<(OsString, OsString)>,
    ledger: Arc<dyn SessionLedger>,
    tree: Arc<dyn ProcessTree + Send + Sync>,
    sessions: Mutex<BTreeMap<SessionId, Arc<Session>>>,
}

impl SessionHost {
    /// A host whose sessions inherit `inherited_env` (the host's own
    /// environment, less what [`session_env`] removes), record themselves in
    /// `ledger` and are ended through `tree`.
    pub fn new(
        inherited_env: Vec<(OsString, OsString)>,
        ledger: Arc<dyn SessionLedger>,
        tree: Arc<dyn ProcessTree + Send + Sync>,
    ) -> Self {
        Self {
            shared: Arc::new(Shared {
                inherited_env,
                ledger,
                tree,
                sessions: Mutex::new(BTreeMap::new()),
            }),
        }
    }

    /// Starts a session: its program in a new pty in its folder, its row
    /// written once it has spawned.
    pub fn start(&self, request: StartSession) -> Result<Arc<Session>> {
        let StartSession {
            spec,
            name,
            size,
            client,
            conversation_id,
            backend,
            origin,
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
        let tied = TiedTree::new(Arc::clone(&self.shared.tree), pid);

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

        let row = NewSessionRow {
            name: name.clone(),
            cwd: spec.cwd.clone(),
            argv: spec
                .args
                .iter()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect(),
            conversation_id,
            backend,
            origin,
        };
        let id = match self.shared.ledger.started(&row) {
            Ok(id) => id,
            Err(err) => {
                let _ = self.shared.tree.end_tree(pid, Ending::Forced);
                let _ = child.kill();
                return Err(err);
            }
        };

        let session = Arc::new(Session {
            id,
            pid,
            name,
            tree: Arc::clone(&self.shared.tree),
            state: Mutex::new(State {
                screen: Some(Screen::new(size)),
                clients: BTreeMap::new(),
                size,
                typist: client,
                exit: None,
                opening: Some(Vec::new()),
            }),
            ended: Condvar::new(),
            pty: Mutex::new(Some(Pty { master, writer })),
        });
        lock(&self.shared.sessions).insert(id, Arc::clone(&session));

        let (drained_tx, drained) = mpsc::channel();
        let output = Arc::clone(&session);
        spawn_thread(format!("session {id} output"), move || {
            output.read_output(reader);
            let _ = drained_tx.send(());
        })?;
        let shared = Arc::clone(&self.shared);
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
            waiting.ended(exit, &drained, &shared);
            // The launch's files, the agent tool token among them, go with it.
            if let Some(folder) = launch_folder
                && let Err(err) = remove_launch_folder(&folder)
            {
                eprintln!("floti host: {err}");
            }
        })?;
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
    tree: Arc<dyn ProcessTree + Send + Sync>,
    state: Mutex<State>,
    ended: Condvar,
    /// Taken when the session is closed or its program exits. Lock order:
    /// `state`, then `pty`.
    pty: Mutex<Option<Pty>>,
}

struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

struct State {
    /// Dropped when the program exits.
    screen: Option<Screen>,
    clients: BTreeMap<ClientId, Attached>,
    size: TermSize,
    /// The client that typed last, whose size the session has.
    typist: Option<ClientId>,
    exit: Option<SessionExit>,
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

    /// Whether the session has let go of its pty and its screen.
    pub fn released(&self) -> bool {
        lock(&self.state).screen.is_none() && lock(&self.pty).is_none()
    }

    /// Attaches `client`, whose terminal is `size`: it is sent the current
    /// screen, then everything after it. Attaching again replaces the
    /// earlier attachment. Attaching does not resize the session; typing
    /// does.
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
    /// client is the one that typed last.
    pub fn resize(&self, client: ClientId, size: TermSize) -> Result<()> {
        let mut state = lock(&self.state);
        if let Some(attached) = state.clients.get_mut(&client) {
            attached.size = size;
        }
        if state.typist == Some(client) {
            self.apply_size(&mut state, size)?;
        }
        Ok(())
    }

    /// Sends the keys `client` typed to the program, first giving the
    /// session that client's size.
    pub fn input(&self, client: ClientId, bytes: &[u8]) -> Result<()> {
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
        pty.writer
            .write_all(bytes)
            .and_then(|()| pty.writer.flush())
            .map_err(|err| Error::io(format!("type into session {}", self.id), err))
    }

    /// Asks the program to end, as closing its tab does: its tree is asked
    /// politely and its terminal is closed, and whatever is still running
    /// after [`GRACE`] is ended outright.
    pub fn close(self: &Arc<Self>) {
        if self.exit().is_some() {
            return;
        }
        let _ = self.tree.end_tree(self.pid, Ending::Polite);
        drop(lock(&self.pty).take());
        let session = Arc::clone(self);
        let _ = spawn_thread(format!("session {} grace", self.id), move || {
            end_after_grace(
                |grace| session.wait_exit(grace).is_some(),
                || {
                    let _ = session.tree.end_tree(session.pid, Ending::Forced);
                },
            );
        });
    }

    /// Ends the program and everything it started, now, as stopping the
    /// host does. The tree is ended before the terminal is closed, while it
    /// is still whole: once the program has gone its children are no longer
    /// found under it.
    pub fn end_now(&self) -> Result<()> {
        if self.exit().is_some() {
            return Ok(());
        }
        let ended = self.tree.end_tree(self.pid, Ending::Forced);
        drop(lock(&self.pty).take());
        ended
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

    /// The size the pty itself reports.
    #[cfg(test)]
    pub(crate) fn pty_size(&self) -> Option<TermSize> {
        let pty = lock(&self.pty);
        let size = pty.as_ref()?.master.get_size().ok()?;
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
            pty.master.resize(pty_size(size)).map_err(|err| {
                Error::io(format!("resize session {}", self.id), io::Error::other(err))
            })?;
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
        broadcast(&mut state, SessionOutput::Data(Arc::from(bytes)));
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
                let _ = pty
                    .writer
                    .write_all(CURSOR_AT_START)
                    .and_then(|()| pty.writer.flush());
            }
        }
        Opening::Done
    }

    /// The program has exited: the pty is released and its output drained,
    /// the exit recorded, the clients told, and the screen dropped.
    fn ended(&self, exit: SessionExit, drained: &mpsc::Receiver<()>, shared: &Shared) {
        // Closing the pty ends the output on every OS, including a Windows
        // pseudoconsole, which keeps it open after its program has gone.
        drop(lock(&self.pty).take());
        let _ = drained.recv_timeout(DRAIN);

        // Unlisted first: recording the exit tells the clients, and one that
        // lists again on hearing it must not find the session still there.
        lock(&shared.sessions).remove(&self.id);
        if let Err(err) = shared.ledger.finished(self.id, &exit) {
            eprintln!("floti host: {err}");
        }

        let mut state = lock(&self.state);
        if let Some(opening) = state.opening.take().filter(|bytes| !bytes.is_empty()) {
            broadcast(&mut state, SessionOutput::Data(Arc::from(opening)));
        }
        state.screen = None;
        state.exit = Some(exit.clone());
        broadcast(&mut state, SessionOutput::Exited(exit));
        state.clients.clear();
        self.ended.notify_all();
    }

    fn has_ended(&self) -> Error {
        Error::Refused(format!("Session {} has ended.", self.id))
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

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
