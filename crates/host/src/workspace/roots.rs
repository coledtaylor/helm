//! The folders the host knows: every Files and content request names one,
//! and nothing under any other folder is listed, read, watched or written.
//!
//! A folder is known while one of these holds it, read afresh on every call
//! so it is known as soon as a scan, a profile save or a session start makes
//! it so and stops being known once that goes: a harness or project the
//! discovery cache holds, a saved profile's root or overlay folder, or a
//! hosted session's working directory. Folders are compared as today's app
//! compares them, made absolute, `.` and `..` folded away, and ignoring
//! case; a folder's parent is not known because the folder is.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use floti_protocol::channels::workspace::ProjectKind;
use rusqlite::Connection;

use crate::config_console::normalize;
use crate::store::Store;
use crate::store::projects::read_cached_projects;
use crate::{Error, Result};

/// Why a folder is known.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootKind {
    /// A harness discovery found.
    Harness,
    /// A project discovery found that is not a harness.
    Project,
    /// A saved profile's root or one of its overlay folders.
    Profile,
    /// A hosted session's working directory.
    Session,
}

/// One known folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownRoot {
    /// The folder as its source spells it, made absolute and folded.
    pub path: PathBuf,
    pub kind: RootKind,
    /// The name discovery gave it, for a harness or project.
    pub name: Option<String>,
}

type SessionFolders = Box<dyn Fn() -> Vec<String> + Send + Sync>;

/// The registry of known folders.
pub struct KnownRoots {
    store: Arc<Mutex<Store>>,
    sessions: SessionFolders,
}

impl KnownRoots {
    /// Folders known from `store` (the discovery cache and the profiles) and
    /// from `sessions`, which answers every hosted session's working
    /// directory now.
    pub fn new(
        store: Arc<Mutex<Store>>,
        sessions: impl Fn() -> Vec<String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            store,
            sessions: Box::new(sessions),
        }
    }

    /// Every known folder, each once: harnesses first, then projects, then
    /// each profile's root and overlays, then the sessions' folders.
    pub fn all(&self) -> Result<Vec<KnownRoot>> {
        let mut out: Vec<KnownRoot> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut add = |path: &str, kind: RootKind, name: Option<&str>| {
            if path.trim().is_empty() {
                return;
            }
            let path = normalize(Path::new(path));
            if seen.insert(key(&path)) {
                out.push(KnownRoot {
                    path,
                    kind,
                    name: name.map(str::to_owned),
                });
            }
        };
        let (projects, profiles) = {
            let store = lock(&self.store);
            (
                read_cached_projects(store.connection())?,
                profile_folders(store.connection())?,
            )
        };
        for project in projects.iter().filter(|p| p.kind == ProjectKind::Harness) {
            add(&project.path, RootKind::Harness, Some(&project.name));
        }
        for project in projects.iter().filter(|p| p.kind != ProjectKind::Harness) {
            add(&project.path, RootKind::Project, Some(&project.name));
        }
        for folder in &profiles {
            add(folder, RootKind::Profile, None);
        }
        for folder in (self.sessions)() {
            add(&folder, RootKind::Session, None);
        }
        Ok(out)
    }

    /// The known folder `root` names, as its source spells it, or a sentence
    /// naming the folder when the host does not know it.
    pub fn known(&self, root: &str) -> std::result::Result<KnownRoot, String> {
        let wanted = key(&normalize(Path::new(root)));
        let all = self.all().map_err(|err| err.to_string())?;
        all.into_iter()
            .find(|candidate| key(&candidate.path) == wanted)
            .ok_or_else(|| refusal(root))
    }
}

/// The sentence for a folder the host does not know.
pub fn refusal(root: &str) -> String {
    format!("{root} is not a folder Floti knows, so it will not list or read it.")
}

/// How two spellings of one folder compare equal: folded, then lower-cased.
pub fn key(path: &Path) -> String {
    let text = path.display().to_string();
    let trimmed = text.trim_end_matches(['/', '\\']);
    // The root itself keeps its separator.
    let text = if trimmed.is_empty() || trimmed.ends_with(':') {
        text.as_str()
    } else {
        trimmed
    };
    text.to_lowercase()
}

/// Every folder a saved profile names: its root, then its overlays.
fn profile_folders(conn: &Connection) -> Result<Vec<String>> {
    let mut select = conn
        .prepare("SELECT root, overlays FROM profiles ORDER BY id")
        .map_err(sql)?;
    let rows = select
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(sql)?;
    let mut out = Vec::new();
    for row in rows {
        let (root, overlays) = row.map_err(sql)?;
        out.push(root);
        out.extend(
            overlays
                .and_then(|text| serde_json::from_str::<Vec<String>>(&text).ok())
                .unwrap_or_default(),
        );
    }
    Ok(out)
}

fn sql(err: rusqlite::Error) -> Error {
    Error::io("read the folders Floti knows", std::io::Error::other(err))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::sync::RwLock;

    use floti_protocol::channels::workspace::{Harness, Project};

    use super::*;
    use crate::store::projects::{EMPTY_INVENTORY, cache_projects, forget_projects};
    use crate::testkit::TestDirs;

    struct World {
        store: Arc<Mutex<Store>>,
        sessions: Arc<RwLock<Vec<String>>>,
        roots: KnownRoots,
        dirs: TestDirs,
    }

    impl World {
        fn new() -> Self {
            let dirs = TestDirs::new();
            let store = Arc::new(Mutex::new(Store::open(&dirs.data).unwrap()));
            let sessions = Arc::new(RwLock::new(Vec::new()));
            let seen = Arc::clone(&sessions);
            let roots = KnownRoots::new(Arc::clone(&store), move || seen.read().unwrap().clone());
            Self {
                store,
                sessions,
                roots,
                dirs,
            }
        }

        fn scan(&self, path: &Path, kind: ProjectKind) {
            let project = Project {
                path: path.display().to_string(),
                name: path.file_name().unwrap().to_string_lossy().into_owned(),
                kind,
                harness_path: None,
                has_claude_dir: false,
                inventory: EMPTY_INVENTORY,
                git: None,
            };
            let harnesses: Vec<Harness> = Vec::new();
            cache_projects(
                lock(&self.store).connection_mut(),
                &[project],
                &harnesses,
                "2026-10-28T10:00:00.000Z",
            )
            .unwrap();
        }

        fn save_profile(&self, root: &Path, overlays: &[&Path]) {
            let overlays: Vec<String> = overlays.iter().map(|p| p.display().to_string()).collect();
            lock(&self.store)
                .connection()
                .execute(
                    "INSERT INTO profiles (name, root, overlays) VALUES (?1, ?2, ?3)",
                    [
                        "a profile".to_owned(),
                        root.display().to_string(),
                        serde_json::to_string(&overlays).unwrap(),
                    ],
                )
                .unwrap();
        }

        fn known(&self, path: &Path) -> std::result::Result<KnownRoot, String> {
            self.roots.known(&path.display().to_string())
        }
    }

    #[test]
    fn a_folder_is_known_once_a_scan_a_profile_or_a_session_makes_it_so() {
        let world = World::new();
        let project = world.dirs.folder("projects/alpha");
        let harness = world.dirs.folder("work harness");
        let profile_root = world.dirs.folder("profile root");
        let overlay = world.dirs.folder("an overlay");
        let session = world.dirs.folder("session folder");
        for folder in [&project, &harness, &profile_root, &overlay, &session] {
            assert_eq!(
                world.known(folder),
                Err(refusal(&folder.display().to_string()))
            );
        }

        world.scan(&project, ProjectKind::Folder);
        world.scan(&harness, ProjectKind::Harness);
        world.save_profile(&profile_root, &[&overlay]);
        world
            .sessions
            .write()
            .unwrap()
            .push(session.display().to_string());

        assert_eq!(world.known(&project).unwrap().kind, RootKind::Project);
        assert_eq!(world.known(&harness).unwrap().kind, RootKind::Harness);
        assert_eq!(world.known(&profile_root).unwrap().kind, RootKind::Profile);
        assert_eq!(world.known(&overlay).unwrap().kind, RootKind::Profile);
        assert_eq!(world.known(&session).unwrap().kind, RootKind::Session);
        let kinds: Vec<RootKind> = world.roots.all().unwrap().iter().map(|r| r.kind).collect();
        assert_eq!(
            kinds,
            [
                RootKind::Harness,
                RootKind::Project,
                RootKind::Profile,
                RootKind::Profile,
                RootKind::Session
            ]
        );
    }

    #[test]
    fn a_folder_is_matched_ignoring_case_and_spelling_and_its_parent_is_not_known() {
        let world = World::new();
        let project = world.dirs.folder("projects/Alpha");
        world.scan(&project, ProjectKind::Folder);

        let spelled = format!(
            "{}{}..{}Alpha{}",
            project
                .parent()
                .unwrap()
                .join("x")
                .display()
                .to_string()
                .to_uppercase(),
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR
        );
        // Case is ignored as today's app ignores it, on every OS.
        let found = world.roots.known(&spelled).unwrap();
        assert_eq!(key(&found.path), key(&normalize(&project)));
        assert_eq!(found.name.as_deref(), Some("Alpha"));

        let parent = project.parent().unwrap();
        assert_eq!(
            world.known(parent),
            Err(refusal(&parent.display().to_string()))
        );
        let child = project.join("src");
        assert!(
            world.known(&child).is_err(),
            "a folder inside a known one is not a root"
        );
    }

    #[test]
    fn a_folder_stops_being_known_once_what_made_it_known_goes() {
        let world = World::new();
        let project = world.dirs.folder("projects/beta");
        let session = world.dirs.folder("session folder");
        world.scan(&project, ProjectKind::Repo);
        world
            .sessions
            .write()
            .unwrap()
            .push(session.display().to_string());
        assert!(world.known(&project).is_ok());
        assert!(world.known(&session).is_ok());

        forget_projects(
            lock(&world.store).connection_mut(),
            &[project.display().to_string()],
        )
        .unwrap();
        world.sessions.write().unwrap().clear();
        assert!(world.known(&project).is_err());
        assert!(world.known(&session).is_err());
    }

    #[test]
    fn a_folder_two_sources_name_is_listed_once_under_the_first() {
        let world = World::new();
        let project = world.dirs.folder("shared");
        world.scan(&project, ProjectKind::Folder);
        world.save_profile(&project, &[]);
        world
            .sessions
            .write()
            .unwrap()
            .push(project.display().to_string().to_uppercase());
        let all = world.roots.all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].kind, RootKind::Project);
    }
}
