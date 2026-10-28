//! A working tree's state, read by running `git`, as
//! `packages/core/src/discovery/git.ts` does: one `git status` per project
//! on a background refresh, with no git library to package.

use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use floti_protocol::channels::workspace::GitState;

/// How long one `git` run may take before it is stopped.
pub const GIT_TIMEOUT: Duration = Duration::from_secs(10);

/// How many repositories are read at once, so a root of fifty does not
/// start fifty `git` processes against one disk at the same moment.
const CONCURRENCY: usize = 8;

/// Variables that would point `git` at some other repository than the one
/// it runs in.
const REDIRECTING: [&str; 4] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
];

/// Runs `git` with `args` in `cwd` and answers what it printed, or a
/// sentence: the first line git wrote about its failure, or why it could
/// not run or finish within `limit`.
pub(crate) fn run_git(cwd: &Path, args: &[&str], limit: Duration) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in REDIRECTING {
        command.env_remove(name);
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("Floti could not run git: {err}"))?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut bytes);
            }
            bytes
        })
    };
    let stdout = drain(
        child
            .stdout
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    );
    let stderr = drain(
        child
            .stderr
            .take()
            .map(|pipe| Box::new(pipe) as Box<dyn Read + Send>),
    );
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() >= limit => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!(
                    "git did not answer within {} seconds.",
                    limit.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(format!("Floti lost track of git: {err}"));
            }
        }
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    let status = status?;
    if status.success() {
        return Ok(String::from_utf8_lossy(&stdout).into_owned());
    }
    let said = String::from_utf8_lossy(&stderr);
    Err(said
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map_or_else(
            || match status.code() {
                Some(code) => format!("git exited with code {code}."),
                None => "git was stopped before it finished.".to_owned(),
            },
            str::to_owned,
        ))
}

/// Whether `project` is a repository: `.git` is a folder in a clone and a
/// file in a worktree or submodule.
pub fn is_git_repo(project: &Path) -> bool {
    std::fs::metadata(project.join(".git")).is_ok()
}

/// `project`'s branch, ahead and behind counts and changed paths, from one
/// `git status --porcelain=v2 --branch`. `None` when it is not a
/// repository (or its folder cannot be read); a repository git could not
/// answer for has `error` set and nothing else, never a guess.
pub fn read_git_state(project: &Path) -> Option<GitState> {
    if !is_git_repo(project) {
        return None;
    }
    Some(
        match run_git(
            project,
            &[
                "--no-optional-locks",
                "status",
                "--porcelain=v2",
                "--branch",
                "--untracked-files=all",
                "--ignore-submodules=dirty",
            ],
            GIT_TIMEOUT,
        ) {
            Ok(stdout) => parse_git_status(&stdout),
            Err(error) => GitState {
                branch: None,
                detached: false,
                dirty: 0,
                ahead: 0,
                behind: 0,
                error: Some(error),
            },
        },
    )
}

/// Reads `git status --porcelain=v2 --branch` output.
pub fn parse_git_status(stdout: &str) -> GitState {
    let mut state = GitState {
        branch: None,
        detached: false,
        dirty: 0,
        ahead: 0,
        behind: 0,
        error: None,
    };
    for line in stdout.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        if let Some(head) = line.strip_prefix("# branch.head ") {
            // A detached HEAD is the literal "(detached)", which no branch
            // could otherwise be called.
            let head = head.trim();
            if head == "(detached)" {
                state.detached = true;
            } else {
                state.branch = Some(head.to_owned());
            }
            continue;
        }
        if let Some(counts) = line.strip_prefix("# branch.ab ") {
            // "+2 -1"; absent when there is no upstream.
            for part in counts.split_whitespace() {
                let Some(sign) = part.chars().next() else {
                    continue;
                };
                let Ok(count) = part[sign.len_utf8()..].parse::<u32>() else {
                    continue;
                };
                match sign {
                    '+' => state.ahead = count,
                    '-' => state.behind = count,
                    _ => {}
                }
            }
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        // One path per line: '1' changed, '2' renamed or copied, 'u'
        // unmerged, '?' untracked ('!' ignored is not asked for).
        if matches!(line.as_bytes()[0], b'1' | b'2' | b'u' | b'?') {
            state.dirty += 1;
        }
    }
    state
}

/// Reads every one of `paths`, [`CONCURRENCY`] at a time.
pub fn read_git_states(paths: &[String]) -> BTreeMap<String, Option<GitState>> {
    let next = AtomicUsize::new(0);
    let read = Mutex::new(BTreeMap::new());
    std::thread::scope(|scope| {
        for _ in 0..CONCURRENCY.min(paths.len()) {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::SeqCst);
                    let Some(path) = paths.get(index) else {
                        return;
                    };
                    let state = read_git_state(Path::new(path));
                    read.lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .insert(path.clone(), state);
                }
            });
        }
    });
    read.into_inner()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
