//! Every file in a project, for a quick-open list.
//!
//! The repository's own answer where there is one: `git ls-files` lists the
//! tracked files and the untracked ones git does not ignore, which is the
//! set a person means by "a file in this project", relative to the project
//! folder and limited to it, because `ls-files` answers for the folder it
//! runs in.
//!
//! Where there is no repository, or no git, a walk takes over with the
//! tree's list of folders not to enter, and a ceiling. A list that stopped
//! says so (`truncated`) rather than passing for the whole project.

use std::collections::{HashSet, VecDeque};
use std::path::Path;

use floti_protocol::channels::workspace::{FileListSource, FileListing};

use super::dir::is_fallback_skipped;
use super::git::{GIT_TIMEOUT, repo_root_of, run_git};
use crate::platform::links::is_link;

/// Past this many files the walk stops, and says so.
pub const FILE_LIST_MAX: usize = 50_000;

pub fn list_project_files(project: &Path) -> FileListing {
    if repo_root_of(project).is_none() {
        return walk(project, FILE_LIST_MAX);
    }
    match run_git(
        project,
        &[
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
        None,
        GIT_TIMEOUT,
    ) {
        Ok(stdout) => {
            let mut seen = HashSet::new();
            let files = stdout
                .split('\0')
                .filter(|path| !path.is_empty() && seen.insert(*path))
                .map(str::to_owned)
                .collect();
            FileListing {
                root: project.display().to_string(),
                files,
                source: FileListSource::Git,
                truncated: false,
                error: None,
            }
        }
        // A repository git could not list (a corrupt index, a timeout) is
        // still a folder that can be walked; the error rides along so the
        // list can say why it is the walk's.
        Err(failure) => FileListing {
            error: Some(failure.sentence()),
            ..walk(project, FILE_LIST_MAX)
        },
    }
}

/// Breadth-first, so a ceiling cuts off the deepest files rather than a
/// whole top-level folder. Links and junctions are listed as files and
/// never entered: an overlay's junction points into another repository, and
/// one pointing at an ancestor would never end.
fn walk(project: &Path, ceiling: usize) -> FileListing {
    let mut files = Vec::new();
    let mut queue: VecDeque<String> = VecDeque::from([String::new()]);
    let mut truncated = false;

    'walk: while let Some(rel) = queue.pop_front() {
        let folder = if rel.is_empty() {
            project.to_path_buf()
        } else {
            rel.split('/')
                .fold(project.to_path_buf(), |path, part| path.join(part))
        };
        // Unreadable: a permissions wall or a folder deleted mid-walk. The
        // rest of the project is still worth listing.
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let link = kind.is_symlink() || is_link(&entry.path());
            if kind.is_dir() && !link {
                let lower = name.to_lowercase();
                if lower != ".git" && !is_fallback_skipped(&lower) {
                    queue.push_back(path);
                }
                continue;
            }
            if !kind.is_file() && !link {
                continue;
            }
            if files.len() >= ceiling {
                truncated = true;
                break 'walk;
            }
            files.push(path);
        }
    }
    FileListing {
        root: project.display().to_string(),
        files,
        source: FileListSource::Walk,
        truncated,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::TestDirs;

    #[test]
    fn a_walk_stops_at_its_ceiling_and_says_it_stopped() {
        assert_eq!(FILE_LIST_MAX, 50_000);
        let dirs = TestDirs::new();
        let root = dirs.folder("many files");
        std::fs::create_dir(root.join("deeper")).unwrap();
        std::fs::write(root.join("deeper").join("last"), "").unwrap();
        for n in 0..5 {
            std::fs::write(root.join(format!("f{n}")), "").unwrap();
        }
        let listing = walk(&root, 4);
        assert_eq!(listing.source, FileListSource::Walk);
        assert!(listing.truncated);
        assert_eq!(listing.files.len(), 4);
        assert!(
            listing.files.iter().all(|file| !file.contains('/')),
            "breadth-first: the top level comes before anything deeper, {:?}",
            listing.files
        );
        let whole = walk(&root, FILE_LIST_MAX);
        assert!(!whole.truncated);
        assert_eq!(whole.files.len(), 6);
    }
}
