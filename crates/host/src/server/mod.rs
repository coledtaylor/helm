//! The host process: one per user, holding the sessions and serving them to
//! clients on the local socket.
//!
//! Starting takes, in this order and before anything else is opened: the
//! data folder's lock, so the host alone opens `floti.db`; the host key
//! ([`HOST_KEY_FILE`]), made on the first start and read on every later one,
//! so a socket that answers always has its key; the socket, which refuses an
//! endpoint a live host holds; then the store, whose rows a crash or an
//! update left running are reconciled to lost and offered back once. The
//! device list and one-time code an earlier version kept
//! ([`RETIRED_FILES`]) are deleted on the way.
//!
//! Every connection starts with a Noise handshake (`floti_protocol::noise`),
//! in which the host proves its key and the client its device key. Whatever
//! reaches the socket, which only the host's OS user can open, and completes
//! the handshake is served in full: on the host's computer, or through that
//! user's own ssh login or command running `floti connect`, which opens the
//! relay endpoint. There is no pairing, approval, role or presence; the login
//! is the access. A connection that fails the handshake or does not finish it
//! within [`HANDSHAKE_DEADLINE`] is closed without a byte written, and the
//! host's log (its stderr) gets one line saying why. Inside the session
//! clients speak `floti-protocol`, starting at `hello`, every frame sealed;
//! one that has not said `hello` within [`HELLO_DEADLINE`] of the host's
//! answer is closed the same way, logged by its device's fingerprint. Every
//! client sees which devices are attached and may disconnect one
//! (`attached`).
//!
//! Sessions outlive clients: a client leaving ends nothing. Stopping the host ends every
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
mod attached;
mod browser_tools;
mod connection;
mod events;
mod features;
pub(crate) mod floti_agents;
mod hosted;
pub mod idle;
mod plugin_tools;
pub(crate) mod records;
mod session_tools;
mod stopper;
pub mod unserved;

pub use stopper::Stopper;

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
use crate::keeper::Keeper;
use crate::keys::{load_or_create_key_pair, read_key_pair};
use crate::platform::folders::{self, Folders, UserEnv};
use crate::platform::node_runtime;
use crate::platform::private_files::sweep_stale_temps;
use crate::platform::process_tree::{self, ProcessTree};
use crate::platform::socket::{self, Endpoint, LocalListener, LocalSocket};
use crate::platform::wsl::{self, WslProgram, WslSide};
use crate::roles::RoleSource;
use crate::roles::folder::{FolderRoles, roles_folder};
use crate::roles::seed::seed_roles;
use crate::session::ClientId;
use crate::store::Store;
use crate::{Error, Result};

use agent_tools::HostAgentTools;
use connection::{Admission, ConnectionContext};
use features::Features;
use hosted::Hosted;
pub use hosted::Occupancy;
use session_tools::HostWorld;

/// The socket's name in the runtime folder.
pub const SOCKET_NAME: &str = "floti";

/// The file in the data folder whose lock says a host is using that folder.
pub const LOCK_FILE: &str = "host.lock";

/// The host's private key in the data folder, owner-only.
pub const HOST_KEY_FILE: &str = "host.key";

/// What an earlier version kept in the data folder and this one deletes at
/// start: its list of paired devices and its one-time enrolment code. Access
/// is the user's login now, so neither means anything.
pub const RETIRED_FILES: [&str; 2] = ["devices.json", "enrolment.json"];

/// How long a connection has, from when it is accepted, to finish the Noise
/// handshake before the host closes it.
pub const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(10);

/// How long a connection has, from when the host's handshake answer has been
/// written, to say `hello` before the host closes it. The same as the
/// handshake's: a client says it as soon as it has read the answer.
pub const HELLO_DEADLINE: Duration = Duration::from_secs(10);

/// The file in a data folder that gives a test build's host a deadline of
/// its own, in milliseconds, for both the handshake and the `hello` after
/// it, so the tests of the deadlines against the executable need not wait
/// the real ones out. A production build never reads it.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_HANDSHAKE_DEADLINE_MARKER: &str = "floti-test-handshake-deadline";

/// How long a connection to the host over the data folder `data` has to
/// finish the handshake: [`HANDSHAKE_DEADLINE`], or in a test build what
/// [`TEST_HANDSHAKE_DEADLINE_MARKER`] there says.
fn handshake_deadline(data: &Path) -> Duration {
    test_deadline(data).unwrap_or(HANDSHAKE_DEADLINE)
}

/// How long a connection to the host over the data folder `data` has to say
/// `hello` once its handshake is answered: [`HELLO_DEADLINE`], or in a test
/// build what [`TEST_HANDSHAKE_DEADLINE_MARKER`] there says.
fn hello_deadline(data: &Path) -> Duration {
    test_deadline(data).unwrap_or(HELLO_DEADLINE)
}

/// The deadline [`TEST_HANDSHAKE_DEADLINE_MARKER`] in `data` gives a test
/// build; always `None` in a production build.
fn test_deadline(data: &Path) -> Option<Duration> {
    #[cfg(any(test, feature = "testkit"))]
    if let Some(ms) = std::fs::read_to_string(data.join(TEST_HANDSHAKE_DEADLINE_MARKER))
        .ok()
        .and_then(|text| text.trim().parse().ok())
    {
        return Some(Duration::from_millis(ms));
    }
    let _ = data;
    None
}

/// The file in a data folder whose text, `<major>.<minor>`, is the protocol
/// version a test build's host greets with in place of [`PROTOCOL_VERSION`],
/// so a test can meet a host one version apart. A production build never
/// reads it.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_HOST_PROTOCOL: &str = "floti-test-host-protocol";

/// The protocol version the host over the data folder `data` greets with:
/// [`PROTOCOL_VERSION`], or in a test build what [`TEST_HOST_PROTOCOL`] there
/// says.
fn host_protocol(data: &Path) -> floti_protocol::ProtocolVersion {
    #[cfg(any(test, feature = "testkit"))]
    if let Some((major, minor)) = std::fs::read_to_string(data.join(TEST_HOST_PROTOCOL))
        .ok()
        .and_then(|text| {
            let (major, minor) = text.trim().split_once('.')?;
            Some((major.parse().ok()?, minor.parse().ok()?))
        })
    {
        return floti_protocol::ProtocolVersion::new(major, minor);
    }
    let _ = data;
    PROTOCOL_VERSION
}

/// The file in a data folder whose text is the floti version a test build's
/// host names, in its welcome and its restart state, in place of
/// [`FLOTI_VERSION`](crate::version::FLOTI_VERSION), so a test, or a dev
/// window driven to look at it, can meet a host older than the Helm it is.
/// A production build never reads it.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_HOST_VERSION: &str = "floti-test-host-version";

/// The floti version the host over the data folder `data` names:
/// [`FLOTI_VERSION`](crate::version::FLOTI_VERSION), or in a test build what
/// [`TEST_HOST_VERSION`] there says.
fn host_version(data: &Path) -> String {
    #[cfg(any(test, feature = "testkit"))]
    if let Some(version) = std::fs::read_to_string(data.join(TEST_HOST_VERSION))
        .ok()
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
    {
        return version;
    }
    let _ = data;
    crate::version::FLOTI_VERSION.to_owned()
}

/// How long a stop waits, once the sessions have ended, for the plugin
/// registry to be let go, and then for the store, before it goes on anyway.
const RELEASE_WAIT: Duration = Duration::from_secs(10);

/// The public half of the host key kept in the data folder `data`, or
/// `None` before a host has started there. For a client on this computer to
/// pin the host it connects to (`floti connect --host-key`); the private
/// half never leaves the host.
pub fn host_public_key(data: &Path) -> Result<Option<PublicKey>> {
    Ok(read_key_pair(&data.join(HOST_KEY_FILE))?.map(|pair| pair.public()))
}

/// Deletes what an earlier version left in the data folder `data`
/// ([`RETIRED_FILES`]). One that is not there is nothing to do; one that
/// cannot be deleted is said in the log, and the host starts all the same:
/// nothing reads it.
fn remove_retired_files(data: &Path) {
    for name in RETIRED_FILES {
        match std::fs::remove_file(data.join(name)) {
            Ok(()) => log_line!("floti host: deleted {name}, which an earlier version kept"),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => log_line!("floti host: could not delete {name}: {err}"),
        }
    }
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

/// Where the host over `folders` listens for clients on other computers,
/// which `floti connect` opens: its relay endpoint, beside the local one.
pub fn relay_endpoint(folders: &Folders) -> Endpoint {
    local_endpoint(folders).relay()
}

/// How a host was started and for whom.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostRun {
    pub mode: AppMode,
    /// The user's home folder, for a client to show a long path from `~`,
    /// and where `roots:suggest` looks for a `.harness` folder. Nothing in
    /// it is written.
    pub home: Option<PathBuf>,
    /// The Node binary plugin services of the `node` kind run on, or `None`
    /// when this host has none ([`node_runtime::runtime`]).
    pub node: Option<PathBuf>,
    /// Whether a desktop started it (`floti host --desktop`), so that a
    /// desktop that loses it may start another in its place.
    pub desktop: bool,
    /// The `floti` executable the host runs its session keeper from
    /// (`floti keeper`), which holds every session and plain terminal so
    /// they outlive the host. `None` runs them in the host itself, ending
    /// with it.
    pub keeper: Option<PathBuf>,
    /// The `wsl.exe` it keeps distros awake with (`wsl:keepAwake`), or
    /// `None` where there is no WSL ([`WslSide::program`]).
    pub wsl: Option<WslProgram>,
}

impl HostRun {
    /// A host on the OS's own folders is the installed one; a host whose
    /// data folder was moved (`FLOTI_DATA_DIR`) runs on data of its own, as
    /// a development run does. Its Node is `FLOTI_NODE`, else the one
    /// shipped beside this executable.
    pub fn from_env(env: &UserEnv) -> Self {
        let moved = env.var(folders::DATA_DIR_VAR).is_some();
        let exe = std::env::current_exe().ok();
        Self {
            mode: if moved {
                AppMode::Dev
            } else {
                AppMode::Installed
            },
            home: env.home.clone(),
            node: node_runtime::runtime(env, exe.as_deref(), &node_runtime::Native),
            desktop: false,
            keeper: exe,
            wsl: wsl::Native.program(env),
        }
    }
}

/// A development run with no home folder to show and no Node: what a test's
/// host is.
impl Default for HostRun {
    fn default() -> Self {
        Self {
            mode: AppMode::Dev,
            home: None,
            node: None,
            desktop: false,
            keeper: None,
            wsl: None,
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
            &[HOST_KEY_FILE, RETIRED_FILES[0], RETIRED_FILES[1]],
            &process_tree::Native,
        );
        remove_retired_files(&folders.data);
        // Before the socket: a host that answers has its key.
        let host_key: Arc<KeyPair> =
            Arc::new(load_or_create_key_pair(&folders.data.join(HOST_KEY_FILE))?);
        let deadline = handshake_deadline(&folders.data);
        let hello_deadline = hello_deadline(&folders.data);
        // Launch folders a crashed run left, once their owners are gone.
        sweep_launch_folders(&folders.data, &process_tree::Native);
        let listener = socket::Native.bind(&endpoint)?;
        let relay = socket::Native.bind(&endpoint.relay())?;
        let store = Store::open(&folders.data)?;
        // Sessions run in the keeper, which outlives this host; without one
        // they run here and end with it.
        let keeper = run
            .keeper
            .clone()
            .map(|program| Arc::new(Keeper::new(program, &folders, inherited_env.clone())));
        let identity = Arc::new(HostIdentity {
            protocol: host_protocol(&folders.data),
            host_version: host_version(&folders.data),
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
            keeper,
        )?);
        // What the keeper still runs keeps the host busy from its start.
        hosted.settle();
        if let Some(floti) = &run.keeper {
            hosted.use_floti(floti);
        }
        // The roles an agent starts children in are files in the config
        // folder, read afresh at every start. A folder that could not be
        // seeded is not a host that cannot start: the default role still
        // works, and the problem is in the log.
        let roles_dir = roles_folder(&folders);
        if let Some(problem) = seed_roles(&roles_dir).problem {
            log_line!("floti host: {problem}");
        }
        hosted.use_roles(Arc::new(FolderRoles::new(roles_dir)));
        let features = Arc::new(Features::new(Arc::clone(&hosted), folders, run)?);
        let agent_tools = start_agent_tools(&hosted, &features)?;

        let (stopper, stop_requested) = Stopper::new();
        let (shutdown, shutdown_rx) = watch::channel(false);
        tokio::spawn(hosted::settle_on_exits(
            hosted.ledger().exits(),
            hosted.terminals().exits(),
            Arc::downgrade(&hosted),
        ));
        let accepted = Accepted {
            features: Arc::clone(&features),
            hosted: Arc::clone(&hosted),
            admission: Admission {
                host_key,
                deadline,
                hello_deadline,
            },
            identity,
            stopper: stopper.clone(),
            shutdown: shutdown_rx,
        };
        let accepting = tokio::spawn({
            let relayed = accepted.clone();
            async move {
                tokio::join!(
                    accept(listener, false, accepted),
                    accept(relay, true, relayed)
                );
            }
        });
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

    /// Reads the roles a session may start children in from `roles` from now
    /// on. The host starts with none named.
    pub fn use_roles(&self, roles: Arc<dyn RoleSource>) {
        self.hosted.use_roles(roles);
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

    /// Where clients on other computers connect, through `floti connect`.
    pub fn relay_endpoint(&self) -> Endpoint {
        self.endpoint.relay()
    }

    /// How many sessions and plain terminals it runs and clients it has
    /// attached, now and as that changes: what a host that exits once it is
    /// idle follows.
    pub fn occupancy(&self) -> watch::Receiver<Occupancy> {
        self.hosted.occupancy()
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
        // Every background, service and plugin call ends, and the registry's
        // own tasks let go of it, and of the store, before the features go.
        let plugins = features.plugins().shutdown();
        if tokio::time::timeout(RELEASE_WAIT, plugins).await.is_err() {
            log_line!(
                "floti host: the plugin registry was still in use {RELEASE_WAIT:?} after it was shut down"
            );
        }
        drop(features);
        drop(hosted);
        // Connections close on the shutdown, and the history and activity
        // workers let go of the store at the end of the pass they are in.
        let deadline = tokio::time::Instant::now() + RELEASE_WAIT;
        while store.strong_count() > 0 {
            if tokio::time::Instant::now() >= deadline {
                log_line!(
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
/// settings say, following every change to them and to the plugins' offers,
/// answering from the sessions, the activity pass and the processes-and-ports
/// pass, given to every launch from now on, and revoking each session's token
/// as it ends.
fn start_agent_tools(hosted: &Arc<Hosted>, features: &Features) -> Result<Arc<HostAgentTools>> {
    let tools = Arc::new(HostAgentTools::new(
        Arc::clone(features.browser()),
        Arc::clone(features.plugin_tools()),
        Arc::clone(features.host_plugin_tools()),
    ));
    // An offer taken away, or a plugin of the host's own switched off, can
    // leave nothing to serve: the port goes then.
    let offers = Arc::downgrade(&tools);
    features.plugin_tools().on_change(move || {
        if let Some(tools) = offers.upgrade() {
            tools.settle();
        }
    });
    let own_plugins = Arc::downgrade(&tools);
    features.host_plugin_tools().on_change(move || {
        if let Some(tools) = own_plugins.upgrade() {
            tools.settle();
        }
    });
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
    // The agents family starts, lists and stops children through the host, and
    // a session's children end with it, with no client needed.
    tools.act_through(Arc::downgrade(hosted));
    tokio::spawn(hosted::end_children_at_exit(
        hosted.ledger().exits(),
        Arc::downgrade(hosted),
    ));
    hosted.use_agent_tools(Arc::clone(&tools));
    // Parents that ended while no host was running left children behind.
    let sweeping = Arc::clone(hosted);
    tokio::task::spawn_blocking(move || sweeping.end_orphans());
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
        Err(TryLockError::WouldBlock) => Err(Error::AlreadyRunning(format!(
            "A Floti host is already running for this user: it is using {}.",
            folders.data.display()
        ))),
        Err(TryLockError::Error(source)) => Err(Error::path("lock", &path, source)),
    }
}

/// What every accepted connection is served with.
#[derive(Clone)]
struct Accepted {
    features: Arc<Features>,
    hosted: Arc<Hosted>,
    admission: Admission,
    identity: Arc<HostIdentity>,
    stopper: Stopper,
    shutdown: watch::Receiver<bool>,
}

/// Accepts clients on `listener` until the host stops; `away` says it is
/// the relay endpoint, whose clients reached the host from another computer.
async fn accept(mut listener: socket::Listener, away: bool, accepted: Accepted) {
    static NEXT_CLIENT: AtomicU64 = AtomicU64::new(1);
    loop {
        match listener.accept().await {
            Ok(stream) => {
                let client = ClientId(NEXT_CLIENT.fetch_add(1, Ordering::Relaxed));
                tokio::spawn(connection::serve(
                    stream,
                    client,
                    away,
                    ConnectionContext {
                        features: Arc::clone(&accepted.features),
                        hosted: Arc::clone(&accepted.hosted),
                        admission: accepted.admission.clone(),
                        identity: Arc::clone(&accepted.identity),
                        stopper: accepted.stopper.clone(),
                        shutdown: accepted.shutdown.clone(),
                    },
                ));
            }
            Err(err) => {
                log_line!("floti host: {err}");
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
