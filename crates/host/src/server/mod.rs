//! The host process: one per user, holding the sessions and serving them to
//! clients on the local socket.
//!
//! Starting takes, in this order and before anything else is opened: the
//! data folder's lock, so the host alone opens `floti.db`; the socket, which
//! refuses an endpoint a live host holds; then the store, whose rows a crash
//! or an update left running are reconciled to lost and offered back once.
//!
//! Clients speak `floti-protocol`, starting at `hello`. Sessions outlive
//! them: a client leaving ends nothing. Stopping the host ends every
//! session's process tree; a plain stop records each row as exited first, a
//! stop for an update leaves them for the next start to find lost.
//!
//! The skeleton serves the session list, start, close and resize, the
//! session terminal stream, `session:exit`, the restore offer and restore,
//! and `host:stop`. Every other declared channel is answered with an error
//! naming it.

mod connection;
mod hosted;
mod records;

use std::ffi::OsString;
use std::fs::{File, TryLockError};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use floti_protocol::channels::host::HostStopReason;
use floti_protocol::{BackendId, Catalogue, HostIdentity, PROTOCOL_VERSION};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::agent::claude_code::{ClaudeCodeBackend, ClaudeCodeSettings};
use crate::agent::{AgentBackend, PlainCommandBackend, sweep_launch_folders};
use crate::platform::folders::{self, Folders, UserEnv};
use crate::platform::process_tree;
use crate::platform::socket::{self, Endpoint, LocalListener, LocalSocket};
use crate::session::ClientId;
use crate::store::Store;
use crate::{Error, Result};

use connection::ConnectionContext;
use hosted::Hosted;

/// The socket's name in the runtime folder.
pub const SOCKET_NAME: &str = "floti";

/// The file in the data folder whose lock says a host is using that folder.
pub const LOCK_FILE: &str = "host.lock";

/// Every channel of the protocol, built once.
static CATALOGUE: LazyLock<Catalogue> = LazyLock::new(Catalogue::protocol);

/// What a host runs with.
pub struct HostConfig {
    /// Its folders. The store is in `folders.data`.
    pub folders: Folders,
    /// Where clients connect.
    pub endpoint: Endpoint,
    /// The agent backends it can run sessions on; the first is the default.
    pub backends: Vec<Arc<dyn AgentBackend>>,
    /// The environment sessions inherit, less what every session drops.
    pub inherited_env: Vec<(OsString, OsString)>,
}

impl HostConfig {
    /// The host the user's environment describes: its folders (with any
    /// `FLOTI_*_DIR` overrides), the socket in its runtime folder, and its
    /// backends: the user's shell, run as a plain command, then Claude Code.
    /// The shell stays the default until a client names the backend it
    /// launches with.
    pub fn from_env(env: &UserEnv) -> Result<Self> {
        let folders = folders::resolve(env)?;
        let endpoint = socket::Native.endpoint(&folders.runtime, SOCKET_NAME);
        let mut backends: Vec<Arc<dyn AgentBackend>> = vec![Arc::new(shell_backend(env))];
        if let Some(settings) = ClaudeCodeSettings::from_env(env) {
            backends.push(Arc::new(ClaudeCodeBackend::new(
                settings,
                Arc::new(process_tree::Native),
            )));
        }
        Ok(Self {
            folders,
            endpoint,
            backends,
            inherited_env: env
                .vars
                .iter()
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect(),
        })
    }
}

/// The user's shell as a plain command: `%COMSPEC%` where it is set, which
/// is Windows, otherwise `$SHELL`, otherwise `/bin/sh`.
pub fn shell_backend(env: &UserEnv) -> PlainCommandBackend {
    let program: OsString = env
        .var_any_case("COMSPEC")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| env.absolute_var("SHELL"))
        .map_or_else(|| "/bin/sh".into(), PathBuf::into_os_string);
    PlainCommandBackend::new(
        BackendId::new("shell"),
        "Shell",
        program,
        Vec::<OsString>::new(),
    )
}

/// Asks a running host to stop. The first reason given is the one it stops
/// for.
#[derive(Clone)]
pub struct Stopper(Arc<watch::Sender<Option<HostStopReason>>>);

impl Stopper {
    pub fn stop(&self, reason: HostStopReason) {
        self.0.send_if_modified(|current| {
            if current.is_some() {
                return false;
            }
            *current = Some(reason);
            true
        });
    }
}

/// A running host.
pub struct Host {
    hosted: Arc<Hosted>,
    endpoint: Endpoint,
    stopper: Stopper,
    stop_requested: watch::Receiver<Option<HostStopReason>>,
    shutdown: watch::Sender<bool>,
    accepting: JoinHandle<()>,
    /// Held for the host's life: the data folder is this host's.
    _lock: File,
}

impl Host {
    /// Starts a host: takes the data folder and the socket, opens and
    /// reconciles the store, and starts accepting clients. Refuses, opening
    /// nothing more, when another host has the data folder or the socket.
    ///
    /// Call it from inside a Tokio runtime.
    pub fn start(config: HostConfig) -> Result<Self> {
        let HostConfig {
            folders,
            endpoint,
            backends,
            inherited_env,
        } = config;
        let lock = lock_data_folder(&folders)?;
        // Launch folders a crashed run left, once their owners are gone.
        sweep_launch_folders(&folders.data, &process_tree::Native);
        let listener = socket::Native.bind(&endpoint)?;
        let store = Store::open(&folders.data)?;
        let lost = records::reconcile_running(&store)?;
        let identity = Arc::new(HostIdentity {
            protocol: PROTOCOL_VERSION,
            host_version: env!("CARGO_PKG_VERSION").to_owned(),
            backends: backends
                .iter()
                .map(|backend| backend.capabilities())
                .collect(),
        });
        let hosted = Arc::new(Hosted::new(
            Arc::new(Mutex::new(store)),
            folders.data.clone(),
            backends,
            inherited_env,
            lost,
        )?);

        let (stop_tx, stop_requested) = watch::channel(None);
        let stopper = Stopper(Arc::new(stop_tx));
        let (shutdown, shutdown_rx) = watch::channel(false);
        let accepting = tokio::spawn(accept(
            listener,
            Arc::clone(&hosted),
            identity,
            stopper.clone(),
            shutdown_rx,
        ));
        Ok(Self {
            hosted,
            endpoint,
            stopper,
            stop_requested,
            shutdown,
            accepting,
            _lock: lock,
        })
    }

    /// Where clients connect.
    pub fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    /// A handle that asks this host to stop, for the OS's stop signals.
    pub fn stopper(&self) -> Stopper {
        self.stopper.clone()
    }

    /// Asks the host to stop; [`Self::run_until_stopped`] carries it out.
    pub fn stop(&self, reason: HostStopReason) {
        self.stopper.stop(reason);
    }

    /// Serves until a stop is asked for, by a client or through
    /// [`Self::stopper`], then stops: no more clients are accepted, the
    /// sessions end as the reason says, and every connection closes. The
    /// store and the data folder are let go when this returns.
    pub async fn run_until_stopped(mut self) -> Result<HostStopReason> {
        let reason = loop {
            if let Some(reason) = *self.stop_requested.borrow_and_update() {
                break reason;
            }
            if self.stop_requested.changed().await.is_err() {
                break HostStopReason::Stop;
            }
        };
        self.accepting.abort();
        let _ = (&mut self.accepting).await;
        let hosted = Arc::clone(&self.hosted);
        tokio::task::spawn_blocking(move || hosted.stop(reason))
            .await
            .map_err(|err| Error::io("end the sessions", std::io::Error::other(err)))?;
        let _ = self.shutdown.send(true);
        Ok(reason)
    }
}

/// Takes the data folder's lock, creating the folder if it is new. Refused
/// when another host holds it, before `floti.db` is opened.
fn lock_data_folder(folders: &Folders) -> Result<File> {
    std::fs::create_dir_all(&folders.data)
        .map_err(|source| Error::path("create the data folder", &folders.data, source))?;
    let path = folders.data.join(LOCK_FILE);
    let file = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(|source| Error::path("open", &path, source))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(Error::Refused(format!(
            "A Floti host is already running for this user: it is using {}.",
            folders.data.display()
        ))),
        Err(TryLockError::Error(source)) => Err(Error::path("lock", &path, source)),
    }
}

async fn accept(
    mut listener: socket::Listener,
    hosted: Arc<Hosted>,
    identity: Arc<HostIdentity>,
    stopper: Stopper,
    shutdown: watch::Receiver<bool>,
) {
    static NEXT_CLIENT: AtomicU64 = AtomicU64::new(1);
    loop {
        match listener.accept().await {
            Ok(stream) => {
                let client = ClientId(NEXT_CLIENT.fetch_add(1, Ordering::Relaxed));
                tokio::spawn(connection::serve(
                    stream,
                    client,
                    ConnectionContext {
                        hosted: Arc::clone(&hosted),
                        identity: Arc::clone(&identity),
                        stopper: stopper.clone(),
                        shutdown: shutdown.clone(),
                    },
                ));
            }
            Err(err) => {
                eprintln!("floti host: {err}");
                // A failing accept is not retried in a tight loop.
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}

#[cfg(test)]
mod shell_tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::agent::{LaunchFolder, LaunchRequest};
    use crate::testkit::TestDirs;

    fn shell_program(vars: &[(&str, &str)]) -> OsString {
        let env = UserEnv {
            home: None,
            vars: vars
                .iter()
                .map(|(name, value)| (OsString::from(name), OsString::from(value)))
                .collect::<BTreeMap<_, _>>(),
        };
        let dirs = TestDirs::new();
        shell_backend(&env)
            .launch(
                &LaunchRequest::default(),
                &LaunchFolder::create(&dirs.data).unwrap(),
            )
            .unwrap()
            .spec
            .program
    }

    #[test]
    fn the_shell_is_comspec_however_windows_spells_it_then_shell_then_bin_sh() {
        let comspec = std::env::current_exe().unwrap();
        let comspec = comspec.to_str().unwrap();
        assert_eq!(
            shell_program(&[("ComSpec", comspec), ("SHELL", "/bin/zsh")]),
            OsString::from(comspec)
        );
        assert_eq!(
            shell_program(&[("COMSPEC", comspec)]),
            OsString::from(comspec)
        );
        assert_eq!(shell_program(&[("ComSpec", "")]), OsString::from("/bin/sh"));
        assert_eq!(shell_program(&[]), OsString::from("/bin/sh"));
    }
}
