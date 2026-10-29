//! Running one declared program to completion, and ending its whole process
//! tree when it may not finish.

use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use crate::platform::launcher::Program;
use crate::platform::process_tree::{self, Ending, ProcessTree};
use crate::plugins::call::{ExecRequest, ExecResult, PluginCallError};

/// Each of stdout and stderr; past this the program is stopped.
pub const OUTPUT_MAX_BYTES: usize = 16 * 1024 * 1024;

/// How long a program whose tree was ended has to let go of its output
/// before the call answers without the rest of it.
const AFTER_END: Duration = Duration::from_secs(5);

const READ_CHUNK: usize = 64 * 1024;

/// A running program's tree, ended when it is dropped before the program
/// was seen to exit: a call cancelled, the plugin switched off or the host
/// stopping all drop the call, and with it this.
struct Tree {
    pid: Option<u32>,
    settled: AtomicBool,
}

impl Tree {
    fn new(pid: Option<u32>) -> Self {
        Self {
            pid,
            settled: AtomicBool::new(false),
        }
    }

    /// Ends the program and everything it started. Once.
    fn end(&self) {
        if self.settled.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Some(pid) = self.pid {
            // A tree that has already ended is not an error, and one the OS
            // would not end leaves nothing else to try.
            let _ = process_tree::Native.end_tree(pid, Ending::Forced);
        }
    }

    /// The program exited on its own; its id may be another process's now.
    fn exited(&self) {
        self.settled.store(true, Ordering::SeqCst);
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        self.end();
    }
}

/// Reads `stream` into `into` until it closes. Past [`OUTPUT_MAX_BYTES`] it
/// ends `tree` and answers true.
async fn read_into(
    stream: Option<impl AsyncRead + Unpin>,
    into: &mut Vec<u8>,
    tree: &Tree,
) -> bool {
    let Some(mut stream) = stream else {
        return false;
    };
    let mut chunk = vec![0u8; READ_CHUNK];
    loop {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return false,
            Ok(read) => {
                if into.len() + read > OUTPUT_MAX_BYTES {
                    tree.end();
                    return true;
                }
                into.extend_from_slice(&chunk[..read]);
            }
        }
    }
}

/// Runs `program` in `folder` with exactly `env`, with no shell, writing the
/// request's input and then closing it.
///
/// Resolves with what it wrote and how it ended: a non-zero exit is an
/// answer, not a failure, and a timeout ends the whole tree and resolves
/// with `timed_out`. Rejects only when it could not be started
/// (`not-found`) or wrote more than the host will hold (`invalid`).
pub async fn run(
    program: &Program,
    folder: &Path,
    env: Vec<(OsString, OsString)>,
    request: &ExecRequest,
    command: &str,
) -> Result<ExecResult, PluginCallError> {
    let mut std_command = std::process::Command::new(&program.program);
    std_command
        .args(&program.args)
        .current_dir(folder)
        .env_clear()
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    process_tree::Native.prepare_root(&mut std_command);
    let mut child = tokio::process::Command::from(std_command)
        .spawn()
        .map_err(|err| {
            PluginCallError::new(
                floti_protocol::channels::plugins::PluginErrorCode::NotFound,
                format!("{command} could not be started: {err}"),
            )
        })?;
    let tree = Tree::new(child.id());

    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let input = request.stdin.clone();
    let mut out = Vec::new();
    let mut err = Vec::new();
    let mut timed_out = false;

    let finished = {
        let write = async move {
            if let Some(mut stdin) = stdin {
                // A program that exits without reading its input closes the
                // pipe under the write; that is the program's business.
                if let Some(input) = input {
                    let _ = stdin.write_all(input.as_bytes()).await;
                }
                let _ = stdin.shutdown().await;
            }
        };
        let work = async {
            let ((), out_over, err_over) = tokio::join!(
                write,
                read_into(stdout, &mut out, &tree),
                read_into(stderr, &mut err, &tree),
            );
            let status = child.wait().await;
            (out_over || err_over, status)
        };
        tokio::pin!(work);
        tokio::select! {
            finished = &mut work => Some(finished),
            () = tokio::time::sleep(Duration::from_millis(request.timeout_ms)) => {
                timed_out = true;
                tree.end();
                tokio::time::timeout(AFTER_END, &mut work).await.ok()
            }
        }
    };

    let exit_code = match finished {
        Some((true, _)) => {
            return Err(PluginCallError::invalid(format!(
                "the program wrote more than {} MB",
                OUTPUT_MAX_BYTES / 1024 / 1024
            )));
        }
        Some((false, status)) => {
            tree.exited();
            status.ok().and_then(|status| status.code())
        }
        None => None,
    };
    Ok(ExecResult {
        exit_code: if timed_out { None } else { exit_code },
        stdout: String::from_utf8_lossy(&out).into_owned(),
        stderr: String::from_utf8_lossy(&err).into_owned(),
        timed_out,
    })
}
