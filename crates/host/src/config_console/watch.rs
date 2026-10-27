//! The file each client's editor has open, and the outside changes to it.
//!
//! The watch is a courtesy: it tells an editor that a file changed under it
//! while the user is still typing. The guarantee is the hash check in every
//! write, which holds whether or not the watch ever saw anything. So the
//! watch polls the one file per client by its hash, which behaves the same
//! on every OS and filesystem, and a change the host made itself updates the
//! hash under the same lock as the change, so it never comes back as
//! somebody else's.
//!
//! An outside change is told to each client watching that file, once, and
//! to no other: a client watching another file, or none, hears nothing.
//! Two clients watching one file are each told.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use floti_protocol::channels::workspace::ConfigExternalChange;

use super::files::{normalize, read_file};
use crate::session::ClientId;

/// How often a watched file is looked at.
const POLL: Duration = Duration::from_millis(200);

/// Tells one client of an outside change to the file it watches.
pub type ChangeSink = Box<dyn Fn(ClientId, &ConfigExternalChange) + Send + Sync>;

struct Watched {
    path: PathBuf,
    /// The hash the host last saw, empty for a file that is not there.
    hash: String,
}

/// Every client's watched file.
pub struct Watches {
    by_client: Mutex<HashMap<ClientId, Watched>>,
    sink: ChangeSink,
}

/// The watches, held while the host changes files, so a poll never sees a
/// change half made.
pub struct Changing<'a> {
    by_client: MutexGuard<'a, HashMap<ClientId, Watched>>,
}

impl Changing<'_> {
    /// The host changed `paths`: each watch on one of them takes the hash on
    /// disk now as its own.
    pub fn changed<'p>(&mut self, paths: impl IntoIterator<Item = &'p Path>) {
        let paths: Vec<PathBuf> = paths.into_iter().map(normalize).collect();
        for watched in self.by_client.values_mut() {
            if paths.contains(&watched.path) {
                watched.hash = read_file(&watched.path).hash;
            }
        }
    }
}

impl Watches {
    /// The watches, polled on a thread of their own until they are dropped.
    pub fn start(sink: ChangeSink) -> Arc<Self> {
        let watches = Arc::new(Self {
            by_client: Mutex::new(HashMap::new()),
            sink,
        });
        let weak = Arc::downgrade(&watches);
        std::thread::Builder::new()
            .name("floti config watch".to_owned())
            .spawn(move || poll(&weak))
            .expect("the OS starts a thread");
        watches
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<ClientId, Watched>> {
        self.by_client
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// `client`'s editor has `path` open, or nothing when `None`.
    pub fn watch(&self, client: ClientId, path: Option<&Path>) {
        let mut by_client = self.lock();
        match path.map(normalize) {
            None => {
                by_client.remove(&client);
            }
            Some(path) => {
                if by_client.get(&client).is_some_and(|w| w.path == path) {
                    return;
                }
                let hash = read_file(&path).hash;
                by_client.insert(client, Watched { path, hash });
            }
        }
    }

    /// The watches held for a change the host is making.
    pub fn changing(&self) -> Changing<'_> {
        Changing {
            by_client: self.lock(),
        }
    }

    /// Every watched file whose bytes are not what the host last saw, told
    /// once to each client watching it.
    fn look(&self) {
        let changes: Vec<(ClientId, ConfigExternalChange)> = {
            let mut by_client = self.lock();
            by_client
                .iter_mut()
                .filter_map(|(client, watched)| {
                    let now = read_file(&watched.path);
                    (now.hash != watched.hash).then(|| {
                        watched.hash.clone_from(&now.hash);
                        let change = ConfigExternalChange {
                            path: watched.path.display().to_string(),
                            hash: now.hash,
                            exists: now.exists,
                            mtime_ms: now.mtime_ms,
                        };
                        (*client, change)
                    })
                })
                .collect()
        };
        // Told outside the lock: a sink is free to take its time.
        for (client, change) in &changes {
            (self.sink)(*client, change);
        }
    }
}

fn poll(watches: &Weak<Watches>) {
    loop {
        std::thread::sleep(POLL);
        match watches.upgrade() {
            Some(watches) => watches.look(),
            None => return,
        }
    }
}
