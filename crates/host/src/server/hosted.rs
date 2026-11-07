//! The sessions the host runs, as its clients' requests reach them: start,
//! the launcher's launch, a profile's launch and a resume from history, then
//! list, rename, close and resize, the restore offer, the plain terminals,
//! and the stop that ends them all.
//!
//! Which device started each running session, and opened each plain
//! terminal, is known here by its fingerprint, from the device each attached
//! client's connection proved. Each program's label in the session keeper
//! carries it too, so a host that takes them back after a crash knows whose
//! they are. A device's deliberate quit ends what it started
//! (`host:quit`), and how many sessions, terminals and clients there are is
//! one watch ([`Occupancy`]) that the host's own exit follows.
//!
//! Every launch is one path ([`Plan`] through `Hosted::run`): a backend, a
//! folder, a name made unique against the running sessions, and a
//! composition the backend turns into its own flags. A start, a launch, a
//! profile's launch, a resume and a restore differ only in where each of
//! those comes from.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Duration;

use floti_protocol::channels::common::{ChildReport, SessionRecord};
use floti_protocol::channels::host::{DeviceSession, HostStopReason};
use floti_protocol::channels::sessions::{
    CloseSessionRequest, HistorySession, LaunchProfileRequest, LaunchSessionRequest,
    LaunchedProfile, LaunchedSession, Profile, PtermOpenRequest, PtermOpened, RenameSessionRequest,
    RestorableSession, RestoreOffer, RestoreSessionsRequest, RestoreSessionsResult,
    RestoredSession, ResumeSessionRequest, ResumedSession, SessionResizeRequest,
    StartSessionRequest, UnrestoredSession,
};
use floti_protocol::noise::PublicKey;
use floti_protocol::{BackendId, Knowable};
use tokio::sync::watch;

use super::agent_tools::HostAgentTools;
use super::floti_agents::FAMILY;
use super::records::{self, HostLedger, LostRow};
use crate::agent::claude_code::{parse_instant, sanitize_session_name, unique_session_name};
use crate::agent::{
    AgentBackend, Composition, Launch, LaunchFolder, LaunchRequest, LiveRecord, ResumeRequest,
};
use crate::agent_tools::{Grant, GrantScope, KeptGrant};
use crate::keeper::{HeldKind, Keeper};
use crate::platform::process_tree;
use crate::session::{
    ClientId, HostedView, Session, SessionHost, SessionId, SessionOrigin, StartSession, TermSize,
    Terminals,
};
use crate::store::Store;
use crate::workspace::discovery::git::read_git_branch;
use crate::{Error, Result};

mod children;

use children::Children;
pub(crate) use children::{
    ChildEntry, ChildStopped, ChildrenListed, RoleEntry, RolesListed, RunCommand, SendChild,
    StartChild, WaitEnd, WaitFor, WaitRequest, Waited, end_children_at_exit,
};
#[cfg(test)]
pub(crate) use children::{EventKind, Facts, News};

/// How long a stop waits for each session to be reported ended after its
/// tree was ended.
const STOP_WAIT: Duration = Duration::from_secs(5);

/// One launch, before its name is made unique and its backend composes it.
struct Plan {
    backend: Arc<dyn AgentBackend>,
    /// The folder it runs in.
    folder: PathBuf,
    /// Basis for its name.
    name: String,
    /// The opening prompt of a new conversation, or the next turn of one
    /// reopened.
    prompt: Option<String>,
    composition: Composition,
    /// The conversation to reopen, or `None` for a new one.
    resume: Option<String>,
    origin: SessionOrigin,
}

/// The host's sessions and what it knows about them beyond the session
/// module: the backends that run them, the restore offer, and the plain
/// terminals. Which backend runs a session is in its row.
pub(crate) struct Hosted {
    sessions: SessionHost,
    terminals: Terminals,
    ledger: Arc<HostLedger>,
    /// Every backend the host can run; the first is the default.
    backends: Vec<Arc<dyn AgentBackend>>,
    /// Floti's data folder, which holds each launch's own folder.
    data: PathBuf,
    /// The session keeper that holds every session and plain terminal, or
    /// `None` when they run in this process.
    keeper: Option<Arc<Keeper>>,
    /// Set by the first stop; a host dropped without one stops as it goes.
    stopped: AtomicBool,
    /// The host's agent tools, once it has built them. A launch before then,
    /// or on a host without them, is given none.
    agent_tools: OnceLock<Arc<HostAgentTools>>,
    /// What starting children for the sessions that ask needs: roles, where
    /// the `floti` executable is, and the one lock that takes starts in turn.
    children: Children,
    /// Who is here: each attached client's device, and the device that
    /// started each running session and opened each plain terminal.
    devices: Mutex<Devices>,
    /// How many WSL distros the host holds awake now.
    held_distros: AtomicUsize,
    occupancy: watch::Sender<Occupancy>,
}

/// How much is keeping the host busy: its running sessions and plain
/// terminals, and the clients attached to it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Occupancy {
    pub sessions: usize,
    pub terminals: usize,
    pub clients: usize,
    /// The WSL distros it holds awake (`wsl:keepAwake`): each keeps a
    /// host inside one running, which a window closing must not end.
    pub distros: usize,
}

impl Occupancy {
    /// Nothing runs and nobody is attached.
    pub fn is_idle(&self) -> bool {
        *self == Self::default()
    }
}

/// The devices behind what the host is running.
#[derive(Default)]
struct Devices {
    /// Each attached client's device: the key its connection proved.
    clients: HashMap<ClientId, PublicKey>,
    /// The fingerprint of the device that started each running session.
    sessions: HashMap<SessionId, String>,
    /// The fingerprint of the device that opened each running plain
    /// terminal.
    terminals: HashMap<SessionId, String>,
}

impl Hosted {
    /// Sessions and plain terminals run in `keeper`, when there is one: what
    /// the keeper the last host left still runs is taken back, under the
    /// ids it had. Every other row the last run left running is lost, and
    /// offered until a client answers.
    pub fn new(
        store: Arc<Mutex<Store>>,
        data: PathBuf,
        backends: Vec<Arc<dyn AgentBackend>>,
        inherited_env: Vec<(OsString, OsString)>,
        keeper: Option<Arc<Keeper>>,
    ) -> Result<Self> {
        if backends.is_empty() {
            return Err(Error::Refused(
                "The Floti host has no agent backend to run sessions with.".to_owned(),
            ));
        }
        let children = Children::new(&inherited_env);
        let ledger = Arc::new(HostLedger::new(store));
        let session_ledger = Arc::clone(&ledger) as Arc<dyn crate::session::SessionLedger>;
        let (sessions, terminals) = match &keeper {
            Some(keeper) => (
                SessionHost::kept(session_ledger, Arc::clone(keeper), HeldKind::Session),
                Terminals::kept(inherited_env, Arc::clone(keeper)),
            ),
            None => (
                SessionHost::new(
                    inherited_env.clone(),
                    session_ledger,
                    Arc::new(process_tree::Native),
                ),
                Terminals::new(inherited_env, Arc::new(process_tree::Native)),
            ),
        };
        let TakenBack {
            sessions: held,
            opened,
        } = match &keeper {
            Some(keeper) => take_back(keeper, &ledger, &sessions, &terminals)?,
            None => TakenBack::default(),
        };
        let lost = records::reconcile_running(&ledger.store(), &held)?;
        // Children the keeper kept running are not news again.
        children.adopt(held.iter().copied());
        let mut devices = Devices::default();
        for (kind, id, device) in opened {
            match kind {
                HeldKind::Session if held.contains(&id) => {
                    devices.sessions.insert(id, device);
                }
                HeldKind::Session => {}
                HeldKind::Terminal => {
                    devices.terminals.insert(id, device);
                }
            }
        }
        *ledger.offer() = Some(lost);
        Ok(Self {
            sessions,
            terminals,
            ledger,
            data,
            backends,
            keeper,
            stopped: AtomicBool::new(false),
            agent_tools: OnceLock::new(),
            children,
            devices: Mutex::new(devices),
            held_distros: AtomicUsize::new(0),
            occupancy: watch::Sender::new(Occupancy::default()),
        })
    }

    /// `client` has been welcomed, on a connection that proved `device`.
    pub fn attach_client(&self, client: ClientId, device: PublicKey) {
        lock(&self.devices).clients.insert(client, device);
        self.settle();
    }

    /// `client`'s connection has ended.
    pub fn detach_client(&self, client: ClientId) {
        lock(&self.devices).clients.remove(&client);
        self.settle();
    }

    /// The device `client`'s connection proved, while it is attached.
    pub fn device_of(&self, client: ClientId) -> Option<PublicKey> {
        lock(&self.devices).clients.get(&client).copied()
    }

    /// The host now holds `count` WSL distros awake.
    pub fn hold_distros(&self, count: usize) {
        self.held_distros.store(count, Ordering::SeqCst);
        self.settle();
    }

    /// How busy the host is, now and as it changes.
    pub fn occupancy(&self) -> watch::Receiver<Occupancy> {
        self.occupancy.subscribe()
    }

    /// Counts again what runs and who is attached, forgetting the devices of
    /// sessions and terminals that have ended, and tells the watchers when
    /// the count moved. Called on every start, attach, exit and leave.
    pub fn settle(&self) {
        let sessions = self.sessions.list();
        let terminals = self.terminals.list();
        let clients = {
            let mut devices = lock(&self.devices);
            devices
                .sessions
                .retain(|id, _| sessions.iter().any(|session| session.id() == *id));
            devices
                .terminals
                .retain(|id, _| terminals.iter().any(|terminal| terminal.id() == *id));
            devices.clients.len()
        };
        let now = Occupancy {
            sessions: sessions.len(),
            terminals: terminals.len(),
            clients,
            distros: self.held_distros.load(Ordering::SeqCst),
        };
        self.occupancy.send_if_modified(|occupancy| {
            let moved = *occupancy != now;
            *occupancy = now;
            moved
        });
    }

    /// The running sessions `device` started, oldest first.
    pub fn started_by(&self, device: &PublicKey) -> Vec<DeviceSession> {
        let mine = opened_by(&lock(&self.devices).sessions, &device.fingerprint());
        self.sessions
            .list()
            .iter()
            .filter(|session| mine.contains(&session.id()))
            .filter_map(|session| {
                let record = self.record(session.id()).ok()?;
                Some(DeviceSession {
                    id: record.id,
                    name: label_of(&record),
                })
            })
            .collect()
    }

    /// `device` is quitting on purpose: the plain terminals it opened end,
    /// and with `end` so do the running sessions it started, each recorded
    /// as exited and its whole tree ended, as a plain stop ends them. What
    /// other devices started is left running. The ids of the sessions ended.
    pub fn quit(&self, device: &PublicKey, end: bool) -> Vec<u64> {
        let device = device.fingerprint();
        let (sessions, terminals) = {
            let devices = lock(&self.devices);
            (
                opened_by(&devices.sessions, &device),
                opened_by(&devices.terminals, &device),
            )
        };
        for terminal in terminals.iter().filter_map(|id| self.terminals.find(*id)) {
            if let Err(err) = terminal.end_now() {
                log_line!("floti host: {err}");
            }
        }
        if !end {
            return Vec::new();
        }
        let running: Vec<Arc<Session>> = sessions
            .iter()
            .filter_map(|id| self.sessions.get(*id))
            .collect();
        let ids: Vec<SessionId> = running.iter().map(|session| session.id()).collect();
        if let Err(err) = records::record_stopped(&self.ledger.store(), &ids) {
            log_line!("floti host: {err}");
        }
        for session in &running {
            if let Err(err) = session.end_now() {
                log_line!("floti host: {err}");
            }
        }
        ids.iter()
            .filter_map(|id| u64::try_from(id.0).ok())
            .collect()
    }

    /// Opens a plain terminal for `client`, or reattaches to its folder's
    /// own; a new one is counted as opened by `client`'s device.
    pub fn open_terminal(
        &self,
        client: ClientId,
        request: PtermOpenRequest,
    ) -> std::result::Result<PtermOpened, String> {
        let device = self.device_of(client).map(|device| device.fingerprint());
        let opened = self.terminals.open(client, request, device.clone())?;
        if let Some(device) = device
            && let Ok(id) = i64::try_from(opened.id)
        {
            lock(&self.devices)
                .terminals
                .entry(SessionId(id))
                .or_insert(device);
        }
        self.settle();
        Ok(opened)
    }

    /// Gives every launch from now on the host's agent tools, and serves
    /// again the sessions taken back from the keeper, at the address and
    /// with the token each was launched with. Only the first given are kept.
    pub fn use_agent_tools(&self, tools: Arc<HostAgentTools>) {
        if self.agent_tools.set(Arc::clone(&tools)).is_err() {
            return;
        }
        let kept: Vec<(SessionId, KeptGrant)> = {
            let store = self.ledger.store();
            self.sessions
                .list()
                .iter()
                .filter_map(
                    |session| match records::kept_agent_tools(&store, session.id()) {
                        Ok(kept) => kept.map(|kept| (session.id(), kept)),
                        Err(err) => {
                            log_line!("floti host: {err}");
                            None
                        }
                    },
                )
                .collect()
        };
        tools.take_back(kept);
        // A session that ended while its token was being taken back loses it.
        tools.ended_unless(|session| self.sessions.get(session).is_some());
    }

    /// A token and the families on for a launch on `backend`, when it takes
    /// agent tools and any family is on, without the families in `excluded`
    /// (the ones the launch's profile turns off). A listener that cannot bind
    /// is a launch without tools and a warning saying so, not a launch
    /// refused.
    fn grant_agent_tools(
        &self,
        backend: &Arc<dyn AgentBackend>,
        excluded: &[&str],
        scope: GrantScope,
    ) -> (Option<(Arc<HostAgentTools>, Grant)>, Option<String>) {
        let Some(tools) = self.agent_tools.get() else {
            return (None, None);
        };
        if backend.agent_tools().is_none() {
            return (None, None);
        }
        match tools.grant_scoped(excluded, scope) {
            Ok(grant) => (grant.map(|grant| (Arc::clone(tools), grant)), None),
            Err(err) => (
                None,
                Some(format!(
                    "This session has none of Helm's agent tools: {err}."
                )),
            ),
        }
    }

    pub fn sessions(&self) -> &SessionHost {
        &self.sessions
    }

    pub fn terminals(&self) -> &Terminals {
        &self.terminals
    }

    pub fn ledger(&self) -> &HostLedger {
        &self.ledger
    }

    /// Every backend the host can run, the default first.
    pub fn backends(&self) -> &[Arc<dyn AgentBackend>] {
        &self.backends
    }

    fn find_backend(&self, id: &BackendId) -> Option<&Arc<dyn AgentBackend>> {
        self.backends.iter().find(|backend| backend.id() == id)
    }

    /// Whether this host runs backend `id`.
    pub fn runs_backend(&self, id: &BackendId) -> bool {
        self.find_backend(id).is_some()
    }

    /// The project a scan found at `cwd`, if any: what a session the host
    /// composes itself there is recorded under. A cache it cannot read is
    /// no project, so the session still starts.
    pub fn known_project(&self, cwd: &str) -> Option<String> {
        crate::store::projects::known_project(self.ledger.store().connection(), cwd)
            .ok()
            .flatten()
    }

    /// The backend a request names, or the host's default when it names
    /// none.
    fn backend(
        &self,
        id: Option<&BackendId>,
    ) -> std::result::Result<Arc<dyn AgentBackend>, String> {
        match id {
            None => Ok(Arc::clone(&self.backends[0])),
            Some(id) => self.named_backend(id),
        }
    }

    fn named_backend(&self, id: &BackendId) -> std::result::Result<Arc<dyn AgentBackend>, String> {
        self.find_backend(id)
            .cloned()
            .ok_or_else(|| format!("This Floti host has no agent backend `{id}`."))
    }

    /// Session `id`'s row.
    pub fn record(&self, id: SessionId) -> Result<SessionRecord> {
        let mut record = records::read_record(&self.ledger.store(), id)?;
        record.last_report = self.last_report_of(id).map(ChildReport::from);
        Ok(record)
    }

    /// The rows of the sessions running now, oldest first.
    pub fn list(&self) -> std::result::Result<Vec<SessionRecord>, String> {
        self.sessions
            .list()
            .iter()
            .map(|session| self.record(session.id()).map_err(|err| err.to_string()))
            .collect()
    }

    /// How many sessions run now, and the link version of the keeper they
    /// run in (none while the host holds no keeper): what a `restartAsk` is
    /// answered with.
    pub fn restart_counts(&self) -> (u32, Option<u32>) {
        let sessions = u32::try_from(self.sessions.list().len()).unwrap_or(u32::MAX);
        let link = self
            .keeper
            .as_ref()
            .and_then(|keeper| keeper.running_link_version());
        (sessions, link)
    }

    /// What each running session's tab says, except `except`'s: the names a
    /// new name or a rename is made unique against.
    fn taken_labels(&self, except: Option<SessionId>) -> Vec<String> {
        self.sessions
            .list()
            .iter()
            .filter(|session| Some(session.id()) != except)
            .filter_map(|session| self.record(session.id()).ok())
            .map(|record| label_of(&record))
            .collect()
    }

    fn profile(&self, id: u64) -> std::result::Result<Profile, String> {
        records::read_profile(&self.ledger.store(), id)
            .map_err(|err| err.to_string())?
            .ok_or_else(|| "That profile no longer exists.".to_owned())
    }

    /// A start: a folder and a backend, with a composition that starts from
    /// the profile named, if any, and takes each choice the request makes
    /// over the profile's. The folder is always the request's.
    pub fn start(
        &self,
        client: ClientId,
        request: StartSessionRequest,
    ) -> std::result::Result<LaunchedSession, String> {
        let backend = self.backend(request.backend.as_ref())?;
        let profile = request.profile_id.map(|id| self.profile(id)).transpose()?;
        let mut composition = composition_of(profile.as_ref());
        if let Some(overlays) = request.overlays {
            composition.overlays = paths(&overlays);
        }
        if let Some(folders) = request.extra_folders {
            composition.extra_folders = paths(&folders);
        }
        if request.model.is_some() {
            composition.model = non_empty(request.model);
        }
        if request.effort.is_some() {
            composition.effort = request.effort;
        }
        if request.agent.is_some() {
            composition.agent = non_empty(request.agent);
        }
        if request.permission_mode.is_some() {
            composition.permission_mode = request.permission_mode;
        }
        let prompt = non_empty(
            request
                .opening_prompt
                .or_else(|| profile.as_ref().and_then(|p| p.opening_prompt.clone())),
        );
        let folder = PathBuf::from(&request.cwd);
        self.run(
            Plan {
                name: non_empty(request.name).unwrap_or_else(|| folder_name(&folder)),
                origin: SessionOrigin {
                    project_path: request.project_path,
                    profile_id: request.profile_id.and_then(|id| i64::try_from(id).ok()),
                    permission_mode: composition
                        .permission_mode
                        .map(records::permission_mode_name),
                    ..SessionOrigin::default()
                },
                backend,
                folder,
                prompt,
                composition,
                resume: None,
            },
            TermSize::new(request.cols, request.rows),
            Some(client),
        )
    }

    /// The launcher's launch: a folder, a saved profile's composition or
    /// none, the launcher's own permission mode (none passes no flag,
    /// whatever the profile says), and optionally a conversation from
    /// history to reopen, which runs in the folder history recorded and on
    /// the backend that recorded it.
    pub fn launch(
        &self,
        client: ClientId,
        request: LaunchSessionRequest,
    ) -> std::result::Result<LaunchedSession, String> {
        let profile = request.profile_id.map(|id| self.profile(id)).transpose()?;
        let history = request
            .resume
            .as_deref()
            .map(|id| self.resumable(id))
            .transpose()?;
        let backend = match &history {
            Some(history) => self.named_backend(&history.backend)?,
            None => self.backend(request.backend.as_ref())?,
        };
        let mut composition = composition_of(profile.as_ref());
        composition.permission_mode = request.permission_mode;
        let (folder, name, prompt) = match &history {
            Some(history) => (PathBuf::from(&history.project), history_name(history), None),
            None => {
                let folder = PathBuf::from(&request.cwd);
                let name = non_empty(request.name).unwrap_or_else(|| folder_name(&folder));
                let prompt = non_empty(profile.as_ref().and_then(|p| p.opening_prompt.clone()));
                (folder, name, prompt)
            }
        };
        self.run(
            Plan {
                origin: SessionOrigin {
                    project_path: history
                        .as_ref()
                        .map(|history| history.project.clone())
                        .or(request.project_path),
                    profile_id: request.profile_id.and_then(|id| i64::try_from(id).ok()),
                    permission_mode: request.permission_mode.map(records::permission_mode_name),
                    ..SessionOrigin::default()
                },
                resume: history.map(|history| history.session_id),
                backend,
                folder,
                name,
                prompt,
                composition,
            },
            TermSize::new(request.cols, request.rows),
            Some(client),
        )
    }

    /// A profile's own launch: at its root, named after it, in its own
    /// permission mode, with its opening prompt. A profile is Claude Code's,
    /// as a session row with no backend is.
    pub fn launch_profile(
        &self,
        client: ClientId,
        request: LaunchProfileRequest,
    ) -> std::result::Result<LaunchedProfile, String> {
        let profile = self.profile(request.profile_id)?;
        let backend = self.named_backend(&BackendId::claude_code())?;
        let composition = composition_of(Some(&profile));
        let launched = self.run(
            Plan {
                backend,
                folder: PathBuf::from(&profile.root),
                name: profile.name.clone(),
                prompt: non_empty(profile.opening_prompt.clone()),
                origin: SessionOrigin {
                    project_path: None,
                    profile_id: i64::try_from(profile.id).ok(),
                    permission_mode: composition
                        .permission_mode
                        .map(records::permission_mode_name),
                    ..SessionOrigin::default()
                },
                composition,
                resume: None,
            },
            TermSize::new(request.cols, request.rows),
            Some(client),
        )?;
        Ok(LaunchedProfile {
            session: launched.session,
            profile,
            overlays: launched.overlays,
            composed_instructions: launched.composed_instructions,
            warnings: launched.warnings,
        })
    }

    /// Reopens a conversation from history as it was had: in the folder
    /// history recorded, on the backend that recorded it, with no profile
    /// and no permission mode. The launcher is where one is reopened with a
    /// composition.
    pub fn resume(
        &self,
        client: ClientId,
        request: ResumeSessionRequest,
    ) -> std::result::Result<ResumedSession, String> {
        let history = self.resumable(&request.session_id)?;
        let backend = self.named_backend(&history.backend)?;
        let launched = self.run(
            Plan {
                backend,
                folder: PathBuf::from(&history.project),
                name: history_name(&history),
                prompt: None,
                composition: Composition::default(),
                resume: Some(history.session_id.clone()),
                origin: SessionOrigin {
                    project_path: Some(history.project.clone()),
                    ..SessionOrigin::default()
                },
            },
            TermSize::new(request.cols, request.rows),
            Some(client),
        )?;
        Ok(ResumedSession {
            session: launched.session,
            history,
        })
    }

    /// The checks a conversation to reopen has to pass, made here rather
    /// than trusted from the client: an agent asked to resume a conversation
    /// it cannot find fails in a fresh tab, and a sentence is better.
    fn resumable(&self, conversation_id: &str) -> std::result::Result<HistorySession, String> {
        let history = records::read_history_session(&self.ledger.store(), conversation_id)
            .map_err(|err| err.to_string())?
            .ok_or_else(|| "That session is not in the history index any more.".to_owned())?;
        let agent = self.find_backend(&history.backend).map_or_else(
            || history.backend.to_string(),
            |backend| backend.name().to_owned(),
        );
        if !history.project_exists || !Path::new(&history.project).is_dir() {
            return Err(format!(
                "{} is no longer on disk. {agent} resolves a conversation against the folder it ran in, so this one cannot be reopened from anywhere else.",
                history.project
            ));
        }
        let transcript_there = history
            .transcript_file
            .as_deref()
            .is_some_and(|file| Path::new(file).is_file());
        if !transcript_there {
            return Err(format!(
                "{agent} has removed this conversation's transcript, so there is nothing left to resume. Its prompts are still in the history."
            ));
        }
        Ok(history)
    }

    /// Every launch: the name made unique against the running sessions, the
    /// backend's composition in a launch folder of its own, and the session
    /// started at the client's size.
    fn run(
        &self,
        plan: Plan,
        size: TermSize,
        client: Option<ClientId>,
    ) -> std::result::Result<LaunchedSession, String> {
        let Plan {
            backend,
            folder,
            name,
            prompt,
            mut composition,
            resume,
            mut origin,
        } = plan;
        if !folder.is_dir() {
            return Err(format!(
                "{} is not a folder on this Floti host.",
                folder.display()
            ));
        }
        // Before the spawn, so the row holds the branch the session started
        // on whatever it checks out afterwards.
        origin.branch = read_git_branch(&folder);
        let taken = self.taken_labels(None);
        let name = unique_session_name(&name, taken.iter().map(String::as_str));
        // Granted before the backend composes the launch, which writes the
        // token into the launch's own folder.
        let excluded = self.families_off_for(origin.profile_id);
        let scope = GrantScope {
            reports_to_parent: origin.parent.is_some(),
        };
        let (grant, tools_warning) = self.grant_agent_tools(&backend, &excluded, scope);
        composition.agent_tools = grant
            .as_ref()
            .map(|(_, grant)| grant.servers.clone())
            .unwrap_or_default();
        // A session given the agents family is told how to use `floti agent`,
        // whatever started it.
        composition.agent_guide = composition
            .agent_tools
            .iter()
            .any(|server| server.name == FAMILY);
        let grant = grant.map(|(tools, grant)| (tools, grant.id));
        // What `floti agent` needs in the session's environment, added to the
        // launch the backend composed.
        let servers = composition.agent_tools.clone();
        let with_agent_env = |mut launch: Launch| {
            self.give_agent_env(&mut launch.spec.env, &servers);
            launch
        };
        let reopened = resume.clone();
        let started = match resume {
            Some(conversation_id) => {
                let request = ResumeRequest {
                    conversation_id,
                    folder,
                    prompt,
                    composition,
                };
                self.launch_in_folder(&backend, name, size, client, origin, |launch_folder| {
                    let resumer = backend.resumer().ok_or_else(|| {
                        Error::Refused(format!("{} cannot reopen a conversation.", backend.name()))
                    })?;
                    resumer.resume(&request, launch_folder).map(with_agent_env)
                })
            }
            None => {
                let request = LaunchRequest {
                    folder,
                    name: name.clone(),
                    prompt,
                    composition,
                };
                self.launch_in_folder(&backend, name, size, client, origin, |launch_folder| {
                    backend.launch(&request, launch_folder).map(with_agent_env)
                })
            }
        };
        match (started, grant) {
            (Ok((mut launched, id)), grant) => {
                // A conversation reopened is the parent of the children its
                // earlier session left running.
                if let Some(conversation_id) = &reopened {
                    self.readopt_children(id, conversation_id);
                }
                if let Some((tools, grant)) = grant {
                    // Kept with the row for a host after this one, should the
                    // session outlive this host.
                    if let Some(kept) = tools.kept(grant)
                        && let Err(err) =
                            records::record_agent_tools(&self.ledger.store(), id, &kept)
                    {
                        log_line!("floti host: {err}");
                    }
                    tools.started(grant, id);
                }
                if let Some(warning) = tools_warning {
                    launched.warnings.push(warning);
                }
                Ok(launched)
            }
            (Err(err), grant) => {
                if let Some((tools, grant)) = grant {
                    tools.failed(grant);
                }
                Err(err.to_string())
            }
        }
    }

    /// Composes a launch in a launch folder of its own and starts it. The
    /// folder belongs to the session from then on, which removes it when it
    /// ends; a launch that never started removes it here.
    fn launch_in_folder(
        &self,
        backend: &Arc<dyn AgentBackend>,
        name: String,
        size: TermSize,
        client: Option<ClientId>,
        origin: SessionOrigin,
        compose: impl FnOnce(&LaunchFolder) -> Result<Launch>,
    ) -> Result<(LaunchedSession, SessionId)> {
        let launch_folder = LaunchFolder::create(&self.data)?;
        let started = compose(&launch_folder).and_then(|launch| {
            let Launch {
                spec,
                overlays,
                composed_instructions,
                warnings,
                not_taken,
            } = launch;
            let conversation_id = spec.conversation_id.clone();
            // A session an agent started has no client, so no device either:
            // a quit ends what a device started, never what an agent did.
            let device = client
                .and_then(|client| self.device_of(client))
                .map(|device| device.fingerprint());
            let session = self.sessions.start(StartSession {
                spec,
                name,
                size,
                client,
                conversation_id,
                backend: backend.id().clone(),
                origin,
                opened_by: device.clone(),
            })?;
            if let Some(device) = device {
                lock(&self.devices).sessions.insert(session.id(), device);
            }
            self.settle();
            Ok((
                session,
                overlays,
                composed_instructions,
                warnings,
                not_taken,
            ))
        });
        let (session, overlays, composed_instructions, warnings, not_taken) = match started {
            Ok(started) => started,
            Err(err) => {
                let _ = launch_folder.remove();
                return Err(err);
            }
        };
        // The session's own process owns its files too, so a session that
        // outlives a crashed host keeps them.
        if let Err(err) = launch_folder.add_owner(session.pid()) {
            log_line!("floti host: {err}");
        }
        let launched = LaunchedSession {
            session: self.record(session.id())?,
            overlays,
            composed_instructions,
            warnings,
            not_taken,
        };
        #[cfg(any(test, feature = "testkit"))]
        crate::host_log::crash_after_session_if_asked(&self.data);
        Ok((launched, session.id()))
    }

    /// Gives session `id`'s tab `label`, made unique against the other
    /// running sessions, or clears it with none. The row is renamed whether
    /// or not the session still runs: the row is the record.
    pub fn rename(
        &self,
        request: RenameSessionRequest,
    ) -> std::result::Result<SessionRecord, String> {
        let id = session_id(request.id)
            .ok_or_else(|| "That session is not in this database.".to_owned())?;
        let label = non_empty(request.label).map(|label| {
            let taken = self.taken_labels(Some(id));
            unique_session_name(&label, taken.iter().map(String::as_str))
        });
        let renamed = records::set_label(&self.ledger.store(), id, label.as_deref())
            .map_err(|err| err.to_string())?;
        if !renamed {
            return Err("That session is not in this database.".to_owned());
        }
        self.record(id).map_err(|err| err.to_string())
    }

    /// Session `id`, while it runs.
    pub fn running(&self, id: u64) -> std::result::Result<Arc<Session>, String> {
        session_id(id)
            .and_then(|id| self.sessions.get(id))
            .ok_or_else(|| format!("Session {id} is not running on this Floti host."))
    }

    /// Ends session `id` as closing its tab does: its tree is asked
    /// politely, then ended. A session that has ended is closed already.
    pub fn end(&self, request: &CloseSessionRequest) {
        if let Ok(session) = self.running(request.id) {
            // A child ended here is stopped by a person, as its parent will
            // be told.
            self.note_person_stop(session.id());
            session.close();
        }
    }

    /// Session `id`'s row and the name of the agent it runs, for asking
    /// before it is ended.
    pub fn describe(&self, id: u64) -> Option<(SessionRecord, String)> {
        let record = self.record(session_id(id)?).ok()?;
        let agent = self.find_backend(&record.backend).map_or_else(
            || record.backend.to_string(),
            |backend| backend.name().to_owned(),
        );
        Some((record, agent))
    }

    /// `client`'s terminal for session `id` is now this size.
    pub fn resize(
        &self,
        client: ClientId,
        request: SessionResizeRequest,
    ) -> std::result::Result<(), String> {
        self.running(request.id)?
            .resize(client, TermSize::new(request.cols, request.rows))
            .map_err(|err| err.to_string())
    }

    /// Each running session as an activity pass joins it.
    pub fn views(&self) -> Vec<HostedView> {
        let store = self.ledger.store();
        self.sessions
            .list()
            .iter()
            .filter_map(|session| {
                let record = records::read_record(&store, session.id()).ok()?;
                let conversation = records::current_conversation(&store, session.id())
                    .ok()
                    .flatten();
                Some(HostedView {
                    id: record.id,
                    backend: record.backend.clone(),
                    pty_pid: session.pid(),
                    conversation_id: conversation,
                    started_at_ms: parse_instant(&record.started_at),
                    label: label_of(&record),
                    cwd: record.cwd,
                    report: session.reported_status(),
                })
            })
            .collect()
    }

    /// The live records of each backend that keeps them.
    pub fn registries(&self) -> Vec<(BackendId, Knowable<Vec<LiveRecord>>)> {
        self.backends
            .iter()
            .filter_map(|backend| {
                backend
                    .status()
                    .map(|status| (backend.id().clone(), status.registry()))
            })
            .collect()
    }

    /// Session `id` is in `conversation_id` now, as its records say.
    pub fn note_conversation(&self, id: u64, conversation_id: &str) {
        let Some(id) = session_id(id) else {
            return;
        };
        if let Err(err) = records::record_conversation(&self.ledger.store(), id, conversation_id) {
            log_line!("floti host: {err}");
        }
    }

    /// What the last run left running, until a client answers for it; null
    /// when there was nothing or it has been answered.
    pub fn restorable(&self) -> Option<RestoreOffer> {
        let offer = self.ledger.offer();
        let lost = offer.as_ref().filter(|lost| !lost.is_empty())?;
        let store = self.ledger.store();
        let sessions = lost
            .iter()
            .map(|row| {
                let profile = row
                    .profile_id
                    .and_then(|id| records::profile_name(&store, id).ok().flatten());
                RestorableSession {
                    id: u64::try_from(row.id.0).unwrap_or(0),
                    name: row.name.clone(),
                    cwd: row.cwd.clone(),
                    branch: row.branch.clone(),
                    profile_gone: row.profile_id.is_some() && profile.is_none(),
                    profile,
                    last_at: None,
                    blocked: self.blocked(row),
                }
            })
            .collect();
        // The host cannot yet see conversations running elsewhere, so it
        // counts none rather than guess.
        Some(RestoreOffer {
            sessions,
            elsewhere: 0,
        })
    }

    /// Why a lost session cannot be reopened, as a sentence, or `None`.
    fn blocked(&self, row: &LostRow) -> Option<String> {
        self.reopener(row).err()
    }

    /// The backend that reopens a lost session: the one its row recorded
    /// (Claude Code for a row from before the host recorded backends, see
    /// `records::recorded_backend`). A row naming a backend this host does
    /// not have is not reopened by another one, which would not know its
    /// conversation; the offer says so instead.
    fn reopener(&self, row: &LostRow) -> std::result::Result<Arc<dyn AgentBackend>, String> {
        if row.conversation_id.is_none() {
            return Err(
                "Floti never learned which conversation this was, so it cannot be reopened."
                    .to_owned(),
            );
        }
        if !Path::new(&row.cwd).is_dir() {
            return Err(format!("{} is no longer on disk.", row.cwd));
        }
        let backend = self.find_backend(&row.backend).ok_or_else(|| {
            format!(
                "This conversation ran on `{}`, which this Floti host does not have, so it cannot be reopened.",
                row.backend
            )
        })?;
        if backend.resumer().is_none() {
            return Err(format!("{} cannot reopen a conversation.", backend.name()));
        }
        Ok(Arc::clone(backend))
    }

    /// Reopens the sessions asked for, each through its backend's resume in
    /// the folder its row recorded, and answers the offer: it is not offered
    /// again, whether some, none or all were asked for.
    pub fn restore(
        &self,
        client: ClientId,
        request: RestoreSessionsRequest,
    ) -> RestoreSessionsResult {
        let answered = self.ledger.offer().take();
        let mut result = RestoreSessionsResult {
            restored: Vec::new(),
            failed: Vec::new(),
        };
        for wanted in request.sessions {
            let row = answered.as_ref().and_then(|lost| {
                lost.iter()
                    .find(|row| u64::try_from(row.id.0) == Ok(wanted.id))
            });
            let Some(row) = row else {
                result.failed.push(UnrestoredSession {
                    id: wanted.id,
                    name: String::new(),
                    reason: match answered {
                        Some(_) => format!("Session {} was not offered for restore.", wanted.id),
                        None => "The restore offer has already been answered.".to_owned(),
                    },
                });
                continue;
            };
            let size = TermSize::new(wanted.cols, wanted.rows);
            match self.reopen(row, size, client) {
                Ok(launched) => result.restored.push(RestoredSession {
                    from: wanted.id,
                    launched,
                }),
                Err(reason) => result.failed.push(UnrestoredSession {
                    id: wanted.id,
                    name: row.name.clone(),
                    reason,
                }),
            }
        }
        result
    }

    /// A lost session reopened as it was launched: its row's folder, name,
    /// profile and permission mode. A profile deleted since is said rather
    /// than refused; the conversation is still worth having back.
    fn reopen(
        &self,
        row: &LostRow,
        size: TermSize,
        client: ClientId,
    ) -> std::result::Result<LaunchedSession, String> {
        let backend = self.reopener(row)?;
        let profile = row
            .profile_id
            .and_then(|id| u64::try_from(id).ok())
            .and_then(|id| {
                records::read_profile(&self.ledger.store(), id)
                    .ok()
                    .flatten()
            });
        let mut composition = composition_of(profile.as_ref());
        composition.permission_mode = row.permission_mode;
        // An agent's child comes back in its role as the role file reads now.
        let mut role_warning = None;
        if let Some(role) = row.role.as_deref() {
            let (reopened, warning) = self.reopen_in_role(
                role,
                backend.as_ref(),
                profile.as_ref(),
                row.permission_mode,
            )?;
            if let Some(reopened) = reopened {
                composition = reopened;
            }
            role_warning = warning;
        }
        let mut launched = self.run(
            Plan {
                backend,
                folder: PathBuf::from(&row.cwd),
                name: row.name.clone(),
                prompt: None,
                composition,
                resume: row.conversation_id.clone(),
                origin: SessionOrigin {
                    project_path: row.project_path.clone(),
                    profile_id: row.profile_id,
                    permission_mode: row.permission_mode.map(records::permission_mode_name),
                    ..SessionOrigin::default()
                },
            },
            size,
            Some(client),
        )?;
        if row.profile_id.is_some() && profile.is_none() {
            launched.warnings.insert(
                0,
                format!(
                    "The profile {} was started with no longer exists, so it reopened without one.",
                    row.name
                ),
            );
        }
        if let Some(warning) = role_warning {
            launched.warnings.insert(0, warning);
        }
        Ok(launched)
    }

    /// Ends every session and plain terminal, as stopping the host does. A
    /// plain stop records each row as exited first, so none is offered for
    /// restore; a stop for an update leaves the rows running, for the next
    /// start to find lost and offer once. Either way each whole process tree
    /// ends. A restart for an update lets go of the keeper instead, leaving
    /// every session and plain terminal running there with its row, for the
    /// next host to take back; without a keeper it is a stop for an update.
    /// Only the first stop does anything.
    pub fn stop(&self, reason: HostStopReason) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        let reason = match (reason, &self.keeper) {
            (HostStopReason::Restart, Some(keeper)) => {
                // From here no exit writes its row: what the keeper holds
                // runs on, and the next host records what ends meanwhile.
                self.ledger.freeze();
                keeper.let_go();
                return;
            }
            (HostStopReason::Restart, None) => HostStopReason::Update,
            (reason, _) => reason,
        };
        // From here no session starts and no exit writes its row.
        self.ledger.freeze();
        self.terminals.end_all();
        // A session that wrote its row just before the freeze joins the
        // list a moment later, so look twice.
        for _ in 0..2 {
            let running = self.sessions.list();
            if reason == HostStopReason::Stop {
                let ids: Vec<SessionId> = running.iter().map(|session| session.id()).collect();
                if let Err(err) = records::record_stopped(&self.ledger.store(), &ids) {
                    log_line!("floti host: {err}");
                }
            }
            for session in &running {
                if let Err(err) = session.end_now() {
                    log_line!("floti host: {err}");
                }
            }
            for session in &running {
                session.wait_exit(STOP_WAIT);
            }
        }
        for terminal in self.terminals.list() {
            terminal.wait_exit(STOP_WAIT);
        }
        // A deliberate stop ends the keeper too, and anything it still held.
        if let Some(keeper) = &self.keeper {
            keeper.shutdown();
        }
    }
}

/// A host that goes away without being stopped, such as one whose run was
/// dropped by a panic, leaves its sessions running in the keeper for the
/// next host to take back. Without a keeper it ends every process it
/// started, and leaves the rows running, as a stop for an update leaves
/// them, so the next start offers them back.
impl Drop for Hosted {
    fn drop(&mut self) {
        if self.keeper.is_none() {
            self.stop(HostStopReason::Update);
        }
    }
}

/// What a host took back from the keeper the last one left.
#[derive(Default)]
struct TakenBack {
    /// The sessions taken back.
    sessions: Vec<SessionId>,
    /// The device each session and plain terminal taken back was started or
    /// opened by, as its label in the keeper says, by fingerprint.
    opened: Vec<(HeldKind, SessionId, String)>,
}

/// Takes back what the keeper the last host left holds: each session whose
/// row is still running and each plain terminal, under the id it had. A
/// program that ended while no host was there has its end recorded, and one
/// nothing here knows is ended.
fn take_back(
    keeper: &Keeper,
    ledger: &HostLedger,
    sessions: &SessionHost,
    terminals: &Terminals,
) -> Result<TakenBack> {
    use crate::session::SessionLedger as _;
    let held = keeper.reattach();
    if held.is_empty() {
        return Ok(TakenBack::default());
    }
    let running = records::running_ids(&ledger.store())?;
    let link = keeper.link()?;
    let mut taken = TakenBack::default();
    for program in held {
        let handle = program.handle;
        let Some(label) = program.label.clone() else {
            match program.exit {
                Some(_) => link.forget(handle),
                None => link.discard(handle),
            }
            continue;
        };
        let id = SessionId(label.id);
        if let Some(exit) = &program.exit {
            if label.kind == HeldKind::Session
                && let Err(err) = ledger.finished(id, exit)
            {
                log_line!("floti host: {err}");
            }
            link.forget(handle);
            continue;
        }
        let adopted = match label.kind {
            HeldKind::Session if running.contains(&id) => sessions.adopt(program, &label),
            HeldKind::Terminal => terminals.adopt(program, &label),
            HeldKind::Session => {
                link.discard(handle);
                continue;
            }
        };
        match adopted {
            Ok(session) => {
                if label.kind == HeldKind::Session {
                    taken.sessions.push(session.id());
                }
                if let Some(device) = label.opened_by.clone() {
                    taken.opened.push((label.kind, session.id(), device));
                }
            }
            Err(err) => {
                log_line!("floti host: {err}");
                link.discard(handle);
            }
        }
    }
    Ok(taken)
}

/// What a profile gives a launch: its overlays, its access as further
/// folders, its model, effort, permission mode and agent. No profile gives
/// nothing.
fn composition_of(profile: Option<&Profile>) -> Composition {
    let Some(profile) = profile else {
        return Composition::default();
    };
    Composition {
        overlays: paths(&profile.overlays),
        extra_folders: paths(&profile.access),
        model: profile.model.clone(),
        effort: profile.effort,
        permission_mode: profile.permission_mode,
        agent: profile.agent.clone(),
        // Granted per launch, in `run`: a profile names no token.
        agent_tools: Vec::new(),
        // Only a role names these.
        allowed_tools: Vec::new(),
        disallowed_tools: Vec::new(),
        instructions: None,
        // Set where the launch is made: they depend on who starts it.
        child: None,
        agent_guide: false,
    }
}

fn paths(list: &[String]) -> Vec<PathBuf> {
    list.iter()
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .collect()
}

fn non_empty(text: Option<String>) -> Option<String> {
    text.map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

/// What a session's tab says: its label, or its name when it has none.
pub(crate) fn label_of(record: &SessionRecord) -> String {
    record
        .label
        .clone()
        .filter(|label| !label.trim().is_empty())
        .unwrap_or_else(|| record.name.clone())
}

/// What a reopened conversation's tab is called: the name history gives it,
/// as the history pane does, never its raw opening prompt.
fn history_name(history: &HistorySession) -> String {
    let title = history.label.as_deref().unwrap_or(&history.title);
    let name = sanitize_session_name(title);
    if name.is_empty() {
        history.project_name.clone()
    } else {
        name
    }
}

fn folder_name(folder: &Path) -> String {
    folder
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "session".to_owned())
}

/// Settles the host's occupancy as each session and plain terminal ends,
/// until the host has gone and its exits close.
pub(crate) async fn settle_on_exits(
    mut sessions: tokio::sync::broadcast::Receiver<records::ExitNotice>,
    mut terminals: tokio::sync::broadcast::Receiver<crate::session::TerminalExit>,
    hosted: std::sync::Weak<Hosted>,
) {
    use tokio::sync::broadcast::error::RecvError;
    loop {
        // A missed exit is still an exit: settling counts afresh.
        let ended = tokio::select! {
            exit = sessions.recv() => !matches!(exit, Err(RecvError::Closed)),
            exit = terminals.recv() => !matches!(exit, Err(RecvError::Closed)),
        };
        let Some(hosted) = hosted.upgrade().filter(|_| ended) else {
            return;
        };
        hosted.settle();
    }
}

/// The ids in `map` that the device whose fingerprint is `device` started
/// or opened.
fn opened_by(map: &HashMap<SessionId, String>, device: &str) -> Vec<SessionId> {
    map.iter()
        .filter(|(_, by)| by.as_str() == device)
        .map(|(id, _)| *id)
        .collect()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The record type's id for a session.
pub(crate) fn session_id(id: u64) -> Option<SessionId> {
    i64::try_from(id).ok().map(SessionId)
}
