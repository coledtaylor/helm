//! Each client's watched roots, and the bursts of changes under them.
//!
//! A client names every root it has on screen in each request, and a root it
//! leaves out is let go, so a reloaded window that names fewer cannot leak
//! the watches the one before it asked for. A client whose connection ends
//! leaves no watch behind.
//!
//! A burst is told 250 ms after its *first* event, not its last: a session
//! writing a file every 100 ms would otherwise hold a trailing debounce open
//! for as long as it kept working, and the view beside it would go stale for
//! exactly the stretch somebody is watching. Past 1,000 paths a burst is
//! told as null, "re-read whatever you are showing". Under `.git` only the
//! index, `HEAD` and refs count, as the one path `.git`: a stage, a commit or
//! a checkout; objects, logs and packs say nothing a refresh would show.

use std::collections::{BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use floti_protocol::channels::workspace::FilesChange;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use crate::session::ClientId;

/// How long a burst of events is gathered, from its first.
pub const SETTLE: Duration = Duration::from_millis(250);

/// Past this many distinct paths in one burst, the client is told
/// "everything".
pub const BURST_MAX: usize = 1000;

/// Tells one client what changed under a root it watches. `key` is the
/// root's [`key`](crate::workspace::roots::key), for the caller's caches.
pub type FilesSink = Arc<dyn Fn(ClientId, &str, &FilesChange) + Send + Sync>;

/// One root, as a client watches it.
pub struct WatchedRoot {
    /// The root as the host knows it, as it is told back.
    pub root: PathBuf,
    /// The root's key, which a request names it by.
    pub key: String,
}

/// What one watch gathers between tellings.
#[derive(Default)]
struct Burst {
    pending: BTreeSet<String>,
    overflow: bool,
    /// A telling is due.
    armed: bool,
    /// Cleared when the watch goes, so a telling already due says nothing.
    live: bool,
}

struct Watch {
    burst: Arc<Mutex<Burst>>,
    /// Held for its handle; dropping it stops the OS's watch.
    _watcher: RecommendedWatcher,
}

impl Drop for Watch {
    fn drop(&mut self) {
        lock(&self.burst).live = false;
    }
}

/// Every client's watches.
pub struct FileWatches {
    by_client: Mutex<HashMap<ClientId, HashMap<String, Watch>>>,
    sink: FilesSink,
}

impl FileWatches {
    pub fn new(sink: FilesSink) -> Self {
        Self {
            by_client: Mutex::new(HashMap::new()),
            sink,
        }
    }

    /// `client` watches `roots` and nothing else: any other root it watched
    /// is let go, and one it already watches keeps its watch.
    pub fn set(&self, client: ClientId, roots: Vec<WatchedRoot>) {
        let mut by_client = lock(&self.by_client);
        let watches = by_client.entry(client).or_default();
        let wanted: HashMap<String, PathBuf> = roots
            .into_iter()
            .map(|root| (root.key, root.root))
            .collect();
        watches.retain(|key, _| wanted.contains_key(key));
        for (key, root) in wanted {
            if watches.contains_key(&key) {
                continue;
            }
            // A root that cannot be watched (gone, or on a filesystem that
            // does not report changes) is still readable: the view works,
            // it just does not update by itself.
            if let Some(watch) = arm(client, &key, &root, Arc::clone(&self.sink)) {
                watches.insert(key, watch);
            }
        }
        if watches.is_empty() {
            by_client.remove(&client);
        }
    }

    /// `client` is gone: every watch it held goes with it.
    pub fn forget(&self, client: ClientId) {
        let gone = lock(&self.by_client).remove(&client);
        drop(gone);
    }

    /// The keys of the roots `client` watches, sorted.
    pub fn watching(&self, client: ClientId) -> Vec<String> {
        let mut keys: Vec<String> = lock(&self.by_client)
            .get(&client)
            .map(|watches| watches.keys().cloned().collect())
            .unwrap_or_default();
        keys.sort();
        keys
    }
}

/// Starts the OS's recursive watch on `root` for `client`.
fn arm(client: ClientId, key: &str, root: &Path, sink: FilesSink) -> Option<Watch> {
    let burst = Arc::new(Mutex::new(Burst {
        live: true,
        ..Burst::default()
    }));
    let told = root.display().to_string();
    // The root as the OS may spell it in its events: macOS reports a
    // temporary folder under /private/var, which is /var as written.
    let spellings: Vec<PathBuf> = std::iter::once(root.to_path_buf())
        .chain(std::fs::canonicalize(root).ok())
        .collect();
    let gathering = Arc::clone(&burst);
    let key = key.to_owned();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        let mut burst = lock(&gathering);
        if !burst.live || !gather(&mut burst, &spellings, event) || burst.armed {
            return;
        }
        burst.armed = true;
        let due = Arc::clone(&gathering);
        let sink = Arc::clone(&sink);
        let told = told.clone();
        let key = key.clone();
        std::thread::spawn(move || {
            std::thread::sleep(SETTLE);
            let paths = {
                let mut burst = lock(&due);
                if !burst.live {
                    return;
                }
                burst.armed = false;
                let pending = std::mem::take(&mut burst.pending);
                let overflow = std::mem::replace(&mut burst.overflow, false);
                (!overflow).then(|| pending.into_iter().collect())
            };
            sink(client, &key, &FilesChange { root: told, paths });
        });
    })
    .ok()?;
    watcher.watch(root, RecursiveMode::Recursive).ok()?;
    Some(Watch {
        burst,
        _watcher: watcher,
    })
}

/// Adds what `event` says changed to `burst`, and answers whether it said
/// anything worth telling.
fn gather(burst: &mut Burst, spellings: &[PathBuf], event: notify::Result<Event>) -> bool {
    let event = match event {
        Ok(event) => event,
        // The handle lost, or the root itself deleted: told as
        // "everything", and the client asks again with its roots.
        Err(_) => {
            burst.overflow = true;
            return true;
        }
    };
    if matches!(event.kind, EventKind::Access(_)) {
        return false;
    }
    // Events the OS dropped, or one that names nothing: anything may have
    // changed.
    let mut counted = event.need_rescan() || event.paths.is_empty();
    if counted {
        burst.overflow = true;
    }
    for path in &event.paths {
        match below(spellings, path) {
            Some(rel) => {
                if let Some(rel) = reported(rel) {
                    burst.pending.insert(rel);
                    counted = true;
                }
            }
            None => {
                burst.overflow = true;
                counted = true;
            }
        }
    }
    if burst.pending.len() > BURST_MAX {
        burst.overflow = true;
    }
    counted
}

/// `path` relative to whichever spelling of the root it is under,
/// forward-slashed; empty for the root itself; `None` when it is under none.
fn below(spellings: &[PathBuf], path: &Path) -> Option<String> {
    spellings.iter().find_map(|root| {
        let mut parts = path.components();
        let under = root.components().all(|part| {
            parts.next().is_some_and(|other| {
                part.as_os_str().to_string_lossy().to_lowercase()
                    == other.as_os_str().to_string_lossy().to_lowercase()
            })
        });
        under.then(|| {
            parts
                .filter_map(|part| match part {
                    Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("/")
        })
    })
}

/// What a changed root-relative path is told as: itself, `.git` for the
/// repository's index, `HEAD` or refs, or nothing for the root itself and
/// anything else under `.git`.
pub fn reported(rel: String) -> Option<String> {
    if rel.is_empty() {
        return None;
    }
    if rel == ".git" || rel.starts_with(".git/") {
        let meaningful = rel.starts_with(".git/index")
            || rel.starts_with(".git/HEAD")
            || rel.starts_with(".git/refs/");
        return meaningful.then(|| ".git".to_owned());
    }
    Some(rel)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::TestDirs;

    #[test]
    fn only_the_index_head_and_refs_count_under_git_and_as_git() {
        assert_eq!(reported("src/a.ts".into()), Some("src/a.ts".into()));
        assert_eq!(reported(".git/index".into()), Some(".git".into()));
        assert_eq!(reported(".git/HEAD".into()), Some(".git".into()));
        assert_eq!(reported(".git/refs/heads/main".into()), Some(".git".into()));
        assert_eq!(reported(".git/objects/ab/cdef".into()), None);
        assert_eq!(reported(".git/logs/HEAD".into()), None);
        assert_eq!(reported(".git".into()), None);
        assert_eq!(reported(String::new()), None);
        assert_eq!(
            reported(".github/x.yml".into()),
            Some(".github/x.yml".into())
        );
    }

    #[test]
    fn a_path_is_told_relative_to_the_root_however_the_os_spells_the_root() {
        let dirs = TestDirs::new();
        let root = dirs.folder("watched root");
        let spellings = vec![root.clone()];
        assert_eq!(
            below(&spellings, &root.join("src").join("a b.ts")).as_deref(),
            Some("src/a b.ts")
        );
        assert_eq!(below(&spellings, &root).as_deref(), Some(""));
        assert_eq!(below(&spellings, &dirs.folder("elsewhere").join("x")), None);
    }

    fn modified(paths: Vec<PathBuf>) -> notify::Result<Event> {
        let mut event = Event::new(EventKind::Modify(notify::event::ModifyKind::Any));
        event.paths = paths;
        Ok(event)
    }

    #[test]
    fn a_burst_past_a_thousand_paths_is_told_as_everything_and_git_churn_says_nothing() {
        let root = PathBuf::from("/watched root");
        let spellings = vec![root.clone()];
        let mut burst = Burst::default();

        let churn = modified(vec![root.join(".git").join("objects").join("ab")]);
        assert!(
            !gather(&mut burst, &spellings, churn),
            "git's churn is not worth telling"
        );
        let read = Event::new(EventKind::Access(notify::event::AccessKind::Any));
        assert!(
            !gather(&mut burst, &spellings, Ok(read)),
            "a read changes nothing"
        );
        assert!(burst.pending.is_empty() && !burst.overflow);

        let paths = (0..BURST_MAX).map(|n| root.join(format!("f{n}"))).collect();
        assert!(gather(&mut burst, &spellings, modified(paths)));
        assert_eq!(burst.pending.len(), BURST_MAX);
        assert!(!burst.overflow, "a thousand paths are still named");
        assert!(gather(
            &mut burst,
            &spellings,
            modified(vec![root.join("one more")])
        ));
        assert!(burst.overflow, "past a thousand, everything");
    }

    #[test]
    fn a_change_outside_every_spelling_of_the_root_or_an_error_is_told_as_everything() {
        let root = PathBuf::from("/watched root");
        let mut burst = Burst::default();
        assert!(gather(
            &mut burst,
            std::slice::from_ref(&root),
            modified(vec![PathBuf::from("/elsewhere/x")])
        ));
        assert!(burst.overflow);
        let mut burst = Burst::default();
        assert!(gather(
            &mut burst,
            &[root],
            Err(notify::Error::generic("lost"))
        ));
        assert!(burst.overflow);
    }

    #[test]
    fn a_client_watches_the_roots_it_names_and_leaves_none_when_it_goes() {
        let dirs = TestDirs::new();
        let one = dirs.folder("one");
        let two = dirs.folder("two");
        let watches = FileWatches::new(Arc::new(|_, _, _| {}));
        let root = |path: &Path, key: &str| WatchedRoot {
            root: path.to_path_buf(),
            key: key.to_owned(),
        };
        let client = ClientId(1);
        let other = ClientId(2);
        watches.set(client, vec![root(&one, "one"), root(&two, "two")]);
        watches.set(other, vec![root(&one, "one")]);
        assert_eq!(watches.watching(client), vec!["one", "two"]);
        watches.set(client, vec![root(&two, "two")]);
        assert_eq!(watches.watching(client), vec!["two"], "one is let go");
        assert_eq!(
            watches.watching(other),
            vec!["one"],
            "another client's watch stays"
        );
        watches.set(client, vec![root(&dirs.root().join("not there"), "gone")]);
        assert!(
            watches.watching(client).is_empty(),
            "a root that cannot be watched is skipped"
        );
        watches.set(client, vec![root(&two, "two")]);
        watches.forget(client);
        assert!(watches.watching(client).is_empty());
        watches.forget(other);
        assert!(watches.watching(other).is_empty());
    }
}
