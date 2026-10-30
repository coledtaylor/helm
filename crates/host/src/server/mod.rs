//! The host process: one per user, holding the sessions and serving them to
//! clients on the local socket.
//!
//! Starting takes, in this order and before anything else is opened: the
//! data folder's lock, so the host alone opens `floti.db`; the host key
//! ([`HOST_KEY_FILE`]), made on the first start and read on every later one,
//! so a socket that answers always has its key; while no device is an admin,
//! a fresh one-time code in [`ENROLMENT_FILE`] (see `enrolment`), so a client
//! on this computer can enrol from the first connection on; the socket,
//! which refuses an endpoint a live host holds; then the store, whose rows a
//! crash or an update left running are reconciled to lost and offered back
//! once.
//!
//! Every connection starts with a Noise handshake (`floti_protocol::noise`),
//! in which the host proves its key and the client its device key, checked
//! against the device registry ([`DEVICES_FILE`], read fresh each time), or,
//! for a key the registry does not know, the one-time code it carried. A
//! connection that fails it, presents a key that is unknown or revoked, or
//! does not finish within [`HANDSHAKE_DEADLINE`] is closed without a byte
//! written, and the host's log (its stderr) gets one line saying why. Inside
//! the session clients speak `floti-protocol`, starting at `hello`, every
//! frame sealed. Sessions outlive them: a client leaving ends nothing. Stopping the host ends every
//! session's process tree; a plain stop records each row as exited first, a
//! stop for an update leaves them for the next start to find lost. Sessions
//! never outlive the host: one that is killed or crashes takes every process
//! it started with it, and leaves the rows for the next start to find lost.
//!
//! What it serves is one module per feature under `features`: today launch
//! and live sessions (the session list, start, the launcher's launch, a
//! profile's launch, a resume from history, rename, resize, focus, close with
//! its confirmation, `session:exit`, `session:activate`, the activity and the
//! machine-wide overview, the restore offer and restore, and the session
//! terminal stream), plain terminals (`pterm:*` and their stream); history
//! (`history:*`), the transcript archive (`archive:*`) and usage (`usage:*`);
//! the config console (`config:*` but `config:render`, with
//! `config:externalChange`); and `host:stop`. Every other declared channel
//! is on the not-yet-served list ([`unserved`]) with the feature that will
//! serve it, and is answered with an error naming it.

mod agent_tools;
mod browser_tools;
mod connection;
mod enrolment;
mod events;
mod features;
mod hosted;
pub(crate) mod records;
mod session_tools;
pub mod unserved;

use std::collections::BTreeSet;

use std::ffi::OsString;
use std::fs::{File, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::Duration;

use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::SessionResources;
use floti_protocol::channels::workspace::AppMode;
use floti_protocol::noise::{KeyPair, PublicKey};
use floti_protocol::{BackendId, Catalogue, HostIdentity, PROTOCOL_VERSION};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::agent::claude_code::{ClaudeCodeBackend, ClaudeCodeSettings};
use crate::agent::{AgentBackend, PlainCommandBackend, sweep_launch_folders};
use crate::devices::DeviceRegistry;
use crate::keys::{load_or_create_key_pair, read_key_pair};
use crate::platform::folders::{self, Folders, UserEnv};
use crate::platform::private_files::sweep_stale_temps;
use crate::platform::process_tree::{self, ProcessTree};
use crate::platform::socket::{self, Endpoint, LocalListener, LocalSocket};
use crate::session::ClientId;
use crate::store::Store;
use crate::{Error, Result};

use agent_tools::HostAgentTools;
use connection::{Admission, ConnectionContext};
use enrolment::Enrolment;
pub use enrolment::{FIRST_ADMIN_NAME, LocalEnrolment, read_enrolment};
use features::Features;
use hosted::Hosted;
use session_tools::HostWorld;

/// The socket's name in the runtime folder.
pub const SOCKET_NAME: &str = "floti";

/// The file in the data folder whose lock says a host is using that folder.
pub const LOCK_FILE: &str = "host.lock";

/// The host's private key in the data folder, owner-only.
pub const HOST_KEY_FILE: &str = "host.key";

/// The device registry in the data folder, owner-only.
pub const DEVICES_FILE: &str = "devices.json";

/// The host's key and its one-time enrolment code in the data folder,
/// owner-only, while the host waits for its first admin.
pub const ENROLMENT_FILE: &str = "enrolment.json";

/// How long a connection has, from when it is accepted, to finish the Noise
/// handshake before the host closes it.
pub const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(10);

/// The file in a data folder that gives a test build's host a handshake
/// deadline of its own, in milliseconds, so the test of the deadline against
/// the executable need not wait the real one out. A production build never
/// reads it.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_HANDSHAKE_DEADLINE_MARKER: &str = "floti-test-handshake-deadline";

/// How long a connection to the host over the data folder `data` has to
/// finish the handshake: [`HANDSHAKE_DEADLINE`], or in a test build what
/// [`TEST_HANDSHAKE_DEADLINE_MARKER`] there says.
fn handshake_deadline(data: &Path) -> Duration {
    #[cfg(any(test, feature = "testkit"))]
    if let Some(ms) = std::fs::read_to_string(data.join(TEST_HANDSHAKE_DEADLINE_MARKER))
        .ok()
        .and_then(|text| text.trim().parse().ok())
    {
        return Duration::from_millis(ms);
    }
    let _ = data;
    HANDSHAKE_DEADLINE
}

/// How long a stop waits, once the sessions have ended, for the store to be
/// let go before it releases the data folder anyway.
const RELEASE_WAIT: Duration = Duration::from_secs(10);

/// The public half of the host key kept in the data folder `data`, or
/// `None` before a host has started there. For pairing a device and pinning
/// a client to the host; the private half never leaves the host.
pub fn host_public_key(data: &Path) -> Result<Option<PublicKey>> {
    Ok(read_key_pair(&data.join(HOST_KEY_FILE))?.map(|pair| pair.public()))
}

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
    /// How it was started and for whom, as `app:info` reports it.
    pub run: HostRun,
}

impl HostConfig {
    /// The host the user's environment describes: its folders (with any
    /// `FLOTI_*_DIR` overrides), the socket in its runtime folder, and the
    /// [`backends`] it gives.
    pub fn from_env(env: &UserEnv) -> Result<Self> {
        let folders = folders::resolve(env)?;
        let endpoint = local_endpoint(&folders);
        Ok(Self {
            folders,
            endpoint,
            backends: backends(env, ClaudeCodeSettings::from_env(env)),
            inherited_env: env
                .vars
                .iter()
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect(),
            run: HostRun::from_env(env),
        })
    }
}

/// Where the host over `folders` listens: the socket in its runtime folder.
/// A client on this computer finds the host the same way.
pub fn local_endpoint(folders: &Folders) -> Endpoint {
    socket::Native.endpoint(&folders.runtime, SOCKET_NAME)
}

/// How a host was started and for whom.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostRun {
    pub mode: AppMode,
    /// The user's home folder, for a client to show a long path from `~`,
    /// and where `roots:suggest` looks for a `.harness` folder. Nothing in
    /// it is written.
    pub home: Option<PathBuf>,
}

impl HostRun {
    /// A host on the OS's own folders is the installed one; a host whose
    /// data folder was moved (`FLOTI_DATA_DIR`) runs on data of its own, as
    /// a development run does.
    pub fn from_env(env: &UserEnv) -> Self {
        let moved = env.var(folders::DATA_DIR_VAR).is_some();
        Self {
            mode: if moved {
                AppMode::Dev
            } else {
                AppMode::Installed
            },
            home: env.home.clone(),
        }
    }
}

/// A development run with no home folder to show: what a test's host is.
impl Default for HostRun {
    fn default() -> Self {
        Self {
            mode: AppMode::Dev,
            home: None,
        }
    }
}

/// The backends a host runs, in order: the user's shell, run as a plain
/// command, then Claude Code as `claude` describes it, when there is one.
/// The shell stays the default until a client names the backend it launches
/// with; a restore uses the backend each session's row recorded.
pub fn backends(env: &UserEnv, claude: Option<ClaudeCodeSettings>) -> Vec<Arc<dyn AgentBackend>> {
    let mut backends: Vec<Arc<dyn AgentBackend>> = vec![Arc::new(shell_backend(env))];
    if let Some(settings) = claude {
        backends.push(Arc::new(ClaudeCodeBackend::new(
            settings,
            Arc::new(process_tree::Native),
        )));
    }
    backends
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
    /// Asks for a stop for `reason`; whether this was the first ask, which
    /// the host stops for.
    pub fn stop(&self, reason: HostStopReason) -> bool {
        self.0.send_if_modified(|current| {
            if current.is_some() {
                return false;
            }
            *current = Some(reason);
            true
        })
    }
}

/// A running host.
pub struct Host {
    hosted: Arc<Hosted>,
    features: Arc<Features>,
    /// The agent tools listener and the tokens its sessions hold.
    agent_tools: Arc<HostAgentTools>,
    endpoint: Endpoint,
    stopper: Stopper,
    stop_requested: watch::Receiver<Option<HostStopReason>>,
    shutdown: watch::Sender<bool>,
    accepting: JoinHandle<()>,
    /// The store, watched so a stop can wait until nothing has it open.
    store: Weak<Mutex<Store>>,
    /// Held for the host's life: the data folder is this host's.
    _lock: File,
}

impl Host {
    /// Starts a host: ties what this process starts to its life, takes the
    /// data folder, loads or makes its key, takes the socket, opens and reconciles the store, and starts
    /// accepting clients. Refuses, opening nothing more, when another host
    /// has the data folder or the socket.
    ///
    /// Call it from inside a Tokio runtime.
    pub fn start(config: HostConfig) -> Result<Self> {
        let HostConfig {
            folders,
            endpoint,
            backends,
            inherited_env,
            run,
        } = config;
        // Before any session starts, so that every process the host starts
        // ends when it does, however it ends. Where the OS will not arrange
        // it, that was said and the host serves anyway.
        process_tree::Native.end_tree_with_this_process();
        let lock = lock_data_folder(&folders)?;
        // What a key or registry write killed partway left, once the process
        // that made it is gone.
        sweep_stale_temps(
            &folders.data,
            &[HOST_KEY_FILE, DEVICES_FILE, ENROLMENT_FILE],
            &process_tree::Native,
        );
        // Before the socket: a host that answers has its key.
        let host_key: Arc<KeyPair> =
            Arc::new(load_or_create_key_pair(&folders.data.join(HOST_KEY_FILE))?);
        let devices = Arc::new(DeviceRegistry::in_data_folder(&folders.data));
        // Before the socket too: a host waiting for its first admin has the
        // code a client on this computer enrols with from the first connection.
        let enrolment = Arc::new(Enrolment::prepare(
            &folders.data,
            host_key.public(),
            &devices,
        ));
        let deadline = handshake_deadline(&folders.data);
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
        let store = Arc::new(Mutex::new(store));
        let store_held = Arc::downgrade(&store);
        let hosted = Arc::new(Hosted::new(
            store,
            folders.data.clone(),
            backends,
            inherited_env,
            lost,
        )?);
        let features = Arc::new(Features::new(Arc::clone(&hosted), folders, run)?);
        let agent_tools = start_agent_tools(&hosted, &features)?;

        let (stop_tx, stop_requested) = watch::channel(None);
        let stopper = Stopper(Arc::new(stop_tx));
        let (shutdown, shutdown_rx) = watch::channel(false);
        let accepting = tokio::spawn(accept(
            listener,
            Arc::clone(&features),
            Admission {
                host_key,
                devices,
                enrolment,
                deadline,
            },
            identity,
            stopper.clone(),
            shutdown_rx,
        ));
        Ok(Self {
            hosted,
            features,
            agent_tools,
            endpoint,
            stopper,
            stop_requested,
            shutdown,
            accepting,
            store: store_held,
            _lock: lock,
        })
    }

    /// Every protocol channel this host serves, of every kind.
    pub fn served_channels(&self) -> BTreeSet<&'static str> {
        connection::served_channels(&self.features)
    }

    /// What each running hosted session is holding (its process tree and
    /// listening ports) from exactly one pass run for this ask, as a
    /// session-detail call needs it. It joins a pass already running, and no
    /// pass runs for it afterwards.
    pub async fn session_resources(&self) -> Vec<SessionResources> {
        self.features.resources().one_pass().await
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
        // Before the sessions end: no session's tools answer once the host
        // is going, and none is answered while its session is being ended.
        self.agent_tools.stop().await;
        let hosted = Arc::clone(&self.hosted);
        tokio::task::spawn_blocking(move || hosted.stop(reason))
            .await
            .map_err(|err| Error::io("end the sessions", std::io::Error::other(err)))?;
        let _ = self.shutdown.send(true);
        let Self {
            hosted,
            features,
            store,
            _lock: lock,
            ..
        } = self;
        drop(features);
        drop(hosted);
        // Connections close on the shutdown, and the history and activity
        // workers let go of the store at the end of the pass they are in.
        let deadline = tokio::time::Instant::now() + RELEASE_WAIT;
        while store.strong_count() > 0 {
            if tokio::time::Instant::now() >= deadline {
                eprintln!(
                    "floti host: the store was still in use {RELEASE_WAIT:?} after the sessions ended"
                );
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        drop(lock);
        Ok(reason)
    }
}

/// The host's agent tools: the listener with its families switched as the
/// settings say, following every change to them, answering from the
/// sessions, the activity pass and the processes-and-ports pass, given to
/// every launch from now on, and revoking each session's token as it ends.
fn start_agent_tools(hosted: &Arc<Hosted>, features: &Features) -> Result<Arc<HostAgentTools>> {
    let tools = Arc::new(HostAgentTools::new(Arc::clone(features.browser())));
    let settings = features.settings();
    tools.follow(&settings.read()?);
    let following = Arc::downgrade(&tools);
    settings.on_change(move |settings| {
        if let Some(tools) = following.upgrade() {
            tools.follow(settings);
        }
    });
    tools.answer_from(Arc::new(HostWorld {
        hosted: Arc::downgrade(hosted),
        activity: features.activity().clone(),
        resources: features.resources().clone(),
    }));
    tokio::spawn(agent_tools::revoke_at_exit(
        hosted.ledger().exits(),
        Arc::downgrade(&tools),
        Arc::downgrade(hosted),
    ));
    hosted.use_agent_tools(Arc::clone(&tools));
    Ok(tools)
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
    features: Arc<Features>,
    admission: Admission,
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
                        features: Arc::clone(&features),
                        admission: admission.clone(),
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
