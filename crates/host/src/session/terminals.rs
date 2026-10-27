//! Plain terminals: a shell in a folder, not a session. It runs in a pty like
//! a session, keeps its screen and outlives its clients the same way, but it
//! has no row, no history and no notification: its ledger only numbers it and
//! says when it ended.
//!
//! A folder has one shell that every open of it reattaches to, unless an open
//! asks for a shell of its own.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use floti_protocol::BackendId;
use floti_protocol::channels::sessions::{DetectedShell, PtermOpenRequest, PtermOpened};
use tokio::sync::broadcast;

use super::shells::{detect_shells, shell_args};
use super::{
    ClientId, NewSessionRow, Session, SessionExit, SessionHost, SessionId, SessionLedger,
    StartSession, TermSize,
};
use crate::Result;
use crate::agent::LaunchSpec;
use crate::platform::process_tree::ProcessTree;

/// A plain terminal whose shell ended, with its exit code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalExit {
    pub id: SessionId,
    pub code: u32,
}

/// Numbers plain terminals and tells who listens when one ends. Nothing is
/// written anywhere.
struct TerminalLedger {
    next: AtomicI64,
    exits: broadcast::Sender<TerminalExit>,
}

impl SessionLedger for TerminalLedger {
    fn started(&self, _: &NewSessionRow) -> Result<SessionId> {
        Ok(SessionId(self.next.fetch_add(1, Ordering::SeqCst)))
    }

    fn finished(&self, id: SessionId, exit: &SessionExit) -> Result<()> {
        // Nobody listening is not a failure.
        let _ = self.exits.send(TerminalExit {
            id,
            code: exit.code,
        });
        Ok(())
    }
}

/// The plain terminals the host runs.
pub struct Terminals {
    host: SessionHost,
    exits: broadcast::Sender<TerminalExit>,
    env: Vec<(OsString, OsString)>,
    /// Each folder's own shell, by its lower-cased path.
    by_folder: Mutex<HashMap<String, SessionId>>,
    shells: OnceLock<Vec<DetectedShell>>,
}

impl Terminals {
    /// Terminals whose shells inherit `env` and are ended through `tree`.
    pub fn new(env: Vec<(OsString, OsString)>, tree: Arc<dyn ProcessTree + Send + Sync>) -> Self {
        let (exits, _) = broadcast::channel(256);
        let ledger = Arc::new(TerminalLedger {
            next: AtomicI64::new(1),
            exits: exits.clone(),
        });
        Self {
            host: SessionHost::new(env.clone(), ledger, tree),
            exits,
            env,
            by_folder: Mutex::new(HashMap::new()),
            shells: OnceLock::new(),
        }
    }

    /// Terminals ending from now on.
    pub fn exits(&self) -> broadcast::Receiver<TerminalExit> {
        self.exits.subscribe()
    }

    /// The shells this machine has, found once: the answer is a fact about
    /// what is installed, not about anything the host does.
    pub fn shells(&self) -> Vec<DetectedShell> {
        self.shells.get_or_init(|| detect_shells(&self.env)).clone()
    }

    /// Terminal `id`, while its shell runs.
    pub fn get(&self, id: u64) -> Option<Arc<Session>> {
        i64::try_from(id)
            .ok()
            .and_then(|id| self.host.get(SessionId(id)))
    }

    /// Every terminal still running.
    pub fn list(&self) -> Vec<Arc<Session>> {
        self.host.list()
    }

    /// Opens a shell in `request.path` for `client`, or reattaches to the
    /// folder's own. A shell that will not start gives way to the others this
    /// machine has, and the answer says which ran and why.
    pub fn open(
        &self,
        client: ClientId,
        request: PtermOpenRequest,
    ) -> std::result::Result<PtermOpened, String> {
        let folder = PathBuf::from(&request.path);
        if !folder.is_dir() {
            return Err(format!("{} is not a folder on this host.", request.path));
        }
        let key = request.path.to_lowercase();
        if !request.separate {
            let existing = lock(&self.by_folder)
                .get(&key)
                .and_then(|id| self.host.get(*id));
            if let Some(session) = existing {
                return Ok(PtermOpened {
                    id: u64::try_from(session.id().0).unwrap_or(0),
                    shell: session.name().to_owned(),
                    requested: None,
                    problem: None,
                });
            }
        }

        let wanted = request
            .shell
            .clone()
            .filter(|shell| !shell.trim().is_empty())
            .unwrap_or_else(|| self.default_shell());
        let size = TermSize::new(request.cols, request.rows);
        let (session, shell, requested, problem) = match self.spawn(&wanted, &folder, size, client)
        {
            Ok(session) => (session, wanted, None, None),
            Err(first) => {
                let mut tried = Err(first.to_string());
                for other in self.alternatives_to(&wanted) {
                    if let Ok(session) = self.spawn(&other, &folder, size, client) {
                        tried = Ok((session, other));
                        break;
                    }
                }
                match tried {
                    Ok((session, other)) => {
                        let problem =
                            format!("{wanted} would not start ({first}), so {other} runs instead.");
                        (session, other, Some(wanted), Some(problem))
                    }
                    Err(why) => {
                        return Err(format!("No shell would start in {}: {why}", request.path));
                    }
                }
            }
        };
        if !request.separate {
            lock(&self.by_folder).insert(key, session.id());
        }
        Ok(PtermOpened {
            id: u64::try_from(session.id().0).unwrap_or(0),
            shell,
            requested,
            problem,
        })
    }

    /// Ends terminal `id`'s shell and everything it started. A terminal that
    /// has already ended is closed already.
    pub fn close(&self, id: u64) {
        if let Some(session) = self.get(id) {
            session.close();
        }
    }

    /// `client`'s view of terminal `id` is now this size.
    pub fn resize(
        &self,
        client: ClientId,
        id: u64,
        size: TermSize,
    ) -> std::result::Result<(), String> {
        self.get(id)
            .ok_or_else(|| format!("Terminal {id} is not open on this Floti host."))?
            .resize(client, size)
            .map_err(|err| err.to_string())
    }

    /// Ends every terminal now, as stopping the host does.
    pub fn end_all(&self) {
        for session in self.host.list() {
            if let Err(err) = session.end_now() {
                eprintln!("floti host: {err}");
            }
        }
    }

    fn spawn(
        &self,
        shell: &str,
        folder: &Path,
        size: TermSize,
        client: ClientId,
    ) -> Result<Arc<Session>> {
        let program = PathBuf::from(shell);
        self.host.start(StartSession {
            spec: LaunchSpec {
                args: shell_args(&program),
                program: program.into_os_string(),
                cwd: folder.to_path_buf(),
                env: Vec::new(),
                conversation_id: None,
                launch_folder: None,
            },
            // A terminal goes by the shell it runs.
            name: shell.to_owned(),
            size,
            client: Some(client),
            conversation_id: None,
            backend: BackendId::new("shell"),
            origin: Default::default(),
        })
    }

    /// The first shell found, or the user's own when none was.
    fn default_shell(&self) -> String {
        self.shells()
            .first()
            .map(|shell| shell.path.clone())
            .unwrap_or_else(|| self.fallback_shell())
    }

    /// `%COMSPEC%` where it is set, otherwise `$SHELL`, otherwise `/bin/sh`.
    fn fallback_shell(&self) -> String {
        ["COMSPEC", "SHELL"]
            .into_iter()
            .find_map(|name| {
                self.env
                    .iter()
                    .find(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case(name))
                    .map(|(_, value)| PathBuf::from(value))
                    .filter(|path| path.is_absolute())
            })
            .map_or_else(
                || "/bin/sh".to_owned(),
                |path| path.to_string_lossy().into_owned(),
            )
    }

    /// Every other shell to try, in detection order, when `wanted` will not
    /// start.
    fn alternatives_to(&self, wanted: &str) -> Vec<String> {
        let mut seen = vec![wanted.to_lowercase()];
        let mut others = Vec::new();
        for candidate in self
            .shells()
            .into_iter()
            .map(|shell| shell.path)
            .chain([self.fallback_shell()])
        {
            if seen.contains(&candidate.to_lowercase()) {
                continue;
            }
            seen.push(candidate.to_lowercase());
            others.push(candidate);
        }
        others
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::platform::process_tree;
    use crate::testkit::TestDirs;

    const A: ClientId = ClientId(1);

    fn terminals() -> Terminals {
        Terminals::new(
            std::env::vars_os().collect(),
            Arc::new(process_tree::Native),
        )
    }

    fn open(terminals: &Terminals, folder: &Path, separate: bool) -> PtermOpened {
        terminals
            .open(
                A,
                PtermOpenRequest {
                    path: folder.to_string_lossy().into_owned(),
                    cols: 80,
                    rows: 24,
                    shell: None,
                    separate,
                },
            )
            .expect("open a terminal")
    }

    #[test]
    fn a_resize_from_the_client_that_opened_it_lands_on_the_terminals_pty() {
        let dirs = TestDirs::new();
        let terminals = terminals();
        let opened = open(&terminals, &dirs.folder("a project"), false);
        terminals
            .resize(A, opened.id, TermSize::new(132, 41))
            .unwrap();
        let session = terminals.get(opened.id).unwrap();
        assert_eq!(session.pty_size(), Some(TermSize::new(132, 41)));
        assert_eq!(session.size(), TermSize::new(132, 41));
        terminals.end_all();
        assert!(session.wait_exit(Duration::from_secs(10)).is_some());
    }

    #[test]
    fn a_folder_has_one_shell_unless_a_separate_one_is_asked_for() {
        let dirs = TestDirs::new();
        let folder = dirs.folder("a project");
        let terminals = terminals();
        let first = open(&terminals, &folder, false);
        let again = open(&terminals, &folder, false);
        let own = open(&terminals, &folder, true);
        assert_eq!(again.id, first.id);
        assert_ne!(own.id, first.id);
        assert_eq!(terminals.list().len(), 2);
        terminals.end_all();
    }

    #[test]
    fn a_shell_that_will_not_start_gives_way_and_the_answer_says_so() {
        let dirs = TestDirs::new();
        let folder = dirs.folder("a project");
        let terminals = terminals();
        let missing = dirs.root().join("no such shell").join("gone.exe");
        let opened = terminals
            .open(
                A,
                PtermOpenRequest {
                    path: folder.to_string_lossy().into_owned(),
                    cols: 80,
                    rows: 24,
                    shell: Some(missing.to_string_lossy().into_owned()),
                    separate: true,
                },
            )
            .expect("another shell opens");
        assert_eq!(
            opened.requested.as_deref(),
            Some(missing.to_string_lossy().as_ref())
        );
        assert_ne!(opened.shell, missing.to_string_lossy());
        assert!(
            opened
                .problem
                .is_some_and(|problem| problem.contains("runs instead"))
        );
        terminals.end_all();
    }

    #[test]
    fn a_folder_that_is_not_there_is_refused_in_a_sentence() {
        let dirs = TestDirs::new();
        let err = terminals()
            .open(
                A,
                PtermOpenRequest {
                    path: dirs.root().join("gone").to_string_lossy().into_owned(),
                    cols: 80,
                    rows: 24,
                    shell: None,
                    separate: false,
                },
            )
            .unwrap_err();
        assert!(err.ends_with("is not a folder on this host."), "{err}");
    }
}
