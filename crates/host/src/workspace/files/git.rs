//! One `git` run for the Files view, with what every one of them needs.
//!
//! `--no-optional-locks` on every run: these run on file-system events while
//! a session may be committing in the same repository, and a status that
//! took the index lock to refresh its stat cache would make that commit fail
//! with "index.lock exists". Read-only is the whole contract here.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How long a status, diff or listing may take.
pub const GIT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long one `check-ignore` per folder opened may take: a user gesture,
/// where a hung one is not.
pub const CHECK_IGNORE_TIMEOUT: Duration = Duration::from_secs(5);

/// Variables that would point `git` at another repository than the one it
/// runs in.
const REDIRECTING: [&str; 4] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
];

/// Why a `git` run gave no answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitFailure {
    /// There is no `git` to run.
    Missing,
    /// It ran and exited with `code`, or never finished (`None`), saying
    /// `said`: the first line it wrote about it, or why it did not finish.
    Failed { code: Option<i32>, said: String },
}

impl GitFailure {
    /// The failure in a sentence for the screen.
    pub fn sentence(&self) -> String {
        match self {
            Self::Missing => "git is not installed, or not on the PATH".to_owned(),
            Self::Failed { said, .. } => said.clone(),
        }
    }

    /// The exit code, when git ran to an end.
    pub fn code(&self) -> Option<i32> {
        match self {
            Self::Missing => None,
            Self::Failed { code, .. } => *code,
        }
    }
}

/// Runs `git --no-optional-locks <args>` in `cwd`, writing `input` to its
/// standard input, and answers what it printed.
pub fn run_git(
    cwd: &Path,
    args: &[&str],
    input: Option<&[u8]>,
    limit: Duration,
) -> Result<String, GitFailure> {
    let mut command = Command::new("git");
    command
        .arg("--no-optional-locks")
        .args(args)
        .current_dir(cwd)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in REDIRECTING {
        command.env_remove(name);
    }
    let mut child = command.spawn().map_err(|err| match err.kind() {
        std::io::ErrorKind::NotFound => GitFailure::Missing,
        _ => GitFailure::Failed {
            code: None,
            said: format!("Floti could not run git: {err}"),
        },
    })?;
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
    if let (Some(mut stdin), Some(input)) = (child.stdin.take(), input) {
        let input = input.to_vec();
        // Written from a thread of its own, so a git that answers before it
        // has read everything cannot leave this one stuck on a full pipe.
        // A git that exits early closes the pipe, which is no failure here:
        // what it printed is still its answer.
        std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() >= limit => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(GitFailure::Failed {
                    code: None,
                    said: format!("git did not answer within {} seconds", limit.as_secs()),
                });
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(GitFailure::Failed {
                    code: None,
                    said: format!("Floti lost track of git: {err}"),
                });
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
    let said = said
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map_or_else(
            || match status.code() {
                Some(code) => format!("git exited with code {code}"),
                None => "git was stopped before it finished".to_owned(),
            },
            str::to_owned,
        );
    Err(GitFailure::Failed {
        code: status.code(),
        said,
    })
}

/// The nearest folder at or above `start` holding a `.git`, or `None`. A
/// worktree's or submodule's `.git` is a file, and counts.
pub fn repo_root_of(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(at) = dir {
        if std::fs::metadata(at.join(".git")).is_ok() {
            return Some(at.to_path_buf());
        }
        dir = at.parent();
    }
    None
}

/// A pathspec that means exactly this path.
///
/// `:(literal)` turns off glob magic, so a file named `[id].tsx` is that
/// file and not a character class; `top` anchors it at the repository root,
/// which is what the forward-slashed relative paths here are.
pub fn literal_path(repo_relative: &str) -> String {
    format!(":(top,literal){repo_relative}")
}

/// `path`'s place inside `repo`, forward-slashed; empty for the repository
/// itself.
pub fn prefix_in(repo: &Path, path: &Path) -> String {
    super::paths::relative_slashed(repo, path)
}
