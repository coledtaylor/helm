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
}
