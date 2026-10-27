//! The sessions the host runs, as its clients' requests reach them: start,
//! the launcher's launch, a profile's launch and a resume from history, then
//! list, rename, close and resize, the restore offer, the plain terminals,
//! and the stop that ends them all.
//!
//! Every launch is one path ([`Plan`] through `Hosted::run`): a backend, a
//! folder, a name made unique against the running sessions, and a
//! composition the backend turns into its own flags. A start, a launch, a
//! profile's launch, a resume and a restore differ only in where each of
//! those comes from.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    CloseSessionRequest, HistorySession, LaunchProfileRequest, LaunchSessionRequest,
    LaunchedProfile, LaunchedSession, Profile, RenameSessionRequest, RestorableSession,
    RestoreOffer, RestoreSessionsRequest, RestoreSessionsResult, RestoredSession,
    ResumeSessionRequest, ResumedSession, SessionResizeRequest, StartSessionRequest,
    UnrestoredSession,
};
use floti_protocol::{BackendId, Knowable};

use super::records::{self, HostLedger, LostRow};
use crate::agent::claude_code::{parse_instant, sanitize_session_name, unique_session_name};
use crate::agent::{
    AgentBackend, Composition, Launch, LaunchFolder, LaunchRequest, LiveRecord, ResumeRequest,
};
use crate::platform::process_tree;
use crate::session::{
    ClientId, HostedView, Session, SessionHost, SessionId, SessionOrigin, StartSession, TermSize,
    Terminals,
};
use crate::store::Store;
use crate::{Error, Result};

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
    /// The opening prompt, for a new conversation.
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
    /// What the start reconciled to lost, until a client answers the offer.
    offer: Mutex<Option<Vec<LostRow>>>,
    /// Set by the first stop; a host dropped without one stops as it goes.
    stopped: AtomicBool,
}

impl Hosted {
    /// `lost` is what the start reconciled; it is offered until answered.
    pub fn new(
        store: Arc<Mutex<Store>>,
        data: PathBuf,
        backends: Vec<Arc<dyn AgentBackend>>,
        inherited_env: Vec<(OsString, OsString)>,
        lost: Vec<LostRow>,
    ) -> Result<Self> {
        if backends.is_empty() {
            return Err(Error::Refused(
                "The Floti host has no agent backend to run sessions with.".to_owned(),
            ));
        }
        let ledger = Arc::new(HostLedger::new(store));
        let sessions = SessionHost::new(
            inherited_env.clone(),
            Arc::clone(&ledger) as Arc<dyn crate::session::SessionLedger>,
            Arc::new(process_tree::Native),
        );
        Ok(Self {
            sessions,
            terminals: Terminals::new(inherited_env, Arc::new(process_tree::Native)),
            ledger,
            data,
            backends,
            offer: Mutex::new(Some(lost)),
            stopped: AtomicBool::new(false),
        })
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
        records::read_record(&self.ledger.store(), id)
    }

    /// The rows of the sessions running now, oldest first.
    pub fn list(&self) -> std::result::Result<Vec<SessionRecord>, String> {
        self.sessions
            .list()
            .iter()
            .map(|session| self.record(session.id()).map_err(|err| err.to_string()))
            .collect()
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
                },
                backend,
                folder,
                prompt,
                composition,
                resume: None,
            },
            TermSize::new(request.cols, request.rows),
            client,
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
                },
                resume: history.map(|history| history.session_id),
                backend,
                folder,
                name,
                prompt,
                composition,
            },
            TermSize::new(request.cols, request.rows),
            client,
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
                },
                composition,
                resume: None,
            },
            TermSize::new(request.cols, request.rows),
            client,
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
            client,
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
        client: ClientId,
    ) -> std::result::Result<LaunchedSession, String> {
        let Plan {
            backend,
            folder,
            name,
            prompt,
            composition,
            resume,
            origin,
        } = plan;
        if !folder.is_dir() {
            return Err(format!(
                "{} is not a folder on this Floti host.",
                folder.display()
            ));
        }
        let taken = self.taken_labels(None);
        let name = unique_session_name(&name, taken.iter().map(String::as_str));
        let started = match resume {
            Some(conversation_id) => {
                let request = ResumeRequest {
                    conversation_id,
                    folder,
                    composition,
                };
                self.launch_in_folder(&backend, name, size, client, origin, |launch_folder| {
                    let resumer = backend.resumer().ok_or_else(|| {
                        Error::Refused(format!("{} cannot reopen a conversation.", backend.name()))
                    })?;
                    resumer.resume(&request, launch_folder)
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
                    backend.launch(&request, launch_folder)
                })
            }
        };
        started.map_err(|err| err.to_string())
    }

    /// Composes a launch in a launch folder of its own and starts it. The
    /// folder belongs to the session from then on, which removes it when it
    /// ends; a launch that never started removes it here.
    fn launch_in_folder(
        &self,
        backend: &Arc<dyn AgentBackend>,
        name: String,
        size: TermSize,
        client: ClientId,
        origin: SessionOrigin,
        compose: impl FnOnce(&LaunchFolder) -> Result<Launch>,
    ) -> Result<LaunchedSession> {
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
            let session = self.sessions.start(StartSession {
                spec,
                name,
                size,
                client: Some(client),
                conversation_id,
                backend: backend.id().clone(),
                origin,
            })?;
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
            eprintln!("floti host: {err}");
        }
        Ok(LaunchedSession {
            session: self.record(session.id())?,
            overlays,
            composed_instructions,
            warnings,
            not_taken,
        })
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
            eprintln!("floti host: {err}");
        }
    }

    /// What the last run left running, until a client answers for it; null
    /// when there was nothing or it has been answered.
    pub fn restorable(&self) -> Option<RestoreOffer> {
        let offer = lock(&self.offer);
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
        let answered = lock(&self.offer).take();
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
                },
            },
            size,
            client,
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
        Ok(launched)
    }

    /// Ends every session and plain terminal, as stopping the host does. A
    /// plain stop records each row as exited first, so none is offered for
    /// restore; a stop for an update leaves the rows running, for the next
    /// start to find lost and offer once. Either way each whole process tree
    /// ends. Only the first stop does anything.
    pub fn stop(&self, reason: HostStopReason) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
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
                    eprintln!("floti host: {err}");
                }
            }
            for session in &running {
                if let Err(err) = session.end_now() {
                    eprintln!("floti host: {err}");
                }
            }
            for session in &running {
                session.wait_exit(STOP_WAIT);
            }
        }
        for terminal in self.terminals.list() {
            terminal.wait_exit(STOP_WAIT);
        }
    }
}

/// A host that goes away without being stopped, such as one whose run was
/// dropped by a panic, still ends every process it started: nothing it ran
/// outlives it. The rows are left running, as a stop for an update leaves
/// them, so the next start offers them back.
impl Drop for Hosted {
    fn drop(&mut self) {
        self.stop(HostStopReason::Update);
    }
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
        // Floti's agent tools come with the agent tools listener.
        agent_tools: Vec::new(),
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

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The record type's id for a session.
pub(crate) fn session_id(id: u64) -> Option<SessionId> {
    i64::try_from(id).ok().map(SessionId)
}
