//! The `floti` executable in a test: a host running as its own process, the
//! commands run beside it, and raw connections to it.
//!
//! An integration test names the executable (`env!("CARGO_BIN_EXE_floti")`,
//! which only it can), and everything here points it at the test's
//! [`TestDirs`] and never at the user's own folders. A `floti host`'s
//! standard error is its log file in the tree's logs folder
//! ([`TestDirs::host_log`]), not the pipe its command was given. A [`HostProcess`]
//! dropped unstopped is killed, and a command run with [`run_floti`] that
//! has not exited within [`PATIENCE`] is killed, so a failing test leaves no
//! process behind.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::time::Duration;

use floti_protocol::channels::host::{HostStop, HostStopReason, HostStopRequest};
use floti_protocol::noise::PublicKey;
use tokio::io::AsyncReadExt;
use tokio::time::Instant;

use super::{PATIENCE, TestClient, TestDirs};
use crate::host_log::{LOG_FILE, TEST_CRASH_MARKER, TEST_LOG_LIMIT_MARKER};
use crate::platform::folders::{CONFIG_DIR_VAR, DATA_DIR_VAR, LOG_DIR_VAR, RUNTIME_DIR_VAR};
use crate::platform::socket::{Endpoint, LocalSocket, LocalStream, Native as NativeSocket};
use crate::platform::startup;
use crate::server::{SOCKET_NAME, host_public_key};

/// How often a wait on another process looks again.
const LOOK_AGAIN: Duration = Duration::from_millis(20);

impl TestDirs {
    /// The `floti` executable at `exe` with every folder in this tree and
    /// its home here, nothing it would read from the user's environment that
    /// could reach a real session, and its output piped.
    pub fn floti_command(&self, exe: impl AsRef<OsStr>) -> Command {
        let mut command = Command::new(exe);
        command
            .env(DATA_DIR_VAR, &self.data)
            .env(LOG_DIR_VAR, &self.logs)
            .env(CONFIG_DIR_VAR, &self.config)
            .env(RUNTIME_DIR_VAR, &self.runtime)
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env_remove("CLAUDE_CONFIG_DIR")
            .env_remove("SSH_CONNECTION")
            .env_remove("SSH_CLIENT")
            .env_remove("SSH_TTY")
            .env("SHELL", "/bin/sh")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        startup::stoppable(&mut command);
        command
    }

    /// Where a `floti host` over this tree listens: the socket in its
    /// runtime folder, as a client on the computer finds it.
    pub fn floti_endpoint(&self) -> Endpoint {
        NativeSocket.endpoint(&self.runtime, SOCKET_NAME)
    }

    /// The log of a `floti host` over this tree, every run's in turn, or an
    /// empty string when none has written one.
    pub fn host_log(&self) -> String {
        read_host_log(&self.logs)
    }

    /// Gives the log of a `floti host` over this tree a limit of `bytes` in
    /// place of the real one.
    pub fn with_log_limit(&self, bytes: u64) {
        std::fs::write(self.data.join(TEST_LOG_LIMIT_MARKER), bytes.to_string())
            .expect("mark the test's data folder");
    }

    /// Makes the next `floti host` over this tree end itself just after its
    /// start line, as a fault would: by a panic, or by failing an allocation,
    /// which aborts the process.
    pub fn crash_host_at_start(&self, how: HostCrash) {
        let how = match how {
            HostCrash::Panic => "panic",
            HostCrash::FailedAllocation => "abort",
        };
        std::fs::write(self.data.join(TEST_CRASH_MARKER), how)
            .expect("mark the test's data folder");
    }
}

/// How [`TestDirs::crash_host_at_start`] ends a host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostCrash {
    Panic,
    FailedAllocation,
}

/// What `host.log` in the logs folder `logs` holds, or an empty string.
fn read_host_log(logs: &Path) -> String {
    std::fs::read(logs.join(LOG_FILE))
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

/// A `floti host` the test stops; dropped unstopped, it is killed.
pub struct HostProcess {
    child: Option<Child>,
    /// The logs folder its command names, where its log is.
    logs: Option<PathBuf>,
}

impl HostProcess {
    /// Runs `command`, a `floti host`.
    pub fn spawn(mut command: Command) -> Self {
        let logs = command
            .get_envs()
            .find(|(name, _)| *name == OsStr::new(LOG_DIR_VAR))
            .and_then(|(_, value)| value)
            .map(PathBuf::from);
        Self {
            child: Some(command.spawn().expect("run floti host")),
            logs,
        }
    }

    /// Asks the host to stop through `client` and hands back its stdout and
    /// its log once it has exited.
    pub async fn stop(self, mut client: TestClient) -> (String, String) {
        client
            .request::<HostStop>(&HostStopRequest {
                reason: HostStopReason::Stop,
            })
            .await
            .expect("the host takes the stop");
        drop(client);
        self.exited().await
    }

    /// Waits for the host to exit, which it was asked to, and hands back its
    /// stdout and its log.
    pub async fn exited(mut self) -> (String, String) {
        let mut child = self.child.take().expect("a host still running");
        let deadline = Instant::now() + PATIENCE;
        while child.try_wait().expect("poll the host").is_none() {
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("the host did not exit within {PATIENCE:?}");
            }
            tokio::time::sleep(LOOK_AGAIN).await;
        }
        let output = child.wait_with_output().expect("read the host's output");
        (
            String::from_utf8_lossy(&output.stdout).into_owned(),
            self.logs.as_deref().map(read_host_log).unwrap_or_default(),
        )
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Runs `command` to its end and hands back what it printed and its status;
/// one still running after [`PATIENCE`] is killed and fails the test.
pub async fn run_floti(mut command: Command) -> Output {
    let mut child = command.spawn().expect("run floti");
    let deadline = Instant::now() + PATIENCE;
    while child.try_wait().expect("poll floti").is_none() {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("floti did not exit within {PATIENCE:?}");
        }
        tokio::time::sleep(LOOK_AGAIN).await;
    }
    child.wait_with_output().expect("read floti's output")
}

/// The public key of the host starting on the data folder `data`, once it
/// has made it.
pub async fn host_key_when_made(data: &Path) -> PublicKey {
    let deadline = Instant::now() + PATIENCE;
    loop {
        if let Ok(Some(key)) = host_public_key(data) {
            return key;
        }
        assert!(
            Instant::now() < deadline,
            "the host made no key within {PATIENCE:?}"
        );
        tokio::time::sleep(LOOK_AGAIN).await;
    }
}

/// A raw connection to `endpoint`, retrying while the host is starting.
pub async fn raw_connection(endpoint: &Endpoint) -> LocalStream {
    let deadline = Instant::now() + PATIENCE;
    loop {
        match NativeSocket.connect(endpoint).await {
            Ok(stream) => return stream,
            Err(err) => {
                assert!(
                    Instant::now() < deadline,
                    "nothing answered at {endpoint}: {err}"
                );
                tokio::time::sleep(LOOK_AGAIN).await;
            }
        }
    }
}

/// Everything the host sends on `stream` until it closes it, failing the
/// test when it is still open after `within`.
pub async fn read_until_closed(stream: &mut LocalStream, within: Duration) -> Vec<u8> {
    let mut received = Vec::new();
    let mut buf = [0; 4096];
    let deadline = Instant::now() + within;
    loop {
        match tokio::time::timeout_at(deadline, stream.read(&mut buf)).await {
            Err(_) => panic!("the host did not close the connection within {within:?}"),
            Ok(Ok(0) | Err(_)) => return received,
            Ok(Ok(n)) => received.extend_from_slice(&buf[..n]),
        }
    }
}
