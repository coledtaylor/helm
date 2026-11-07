//! Where a child may run, and under which profile.
//!
//! A child runs only in a folder Floti tracks: inside a scanned project, a
//! harness, or a saved profile's folder. It is judged on where the folder
//! leads, with junctions, symlinks and `..` resolved the way the disk
//! resolves them, and with case ignored where the OS ignores it. A session's
//! own working directory does not make a folder tracked, so a session
//! cannot widen what the agents it starts may reach by being started
//! somewhere else.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use floti_protocol::channels::sessions::Profile;

use super::rows;
use crate::config_console::normalize;
use crate::store::Store;
use crate::workspace::files::paths::{real_path, resolves_inside};
use crate::workspace::roots::KnownRoots;

/// The folder a child runs in: `asked` (relative to the starting session's
/// folder `base` when it is not absolute), or `base` itself when nothing is
/// asked. A sentence when it is not tracked or is not a folder.
pub(super) fn child_folder(
    store: &Arc<Mutex<Store>>,
    base: &Path,
    asked: Option<&str>,
) -> Result<PathBuf, String> {
    let wanted = match asked {
        Some(asked) => {
            let asked = Path::new(asked);
            if asked.is_absolute() {
                asked.to_path_buf()
            } else {
                base.join(asked)
            }
        }
        None => base.to_path_buf(),
    };
    let tracked = KnownRoots::new(Arc::clone(store), Vec::new)
        .tracked()
        .map_err(|err| err.to_string())?;
    if !tracked
        .iter()
        .any(|root| resolves_inside(&root.path, &wanted))
    {
        return Err(format!(
            "{} is not a folder Floti tracks, so no agent starts there. Agents run only inside a project, a harness or a profile's folder.",
            wanted.display()
        ));
    }
    if !wanted.is_dir() {
        return Err(format!(
            "{} is not a folder on this Floti host.",
            wanted.display()
        ));
    }
    Ok(normalize(&wanted))
}

/// The profile named `name`, ignoring case.
pub(super) fn profile_named(profiles: &[Profile], name: &str) -> Result<Profile, String> {
    profiles
        .iter()
        .find(|profile| profile.name.eq_ignore_ascii_case(name.trim()))
        .cloned()
        .ok_or_else(|| {
            let names: Vec<&str> = profiles
                .iter()
                .map(|profile| profile.name.as_str())
                .collect();
            if names.is_empty() {
                format!("There is no profile named {name}: Floti has no profiles.")
            } else {
                format!(
                    "There is no profile named {name}. The profiles are: {}.",
                    names.join(", ")
                )
            }
        })
}

/// The profile whose folder holds `folder`: the one whose root is nearest to
/// it, else the one with a nearest overlay folder holding it. The oldest wins
/// a tie.
pub(super) fn profile_holding(store: &Store, folder: &Path) -> crate::Result<Option<Profile>> {
    let profiles = rows::profiles(store)?;
    let nearest = |folders: &dyn Fn(&Profile) -> Vec<String>| -> Option<Profile> {
        profiles
            .iter()
            .filter_map(|profile| {
                folders(profile)
                    .iter()
                    .filter(|candidate| !candidate.trim().is_empty())
                    .filter(|candidate| resolves_inside(Path::new(candidate), folder))
                    .map(|candidate| real_path(Path::new(candidate)).components().count())
                    .max()
                    .map(|depth| (depth, profile))
            })
            // The deepest folder wins; among equals the first, which is the oldest.
            .fold(
                None::<(usize, &Profile)>,
                |best, (depth, profile)| match best {
                    Some((held, _)) if held >= depth => best,
                    _ => Some((depth, profile)),
                },
            )
            .map(|(_, profile)| profile.clone())
    };
    Ok(nearest(&|profile| vec![profile.root.clone()])
        .or_else(|| nearest(&|profile| profile.overlays.clone())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{TestDirs, link_folder};

    fn profile(id: u64, name: &str, root: &Path) -> Profile {
        Profile {
            id,
            name: name.to_owned(),
            root: root.display().to_string(),
            overlays: Vec::new(),
            access: Vec::new(),
            model: None,
            effort: None,
            permission_mode: None,
            agent: None,
            mcp: Vec::new(),
            opening_prompt: None,
            pinned_order: None,
            created_at: String::new(),
            updated_at: String::new(),
            session_agents: None,
            remote_control: None,
        }
    }

    fn store_with(dirs: &TestDirs, profiles: &[Profile]) -> Arc<Mutex<Store>> {
        let store = Store::open(&dirs.data).expect("open the store");
        for profile in profiles {
            store
                .connection()
                .execute(
                    "INSERT INTO profiles (id, name, root, overlays) VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![
                        i64::try_from(profile.id).unwrap(),
                        profile.name,
                        profile.root,
                        serde_json::to_string(&profile.overlays).unwrap()
                    ],
                )
                .expect("save a profile");
        }
        Arc::new(Mutex::new(store))
    }

    #[test]
    fn a_folder_inside_a_profiles_folder_is_tracked_and_one_outside_every_folder_is_not() {
        let dirs = TestDirs::new();
        let root = dirs.folder("harness");
        let inside = dirs.folder("harness/repos/acme");
        let outside = dirs.folder("elsewhere");
        let store = store_with(&dirs, &[profile(1, "Acme", &root)]);
        assert_eq!(
            child_folder(&store, &inside, None).unwrap(),
            normalize(&inside)
        );
        assert_eq!(
            child_folder(&store, &root, Some("repos/acme")).unwrap(),
            normalize(&inside)
        );
        let refused = child_folder(&store, &outside, None).expect_err("untracked");
        assert!(refused.contains("not a folder Floti tracks"), "{refused}");
        assert!(child_folder(&store, &root, Some("..")).is_err());
        assert!(child_folder(&store, &root, Some("not made")).is_err());
    }

    #[test]
    fn a_link_out_of_a_tracked_folder_is_untracked_however_it_is_spelled() {
        let dirs = TestDirs::new();
        let root = dirs.folder("harness");
        let outside = dirs.folder("elsewhere");
        link_folder(&outside, &root.join("escape"));
        let store = store_with(&dirs, &[profile(1, "Acme", &root)]);
        for asked in ["escape", "escape/../elsewhere", "./escape/."] {
            assert!(
                child_folder(&store, &root, Some(asked)).is_err(),
                "{asked} leads outside"
            );
        }
        crate::platform::links::remove_tree(&crate::platform::links::Native, &root).unwrap();
    }

    #[test]
    fn the_profile_is_the_one_whose_nearest_folder_holds_the_folder() {
        let dirs = TestDirs::new();
        let outer = dirs.folder("harness");
        let inner = dirs.folder("harness/repos/acme");
        let store = store_with(
            &dirs,
            &[profile(1, "Outer", &outer), profile(2, "Inner", &inner)],
        );
        let guard = store.lock().unwrap();
        let held = |folder: &Path| {
            profile_holding(&guard, folder)
                .unwrap()
                .map(|profile| profile.name)
        };
        assert_eq!(held(&inner.join("src")).as_deref(), Some("Inner"));
        assert_eq!(held(&outer.join("notes")).as_deref(), Some("Outer"));
        assert_eq!(held(&dirs.folder("elsewhere")), None);
    }

    #[test]
    fn a_profile_is_found_by_name_ignoring_case() {
        let dirs = TestDirs::new();
        let one = profile(1, "Acme cloud sync", &dirs.folder("a"));
        let found = profile_named(std::slice::from_ref(&one), "acme CLOUD sync").unwrap();
        assert_eq!(found.id, 1);
        let missing = profile_named(&[one], "Other").expect_err("no such profile");
        assert!(missing.contains("Acme cloud sync"), "{missing}");
    }
}
