//! An ordinary file tree over a root, read one folder at a time.
//!
//! **Lazy.** No depth or file ceiling: a folder costs one read at the moment
//! it is opened, so the cost is bounded by what the reader opened rather
//! than by what the repository holds.
//!
//! **Ignored paths are shown.** `node_modules/` and `dist/` are listed,
//! marked ignored rather than hidden, and not descended.
//!
//! **The repository decides what is ignored.** `git check-ignore` is asked,
//! so nested `.gitignore` files, `.git/info/exclude` and negations are
//! exactly right. Where there is no git (no repository, or no `git` to run)
//! the built-in list takes over and the listing says which answered.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering as Atomic};
use std::time::Instant;

use floti_protocol::channels::workspace::{
    ContentDirEntry, ContentDirListing, ContentIgnoreReason, Millis,
};

use super::git::{CHECK_IGNORE_TIMEOUT, GitFailure, repo_root_of, run_git};
use super::paths::{escapes, escapes_after_links, relative_slashed};
use crate::config_console::{mtime_ms, normalize};
use crate::platform::links::is_link;
use crate::workspace::content::kinds::{content_extension, content_file_kind};
use crate::workspace::content::tree::CURATED_SKIPPED_DIRS;

/// Whether the built-in list skips a folder named `lower`: the curated
/// view's list without `repos/`, because a tree's promise is every file,
/// lazily, and a harness keeps its actual work in `repos/`.
pub fn is_fallback_skipped(lower: &str) -> bool {
    lower != "repos" && CURATED_SKIPPED_DIRS.contains(&lower)
}

/// Always ignored and never descended: the repository's own database, which
/// no `.gitignore` names.
const ALWAYS_IGNORED: &str = ".git";

/// Whether `git` can be run at all: unknown, yes or no. A machine without
/// git learns it once rather than paying a failed start per folder opened.
static GIT_USABLE: AtomicU8 = AtomicU8::new(UNKNOWN);
const UNKNOWN: u8 = 0;
const USABLE: u8 = 1;
const MISSING: u8 = 2;

struct Listed {
    name: String,
    directory: bool,
    link: bool,
}

/// The names among `entries` this repository ignores, or `None` when git
/// could not say.
///
/// Folders are passed with a trailing slash, because a `build/` pattern is
/// folder-only and `check-ignore` decides that from the string it is given.
/// Index-aware, as git is by default: a tracked file that matches an ignore
/// rule is not ignored by that repository.
fn git_ignored_names(dir: &Path, entries: &[Listed]) -> Option<HashSet<String>> {
    if entries.is_empty() {
        return Some(HashSet::new());
    }
    if GIT_USABLE.load(Atomic::Relaxed) == MISSING {
        return None;
    }
    // NUL-separated in as well as out, so a name with a newline in it cannot
    // be read as two paths.
    let probe = entries
        .iter()
        .map(|entry| {
            if entry.directory {
                format!("{}/", entry.name)
            } else {
                entry.name.clone()
            }
        })
        .collect::<Vec<_>>()
        .join("\0");
    let answer = run_git(
        dir,
        &["check-ignore", "--stdin", "-z"],
        Some(probe.as_bytes()),
        CHECK_IGNORE_TIMEOUT,
    );
    let names = |stdout: &str| {
        stdout
            .split('\0')
            .filter(|line| !line.is_empty())
            .map(|line| line.strip_suffix('/').unwrap_or(line).to_owned())
            .collect()
    };
    // Exit 1 is "none of these are ignored", an answer rather than a
    // failure. Anything else is the built-in list's cue.
    match answer {
        Ok(stdout) => {
            GIT_USABLE.store(USABLE, Atomic::Relaxed);
            Some(names(&stdout))
        }
        Err(failure) if failure.code() == Some(1) => {
            GIT_USABLE.store(USABLE, Atomic::Relaxed);
            Some(HashSet::new())
        }
        Err(GitFailure::Missing) => {
            GIT_USABLE.store(MISSING, Atomic::Relaxed);
            None
        }
        Err(_) => None,
    }
}

/// The run of digits or of anything else at the start of `text`.
fn chunk(text: &str) -> (&str, &str) {
    let digits = text.starts_with(|c: char| c.is_ascii_digit());
    let end = text
        .find(|c: char| c.is_ascii_digit() != digits)
        .unwrap_or(text.len());
    text.split_at(end)
}

/// Names in the order a file tree lists them: ignoring case, and numbers by
/// their value, so `file2` comes before `file10`.
pub fn natural_order(a: &str, b: &str) -> Ordering {
    let (mut left, mut right) = (a, b);
    while !left.is_empty() && !right.is_empty() {
        let (l, rest_l) = chunk(left);
        let (r, rest_r) = chunk(right);
        let numeric = l.starts_with(|c: char| c.is_ascii_digit())
            && r.starts_with(|c: char| c.is_ascii_digit());
        let order = if numeric {
            let l = l.trim_start_matches('0');
            let r = r.trim_start_matches('0');
            l.len().cmp(&r.len()).then_with(|| l.cmp(r))
        } else {
            l.to_lowercase().cmp(&r.to_lowercase())
        };
        if order != Ordering::Equal {
            return order;
        }
        left = rest_l;
        right = rest_r;
    }
    left.len().cmp(&right.len()).then_with(|| a.cmp(b))
}

fn elapsed(started: Instant) -> Millis {
    Millis(started.elapsed().as_secs_f64() * 1_000.0)
}

/// One folder of the tree under `scope`, listed.
///
/// `rel_path` is scope-relative and forward-slashed; empty is the scope
/// folder itself. A path that escapes the scope, as written or once its
/// links are resolved, is refused rather than clamped: a listing that
/// quietly resolved `../../..` would be a browser for the whole disk.
pub fn read_content_dir(scope: &Path, rel_path: &str) -> ContentDirListing {
    let started = Instant::now();
    let base = normalize(scope);
    let dir = if rel_path.is_empty() {
        base.clone()
    } else {
        normalize(&base.join(rel_path))
    };
    let refused = |error: String| ContentDirListing {
        scope_path: base.display().to_string(),
        rel_path: rel_path.to_owned(),
        entries: Vec::new(),
        ignored: 0,
        ignore_source: ContentIgnoreReason::Default,
        error: Some(error),
        took_ms: elapsed(started),
    };
    if escapes(&base, &dir) {
        return refused(format!("{rel_path} is outside this scope"));
    }
    // And outside it once links are resolved: an overlay shim's subfolders
    // are junctions into real repositories, and a listing reached through
    // one would report another project's files as this scope's.
    if escapes_after_links(&base, &dir) {
        return refused(format!(
            "{rel_path} is a link out of this scope, and Floti does not follow one"
        ));
    }
    let raw = match std::fs::read_dir(&dir) {
        Ok(raw) => raw,
        Err(err) => return refused(err.to_string()),
    };

    // A junction is a folder, whatever the entry's type says: it is one
    // Floti will not walk into. Following it is a metadata read, not a walk,
    // and a broken one keeps the entry's own answer.
    let listed: Vec<Listed> = raw
        .flatten()
        .filter_map(|entry| {
            let kind = entry.file_type().ok()?;
            let path = entry.path();
            let link = kind.is_symlink() || is_link(&path);
            if !kind.is_dir() && !kind.is_file() && !link {
                return None;
            }
            let directory = if link {
                std::fs::metadata(&path).map_or(kind.is_dir(), |meta| meta.is_dir())
            } else {
                kind.is_dir()
            };
            Some(Listed {
                name: entry.file_name().to_string_lossy().into_owned(),
                directory,
                link,
            })
        })
        .collect();

    let from_git = repo_root_of(&dir).and_then(|_| git_ignored_names(&dir, &listed));
    let ignore_source = if from_git.is_some() {
        ContentIgnoreReason::Gitignore
    } else {
        ContentIgnoreReason::Default
    };

    let mut ignored = 0;
    let mut entries: Vec<ContentDirEntry> = listed
        .into_iter()
        .map(|entry| {
            let path = dir.join(&entry.name);
            let lower = entry.name.to_lowercase();
            let always = lower == ALWAYS_IGNORED;
            let by_rule = always
                || match &from_git {
                    None => entry.directory && is_fallback_skipped(&lower),
                    Some(names) => names.contains(&entry.name),
                };
            // A link whose target is gone still gets a row, with no numbers.
            let (size, mtime) = std::fs::metadata(&path)
                .map_or((0, Millis(0.0)), |meta| (meta.len(), mtime_ms(&meta)));
            if by_rule {
                ignored += 1;
            }
            ContentDirEntry {
                rel_path: relative_slashed(&base, &path),
                path: path.display().to_string(),
                directory: entry.directory,
                link: entry.link,
                kind: (!entry.directory).then(|| content_file_kind(&entry.name)),
                ext: if entry.directory {
                    String::new()
                } else {
                    let ext = content_extension(&entry.name);
                    ext.strip_prefix('.').unwrap_or(&ext).to_owned()
                },
                size,
                mtime_ms: mtime,
                ignored: by_rule,
                ignored_by: by_rule.then_some(if always {
                    ContentIgnoreReason::Default
                } else {
                    ignore_source
                }),
                name: entry.name,
            }
        })
        .collect();

    // Folders first, then by name, the way every file tree orders one.
    entries.sort_by(|a, b| {
        b.directory
            .cmp(&a.directory)
            .then_with(|| natural_order(&a.name, &b.name))
    });

    ContentDirListing {
        scope_path: base.display().to_string(),
        rel_path: rel_path.to_owned(),
        entries,
        ignored,
        ignore_source,
        error: None,
        took_ms: elapsed(started),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_order_ignoring_case_and_by_the_value_of_their_numbers() {
        let mut names = vec!["file10", "File2", "b", "a", "file1"];
        names.sort_by(|a, b| natural_order(a, b));
        assert_eq!(names, vec!["a", "b", "file1", "File2", "file10"]);
    }
}
