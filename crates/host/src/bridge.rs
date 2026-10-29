//! `floti bridge <client folder>`: a client's connection to the host on this
//! computer, for a program that does not link this crate (the desktop). It
//! runs the client's half of the Noise handshake from the keys in the folder
//! it is given, then relays the protocol between its standard input and
//! output and the host.
//!
//! It finds the host exactly as `floti host` finds its own folders and
//! socket: from the user's environment, `FLOTI_DATA_DIR`, `FLOTI_RUNTIME_DIR`
//! and the other overrides included. It connects with
//! [`ClientKeys::connect_local`], so a client that has pinned no host enrols
//! with the host's enrolment file while the host waits for its first admin,
//! and one that has connects pinned and carries no code. The client's folder
//! holds the device key and the pinned host key and nothing else.
//!
//! After the handshake both directions are `floti_protocol::frame` frames (a
//! 4-byte big-endian length, then one CBOR message), each relayed in the
//! order it came. Standard output carries the host's messages and nothing
//! else; standard input carries the program's, starting with its `hello`,
//! which the bridge does not send itself. Every other word goes to standard
//! error as one line, and no line holds a code, key material or frame bytes:
//! a key is named by its fingerprint.
//!
//! How it ends is its exit status ([`BridgeExit`]): standard input closing
//! closes the connection and is a success, and every failure has a status of
//! its own.

use std::io::{Read, Write};
use std::path::Path;

use floti_protocol::{FrameDecoder, Message, encode_frame};
use tokio::sync::mpsc;

use crate::client::{ClientError, ClientKeys, Connection, is_closed};
use crate::platform::folders::{self, UserEnv};
use crate::server::local_endpoint;

/// How the bridge ended, which is its exit status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeExit {
    /// Standard input closed, and the bridge closed the connection.
    Closed,
    /// Anything not named below: a client file that could not be read or
    /// written, a frame on standard input that does not decode, a message
    /// from the host that does not, a handshake that did not finish in time.
    Failed,
    /// The command line was not `floti bridge <client folder>`.
    Usage,
    /// No host answered on the socket.
    Unreachable,
    /// The client has pinned no host key and the host's data folder holds no
    /// enrolment file to enrol with.
    NotPinned,
    /// The host on the socket did not prove the key the client expected: the
    /// one it pinned, or the one the enrolment file names. Nothing past the
    /// first handshake message was sent to it.
    HostNotProven,
    /// The host closed the connection after the handshake.
    HostClosed,
}

impl BridgeExit {
    /// The process's exit status.
    pub fn code(self) -> u8 {
        match self {
            Self::Closed => 0,
            Self::Failed => 1,
            Self::Usage => 2,
            Self::Unreachable => 3,
            Self::NotPinned => 4,
            Self::HostNotProven => 5,
            Self::HostClosed => 6,
        }
    }

    /// The status a failure to connect ends with.
    fn of_connect(err: &ClientError) -> Self {
        match err {
            ClientError::Unreachable { .. } => Self::Unreachable,
            ClientError::NotPinned => Self::NotPinned,
            ClientError::HostNotProven { .. }
            | ClientError::HostClosed { .. }
            | ClientError::EnrolmentNotProven { .. } => Self::HostNotProven,
            _ => Self::Failed,
        }
    }
}

/// Runs the bridge for the client whose keys are in `client_folder`, until
/// its standard input closes or the connection ends, and says how it ended.
pub fn run_bridge(client_folder: &Path) -> BridgeExit {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => return fail(BridgeExit::Failed, &format!("could not start: {err}")),
    };
    let exit = runtime.block_on(bridge(UserEnv::from_process(), client_folder));
    // The thread reading standard input may still be blocked in a read; it
    // goes with the process.
    runtime.shutdown_background();
    exit
}

async fn bridge(env: UserEnv, client_folder: &Path) -> BridgeExit {
    let folders = match folders::resolve(&env) {
        Ok(folders) => folders,
        Err(err) => return fail(BridgeExit::Failed, &err.to_string()),
    };
    let endpoint = local_endpoint(&folders);
    let mut keys = match ClientKeys::open(client_folder) {
        Ok(keys) => keys,
        Err(err) => return fail(BridgeExit::Failed, &err.to_string()),
    };
    match keys.connect_local(&endpoint, &folders.data).await {
        Ok(connection) => relay(connection).await,
        Err(err) => fail(BridgeExit::of_connect(&err), &err.to_string()),
    }
}

/// What the thread reading standard input hands on.
enum Input {
    Bytes(Vec<u8>),
    Failed(std::io::Error),
}

/// How many reads of standard input wait to be relayed before the reader
/// waits too, so a host that reads slowly slows the program writing.
const INPUT_BACKLOG: usize = 16;

const INPUT_CHUNK: usize = 64 * 1024;

/// Standard input, read on a thread of its own: the reads, in order, then
/// the channel closing at end of file.
fn read_stdin() -> mpsc::Receiver<Input> {
    let (tx, rx) = mpsc::channel(INPUT_BACKLOG);
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut buf = vec![0; INPUT_CHUNK];
        loop {
            let input = match stdin.read(&mut buf) {
                Ok(0) => return,
                Ok(n) => Input::Bytes(buf[..n].to_vec()),
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(err) => Input::Failed(err),
            };
            let failed = matches!(input, Input::Failed(_));
            if tx.blocking_send(input).is_err() || failed {
                return;
            }
        }
    });
    rx
}

/// Relays frames between standard input and output and `connection` until
/// one side ends.
async fn relay(mut connection: Connection) -> BridgeExit {
    let mut input = read_stdin();
    let mut decoder = FrameDecoder::new();
    let mut stdout = std::io::stdout().lock();
    loop {
        tokio::select! {
            read = input.recv() => match read {
                Some(Input::Bytes(bytes)) => {
                    decoder.push(&bytes);
                    loop {
                        let message = match decoder.next_message() {
                            Ok(Some(message)) => message,
                            Ok(None) => break,
                            Err(err) => {
                                connection.close().await;
                                return fail(
                                    BridgeExit::Failed,
                                    &format!("a frame on standard input does not decode: {err}"),
                                );
                            }
                        };
                        if let Err(err) = connection.send(&message).await {
                            return ended_by(&err);
                        }
                    }
                }
                Some(Input::Failed(err)) => {
                    connection.close().await;
                    return fail(BridgeExit::Failed, &format!("could not read standard input: {err}"));
                }
                None => {
                    connection.close().await;
                    if let Err(err) = decoder.finish() {
                        return fail(
                            BridgeExit::Failed,
                            &format!("standard input ended inside a frame: {err}"),
                        );
                    }
                    return BridgeExit::Closed;
                }
            },
            received = connection.next() => match received {
                Ok(Some(message)) => {
                    if let Err(err) = write_frame(&mut stdout, &message) {
                        connection.close().await;
                        return fail(BridgeExit::Failed, &err);
                    }
                }
                Ok(None) => return host_closed(),
                Err(err) => return ended_by(&err),
            },
        }
    }
}

fn write_frame(out: &mut impl Write, message: &Message) -> Result<(), String> {
    let frame = encode_frame(message)
        .map_err(|err| format!("a message from the host does not encode: {err}"))?;
    out.write_all(&frame)
        .and_then(|()| out.flush())
        .map_err(|err| format!("could not write to standard output: {err}"))
}

/// The status a failure on an open connection ends with: the host having
/// closed it, or anything else.
fn ended_by(err: &ClientError) -> BridgeExit {
    match err {
        ClientError::Io(io) if is_closed(io) => host_closed(),
        other => fail(BridgeExit::Failed, &other.to_string()),
    }
}

fn host_closed() -> BridgeExit {
    fail(BridgeExit::HostClosed, "the host closed the connection.")
}

/// Says `why` on standard error, as one line, and ends with `exit`.
fn fail(exit: BridgeExit, why: &str) -> BridgeExit {
    let line = why.replace(['\r', '\n'], " ");
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "floti bridge: {line}").and_then(|()| err.flush());
    exit
}
