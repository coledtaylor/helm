//! The Files view: a project's tree with git's letters on it, one file read
//! for viewing, every file for a quick-open list, and a watch that keeps all
//! of that current while a session changes the files under it.
//!
//! **Read-only.** Nothing here writes a file.
//!
//! **Scoped.** Every call names a root, and a root has to be a folder the
//! host knows ([`KnownRoots`]) before anything under it is listed, read or
//! watched. A root the host does not know is refused with a sentence naming
//! it; one named in a watch request is skipped, since the client asks again
//! with its current roots every time they change.

pub mod changes;
pub mod dir;
pub mod git;
pub mod listing;
pub mod paths;
pub mod status;
pub mod view;
pub mod watch;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use floti_protocol::channels::workspace::{
    ContentDirListing, FileListing, FileView, FilesChange, FilesStatus,
};

use self::watch::{FileWatches, WatchedRoot};
use crate::session::ClientId;
use crate::workspace::roots::{KnownRoot, KnownRoots, key};

/// How long a project's file list is reused, unless a watch says it moved.
pub const LIST_TTL: Duration = Duration::from_secs(30);

type Lists = Mutex<HashMap<String, (FileListing, Instant)>>;

/// The Files view's requests, over the folders the host knows.
pub struct FilesService {
    roots: Arc<KnownRoots>,
    lists: Arc<Lists>,
    watches: FileWatches,
}

impl FilesService {
    /// `tell` delivers a change under a watched root to the one client
    /// watching it.
    pub fn new(
        roots: Arc<KnownRoots>,
        tell: impl Fn(ClientId, &FilesChange) + Send + Sync + 'static,
    ) -> Self {
        let lists: Arc<Lists> = Arc::default();
        let stale = Arc::clone(&lists);
        let watches = FileWatches::new(Arc::new(move |client, key: &str, change: &FilesChange| {
            // A file appeared, went or was renamed, as far as an event can
            // tell, so the quick-open list is rebuilt on its next ask.
            lock(&stale).remove(key);
            tell(client, change);
        }));
        Self {
            roots,
            lists,
            watches,
        }
    }

    fn known(&self, root: &str) -> Result<KnownRoot, String> {
        self.roots.known(root)
    }

    /// One folder of the tree under `root`.
    pub fn dir(&self, root: &str, rel_path: &str) -> Result<ContentDirListing, String> {
        let root = self.known(root)?;
        Ok(dir::read_content_dir(&root.path, rel_path))
    }

    /// Every changed path under `root`.
    pub fn status(&self, root: &str) -> Result<FilesStatus, String> {
        let root = self.known(root)?;
        Ok(status::read_files_status(&root.path))
    }

    /// `path`, which must be inside `root`, read for the view.
    pub fn read(&self, root: &str, path: &str) -> Result<FileView, String> {
        let root = self.known(root)?;
        Ok(view::read_file_view(&root.path, Path::new(path)))
    }

    /// Every file in `root`, reused for [`LIST_TTL`] unless a watch says it
    /// moved.
    pub fn list(&self, root: &str) -> Result<FileListing, String> {
        let root = self.known(root)?;
        let key = key(&root.path);
        if let Some((listing, at)) = lock(&self.lists).get(&key)
            && at.elapsed() < LIST_TTL
        {
            return Ok(listing.clone());
        }
        let listing = listing::list_project_files(&root.path);
        lock(&self.lists).insert(key, (listing.clone(), Instant::now()));
        Ok(listing)
    }

    /// `client` has `roots` on screen, all of them: each it names that the
    /// host knows is watched, and any other it watched is let go.
    pub fn watch(&self, client: ClientId, roots: &[String]) {
        let wanted = roots
            .iter()
            .filter_map(|root| self.known(root).ok())
            .map(|root| WatchedRoot {
                key: key(&root.path),
                root: root.path,
            })
            .collect();
        self.watches.set(client, wanted);
    }

    /// `client` is gone, and its watches with it.
    pub fn forget(&self, client: ClientId) {
        self.watches.forget(client);
    }

    /// The keys of the roots `client` watches.
    pub fn watching(&self, client: ClientId) -> Vec<String> {
        self.watches.watching(client)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
