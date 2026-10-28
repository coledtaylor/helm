//! Notes and documents in a known scope, and the note write: what
//! `content:*` serves.
//!
//! - [`kinds`]: how a file opens, decided by its name.
//! - [`tree`]: the readable files of a scope, which wikilinks resolve against
//!   and search reads.
//! - [`search`]: the full-text search over them.
//! - [`guard`]: which paths a note save may write.
//! - [`artifact`]: the addresses a sandboxed frame loads an HTML artifact
//!   from.
//!
//! Every request names a scope, and a scope is a folder the host knows
//! ([`KnownRoots`]): a harness, a project, a profile's root or overlay, or a
//! hosted session's working directory. Anything else is refused with the
//! sentence the Files view uses, and every path a request names must lie
//! inside its scope. The scopes offered are the same folders but the
//! sessions': a session's folder is reachable, not advertised.

pub mod artifact;
pub mod guard;
pub mod kinds;
pub mod search;
pub mod tree;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use floti_protocol::channels::workspace::{
    ArtifactLink, ConfigScopeKind, ConfigSnapshotMeta, ContentDocument, ContentFileKind,
    ContentScope, ContentSearchResult, RenderedMarkdown, WriteConfigRequest, WriteConfigResult,
};

use self::artifact::{ArtifactResponse, Artifacts, artifact_wikilinks};
use self::guard::{ContentGuard, rebuilt_below};
use self::search::{ContentCorpus, MAX_HITS, build_corpus, corpus_is_current, search_corpus};
use self::tree::{ContentTree, content_scope, describe_unlisted, read_content_tree};
use crate::config_console::{SnapshotWriter, normalize, read_file, snapshot_key, snapshots};
use crate::store::Store;
use crate::workspace::render::render_markdown;
use crate::workspace::render::wikilinks::{IndexedFile, WikiIndex, parse_wikilink};
use crate::workspace::roots::{self, KnownRoot, KnownRoots, RootKind};

/// How long a scope's tree is trusted before a fresh request walks it again.
const TREE_TTL: Duration = Duration::from_secs(30);

/// A scope's walk, its wikilink index, and its search corpus once a search
/// has asked for one: a scope is opened far more often than it is searched.
struct ScopeCache {
    tree: ContentTree,
    index: WikiIndex,
    corpus: Mutex<Option<Arc<ContentCorpus>>>,
    built_at: Instant,
}

/// The content of every known scope.
pub struct ContentService {
    store: Arc<Mutex<Store>>,
    roots: Arc<KnownRoots>,
    cache: Mutex<HashMap<String, Arc<ScopeCache>>>,
    artifacts: Artifacts,
}

fn scope_of(root: &KnownRoot) -> ContentScope {
    let kind = match root.kind {
        RootKind::Harness => ConfigScopeKind::Harness,
        RootKind::Project | RootKind::Profile | RootKind::Session => ConfigScopeKind::Project,
    };
    content_scope(&root.path, kind, root.name.as_deref())
}

/// `path` inside `scope`, spelled from the scope's own spelling, or the
/// sentence refusing it.
fn inside(scope: &ContentScope, path: &str) -> Result<PathBuf, String> {
    let given = Path::new(path);
    if !given.is_absolute() {
        return Err(format!(
            "{path} is not an absolute path, so Floti will not read it."
        ));
    }
    rebuilt_below(Path::new(&scope.path), given).ok_or_else(|| {
        format!(
            "{} is not inside {}, so Floti will not read it.",
            normalize(given).display(),
            scope.path
        )
    })
}

impl ContentService {
    pub fn new(store: Arc<Mutex<Store>>, roots: Arc<KnownRoots>) -> Self {
        Self {
            store,
            roots,
            cache: Mutex::new(HashMap::new()),
            artifacts: Artifacts::default(),
        }
    }

    /// Every scope a client can open: harnesses, then projects, then each
    /// profile's root and overlays. The agent's own config folder is not one:
    /// nobody keeps notes there, and walking it means walking transcripts.
    pub fn scopes(&self) -> Result<Vec<ContentScope>, String> {
        let all = self.roots.all().map_err(|err| err.to_string())?;
        Ok(all
            .iter()
            .filter(|root| root.kind != RootKind::Session)
            .map(scope_of)
            .collect())
    }

    /// The known scope `scope_path` names, or the refusal.
    fn scope(&self, scope_path: &str) -> Result<ContentScope, String> {
        self.roots.known(scope_path).map(|root| scope_of(&root))
    }

    fn cached(&self, scope: &ContentScope) -> Arc<ScopeCache> {
        let id = roots::key(Path::new(&scope.path));
        let existing = {
            let cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
            cache.get(&id).cloned()
        };
        if let Some(existing) = &existing
            && existing.built_at.elapsed() < TREE_TTL
        {
            return Arc::clone(existing);
        }

        let tree = read_content_tree(scope);
        let index = WikiIndex::build(tree.files.iter().map(|file| IndexedFile {
            path: &file.path,
            rel_path: &file.rel_path,
            slug: &file.slug,
        }));
        // A corpus still current for the new walk is kept.
        let corpus = existing.and_then(|old| {
            old.corpus
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
                .filter(|corpus| corpus_is_current(corpus, &id, &tree.files))
        });
        let entry = Arc::new(ScopeCache {
            tree,
            index,
            corpus: Mutex::new(corpus),
            built_at: Instant::now(),
        });
        self.cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, Arc::clone(&entry));
        entry
    }

    /// Drops every cached scope `path` lies in: a save changes the tree's
    /// mtimes, the corpus and perhaps what a wikilink resolves to.
    fn invalidate(&self, path: &Path) {
        let touched = roots::key(&normalize(path));
        self.cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|id, _| !touched.starts_with(id.as_str()));
    }

    /// A file, its bytes, and for markdown what it renders to.
    pub fn document(&self, scope_path: &str, path: &str) -> Result<ContentDocument, String> {
        let scope = self.scope(scope_path)?;
        let absolute = inside(&scope, path)?;
        let entry = self.cached(&scope);
        let content = read_file(&absolute);
        let wanted = absolute.display().to_string().to_lowercase();
        // Looked up once, and not walked again on a miss: a file the Files
        // view opens is usually one the walk never listed.
        let file = entry
            .tree
            .files
            .iter()
            .find(|candidate| candidate.path.to_lowercase() == wanted)
            .cloned()
            .unwrap_or_else(|| {
                describe_unlisted(
                    Path::new(&scope.path),
                    &absolute,
                    content.size,
                    content.mtime_ms,
                )
            });
        let missing = (!content.exists).then(|| "That file is not there any more.".to_owned());
        if file.kind != ContentFileKind::Markdown || content.binary || !content.exists {
            return Ok(ContentDocument {
                file,
                content,
                rendered: None,
                error: missing,
            });
        }
        let rendered = render_markdown(&content.content, Some(&entry.index), Some(&file.path));
        Ok(ContentDocument {
            file,
            content,
            rendered: Some(rendered),
            error: None,
        })
    }

    /// Renders a draft that is not on disk yet, against the scope's notes.
    pub fn render(
        &self,
        scope_path: &str,
        path: &str,
        source: &str,
    ) -> Result<RenderedMarkdown, String> {
        let scope = self.scope(scope_path)?;
        let absolute = inside(&scope, path)?;
        let entry = self.cached(&scope);
        let shown = absolute.display().to_string();
        Ok(render_markdown(source, Some(&entry.index), Some(&shown)))
    }

    pub fn search(&self, scope_path: &str, query: &str) -> Result<ContentSearchResult, String> {
        let scope = self.scope(scope_path)?;
        let entry = self.cached(&scope);
        let (corpus, cold) = {
            let mut held = entry.corpus.lock().unwrap_or_else(PoisonError::into_inner);
            match &*held {
                Some(corpus) => (Arc::clone(corpus), false),
                None => {
                    let id = roots::key(Path::new(&scope.path));
                    let built = Arc::new(build_corpus(&id, &entry.tree.files));
                    *held = Some(Arc::clone(&built));
                    (built, true)
                }
            }
        };
        Ok(search_corpus(&corpus, query, cold, MAX_HITS))
    }

    /// Saves a note through the config console's writer: snapshot first, a
    /// conflict when the file moved, and the content guard's refusals.
    pub fn write(&self, request: &WriteConfigRequest) -> Result<WriteConfigResult, String> {
        let scope = self.scope(&request.scope_path)?;
        let base = Path::new(&scope.path);
        ContentGuard::check(base, Path::new(&request.path))?;
        let absolute = rebuilt_below(base, Path::new(&request.path))
            .ok_or_else(|| format!("{} is not inside {}.", request.path, scope.path))?;
        let request = WriteConfigRequest {
            scope_path: scope.path.clone(),
            path: absolute.display().to_string(),
            ..request.clone()
        };
        let result = {
            let store = self.store.lock().unwrap_or_else(PoisonError::into_inner);
            SnapshotWriter::new(store.connection(), &ContentGuard).write(&request)?
        };
        if result.ok && !result.unchanged {
            self.invalidate(&absolute);
        }
        Ok(result)
    }

    /// One note's versions, newest first.
    pub fn snapshots(
        &self,
        scope_path: &str,
        path: &str,
    ) -> Result<Vec<ConfigSnapshotMeta>, String> {
        let scope = self.scope(scope_path)?;
        let absolute = inside(&scope, path)?;
        let base = Path::new(&scope.path);
        let store = self.store.lock().unwrap_or_else(PoisonError::into_inner);
        snapshots::list(
            store.connection(),
            &normalize(base).display().to_string(),
            &snapshot_key(base, &absolute),
        )
    }

    /// Puts a version back, after a snapshot of what is there now. The
    /// version's scope must still be one the host knows.
    pub fn restore(&self, id: u64, path: &str) -> Result<WriteConfigResult, String> {
        // Read and released before the scope is checked: the known roots
        // read the same store.
        let version = {
            let store = self.store.lock().unwrap_or_else(PoisonError::into_inner);
            snapshots::read(store.connection(), id)?
        };
        let target = match version {
            Some(snapshot) => {
                let scope = self.scope(&snapshot.meta.scope_path)?;
                let base = Path::new(&scope.path);
                ContentGuard::check(base, Path::new(path))?;
                rebuilt_below(base, Path::new(path))
                    .ok_or_else(|| format!("{path} is not inside {}.", scope.path))?
            }
            // The writer answers a version that is gone.
            None => PathBuf::from(path),
        };
        let result = {
            let store = self.store.lock().unwrap_or_else(PoisonError::into_inner);
            SnapshotWriter::new(store.connection(), &ContentGuard).restore(id, &target)?
        };
        if result.ok && !result.unchanged {
            self.invalidate(&target);
        }
        Ok(result)
    }

    /// Mints the address a sandboxed frame loads `path` from, pinned to its
    /// folder, with the wikilinks it carries resolved against the scope.
    pub fn artifact(&self, scope_path: &str, path: &str) -> Result<ArtifactLink, String> {
        let scope = self.scope(scope_path)?;
        let absolute = inside(&scope, path)?;
        if !absolute.is_file() {
            return Err(format!(
                "{} is not a file Floti can open.",
                absolute.display()
            ));
        }
        let entry = self.cached(&scope);
        let links = artifact_wikilinks(&entry.index, &absolute);
        Ok(self.artifacts.mint(&absolute, links))
    }

    /// What an artifact address answers. A frame's loads reach the host
    /// through the client, which hands each address here.
    pub fn serve_artifact(&self, url: &str) -> ArtifactResponse {
        self.artifacts.serve(url)
    }

    /// The file a `[[wikilink]]` an artifact's frame clicked names, preferring
    /// one beside the artifact.
    pub fn wikilink(
        &self,
        scope_path: &str,
        target: &str,
        from: &str,
    ) -> Result<Option<String>, String> {
        let scope = self.scope(scope_path)?;
        let from = inside(&scope, from)?;
        let entry = self.cached(&scope);
        let from = from.display().to_string();
        Ok(entry
            .index
            .resolve(&parse_wikilink(target, false), Some(&from)))
    }
}
