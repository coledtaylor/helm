//! What git says about every changed path under a project, for the Files
//! tree.
//!
//! One `git status --porcelain=v2 -z` per refresh, limited to the project's
//! own subtree with a `.` pathspec, so a project that is a folder inside a
//! larger repository pays for its own files and not the repository's. The
//! answer is keyed by project-relative, forward-slashed path, the key the
//! tree's listings already use.

use std::collections::BTreeMap;
use std::path::Path;

use floti_protocol::channels::workspace::{FilesStatus, GitFileState};

use super::git::{GIT_TIMEOUT, prefix_in, repo_root_of, run_git};

/// Everything after the `n`th space: porcelain v2 puts the path last, and a
/// path may hold spaces.
fn after_spaces(record: &str, n: usize) -> &str {
    let mut at = 0;
    for _ in 0..n {
        match record[at..].find(' ') {
            Some(found) => at += found + 1,
            None => return "",
        }
    }
    &record[at..]
}

/// An ordinary changed entry's state, from its two-letter XY field.
fn state_of(xy: &str) -> GitFileState {
    let mut letters = xy.chars();
    let index = letters.next().unwrap_or('.');
    let tree = letters.next().unwrap_or('.');
    if index == 'A' || tree == 'A' {
        GitFileState::Added
    } else if index == 'D' || tree == 'D' {
        GitFileState::Deleted
    } else {
        GitFileState::Modified
    }
}

/// Parses `git status --porcelain=v2 -z` into project-relative paths.
///
/// `prefix` is the project's own path inside the repository,
/// forward-slashed, empty when the project is the repository. Paths outside
/// it are dropped and the prefix is cut off the rest, compared without case,
/// because git writes the index's spelling of a path and a client may have
/// typed the project's path in another case.
///
/// A rename's record is followed by a second record holding the path it
/// came from, which is consumed rather than read as an entry of its own. An
/// untracked folder (a nested repository is the usual one) ends in `/`,
/// which is dropped so the tree can look it up by its own name.
pub fn parse_status_z(stdout: &str, prefix: &str) -> BTreeMap<String, GitFileState> {
    let mut out = BTreeMap::new();
    let lower_prefix = if prefix.is_empty() {
        String::new()
    } else {
        format!("{}/", prefix.to_lowercase())
    };
    let mut add = |path: &str, state: GitFileState| {
        let clean = path.strip_suffix('/').unwrap_or(path);
        if clean.is_empty() {
            return;
        }
        if lower_prefix.is_empty() {
            out.insert(clean.to_owned(), state);
            return;
        }
        // Lower-casing can change a string's length, so the cut is made on
        // the original at the prefix's own length in characters.
        let lowered = clean.to_lowercase();
        if !lowered.starts_with(&lower_prefix) {
            return;
        }
        let rest: String = clean.chars().skip(lower_prefix.chars().count()).collect();
        if !rest.is_empty() {
            out.insert(rest, state);
        }
    };

    let records: Vec<&str> = stdout.split('\0').collect();
    let mut i = 0;
    while i < records.len() {
        let record = records[i];
        i += 1;
        if record.is_empty() || record.starts_with('#') {
            continue;
        }
        match record.as_bytes()[0] {
            b'1' => add(
                after_spaces(record, 8),
                state_of(record.get(2..4).unwrap_or("")),
            ),
            b'2' => {
                add(after_spaces(record, 9), GitFileState::Renamed);
                i += 1;
            }
            b'u' => add(after_spaces(record, 10), GitFileState::Conflicted),
            b'?' => add(record.get(2..).unwrap_or(""), GitFileState::Untracked),
            // `!` is an ignored path, reported only when asked for and no
            // change. Anything else is a format this build does not know,
            // and guessing at it would put a wrong letter in the tree.
            _ => {}
        }
    }
    out
}

/// The status of every changed path under `project`.
///
/// Three answers, never merged: a project outside any repository has no
/// repository and nothing to report; a repository git answered for has
/// `files`; one git could not be asked about (no `git`, a corrupt index, a
/// timeout) has `files: null` and the sentence why. An empty map means
/// clean, and only that.
pub fn read_files_status(project: &Path) -> FilesStatus {
    let root = project.display().to_string();
    let Some(repo) = repo_root_of(project) else {
        return FilesStatus {
            root,
            repo: None,
            files: Some(BTreeMap::new()),
            error: None,
        };
    };
    let run = run_git(
        project,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=dirty",
            "--",
            ".",
        ],
        None,
        GIT_TIMEOUT,
    );
    match run {
        Ok(stdout) => FilesStatus {
            root,
            repo: Some(repo.display().to_string()),
            files: Some(parse_status_z(&stdout, &prefix_in(&repo, project))),
            error: None,
        },
        Err(failure) => FilesStatus {
            root,
            repo: Some(repo.display().to_string()),
            files: None,
            error: Some(failure.sentence()),
        },
    }
}
