//! `floti connect`: what a transport runs on the host's computer, such as
//! `ssh <target> floti connect`, so a client on another computer reaches the
//! host there.
//!
//! It finds the host's socket exactly as `floti host` and `floti bridge` do:
//! from the login's environment, `FLOTI_DATA_DIR`, `FLOTI_RUNTIME_DIR` and
//! the other overrides included. It opens the host's relay endpoint, beside
//! its local one, so the host knows the client is on another computer and
//! asks it for presence before an admin action. It then copies every byte on
//! its standard input to the socket and every byte from the socket to its
//! standard output, unchanged and in order, both ways at once. It runs
//! no handshake and opens no key or client file: the client's Noise
//! handshake crosses it as it would the socket, so the client holds the host
//! to the key it pinned and proves its own device key exactly as on this
//! computer. The transport only makes the host reachable; it is not what
//! lets a client in.
//!
//! Standard output carries the host's bytes and nothing else. Every other
//! word goes to standard error as one line, starting `floti connect: `. It
//! starts no host: with none running, it says so.
//!
//! `floti connect --host-key` prints the host's public key, as 64 hex
//! digits on one line, for a device that has not paired yet to hold the host
//! to while it asks to pair, learned through the same login it will connect
//! through. Only the public key is printed; the private key it is read from
//! never leaves this process.
//!
//! How it ends is its exit status ([`ConnectExit`]).

use std::io::Write;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::client::is_closed;
use crate::platform::folders::{self, UserEnv};
use crate::platform::socket::{LocalSocket, Native as NativeSocket};
use crate::server::{host_public_key, relay_endpoint};

/// How `floti connect` ended, which is its exit status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectExit {
    /// Standard input closed, so it closed the connection; or the host
    /// closed it. Either way, the connection ended as connections do.
    Closed,
    /// Anything not named below: folders that do not resolve, a read or
    /// write that failed.
    Failed,
    /// The command line was not `floti connect [--host-key]`.
    Usage,
    /// No Floti host is running for this user on this computer: nothing
    /// answered on its socket, or, for `--host-key`, no host has made a key.
    NoHost,
}

impl ConnectExit {
    /// The process's exit status.
    pub fn code(self) -> u8 {
        match self {
            Self::Closed => 0,
            Self::Failed => 1,
            Self::Usage => 2,
            Self::NoHost => 3,
        }
    }
}

/// The line `floti connect` writes when no host is running.
pub const NO_HOST_LINE: &str = "floti connect: no Floti host is running there.";

/// What `floti connect` was asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectStep {
    /// Relay the protocol between standard input and output and the host.
    Relay,
    /// Print the host's public key.
    HostKey,
}

/// Runs `floti connect` for `step` and says how it ended.
pub fn run_connect(step: ConnectStep) -> ConnectExit {
    let env = UserEnv::from_process();
    match step {
        ConnectStep::HostKey => print_host_key(&env),
        ConnectStep::Relay => {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(err) => return fail(ConnectExit::Failed, &format!("could not start: {err}")),
            };
            let exit = runtime.block_on(relay(&env));
            // A read of standard input may still be waiting; it goes with
            // the process.
            runtime.shutdown_background();
            exit
        }
    }
}

fn print_host_key(env: &UserEnv) -> ConnectExit {
    let folders = match folders::resolve(env) {
        Ok(folders) => folders,
        Err(err) => return fail(ConnectExit::Failed, &err.to_string()),
    };
    match host_public_key(&folders.data) {
        Ok(Some(key)) => {
            let mut out = std::io::stdout().lock();
            match writeln!(out, "{}", key.to_hex()).and_then(|()| out.flush()) {
                Ok(()) => ConnectExit::Closed,
                Err(err) => fail(
                    ConnectExit::Failed,
                    &format!("could not write to standard output: {err}"),
                ),
            }
        }
        Ok(None) => no_host(),
        Err(err) => fail(ConnectExit::Failed, &err.to_string()),
    }
}

async fn relay(env: &UserEnv) -> ConnectExit {
    let folders = match folders::resolve(env) {
        Ok(folders) => folders,
        Err(err) => return fail(ConnectExit::Failed, &err.to_string()),
    };
    let Ok(socket) = NativeSocket.connect(&relay_endpoint(&folders)).await else {
        return no_host();
    };
    let (mut from_host, mut to_host) = tokio::io::split(socket);
    // Both directions run at once, so a reader that is slow on one side
    // never holds up the other.
    let up = async {
        let mut stdin = tokio::io::stdin();
        let mut buf = vec![0; CHUNK];
        loop {
            let n = match stdin.read(&mut buf).await {
                Ok(0) => {
                    let _ = to_host.shutdown().await;
                    return ConnectExit::Closed;
                }
                Ok(n) => n,
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(err) => {
                    return fail(
                        ConnectExit::Failed,
                        &format!("could not read standard input: {err}"),
                    );
                }
            };
            match to_host.write_all(&buf[..n]).await {
                Ok(()) => {}
                Err(err) if is_closed(&err) => return ConnectExit::Closed,
                Err(err) => {
                    return fail(
                        ConnectExit::Failed,
                        &format!("could not write to the host: {err}"),
                    );
                }
            }
        }
    };
    let down = async {
        let mut stdout = tokio::io::stdout();
        let mut buf = vec![0; CHUNK];
        loop {
            let n = match from_host.read(&mut buf).await {
                Ok(0) => return ConnectExit::Closed,
                Ok(n) => n,
                Err(err) if is_closed(&err) => return ConnectExit::Closed,
                Err(err) => {
                    return fail(
                        ConnectExit::Failed,
                        &format!("could not read from the host: {err}"),
                    );
                }
            };
            if let Err(err) = async {
                stdout.write_all(&buf[..n]).await?;
                stdout.flush().await
            }
            .await
            {
                return fail(
                    ConnectExit::Failed,
                    &format!("could not write to standard output: {err}"),
                );
            }
        }
    };
    tokio::select! {
        exit = up => exit,
        exit = down => exit,
    }
}

const CHUNK: usize = 64 * 1024;

fn no_host() -> ConnectExit {
    say(NO_HOST_LINE);
    ConnectExit::NoHost
}

/// Says `why` on standard error, as one line, and ends with `exit`.
fn fail(exit: ConnectExit, why: &str) -> ConnectExit {
    say(&format!(
        "floti connect: {}",
        why.replace(['\r', '\n'], " ")
    ));
    exit
}

fn say(line: &str) {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "{line}").and_then(|()| err.flush());
}
