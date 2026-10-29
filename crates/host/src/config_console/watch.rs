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
    /// A new hash one look saw, told only when the next look sees it again:
    /// a write that truncates and then writes can be caught between the two,
    /// and an empty file it never meant to leave is not news.
    seen: Option<String>,
}

impl Watched {
    fn new(path: PathBuf) -> Self {
        let hash = read_file(&path).hash;
        Self {
            path,
            hash,
            seen: None,
        }
    }

    /// The change to tell, once the file has held new bytes for two looks
    /// running.
    fn look(&mut self) -> Option<ConfigExternalChange> {
        let now = read_file(&self.path);
        if now.hash == self.hash {
            self.seen = None;
            return None;
        }
        if self.seen.as_ref() != Some(&now.hash) {
            self.seen = Some(now.hash);
            return None;
        }
        self.seen = None;
        self.hash.clone_from(&now.hash);
        Some(ConfigExternalChange {
            path: self.path.display().to_string(),
            hash: now.hash,
            exists: now.exists,
            mtime_ms: now.mtime_ms,
        })
    }
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
                watched.seen = None;
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
                by_client.insert(client, Watched::new(path));
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
                .filter_map(|(client, watched)| Some((*client, watched.look()?)))
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

#[cfg(test)]
mod tests {
    use super::super::files::hash_content;
    use super::*;
    use crate::testkit::TestDirs;

    #[test]
    fn a_change_is_told_once_it_has_held_for_two_looks_and_a_write_caught_halfway_is_not() {
        let dirs = TestDirs::new();
        let file = dirs.root().join("CLAUDE.md");
        std::fs::write(&file, "one\n").unwrap();
        let mut watched = Watched::new(normalize(&file));

        // Truncated, then written: a look between the two sees an empty file.
        std::fs::write(&file, "").unwrap();
        assert!(watched.look().is_none());
        std::fs::write(&file, "three\n").unwrap();
        assert!(watched.look().is_none());
        let change = watched.look().expect("told once it held");
        assert_eq!(change.hash, hash_content("three\n"));
        assert!(change.exists);
        assert!(watched.look().is_none());

        // A file emptied and left empty is told too, a look later.
        std::fs::write(&file, "").unwrap();
        assert!(watched.look().is_none());
        assert_eq!(watched.look().expect("told").hash, hash_content(""));

        // A change undone before the second look is nothing.
        std::fs::write(&file, "four\n").unwrap();
        assert!(watched.look().is_none());
        std::fs::write(&file, "").unwrap();
        assert!(watched.look().is_none());
        assert!(watched.look().is_none());
    }
}
