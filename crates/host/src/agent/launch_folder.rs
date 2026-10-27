//! A launch's own folder under Floti's data folder: everything one session
//! needs on disk that is not the agent's to keep. Agent tool registration
//! (with the session's token), a settings file, composed instructions and
//! overlays all go here, never into the agent's config or a repository.
//!
//! The folder is removed when its session ends. One left by a crash is swept
//! at host start, and only when every process that owns it is provably gone:
//! a process the OS will not answer about counts as alive, and an owner that
//! cannot be read means keep. Removal unlinks the overlays' links and never
//! walks into one.

use std::path::{Path, PathBuf};

use floti_protocol::Knowable;
use serde::{Deserialize, Serialize};

use crate::platform::links;
use crate::platform::process_tree::ProcessTree;
use crate::{Error, Result};

/// The folder under the data folder that holds every launch's folder.
pub const LAUNCHES_DIR: &str = "launches";

/// The prefix on every launch folder, which is what marks one as Floti's to
/// sweep.
const PREFIX: &str = "launch-";

/// The file in a launch folder naming the processes that own it.
const OWNERS_FILE: &str = "owners.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct Owners {
    pids: Vec<u32>,
}

/// One launch's folder, made fresh for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchFolder {
    path: PathBuf,
}

impl LaunchFolder {
    /// A new, empty launch folder under `data`, owned by this process.
    pub fn create(data: &Path) -> Result<Self> {
        let parent = data.join(LAUNCHES_DIR);
        std::fs::create_dir_all(&parent)
            .map_err(|source| Error::path("create the launches folder", &parent, source))?;
        let mut suffix = [0u8; 6];
        super::fill_random(&mut suffix);
        let path = parent.join(format!(
            "{PREFIX}{}-{}",
            std::process::id(),
            super::hex(&suffix)
        ));
        std::fs::create_dir(&path)
            .map_err(|source| Error::path("create a launch folder", &path, source))?;
        let folder = Self { path };
        folder.write_owners(&Owners {
            pids: vec![std::process::id()],
        })?;
        Ok(folder)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Writes `contents` to `name` in the folder and answers its path.
    pub fn write(&self, name: &str, contents: impl AsRef<[u8]>) -> Result<PathBuf> {
        let path = self.path.join(name);
        std::fs::write(&path, contents).map_err(|source| Error::path("write", &path, source))?;
        Ok(path)
    }

    /// Records `pid`, the session's own process, as an owner too, so a
    /// session that outlives a crashed host keeps its files.
    pub fn add_owner(&self, pid: u32) -> Result<()> {
        let mut owners = read_owners(&self.path).unwrap_or_default();
        if !owners.pids.contains(&pid) {
            owners.pids.push(pid);
        }
        self.write_owners(&owners)
    }

    /// Removes the folder, unlinking its links first.
    pub fn remove(&self) -> Result<()> {
        remove_launch_folder(&self.path)
    }

    fn write_owners(&self, owners: &Owners) -> Result<()> {
        let json = serde_json::to_vec(owners).expect("owners serialise");
        self.write(OWNERS_FILE, json).map(drop)
    }
}

/// Removes the launch folder at `path`, unlinking every link in it and never
/// walking into one.
pub fn remove_launch_folder(path: &Path) -> Result<()> {
    links::remove_tree(&links::Native, path)
}

fn read_owners(folder: &Path) -> Option<Owners> {
    let bytes = std::fs::read(folder.join(OWNERS_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Removes the launch folders under `data` whose every owner is provably
/// gone, and answers what it removed. Run at host start only.
pub fn sweep_launch_folders(data: &Path, tree: &dyn ProcessTree) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(data.join(LAUNCHES_DIR)) else {
        return Vec::new();
    };
    let mut removed = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_launch = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(PREFIX));
        if !is_launch || links::is_link(&path) || !path.is_dir() {
            continue;
        }
        let Some(owners) = read_owners(&path) else {
            continue;
        };
        let all_gone = !owners.pids.is_empty()
            && owners
                .pids
                .iter()
                .all(|&pid| tree.is_alive(pid) == Knowable::Known(false));
        if all_gone && remove_launch_folder(&path).is_ok() {
            removed.push(path);
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::platform::links::{FolderLinks, Native as Links};
    use crate::testkit::TestDirs;

    /// A machine whose processes answer as the test says.
    struct Machine(BTreeMap<u32, Knowable<bool>>);

    impl ProcessTree for Machine {
        fn end_tree(&self, _: u32, _: crate::platform::process_tree::Ending) -> Result<()> {
            Ok(())
        }

        fn is_alive(&self, pid: u32) -> Knowable<bool> {
            self.0.get(&pid).cloned().unwrap_or(Knowable::Known(false))
        }
    }

    fn owned_by(data: &Path, pids: &[u32]) -> PathBuf {
        let folder = LaunchFolder::create(data).unwrap();
        folder
            .write_owners(&Owners {
                pids: pids.to_vec(),
            })
            .unwrap();
        folder.path().to_path_buf()
    }

    #[test]
    fn a_launch_folder_is_new_under_the_data_folder_and_owned_by_this_process() {
        let dirs = TestDirs::new();
        let one = LaunchFolder::create(&dirs.data).unwrap();
        let two = LaunchFolder::create(&dirs.data).unwrap();
        assert_ne!(one, two);
        assert!(one.path().starts_with(dirs.data.join(LAUNCHES_DIR)));
        assert_eq!(
            read_owners(one.path()).unwrap().pids,
            vec![std::process::id()]
        );
        one.add_owner(42).unwrap();
        assert_eq!(
            read_owners(one.path()).unwrap().pids,
            vec![std::process::id(), 42]
        );
    }

    #[test]
    fn sweeping_removes_only_folders_whose_every_owner_is_provably_gone() {
        let dirs = TestDirs::new();
        let gone = owned_by(&dirs.data, &[10, 11]);
        let one_alive = owned_by(&dirs.data, &[10, 20]);
        let denied = owned_by(&dirs.data, &[30]);
        let unknown = owned_by(&dirs.data, &[40]);
        let unreadable = owned_by(&dirs.data, &[10]);
        std::fs::write(unreadable.join(OWNERS_FILE), "not json").unwrap();
        let not_ours = dirs.data.join(LAUNCHES_DIR).join("something else");
        std::fs::create_dir_all(&not_ours).unwrap();

        // Access denied is alive by the time it reaches here: the process
        // tree's is_alive answers it so.
        let machine = Machine(BTreeMap::from([
            (20, Knowable::Known(true)),
            (30, Knowable::Known(true)),
            (40, Knowable::Unknown),
        ]));
        let removed = sweep_launch_folders(&dirs.data, &machine);

        assert_eq!(removed, vec![gone.clone()]);
        assert!(!gone.exists());
        for kept in [&one_alive, &denied, &unknown, &unreadable, &not_ours] {
            assert!(kept.exists(), "{} was kept", kept.display());
        }
    }

    #[test]
    fn sweeping_unlinks_an_overlay_and_leaves_the_repository_it_points_into() {
        let dirs = TestDirs::new();
        let skills = dirs.folder("harness/.claude/skills/think");
        std::fs::write(skills.join("SKILL.md"), "think").unwrap();
        let folder = owned_by(&dirs.data, &[10]);
        let overlay = folder.join("overlays").join("harness");
        std::fs::create_dir_all(&overlay).unwrap();
        Links
            .link_folder(skills.parent().unwrap(), &overlay.join("skills"))
            .unwrap();

        let removed = sweep_launch_folders(&dirs.data, &Machine(BTreeMap::new()));

        assert_eq!(removed, vec![folder.clone()]);
        assert!(!folder.exists());
        assert_eq!(
            std::fs::read_to_string(skills.join("SKILL.md")).unwrap(),
            "think"
        );
    }
}
