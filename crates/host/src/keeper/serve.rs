//! The keeper's side: `floti keeper <data folder> <runtime folder>`.
//!
//! It holds every program in a pty of its own, each with its screen, the
//! way a host without a keeper would ([`SessionHost::new`]), and ties every
//! tree to its own life. It serves one host at a time on its endpoint, and
//! keeps reading every program's output while no host is connected, so no
//! program waits on a full pty. It keeps how a program ended until a host
//! has recorded it, and exits once it holds nothing and no host is there.
//!
//! It opens no store, keeps no history or usage, runs no plugin and listens
//! on no network port: its one way in is its endpoint, which only this user
//! can open.

use std::collections::{BTreeMap, HashMap};
use std::io::Write as _;
use std::path::Path;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use floti_protocol::BackendId;
use serde_bytes::ByteBuf;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::task::JoinHandle;

use super::wire::{FromKeeper, Label, Spawned, ToKeeper, WireExit, read_frame, write_frame};
use super::{keeper_endpoint, keeper_version};
use crate::agent::LaunchSpec;
use crate::platform::process_tree::{self, ProcessTree};
use crate::platform::socket::{self, LocalListener, LocalSocket, LocalStream};
use crate::session::{
    ClientId, NewSessionRow, Session, SessionExit, SessionHost, SessionId, SessionLedger,
    SessionOrigin, SessionOutput, StartSession, TermSize,
};
use crate::{Error, Result};

/// The keeper's one client: the host connected now.
const HOST: ClientId = ClientId(0);

/// How long a keeper that holds nothing waits for a host before it exits.
const HOST_WAIT: Duration = Duration::from_secs(30);

/// How long a shutdown waits for each tree to end.
const END_WAIT: Duration = Duration::from_secs(5);

/// The exit status of a keeper that found another already serving its
/// endpoint.
pub const KEEPER_ALREADY_RUNNING: u8 = 3;

/// Numbers what the keeper holds, and keeps how each ended until a host has
/// recorded it.
struct KeptLedger {
    next: AtomicI64,
    exits: Mutex<BTreeMap<i64, SessionExit>>,
}

impl SessionLedger for KeptLedger {
    fn started(&self, _: &NewSessionRow) -> Result<SessionId> {
        Ok(SessionId(self.next.fetch_add(1, Ordering::SeqCst)))
    }

    fn finished(&self, id: SessionId, exit: &SessionExit) -> Result<()> {
        lock(&self.exits).insert(id.0, exit.clone());
        Ok(())
    }
}

struct Keeper {
    programs: SessionHost,
    ledger: Arc<KeptLedger>,
    labels: Mutex<HashMap<u64, Label>>,
}

/// How a host's connection ended.
enum Served {
    /// The host went away; the keeper holds on.
    Left,
    /// The host told it to end everything, which it has.
    Shutdown,
}

impl Keeper {
    /// Whether it holds a running program or an end no host has recorded.
    fn holds_anything(&self) -> bool {
        !self.programs.list().is_empty() || !lock(&self.ledger.exits).is_empty()
    }

    fn program(&self, handle: u64) -> Option<Arc<Session>> {
        i64::try_from(handle)
            .ok()
            .and_then(|id| self.programs.get(SessionId(id)))
    }

    fn forget(&self, handle: u64) {
        if let Ok(id) = i64::try_from(handle) {
            lock(&self.ledger.exits).remove(&id);
        }
        lock(&self.labels).remove(&handle);
    }

    fn label(&self, handle: u64) -> Option<Label> {
        lock(&self.labels).get(&handle).cloned()
    }

    fn start(&self, start: StartFrame) -> std::result::Result<(Spawned, Attached), String> {
        let StartFrame {
            program,
            args,
            cwd,
            env,
            size,
        } = start;
        let name = program.to_string_lossy().into_owned();
        let (session, attachment) = self
            .programs
            .start_attached(
                StartSession {
                    spec: LaunchSpec {
                        program,
                        args,
                        cwd,
                        env,
                        conversation_id: None,
                        launch_folder: None,
                    },
                    name,
                    size,
                    client: Some(HOST),
                    conversation_id: None,
                    // Recorded nowhere: the host's row says which backend.
                    backend: BackendId::new("keeper"),
                    origin: SessionOrigin::default(),
                    // The label the host sends next says whose it is.
                    opened_by: None,
                },
                HOST,
            )
            .map_err(|err| err.to_string())?;
        let handle = u64::try_from(session.id().0).unwrap_or(0);
        Ok((
            Spawned {
                handle,
                pid: session.pid(),
            },
            attachment.output,
        ))
    }

    /// Ends every tree and waits for each to be reaped.
    fn end_everything(&self) {
        let running = self.programs.list();
        for program in &running {
            if let Err(err) = program.end_now() {
                log_line!("floti keeper: {err}");
            }
        }
        for program in &running {
            program.wait_exit(END_WAIT);
        }
    }
}

type Attached = UnboundedReceiver<SessionOutput>;

struct StartFrame {
    program: std::ffi::OsString,
    args: Vec<std::ffi::OsString>,
    cwd: std::path::PathBuf,
    env: Vec<(std::ffi::OsString, std::ffi::OsString)>,
    size: TermSize,
}

/// Runs the keeper for the host on `data`, until a host tells it to end
/// everything or it holds nothing and no host is there. An error comes with
/// the status to exit with.
pub fn run_keeper(data: &Path, runtime: &Path) -> std::result::Result<(), (u8, Error)> {
    #[cfg(feature = "testkit")]
    crate::testkit::owner::exit_when_owner_is_gone(data, |pid| {
        process_tree::Native.is_alive(pid) != floti_protocol::Knowable::Known(false)
    });
    // Every tree it holds ends with it, however it ends.
    process_tree::Native.end_tree_with_this_process();
    let endpoint = keeper_endpoint(runtime, data);
    let version = keeper_version(data);
    let tokio = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| (1, Error::io("start the keeper's runtime", err)))?;
    tokio.block_on(async move {
        let listener = socket::Native.bind(&endpoint).map_err(|err| match err {
            err @ Error::AlreadyRunning(_) => (KEEPER_ALREADY_RUNNING, err),
            err => (1, err),
        })?;
        // The host that started it reads this line, then connects.
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "ready").and_then(|()| out.flush());
        drop(out);
        let ledger = Arc::new(KeptLedger {
            next: AtomicI64::new(1),
            exits: Mutex::new(BTreeMap::new()),
        });
        let keeper = Keeper {
            programs: SessionHost::new(
                std::env::vars_os().collect(),
                Arc::clone(&ledger) as Arc<dyn SessionLedger>,
                Arc::new(process_tree::Native),
            ),
            ledger,
            labels: Mutex::new(HashMap::new()),
        };
        serve_hosts(listener, &keeper, &version)
            .await
            .map_err(|err| (1, err))
    })
}

async fn serve_hosts(
    mut listener: impl LocalListener,
    keeper: &Keeper,
    version: &str,
) -> Result<()> {
    loop {
        let stream: LocalStream = if keeper.holds_anything() {
            listener.accept().await?
        } else {
            match tokio::time::timeout(HOST_WAIT, listener.accept()).await {
                Ok(accepted) => accepted?,
                Err(_) => return Ok(()),
            }
        };
        if let Served::Shutdown = serve_host(stream, keeper, version).await {
            return Ok(());
        }
    }
}

/// Serves one host until it goes or tells the keeper to end everything.
async fn serve_host<S>(stream: S, keeper: &Keeper, version: &str) -> Served
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (mut reader, mut writer) = tokio::io::split(stream);
    let (out, mut outgoing) = unbounded_channel::<FromKeeper>();
    let writing = tokio::spawn(async move {
        while let Some(message) = outgoing.recv().await {
            if write_frame(&mut writer, &message).await.is_err() {
                return;
            }
        }
    });
    let mut forwarders: Vec<JoinHandle<()>> = Vec::new();

    let _ = out.send(FromKeeper::Hello {
        version: version.to_owned(),
        pid: std::process::id(),
    });
    let mut attached = Vec::new();
    for program in keeper.programs.list() {
        let size = program.size();
        let Ok(attachment) = program.attach(HOST, size) else {
            continue;
        };
        let handle = u64::try_from(program.id().0).unwrap_or(0);
        attached.push(handle);
        let _ = out.send(FromKeeper::held(
            handle,
            keeper.label(handle),
            program.pid(),
            attachment.size,
            attachment.redraw,
        ));
        forwarders.push(forward(handle, attachment.output, out.clone()));
    }
    let ended: Vec<(i64, SessionExit)> = lock(&keeper.ledger.exits)
        .iter()
        .map(|(id, exit)| (*id, exit.clone()))
        .collect();
    for (id, exit) in ended {
        let handle = u64::try_from(id).unwrap_or(0);
        if attached.contains(&handle) {
            continue;
        }
        let _ = out.send(FromKeeper::Held {
            handle,
            label: keeper.label(handle),
            pid: 0,
            cols: 0,
            rows: 0,
            redraw: ByteBuf::new(),
            exit: Some(WireExit::from(&exit)),
        });
    }
    let _ = out.send(FromKeeper::Ready);

    let served = loop {
        let message = match read_frame::<_, ToKeeper>(&mut reader).await {
            Ok(Some(message)) => message,
            Ok(None) | Err(_) => break Served::Left,
        };
        match message {
            ToKeeper::Start {
                request,
                program,
                args,
                cwd,
                env,
                cols,
                rows,
            } => {
                let started = keeper.start(StartFrame {
                    program,
                    args,
                    cwd,
                    env,
                    size: TermSize::new(cols, rows),
                });
                match started {
                    Ok((spawned, output)) => {
                        let _ = out.send(FromKeeper::Started {
                            request,
                            outcome: Ok(spawned),
                        });
                        forwarders.push(forward(spawned.handle, output, out.clone()));
                    }
                    Err(why) => {
                        let _ = out.send(FromKeeper::Started {
                            request,
                            outcome: Err(why),
                        });
                    }
                }
            }
            ToKeeper::Label { handle, label } => {
                lock(&keeper.labels).insert(handle, label);
            }
            ToKeeper::Input { handle, bytes } => {
                if let Some(program) = keeper.program(handle)
                    && let Err(err) = program.input(HOST, &bytes)
                {
                    log_line!("floti keeper: {err}");
                }
            }
            ToKeeper::Resize { handle, cols, rows } => {
                if let Some(program) = keeper.program(handle)
                    && let Err(err) = program.resize(HOST, TermSize::new(cols, rows))
                {
                    log_line!("floti keeper: {err}");
                }
            }
            ToKeeper::Close { handle } => {
                if let Some(program) = keeper.program(handle) {
                    program.close();
                }
            }
            ToKeeper::EndNow { handle } => {
                if let Some(program) = keeper.program(handle)
                    && let Err(err) = program.end_now()
                {
                    log_line!("floti keeper: {err}");
                }
            }
            ToKeeper::Forget { handle } => keeper.forget(handle),
            ToKeeper::Shutdown => {
                keeper.end_everything();
                break Served::Shutdown;
            }
        }
    };

    for forwarder in &forwarders {
        forwarder.abort();
    }
    for program in keeper.programs.list() {
        program.detach(HOST);
    }
    if let Served::Shutdown = served {
        let _ = out.send(FromKeeper::Bye);
        drop(out);
        // Every forwarder has let go of its sender, so this ends once Bye
        // is written.
        let _ = writing.await;
    } else {
        writing.abort();
    }
    served
}

/// Sends `handle`'s output to the host until the program ends.
fn forward(handle: u64, mut output: Attached, out: UnboundedSender<FromKeeper>) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(next) = output.recv().await {
            match next {
                SessionOutput::Data(bytes) => {
                    let _ = out.send(FromKeeper::Data {
                        handle,
                        bytes: ByteBuf::from(bytes.to_vec()),
                    });
                }
                // The host keeps the size; it told the keeper.
                SessionOutput::Resized(_) => {}
                SessionOutput::Exited(exit) => {
                    let _ = out.send(FromKeeper::Exited {
                        handle,
                        exit: WireExit::from(&exit),
                    });
                    return;
                }
            }
        }
    })
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
