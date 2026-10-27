//! The sessions the host runs, as its clients' requests reach them: start,
//! list, close and resize, the restore offer, and the stop that ends them.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use floti_protocol::BackendId;
use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    CloseSessionRequest, CloseSessionResult, LaunchedSession, RestorableSession, RestoreOffer,
    RestoreSessionsRequest, RestoreSessionsResult, RestoredSession, SessionResizeRequest,
    StartSessionRequest, UnrestoredSession,
};

use super::records::{self, HostLedger, LostRow};
use crate::agent::{AgentBackend, Launch, LaunchFolder, LaunchRequest, ResumeRequest};
use crate::platform::process_tree;
use crate::session::{ClientId, SessionHost, SessionId, StartSession, TermSize};
use crate::store::Store;
use crate::{Error, Result};

/// How long a stop waits for each session to be reported ended after its
/// tree was ended.
const STOP_WAIT: Duration = Duration::from_secs(5);

/// The host's sessions and what it knows about them beyond the session
/// module: which backend runs each, and the restore offer.
pub(crate) struct Hosted {
    sessions: SessionHost,
    ledger: Arc<HostLedger>,
    /// Every backend the host can run; the first is the default.
    backends: Vec<Arc<dyn AgentBackend>>,
    /// Floti's data folder, which holds each launch's own folder.
    data: PathBuf,
    /// The backend of each session this run started.
    running_backends: Mutex<HashMap<SessionId, BackendId>>,
    /// What the start reconciled to lost, until a client answers the offer.
    offer: Mutex<Option<Vec<LostRow>>>,
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
            inherited_env,
            Arc::clone(&ledger) as Arc<dyn crate::session::SessionLedger>,
            Arc::new(process_tree::Native),
        );
        Ok(Self {
            sessions,
            ledger,
            data,
            backends,
            running_backends: Mutex::new(HashMap::new()),
            offer: Mutex::new(Some(lost)),
        })
    }

    pub fn sessions(&self) -> &SessionHost {
        &self.sessions
    }

    pub fn ledger(&self) -> &HostLedger {
        &self.ledger
    }

    fn default_backend(&self) -> &Arc<dyn AgentBackend> {
        &self.backends[0]
    }

    fn backend(
        &self,
        id: Option<&BackendId>,
    ) -> std::result::Result<&Arc<dyn AgentBackend>, String> {
        match id {
            None => Ok(self.default_backend()),
            Some(id) => self
                .backends
                .iter()
                .find(|backend| backend.id() == id)
                .ok_or_else(|| format!("This Floti host has no agent backend `{id}`.")),
        }
    }

    /// The backend session `id` runs on: the one that started it, or the
    /// host's default for a row this run did not start.
    pub fn backend_of(&self, id: SessionId) -> BackendId {
        lock(&self.running_backends)
            .get(&id)
            .cloned()
            .unwrap_or_else(|| self.default_backend().id().clone())
    }

    /// Session `id`'s row.
    pub fn record(&self, id: SessionId) -> Result<SessionRecord> {
        let backend = self.backend_of(id);
        records::read_record(&self.ledger.store(), id, &backend)
    }

    /// The rows of the sessions running now, oldest first.
    pub fn list(&self) -> std::result::Result<Vec<SessionRecord>, String> {
        let running = self.sessions.list();
        lock(&self.running_backends)
            .retain(|id, _| running.iter().any(|session| session.id() == *id));
        running
            .iter()
            .map(|session| self.record(session.id()).map_err(|err| err.to_string()))
            .collect()
    }

    /// Starts a session on the backend asked for, in the folder asked for,
    /// at the starting client's size.
    pub fn start(
        &self,
        client: ClientId,
        request: StartSessionRequest,
    ) -> std::result::Result<SessionRecord, String> {
        let backend = Arc::clone(self.backend(request.backend.as_ref())?);
        let folder = PathBuf::from(&request.cwd);
        let name = request
            .name
            .filter(|name| !name.trim().is_empty())
            .unwrap_or_else(|| folder_name(&folder));
        let launch = LaunchRequest {
            folder,
            name: name.clone(),
            ..LaunchRequest::default()
        };
        let size = TermSize::new(request.cols, request.rows);
        self.launch(&backend, name, size, client, |launch_folder| {
            backend.launch(&launch, launch_folder)
        })
        .map(|launched| launched.session)
        .map_err(|err| err.to_string())
    }

    /// Composes a launch in a launch folder of its own and starts it. The
    /// folder belongs to the session from then on, which removes it when it
    /// ends; a launch that never started removes it here.
    fn launch(
        &self,
        backend: &Arc<dyn AgentBackend>,
        name: String,
        size: TermSize,
        client: ClientId,
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
        lock(&self.running_backends).insert(session.id(), backend.id().clone());
        Ok(LaunchedSession {
            session: self.record(session.id())?,
            overlays,
            composed_instructions,
            warnings,
            not_taken,
        })
    }

    /// Asks session `id` to end, as closing its tab does. The skeleton asks
    /// no confirmation first: a client's close is taken as meant.
    pub fn close(
        &self,
        request: CloseSessionRequest,
    ) -> std::result::Result<CloseSessionResult, String> {
        let session = self.running(request.id)?;
        session.close();
        Ok(CloseSessionResult { closed: true })
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

    fn running(&self, id: u64) -> std::result::Result<Arc<crate::session::Session>, String> {
        i64::try_from(id)
            .ok()
            .and_then(|id| self.sessions.get(SessionId(id)))
            .ok_or_else(|| format!("Session {id} is not running on this Floti host."))
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
        if row.conversation_id.is_none() {
            return Some(
                "Floti never learned which conversation this was, so it cannot be reopened."
                    .to_owned(),
            );
        }
        if !Path::new(&row.cwd).is_dir() {
            return Some(format!("{} is no longer on disk.", row.cwd));
        }
        let backend = self.default_backend();
        if backend.resumer().is_none() {
            return Some(format!("{} cannot reopen a conversation.", backend.name()));
        }
        None
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

    fn reopen(
        &self,
        row: &LostRow,
        size: TermSize,
        client: ClientId,
    ) -> std::result::Result<LaunchedSession, String> {
        if let Some(blocked) = self.blocked(row) {
            return Err(blocked);
        }
        // In the folder the row recorded, wherever the request came from.
        let request = ResumeRequest {
            conversation_id: row.conversation_id.clone().unwrap_or_default(),
            folder: PathBuf::from(&row.cwd),
            composition: Default::default(),
        };
        let backend = Arc::clone(self.default_backend());
        self.launch(&backend, row.name.clone(), size, client, |launch_folder| {
            let resumer = backend.resumer().ok_or_else(|| {
                Error::Refused(format!("{} cannot reopen a conversation.", backend.name()))
            })?;
            resumer.resume(&request, launch_folder)
        })
        .map_err(|err| err.to_string())
    }

    /// Ends every session, as stopping the host does. A plain stop records
    /// each row as exited first, so none is offered for restore; a stop for
    /// an update leaves the rows running, for the next start to find lost
    /// and offer once. Either way each whole process tree ends.
    pub fn stop(&self, reason: HostStopReason) {
        // From here no session starts and no exit writes its row.
        self.ledger.freeze();
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
