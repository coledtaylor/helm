//! The host's connection to its session keeper.
//!
//! The connection runs on a thread of its own, so a session can type into
//! the keeper, or a stop can wait for it, from anywhere the host is. Each
//! program the keeper holds is routed to the terminal that shows it here
//! ([`KeptTerminal`]): its bytes in the order the keeper sent them, then how
//! it ended. Until a program is routed, what arrives for it is kept, so the
//! terminal made for it misses nothing.
//!
//! When the connection ends while the host still wants it, every program
//! routed through it is lost: the host cannot reach it, and a keeper that
//! went away took it along.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc as std_mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, Instant};

use serde_bytes::ByteBuf;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Notify, mpsc};

use super::wire::{FromKeeper, Label, Spawned, ToKeeper, read_frame, write_frame};
use crate::platform::socket::{Endpoint, LocalSocket};
use crate::session::{SessionExit, TermSize};
use crate::{Error, Result};

/// How long the keeper has to answer a connect's greeting or a start.
const ANSWER_WAIT: Duration = Duration::from_secs(30);

/// What a program the keeper holds is shown through on the host.
pub trait KeptTerminal: Send + Sync {
    /// Bytes the program wrote.
    fn output(&self, bytes: &[u8]);
    /// The program ended. Nothing follows.
    fn exited(&self, exit: SessionExit);
    /// The keeper went away, taking the program along. Nothing follows.
    fn lost(&self);
}

/// A program to start in the keeper.
#[derive(Debug, Clone)]
pub struct StartPty {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub cwd: PathBuf,
    /// What the launch adds to the keeper's own environment.
    pub env: Vec<(OsString, OsString)>,
    pub size: TermSize,
}

/// A program the keeper held when the host connected.
#[derive(Debug, Clone)]
pub struct Held {
    pub handle: u64,
    /// What the host that started it said it is, if it said.
    pub label: Option<Label>,
    pub pid: u32,
    pub size: TermSize,
    /// Bytes that draw its screen in an empty terminal of `size`.
    pub redraw: Vec<u8>,
    /// How it ended, when it ended while no host was connected.
    pub exit: Option<SessionExit>,
}

/// What the keeper said as the host connected.
pub(crate) enum Greeting {
    /// A keeper of this version, and what it holds.
    Ours(Vec<Held>),
    /// A keeper of another version, which this host does not use.
    Other { version: String },
}

/// Whether the host still wants the connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinkState {
    Open,
    /// The host is letting go, or has told the keeper to end everything:
    /// the connection ending loses nothing.
    Closing,
    /// The connection has ended.
    Ended,
}

enum Event {
    Data(Vec<u8>),
    Exited(SessionExit),
}

enum Route {
    /// Not yet routed: what has arrived for it so far.
    Waiting(Vec<Event>),
    To(Weak<dyn KeptTerminal>),
}

/// One connection to the keeper.
pub struct KeeperLink {
    pid: u32,
    out: mpsc::UnboundedSender<ToKeeper>,
    routes: Mutex<HashMap<u64, Route>>,
    starts: Mutex<HashMap<u64, std_mpsc::Sender<std::result::Result<Spawned, String>>>>,
    /// Labels sent and not yet answered, by request.
    labels: Mutex<HashMap<u64, std_mpsc::Sender<()>>>,
    next_request: AtomicU64,
    state: Mutex<LinkState>,
    /// Signalled when the connection ends.
    ended: Condvar,
    /// Whether the keeper said it had ended everything.
    bye: Mutex<bool>,
    stop: Notify,
}

impl KeeperLink {
    /// Connects to the keeper at `endpoint`, on a thread of its own, and
    /// reads its greeting. A keeper of `version` says what it holds, each of
    /// which waits for [`KeeperLink::route`], [`KeeperLink::discard`] or
    /// [`KeeperLink::forget`].
    pub(crate) fn connect(
        socket: impl LocalSocket + Send + 'static,
        endpoint: &Endpoint,
        version: &str,
    ) -> Result<(Arc<Self>, Greeting)> {
        let (greeted, greeting) = std_mpsc::channel();
        let endpoint = endpoint.clone();
        let version = version.to_owned();
        std::thread::Builder::new()
            .name("session keeper link".to_owned())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(err) => {
                        let _ = greeted.send(Err(Error::io("start the keeper link", err)));
                        return;
                    }
                };
                runtime.block_on(async move {
                    let stream = match socket.connect(&endpoint).await {
                        Ok(stream) => stream,
                        Err(err) => {
                            let _ = greeted.send(Err(err));
                            return;
                        }
                    };
                    serve(stream, &version, greeted).await;
                });
            })
            .map_err(|err| Error::io("start the keeper link", err))?;
        greeting
            .recv_timeout(ANSWER_WAIT)
            .map_err(|_| Error::Refused("The session keeper did not answer.".to_owned()))?
    }

    /// The keeper's process id.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Whether the connection has ended.
    pub fn is_ended(&self) -> bool {
        *lock(&self.state) == LinkState::Ended
    }

    /// Starts a program in the keeper: its handle and process id.
    pub fn start(&self, start: StartPty) -> Result<(u64, u32)> {
        let request = self.next_request.fetch_add(1, Ordering::SeqCst);
        let (answer, answered) = std_mpsc::channel();
        lock(&self.starts).insert(request, answer);
        if self.is_ended() {
            lock(&self.starts).remove(&request);
            return Err(gone());
        }
        let program = start.program.to_string_lossy().into_owned();
        self.send(ToKeeper::Start {
            request,
            program: start.program,
            args: start.args,
            cwd: start.cwd,
            env: start.env,
            cols: start.size.cols,
            rows: start.size.rows,
        });
        match answered.recv_timeout(ANSWER_WAIT) {
            Ok(Ok(spawned)) => Ok((spawned.handle, spawned.pid)),
            Ok(Err(why)) => Err(Error::io(
                format!("start {program}"),
                std::io::Error::other(why),
            )),
            Err(_) => {
                lock(&self.starts).remove(&request);
                Err(gone())
            }
        }
    }

    /// Tells the keeper what `handle` is, for the next host, and waits until
    /// it has kept it. Only then may the host say the program started: a
    /// host that dies after saying so leaves a keeper that knows what it
    /// holds, and the next host takes it back rather than offering it.
    pub fn label(&self, handle: u64, label: Label) -> Result<()> {
        let request = self.next_request.fetch_add(1, Ordering::SeqCst);
        let (answer, answered) = std_mpsc::channel();
        lock(&self.labels).insert(request, answer);
        if self.is_ended() {
            lock(&self.labels).remove(&request);
            return Err(gone());
        }
        self.send(ToKeeper::Label {
            request,
            handle,
            label,
        });
        answered.recv_timeout(ANSWER_WAIT).map_err(|_| {
            lock(&self.labels).remove(&request);
            gone()
        })
    }

    pub fn input(&self, handle: u64, bytes: &[u8]) -> std::io::Result<()> {
        if self.is_ended() {
            return Err(std::io::Error::other("the session keeper has gone"));
        }
        self.send(ToKeeper::Input {
            handle,
            bytes: ByteBuf::from(bytes.to_vec()),
        });
        Ok(())
    }

    pub fn resize(&self, handle: u64, size: TermSize) -> std::io::Result<()> {
        self.send(ToKeeper::Resize {
            handle,
            cols: size.cols,
            rows: size.rows,
        });
        Ok(())
    }

    /// Asks `handle`'s program to end, its tree ended outright after the
    /// grace.
    pub fn close(&self, handle: u64) {
        self.send(ToKeeper::Close { handle });
    }

    /// Ends `handle`'s whole tree now.
    pub fn end_now(&self, handle: u64) {
        self.send(ToKeeper::EndNow { handle });
    }

    /// From here `handle`'s output and end go to `terminal`, starting with
    /// what has arrived for it already. A program routed after the
    /// connection ended is lost at once.
    pub fn route(&self, handle: u64, terminal: Weak<dyn KeptTerminal>) {
        let mut routes = lock(&self.routes);
        let waiting = match routes.remove(&handle) {
            Some(Route::Waiting(events)) => events,
            _ => Vec::new(),
        };
        let Some(shown) = terminal.upgrade() else {
            return;
        };
        for event in waiting {
            match event {
                Event::Data(bytes) => shown.output(&bytes),
                Event::Exited(exit) => {
                    shown.exited(exit);
                    self.forget(handle);
                    return;
                }
            }
        }
        if *lock(&self.state) == LinkState::Ended {
            drop(routes);
            shown.lost();
            return;
        }
        routes.insert(handle, Route::To(terminal));
    }

    /// The host has no use for `handle`: its tree ends and the keeper keeps
    /// nothing of it.
    pub fn discard(&self, handle: u64) {
        lock(&self.routes).remove(&handle);
        self.end_now(handle);
    }

    /// The host has recorded `handle`'s end.
    pub fn forget(&self, handle: u64) {
        lock(&self.routes).remove(&handle);
        self.send(ToKeeper::Forget { handle });
    }

    /// Tells the keeper to end every tree and exit, and waits up to `wait`
    /// for the connection to end. Whether the keeper said it had.
    pub fn shutdown(&self, wait: Duration) -> bool {
        {
            let mut state = lock(&self.state);
            if *state == LinkState::Open {
                *state = LinkState::Closing;
            }
        }
        self.send(ToKeeper::Shutdown);
        self.wait_ended(wait);
        *lock(&self.bye)
    }

    /// Lets go of the keeper, leaving it running with everything it holds.
    pub fn detach(&self) {
        {
            let mut state = lock(&self.state);
            if *state == LinkState::Open {
                *state = LinkState::Closing;
            }
        }
        self.stop.notify_one();
    }

    fn wait_ended(&self, wait: Duration) {
        let deadline = Instant::now() + wait;
        let mut state = lock(&self.state);
        while *state != LinkState::Ended {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                return;
            };
            state = self
                .ended
                .wait_timeout(state, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    fn send(&self, message: ToKeeper) {
        // A connection that has ended takes nothing more; what it was for is
        // lost already.
        let _ = self.out.send(message);
    }

    /// What arrived from the keeper after its greeting.
    fn received(&self, message: FromKeeper) {
        match message {
            FromKeeper::Started { request, outcome } => {
                if let Ok(spawned) = &outcome {
                    lock(&self.routes).insert(spawned.handle, Route::Waiting(Vec::new()));
                }
                if let Some(answer) = lock(&self.starts).remove(&request) {
                    // A start that gave up waiting leaves its program to be
                    // found by the next host, or ended with the keeper.
                    let _ = answer.send(outcome);
                }
            }
            FromKeeper::Data { handle, bytes } => {
                let mut routes = lock(&self.routes);
                match routes.get_mut(&handle) {
                    Some(Route::Waiting(events)) => events.push(Event::Data(bytes.into_vec())),
                    Some(Route::To(terminal)) => {
                        if let Some(terminal) = terminal.upgrade() {
                            terminal.output(&bytes);
                        }
                    }
                    None => {}
                }
            }
            FromKeeper::Exited { handle, exit } => {
                let exit = SessionExit::from(exit);
                let mut routes = lock(&self.routes);
                match routes.remove(&handle) {
                    Some(Route::Waiting(mut events)) => {
                        events.push(Event::Exited(exit));
                        routes.insert(handle, Route::Waiting(events));
                    }
                    Some(Route::To(terminal)) => {
                        if let Some(terminal) = terminal.upgrade() {
                            terminal.exited(exit);
                        }
                        drop(routes);
                        self.send(ToKeeper::Forget { handle });
                    }
                    None => {
                        drop(routes);
                        self.send(ToKeeper::Forget { handle });
                    }
                }
            }
            FromKeeper::Labelled { request } => {
                if let Some(answer) = lock(&self.labels).remove(&request) {
                    let _ = answer.send(());
                }
            }
            FromKeeper::Bye => *lock(&self.bye) = true,
            FromKeeper::Hello { .. } | FromKeeper::Held { .. } | FromKeeper::Ready => {}
        }
    }

    /// The connection has ended. Every program routed through it is lost,
    /// unless the host was letting go.
    fn end(&self) {
        let was = std::mem::replace(&mut *lock(&self.state), LinkState::Ended);
        lock(&self.starts).clear();
        lock(&self.labels).clear();
        let routed: Vec<Weak<dyn KeptTerminal>> = {
            let mut routes = lock(&self.routes);
            let routed = routes
                .values()
                .filter_map(|route| match route {
                    Route::To(terminal) => Some(Weak::clone(terminal)),
                    Route::Waiting(_) => None,
                })
                .collect();
            routes.retain(|_, route| matches!(route, Route::Waiting(_)));
            routed
        };
        if was == LinkState::Open {
            for terminal in routed.iter().filter_map(Weak::upgrade) {
                terminal.lost();
            }
        }
        self.ended.notify_all();
    }
}

/// Reads the greeting, hands it to the connecting host, then carries the
/// connection until either side ends it.
async fn serve<S>(
    stream: S,
    version: &str,
    greeted: std_mpsc::Sender<Result<(Arc<KeeperLink>, Greeting)>>,
) where
    S: AsyncRead + AsyncWrite + Send,
{
    let (mut reader, mut writer) = tokio::io::split(stream);
    let refused = |why: String| Error::Refused(format!("The session keeper {why}."));
    let (pid, theirs) = match read_frame::<_, FromKeeper>(&mut reader).await {
        Ok(Some(FromKeeper::Hello { version, pid })) => (pid, version),
        Ok(_) => {
            let _ = greeted.send(Err(refused("did not say which it is".to_owned())));
            return;
        }
        Err(err) => {
            let _ = greeted.send(Err(Error::io("read the session keeper's greeting", err)));
            return;
        }
    };
    let (out, mut outgoing) = mpsc::unbounded_channel();
    let link = Arc::new(KeeperLink {
        pid,
        out,
        routes: Mutex::new(HashMap::new()),
        starts: Mutex::new(HashMap::new()),
        labels: Mutex::new(HashMap::new()),
        next_request: AtomicU64::new(1),
        state: Mutex::new(LinkState::Open),
        ended: Condvar::new(),
        bye: Mutex::new(false),
        stop: Notify::new(),
    });
    let greeting = if theirs == version {
        let mut held = Vec::new();
        loop {
            match read_frame::<_, FromKeeper>(&mut reader).await {
                Ok(Some(FromKeeper::Ready)) => break,
                Ok(Some(FromKeeper::Held {
                    handle,
                    label,
                    pid,
                    cols,
                    rows,
                    redraw,
                    exit,
                })) => {
                    if exit.is_none() {
                        lock(&link.routes).insert(handle, Route::Waiting(Vec::new()));
                    }
                    held.push(Held {
                        handle,
                        label,
                        pid,
                        size: TermSize::new(cols, rows),
                        redraw: redraw.into_vec(),
                        exit: exit.map(SessionExit::from),
                    });
                }
                Ok(Some(_)) => {}
                Ok(None) => {
                    let _ = greeted.send(Err(refused("ended before saying what it holds".into())));
                    return;
                }
                Err(err) => {
                    let _ = greeted.send(Err(Error::io("read what the session keeper holds", err)));
                    return;
                }
            }
        }
        Greeting::Ours(held)
    } else {
        Greeting::Other { version: theirs }
    };
    if greeted.send(Ok((Arc::clone(&link), greeting))).is_err() {
        return;
    }

    let reading = async {
        loop {
            match read_frame::<_, FromKeeper>(&mut reader).await {
                Ok(Some(message)) => link.received(message),
                Ok(None) | Err(_) => return,
            }
        }
    };
    let writing = async {
        while let Some(message) = outgoing.recv().await {
            if write_frame(&mut writer, &message).await.is_err() {
                return;
            }
        }
    };
    tokio::select! {
        () = reading => {}
        () = writing => {}
        () = link.stop.notified() => {}
    }
    link.end();
}

fn gone() -> Error {
    Error::Refused("The session keeper has stopped.".to_owned())
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
