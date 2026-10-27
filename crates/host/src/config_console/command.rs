//! Running the agent's own CLI for the console (`mcp add-json`, `mcp
//! remove`, `mcp list`, `doctor`): an argument array, no shell, a time
//! limit, and both output streams kept.

use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::platform::launcher::{self, ProgramLauncher};

/// How to start the agent's CLI: the program, the arguments before every
/// subcommand, and the variables it needs. Each run is resolved by the OS's
/// launcher, so on Windows a batch-file install runs through `cmd.exe`
/// without any argument being re-parsed by it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCommand {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
}

/// What a run printed and how it ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutcome {
    /// Standard output, then standard error, trimmed.
    pub output: String,
    /// The exit code, or `None` when there was none to read (killed, or
    /// never started).
    pub exit_code: Option<i32>,
    /// Set when the program could not be run or was stopped for taking too
    /// long, as a sentence.
    pub failure: Option<String>,
}

impl RunOutcome {
    pub fn succeeded(&self) -> bool {
        self.failure.is_none() && self.exit_code == Some(0)
    }
}

fn drain(stream: Option<impl Read + Send + 'static>) -> Option<JoinHandle<Vec<u8>>> {
    stream.map(|mut stream| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = stream.read_to_end(&mut bytes);
            bytes
        })
    })
}

fn joined(handle: Option<JoinHandle<Vec<u8>>>) -> String {
    handle
        .and_then(|handle| handle.join().ok())
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

fn wait(child: &mut Child, limit: Duration) -> Result<Option<i32>, String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.code()),
            Ok(None) if started.elapsed() >= limit => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "It was stopped after {} seconds without finishing.",
                    limit.as_secs()
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(err) => return Err(format!("Floti lost track of it: {err}")),
        }
    }
}

/// Runs `command` with `args` after its own, in `cwd` when one is given.
pub fn run(
    command: &AgentCommand,
    args: &[&str],
    cwd: Option<&Path>,
    limit: Duration,
) -> RunOutcome {
    let all: Vec<OsString> = command
        .args
        .iter()
        .cloned()
        .chain(args.iter().map(OsString::from))
        .collect();
    let resolved = launcher::Native.resolve(&command.program, &all);
    let mut process = Command::new(&resolved.program);
    process
        .args(&resolved.args)
        .envs(command.env.iter().map(|(name, value)| (name, value)))
        .envs(resolved.env.iter().map(|(name, value)| (name, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        process.current_dir(cwd);
    }
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(err) => {
            return RunOutcome {
                output: String::new(),
                exit_code: None,
                failure: Some(format!(
                    "Floti could not run {}: {err}",
                    Path::new(&command.program).display()
                )),
            };
        }
    };
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let ended = wait(&mut child, limit);
    let output = format!("{}{}", joined(stdout), joined(stderr))
        .trim()
        .to_owned();
    match ended {
        Ok(exit_code) => RunOutcome {
            output,
            exit_code,
            failure: None,
        },
        Err(failure) => RunOutcome {
            output,
            exit_code: None,
            failure: Some(failure),
        },
    }
}
