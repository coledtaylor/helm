//! The session keeper: `floti keeper`, a second process the host starts,
//! which holds every session's and plain terminal's pty and process tree and
//! nothing else, so a host that crashes, panics or is killed takes no
//! session with it.
//!
//! - The keeper ([`run_keeper`]) runs each program in a pty of its own with
//!   its screen, keeps reading its output while no host is connected, and
//!   keeps how a program ended until a host has recorded it. Every tree it
//!   holds ends with it ([`ProcessTree::end_tree_with_this_process`]), so a
//!   dead keeper leaves nothing running. It opens no store, keeps no history
//!   or usage, runs no plugin and holds no network port, and exits once it
//!   holds nothing and no host is connected.
//! - The host reaches it through [`Keeper`], on a local socket only this
//!   user can open, named from the host's data folder ([`keeper_endpoint`]),
//!   over one [`KeeperLink`]. The keeper is started outside the host's own
//!   tie ([`ProcessTree::prepare_lasting_root`]), so it outlives the host.
//! - A host starting finds the keeper the last one left ([`Keeper::reattach`])
//!   and takes back what it holds, whenever the keeper speaks its link
//!   version ([`floti_protocol::KEEPER_LINK_VERSION`]), whatever floti version
//!   built it. A keeper whose greeting names no link version was built before
//!   the greeting carried one (2.4.1-preview.7's) and speaks link version 1
//!   ([`wire::UNNAMED_LINK_VERSION`]), so a host on link version 1 takes it
//!   back too. A keeper of a link version the host does not speak is told to
//!   end everything, or ended by its pid, and one of the host's link version
//!   starts when the next program does.
//! - A host restarted for an update ([`Keeper::let_go`]) leaves the keeper
//!   running as a crash would, for the next host to take back.
//! - Only a deliberate stop ([`Keeper::shutdown`]) ends the keeper and every
//!   tree in it. A host that lets go of it ([`Keeper`]'s drop) leaves it
//!   running.
//!
//! Nothing crosses the endpoint but programs, their folders, sizes, bytes
//! and ends ([`wire`]): no key, token, code or credential.

mod link;
mod serve;
mod wire;

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use floti_protocol::Knowable;

pub use link::{Held, KeeperLink, KeptTerminal, StartPty};
pub use serve::{KEEPER_ALREADY_RUNNING, run_keeper};
pub use wire::{HeldKind, Label};

use crate::platform::folders::Folders;
use crate::platform::process_tree::{self, Ending, ProcessTree};
use crate::platform::socket::{self, Endpoint, LocalSocket};
use crate::{Error, Result};
use link::Greeting;

/// The file in the logs folder the keeper writes its standard error to.
pub const KEEPER_LOG: &str = "keeper.log";

/// Past this, the keeper's log starts afresh when the next keeper starts.
const KEEPER_LOG_LIMIT: u64 = 1 << 20;

/// How long a keeper has to say it is ready, or to end everything when told.
const KEEPER_WAIT: Duration = Duration::from_secs(30);

/// How often a host ending a keeper looks whether it has gone.
const GONE_POLL: Duration = Duration::from_millis(25);

/// A file in a test's data folder whose text is the version the host and
/// keeper on it say they are, in place of this build's.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_KEEPER_VERSION: &str = "floti-test-keeper-version";

/// A file in a test's data folder whose text is the link version the host
/// and keeper on it speak, in place of [`floti_protocol::KEEPER_LINK_VERSION`]:
/// a number, or `none` for a keeper whose greeting leaves it out, as
/// 2.4.1-preview.7's does. A host on `none` takes keepers back by link
/// version 1, which is what such a keeper speaks.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_KEEPER_LINK_VERSION: &str = "floti-test-keeper-link-version";

/// The link version a keeper names in its greeting: this build's, or in a
/// test build what [`TEST_KEEPER_LINK_VERSION`] says, `none` leaving it out as
/// 2.4.1-preview.7's keeper does.
pub fn keeper_link_version(data: &Path) -> Option<u32> {
    #[cfg(any(test, feature = "testkit"))]
    if let Ok(text) = fs::read_to_string(data.join(TEST_KEEPER_LINK_VERSION)) {
        let text = text.trim();
        if text == "none" {
            return None;
        }
        if let Ok(link) = text.parse() {
            return Some(link);
        }
    }
    let _ = data;
    Some(floti_protocol::KEEPER_LINK_VERSION)
}

/// The floti version a keeper says built it: this build's.
pub fn keeper_version(data: &Path) -> String {
    #[cfg(any(test, feature = "testkit"))]
    if let Ok(version) = fs::read_to_string(data.join(TEST_KEEPER_VERSION)) {
        let version = version.trim();
        if !version.is_empty() {
            return version.to_owned();
        }
    }
    let _ = data;
    crate::version::FLOTI_VERSION.to_owned()
}

/// Where the keeper of the host on `data` listens: a socket in the runtime
/// folder, only this user can open, named from the data folder so two hosts
/// on two data folders never share one.
pub fn keeper_endpoint(runtime: &Path, data: &Path) -> Endpoint {
    let name = data.to_string_lossy().to_lowercase();
    socket::Native.endpoint(runtime, &format!("keeper-{:08x}", fnv1a(name.as_bytes())))
}

fn fnv1a(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0x811c_9dc5_u32, |hash, byte| {
        (hash ^ u32::from(*byte)).wrapping_mul(0x0100_0193)
    })
}

/// The host's way to its keeper: the one it found at its start, or the one
/// it starts when it next needs one.
pub struct Keeper {
    /// The `floti` executable, run as `floti keeper`.
    program: PathBuf,
    data: PathBuf,
    runtime: PathBuf,
    logs: PathBuf,
    /// The keeper's environment, which every program it starts inherits.
    env: Vec<(OsString, OsString)>,
    endpoint: Endpoint,
    /// The link version this host takes a keeper back by.
    link_version: u32,
    link: Mutex<Option<Arc<KeeperLink>>>,
}

impl Keeper {
    /// The keeper of the host on `folders`, run from `program` with `env`.
    pub fn new(program: PathBuf, folders: &Folders, env: Vec<(OsString, OsString)>) -> Self {
        Self {
            program,
            data: folders.data.clone(),
            runtime: folders.runtime.clone(),
            logs: folders.logs.clone(),
            env,
            endpoint: keeper_endpoint(&folders.runtime, &folders.data),
            link_version: keeper_link_version(&folders.data).unwrap_or(wire::UNNAMED_LINK_VERSION),
            link: Mutex::new(None),
        }
    }

    /// Connects to the keeper the last host left, and returns what it holds:
    /// nothing when there is none. A keeper whose greeting names no link
    /// version speaks link version 1 and is taken back by a host on it. A
    /// keeper of a link version this host does not speak is ended, with
    /// everything it holds, and nothing is returned.
    pub fn reattach(&self) -> Vec<Held> {
        match KeeperLink::connect(socket::Native, &self.endpoint, self.link_version) {
            // No keeper is listening: the last host left none.
            Err(_) => Vec::new(),
            Ok((link, Greeting::Ours(held))) => {
                log_line!(
                    "floti host: took back the session keeper, process {}, holding {}.",
                    link.pid(),
                    held.len()
                );
                *lock(&self.link) = Some(link);
                held
            }
            Ok((
                link,
                Greeting::Other {
                    version,
                    link: theirs,
                },
            )) => {
                log_line!(
                    "floti host: the session keeper, process {}, is floti {version} with link version {theirs}, and this host speaks link version {}; it is ended with what it holds.",
                    link.pid(),
                    self.link_version
                );
                end_keeper(&link);
                Vec::new()
            }
        }
    }

    /// The connection to a running keeper, starting one when there is none.
    pub fn link(&self) -> Result<Arc<KeeperLink>> {
        let mut current = lock(&self.link);
        if let Some(link) = current.as_ref().filter(|link| !link.is_ended()) {
            return Ok(Arc::clone(link));
        }
        let link = self.start()?;
        *current = Some(Arc::clone(&link));
        Ok(link)
    }

    /// The running keeper's process id, while the host is connected to one.
    pub fn pid(&self) -> Option<u32> {
        lock(&self.link)
            .as_ref()
            .filter(|link| !link.is_ended())
            .map(|link| link.pid())
    }

    /// The link version of the keeper this host is connected to, or none
    /// while it is connected to none.
    pub fn running_link_version(&self) -> Option<u32> {
        lock(&self.link)
            .as_ref()
            .filter(|link| !link.is_ended())
            .map(|link| link.link_version())
    }

    /// Lets go of the keeper, leaving it running with everything it holds,
    /// as a host that crashed leaves it: a restart for an update.
    pub fn let_go(&self) {
        if let Some(link) = lock(&self.link).take() {
            log_line!(
                "floti host: let go of the session keeper, process {}, for the next host to take back.",
                link.pid()
            );
            link.detach();
        }
    }

    /// Ends the keeper and every tree in it, as a deliberate stop does.
    pub fn shutdown(&self) {
        if let Some(link) = lock(&self.link).take() {
            end_keeper(&link);
        }
    }

    fn start(&self) -> Result<Arc<KeeperLink>> {
        let mut command = Command::new(&self.program);
        command
            .arg("keeper")
            .arg(&self.data)
            .arg(&self.runtime)
            .env_clear()
            .envs(self.env.iter().map(|(name, value)| (name, value)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(self.log_file());
        process_tree::Native.prepare_lasting_root(&mut command);
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(err) => {
                // Where the host may not start a program outside its own
                // tie, the keeper runs inside it: sessions then end with the
                // host, as they did before there was a keeper.
                log_line!(
                    "floti host: the session keeper could not start apart from the host ({err}), so it runs within it."
                );
                let mut command = Command::new(&self.program);
                command
                    .arg("keeper")
                    .arg(&self.data)
                    .arg(&self.runtime)
                    .env_clear()
                    .envs(self.env.iter().map(|(name, value)| (name, value)))
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(self.log_file());
                process_tree::Native.prepare_root(&mut command);
                command
                    .spawn()
                    .map_err(|err| Error::io("start the session keeper", err))?
            }
        };
        let pid = child.id();
        let (said, saying) = mpsc::channel();
        if let Some(stdout) = child.stdout.take() {
            std::thread::spawn(move || {
                let mut line = String::new();
                let _ = BufReader::new(stdout).read_line(&mut line);
                let _ = said.send(line);
            });
        }
        // Reaped whenever it ends, so it never lingers as a zombie.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        // A keeper that would not bind found one already there: connect to
        // that one all the same.
        let _ = saying.recv_timeout(KEEPER_WAIT);
        let (link, greeting) =
            KeeperLink::connect(socket::Native, &self.endpoint, self.link_version)?;
        match greeting {
            Greeting::Ours(held) => {
                for program in held {
                    link.discard(program.handle);
                }
                log_line!(
                    "floti host: started a session keeper, process {}.",
                    link.pid()
                );
                if link.pid() != pid {
                    log_line!("floti host: another session keeper answered in its place.");
                }
                Ok(link)
            }
            Greeting::Other {
                version,
                link: theirs,
            } => {
                end_keeper(&link);
                Err(Error::Refused(format!(
                    "Another session keeper, floti {version} with link version {theirs}, holds this host's endpoint."
                )))
            }
        }
    }

    /// The keeper's log, started afresh once it has grown past its limit;
    /// nowhere when it cannot be opened.
    fn log_file(&self) -> Stdio {
        let path = self.logs.join(KEEPER_LOG);
        let fresh = fs::metadata(&path).is_ok_and(|meta| meta.len() > KEEPER_LOG_LIMIT);
        let opened = fs::create_dir_all(&self.logs).and_then(|()| {
            OpenOptions::new()
                .create(true)
                .append(!fresh)
                .write(true)
                .truncate(fresh)
                .open(&path)
        });
        match opened {
            Ok(file) => Stdio::from(file as File),
            Err(err) => {
                log_line!("floti host: the session keeper keeps no log: {err}");
                Stdio::null()
            }
        }
    }
}

/// A host that lets go of its keeper leaves it running with everything it
/// holds, for the next host to take back.
impl Drop for Keeper {
    fn drop(&mut self) {
        if let Some(link) = lock(&self.link).take() {
            link.detach();
        }
    }
}

/// Tells the keeper on `link` to end everything and exit, and ends its tree
/// by its pid if it has not gone once it has had its time.
fn end_keeper(link: &KeeperLink) {
    let pid = link.pid();
    link.shutdown(KEEPER_WAIT);
    let tree = process_tree::Native;
    if !gone_within(&tree, pid, KEEPER_WAIT) {
        log_line!("floti host: the session keeper, process {pid}, did not end, so it is ended.");
        if let Err(err) = tree.end_tree(pid, Ending::Forced) {
            log_line!("floti host: {err}");
        }
        gone_within(&tree, pid, KEEPER_WAIT);
    }
}

fn gone_within(tree: &impl ProcessTree, pid: u32, wait: Duration) -> bool {
    let deadline = Instant::now() + wait;
    loop {
        if tree.is_alive(pid) != Knowable::Known(true) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(GONE_POLL);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
