//! Which lines of a file differ from the last commit.
//!
//! The working tree against `HEAD`, staged and unstaged together, because
//! "what has changed in this file since it was last committed" is the
//! question somebody reading a file beside the session working on it is
//! asking, and it is the one git can answer without guessing who did it.

use std::path::Path;

use floti_protocol::channels::workspace::{FileChangeState, LineChanges};

use super::git::{GIT_TIMEOUT, literal_path, prefix_in, repo_root_of, run_git};

/// A hunk header's four numbers: `-a,b +c,d`, a missing count being 1.
fn hunk(line: &str) -> Option<(u32, u32, u32)> {
    let rest = line.strip_prefix("@@ -")?;
    let (old, rest) = rest.split_once(" +")?;
    let (new, _) = rest.split_once(" @@")?;
    let count = |range: &str| -> Option<(u32, u32)> {
        match range.split_once(',') {
            Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
            None => Some((range.parse().ok()?, 1)),
        }
    };
    let (_, old_count) = count(old)?;
    let (start, new_count) = count(new)?;
    Some((old_count, start, new_count))
}

/// Reads a zero-context diff's hunk headers into line marks on the new file.
///
/// With `-U0` every hunk is exactly one change, so the header says
/// everything: `-a,b +c,d` replaces `b` old lines with the `d` new lines
/// starting at `c`. A hunk with `d = 0` removed lines and added none, and
/// git then sets `c` to the line above the removal, which is where the
/// marker goes. A hunk that removed more than it added marks its new lines
/// as changed and the removal below the last of them.
pub fn parse_zero_context_diff(diff: &str) -> LineChanges {
    let mut lines = no_changes();
    for line in diff.split('\n') {
        let Some((old_count, start, new_count)) = hunk(line) else {
            continue;
        };
        if new_count == 0 {
            lines.removed_after.push(start);
            lines.removed_count += old_count;
            continue;
        }
        lines.changed.push((start, start + new_count - 1));
        lines.changed_count += new_count;
        if old_count > new_count {
            lines.removed_after.push(start + new_count - 1);
            lines.removed_count += old_count - new_count;
        }
    }
    lines
}

/// No line differs.
pub fn no_changes() -> LineChanges {
    LineChanges {
        changed: Vec::new(),
        removed_after: Vec::new(),
        changed_count: 0,
        removed_count: 0,
    }
}

/// How one file stands against the last commit.
///
/// A status run first, for the path alone: it tells a file that is not in
/// the last commit, or that git ignores, from one that is merely unchanged,
/// and all three would otherwise print the same empty diff. The diff runs
/// only for a file git reports as changed, so an unchanged file costs one
/// process.
pub fn read_file_changes(path: &Path) -> FileChangeState {
    let Some(repo) = repo_root_of(path) else {
        return FileChangeState::Outside;
    };
    let rel = prefix_in(&repo, path);
    let status = run_git(
        &repo,
        &[
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
            "--",
            &literal_path(&rel),
        ],
        None,
        GIT_TIMEOUT,
    );
    let stdout = match status {
        Ok(stdout) => stdout,
        Err(failure) => {
            return FileChangeState::Unknown {
                reason: failure.sentence(),
            };
        }
    };
    let records: Vec<&str> = stdout
        .split('\0')
        .filter(|record| !record.is_empty() && !record.starts_with('#'))
        .collect();
    let Some(first) = records.first() else {
        return FileChangeState::Tracked {
            lines: no_changes(),
        };
    };
    if first.starts_with('?') {
        return FileChangeState::New;
    }
    if first.starts_with('!') {
        return FileChangeState::Ignored;
    }

    let mut pathspecs = vec![literal_path(&rel)];
    if first.starts_with('1') {
        // Added to the index but never committed: there is no `HEAD` side to
        // compare against, so every line is new.
        if first.get(2..4).is_some_and(|xy| xy.contains('A')) {
            return FileChangeState::New;
        }
    } else if first.starts_with('2') {
        // A rename is seen as one only when both its paths are in the diff;
        // given the new name alone, git reports a whole new file.
        if let Some(from) = records.get(1) {
            pathspecs.push(literal_path(from));
        }
    }

    let mut args = vec![
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "-U0",
        "HEAD",
        "--",
    ];
    args.extend(pathspecs.iter().map(String::as_str));
    match run_git(&repo, &args, None, GIT_TIMEOUT) {
        Ok(diff) => FileChangeState::Tracked {
            lines: parse_zero_context_diff(&diff),
        },
        Err(failure) => FileChangeState::Unknown {
            reason: failure.sentence(),
        },
    }
}
