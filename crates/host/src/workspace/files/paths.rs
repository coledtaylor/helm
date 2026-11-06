//! Where a path is, relative to a root: before links are resolved and after.

use std::path::{Component, Path, PathBuf};

use crate::config_console::normalize;

/// One component as compared when a path is spelled the way a client typed
/// it: ignoring case, as the known-roots check does.
fn folded(part: Component<'_>) -> String {
    part.as_os_str().to_string_lossy().to_lowercase()
}

/// `target` relative to `base`, forward-slashed, the way Node's
/// `path.relative` answers on the host's paths: `..` for each folder of
/// `base` that `target` is not under, then the rest of `target`. Empty when
/// they are the same folder.
pub fn relative_slashed(base: &Path, target: &Path) -> String {
    let base = normalize(base);
    let target = normalize(target);
    let base: Vec<Component<'_>> = base.components().collect();
    let target: Vec<Component<'_>> = target.components().collect();
    let shared = base
        .iter()
        .zip(&target)
        .take_while(|(a, b)| folded(**a) == folded(**b))
        .count();
    if shared == 0 && !base.is_empty() && !target.is_empty() {
        // Another drive: there is no relative path, only the target.
        return target
            .iter()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
    }
    let mut parts: Vec<String> =
        std::iter::repeat_n("..".to_owned(), base.len() - shared).collect();
    parts.extend(
        target[shared..]
            .iter()
            .map(|part| part.as_os_str().to_string_lossy().into_owned()),
    );
    parts.join("/")
}

/// Whether `target`'s components start with all of `base`'s.
fn starts_with(base: &Path, target: &Path, ignore_case: bool) -> bool {
    let mut target = target.components();
    base.components().all(|part| match target.next() {
        Some(other) if ignore_case => folded(part) == folded(other),
        Some(other) => part == other,
        None => false,
    })
}

/// An absolute path as the disk resolves it: every link followed and every
/// 8.3 alias spelled out. A path that does not exist (a file the session
/// deleted, a folder not made yet) resolves through its deepest ancestor that
/// does, with the rest appended as written.
///
/// Never the path as written: a root reached through a link (macOS's
/// temporary folder is under /var, which is /private/var) or a short name (a
/// Windows runner's TEMP is C:\Users\RUNNER~1) resolves, so a missing file
/// under it compared unresolved would look outside the project, and a
/// missing file behind a junction out of the project would look inside it.
pub fn real_path(path: &Path) -> PathBuf {
    let path = normalize(path);
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    let mut at = path.as_path();
    loop {
        if let Ok(real) = std::fs::canonicalize(at) {
            return rest.iter().rev().fold(real, |path, part| path.join(part));
        }
        match (at.parent(), at.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                at = parent;
            }
            _ => return path,
        }
    }
}

/// Whether `path` is inside `root`, before and after links are resolved.
///
/// Both, because a path spelled inside the project can be a junction out of
/// it (an overlay shim's subfolders are junctions into other repositories),
/// and a file view scoped to a project must not become a reader for the
/// rest of the disk. The resolved check resolves both sides, the root and
/// the path, the same way.
pub fn is_inside_root(root: &Path, path: &Path) -> bool {
    let base = normalize(root);
    let target = normalize(path);
    starts_with(&base, &target, true) && starts_with(&real_path(&base), &real_path(&target), false)
}

/// Whether `path` is inside `root` once both are resolved as the disk
/// resolves them: junctions and symlinks followed, `..` taken after the links
/// before it rather than folded away, and the case of a name ignored where
/// the disk ignores it ([`folds_case`]). `path` is judged where it leads, not
/// where it is spelled, so a link out of `root` is outside and a link into it
/// is inside. A path that does not exist resolves through its deepest
/// ancestor that does.
pub fn resolves_inside(root: &Path, path: &Path) -> bool {
    let walked = walk_dots_after_links(path);
    let reached = std::fs::canonicalize(&walked).unwrap_or_else(|_| real_path(&walked));
    let root = real_path(root);
    starts_with(&root, &reached, folds_case(&root))
}

/// Whether the disk holding `folder` reads two names that differ only in case
/// as one, which it answers by asking the disk: the deepest cased name on the
/// way to `folder`, spelled with its case swapped, opens although the folder
/// above it does not list it under that spelling. A Windows volume folds, a
/// macOS volume usually does and a Linux one usually does not; no list of
/// operating systems decides it, so a volume that differs from its OS's habit
/// is judged as it behaves. A folder that is not there is judged by the
/// deepest ancestor that is, and a path with no name that has a case is not
/// judged to fold.
fn folds_case(folder: &Path) -> bool {
    let named = folder
        .ancestors()
        .filter(|ancestor| ancestor.exists())
        .find_map(|ancestor| {
            let name = ancestor.file_name()?.to_string_lossy().into_owned();
            let swapped = swap_case(&name);
            (swapped != name).then(|| (ancestor.parent().map(Path::to_path_buf), swapped))
        });
    let Some((Some(parent), swapped)) = named else {
        return false;
    };
    if !parent.join(&swapped).exists() {
        return false;
    }
    // Opening is not enough: a disk that tells the two names apart can hold
    // both as folders of their own, and then the swapped one is another folder.
    let Ok(listing) = std::fs::read_dir(&parent) else {
        return false;
    };
    !listing
        .flatten()
        .any(|entry| entry.file_name() == std::ffi::OsStr::new(&swapped))
}

/// `text` with each lower-case letter upper-cased and each upper-case letter
/// lower-cased.
fn swap_case(text: &str) -> String {
    text.chars()
        .flat_map(|c| {
            if c.is_lowercase() {
                c.to_uppercase().collect::<Vec<_>>()
            } else if c.is_uppercase() {
                c.to_lowercase().collect::<Vec<_>>()
            } else {
                vec![c]
            }
        })
        .collect()
}

/// `path` with each `..` taken from where the walk has got to, links before
/// it followed first. Windows folds `..` away before it looks at the disk, so
/// `link\..\x` would be read as a sibling of `link` rather than as the folder
/// above where `link` leads, as it is on macOS and Linux.
fn walk_dots_after_links(path: &Path) -> PathBuf {
    let mut walked = PathBuf::new();
    for part in path.components() {
        match part {
            std::path::Component::ParentDir => {
                if let Ok(real) = std::fs::canonicalize(&walked) {
                    walked = real;
                }
                walked.pop();
            }
            std::path::Component::CurDir => {}
            other => walked.push(other.as_os_str()),
        }
    }
    walked
}

/// Whether `dir`, relative to `base` as written, climbs out of it.
pub fn escapes(base: &Path, dir: &Path) -> bool {
    !starts_with(&normalize(base), &normalize(dir), true)
}

/// Whether `dir` resolves, links followed, outside where `base` resolves.
/// A folder that cannot be resolved is compared as written.
pub fn escapes_after_links(base: &Path, dir: &Path) -> bool {
    let real = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| normalize(path));
    !starts_with(&real(base), &real(dir), false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::{TestDirs, link_folder};

    #[test]
    fn a_relative_path_climbs_for_each_folder_left_and_is_empty_for_the_same_folder() {
        let dirs = TestDirs::new();
        let root = dirs.folder("a root");
        assert_eq!(relative_slashed(&root, &root), "");
        assert_eq!(
            relative_slashed(&root, &root.join("src").join("a b.ts")),
            "src/a b.ts"
        );
        assert_eq!(
            relative_slashed(&root.join("src"), &root.join("docs")),
            "../docs"
        );
    }

    #[test]
    fn a_path_inside_is_inside_and_one_out_through_a_link_or_dots_is_not() {
        let dirs = TestDirs::new();
        let root = dirs.folder("project");
        let outside = dirs.folder("outside");
        link_folder(&outside, &root.join("escape"));
        assert!(is_inside_root(&root, &root.join("a").join("b.txt")));
        assert!(is_inside_root(&root, &root));
        assert!(!is_inside_root(&root, &root.join("..").join("x")));
        assert!(!is_inside_root(
            &root,
            &root.join("escape").join("gone.txt")
        ));
        assert!(!is_inside_root(&root, &outside.join("x")));
        crate::platform::links::remove_tree(&crate::platform::links::Native, &root).unwrap();
    }

    #[test]
    fn a_path_resolves_inside_a_root_by_where_it_leads_not_how_it_is_spelled() {
        let dirs = TestDirs::new();
        let root = dirs.folder("project");
        let inside = dirs.folder("project/src");
        let outside = dirs.folder("outside");
        link_folder(&outside, &root.join("escape"));
        link_folder(&inside, &dirs.folder("elsewhere").join("shortcut"));
        assert!(resolves_inside(&root, &root));
        assert!(resolves_inside(&root, &inside));
        assert!(!resolves_inside(&root, &outside));
        // `..` is taken after the link before it, so this leads out of the
        // project although it is spelled inside it.
        assert!(!resolves_inside(
            &root,
            &root.join("escape").join("..").join("outside")
        ));
        assert!(!resolves_inside(&root, &root.join("escape")));
        assert!(!resolves_inside(&root, &root.join("..").join("outside")));
        // A link from elsewhere into the project leads inside it.
        assert!(resolves_inside(
            &root,
            &dirs.folder("elsewhere").join("shortcut")
        ));
        // A folder not made yet resolves through the ancestor that exists.
        assert!(resolves_inside(&root, &root.join("not").join("yet")));
        assert!(!resolves_inside(&root, &outside.join("not").join("yet")));
        crate::platform::links::remove_tree(&crate::platform::links::Native, &root).unwrap();
        crate::platform::links::remove_tree(
            &crate::platform::links::Native,
            &dirs.folder("elsewhere"),
        )
        .unwrap();
    }

    #[test]
    fn a_name_spelled_in_another_case_is_the_same_folder_exactly_where_the_disk_says_so() {
        let dirs = TestDirs::new();
        let root = dirs.folder("Holder/Project");
        let held = dirs.folder("Holder/Project/Src");
        let real_root = real_path(&root);
        let parent = real_root.parent().expect("a project has a parent");

        // The disk's own answer: does the other spelling open the folder?
        let other_spelling = parent.join(swap_case("Project"));
        let folds = other_spelling.exists();
        assert_eq!(folds_case(&real_root), folds);
        assert_eq!(
            resolves_inside(&root, &other_spelling.join("Src")),
            folds,
            "{} is the project's folder exactly where the disk folds case",
            other_spelling.join("Src").display()
        );
        assert!(resolves_inside(&root, &held));

        // A name that differs by more than case is another folder on any disk.
        assert!(!resolves_inside(&root, &parent.join("Projects")));
    }

    #[test]
    fn a_root_that_is_gone_is_judged_by_the_disk_that_held_it() {
        let dirs = TestDirs::new();
        let holder = dirs.folder("Holder");
        let gone = holder.join("Gone").join("Project");
        let other_holder = holder.parent().unwrap().join(swap_case("Holder"));
        let folds = other_holder.exists();

        assert_eq!(folds_case(&gone), folds);
        // Neither the root nor the path is there, so each resolves through
        // `Holder`, and the names below it compare as the disk compares them.
        assert_eq!(
            resolves_inside(&gone, &holder.join("gONE").join("pROJECT").join("x")),
            folds
        );
        assert!(resolves_inside(&gone, &gone.join("x")));
        assert!(!resolves_inside(&gone, &holder.join("Gone").join("Other")));
    }

    #[test]
    fn swapping_case_changes_only_letters_that_have_one() {
        assert_eq!(swap_case("Project 2.x"), "pROJECT 2.X");
        assert_eq!(swap_case("12 .-"), "12 .-");
        assert_eq!(swap_case("Ünï"), "üNÏ");
    }
}
