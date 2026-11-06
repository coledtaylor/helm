//! `floti end-old-host <client folder>`: what Helm runs, from the floti it
//! carries, when the user chooses Restart host to update for this PC's host
//! and that host speaks protocol 1.x, from before the restart frames. Such a
//! host can be asked nothing about a restart, so it is ended the way a crash
//! would end it: its process alone, at once, which leaves its session keeper
//! running with every session and terminal in it. The host Helm starts next
//! takes that keeper back.
//!
//! It connects as `floti bridge` does, with the keys in Helm's client folder,
//! and says this floti's hello. Only when the host refuses it naming protocol
//! major 1 does it end the process serving this user's local endpoint
//! ([`LocalSocket::connect_naming_server`]), held before the hello so the
//! process it ends is the one that refused, and never its tree, its group or
//! its keeper ([`OneProcess`]). It then waits until that host has let go of
//! its data folder's lock, which it holds for as long as it runs, and exits
//! 0. It sends nothing the host could handle: no restart frame, no protocol
//! 1.0 hello and no `host:stop`.
//!
//! A host that welcomes it, or refuses it naming any other protocol, is left
//! running, and it exits [`NOT_AN_OLD_HOST_EXIT`]. Every other ending is the
//! bridge's exit status for it ([`BridgeExit`]). Every word goes to standard
//! error as one line, and none holds key material.

use std::io::Write;
use std::path::{Path, PathBuf};

use floti_host::bridge::BridgeExit;
use floti_host::client::{ClientError, ClientKeys, Connection, is_closed};
use floti_host::platform::folders::{self, UserEnv};
use floti_host::platform::process_tree::OneProcess;
use floti_host::platform::socket::{self, LocalSocket};
use floti_host::server::local_endpoint;
use floti_protocol::message::{ClientInfo, ClientKind, Hello, Refused};
use floti_protocol::{Knowable, Message, PROTOCOL_VERSION};

use crate::update_stop::host_exited;

/// The status when the host on this PC is not one of protocol 1.x, so it was
/// left running.
pub const NOT_AN_OLD_HOST_EXIT: u8 = 9;

/// The protocol major of a host from before the restart frames.
const OLD_MAJOR: u16 = 1;

/// What follows `end-old-host`: Helm's client folder.
pub fn parse(args: &[String]) -> Option<PathBuf> {
    match args {
        [folder] if !folder.is_empty() => Some(PathBuf::from(folder)),
        _ => None,
    }
}

/// How it ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The protocol-1.x host was ended and has exited.
    Ended,
    /// The host is not one of protocol 1.x, and was left running: why.
    NotOld(String),
    /// No host could be reached, talked to or ended, with why.
    Failed(BridgeExit, String),
}

impl Outcome {
    /// The process's exit status.
    pub fn code(&self) -> u8 {
        match self {
            Self::Ended => 0,
            Self::NotOld(_) => NOT_AN_OLD_HOST_EXIT,
            Self::Failed(exit, _) => exit.code(),
        }
    }
}

/// Ends the protocol-1.x host on this computer, as the client whose keys are
/// in `client_folder`, and answers the exit status.
pub fn run(client_folder: &Path) -> u8 {
    let outcome = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => {
            let outcome = runtime.block_on(perform(UserEnv::from_process(), client_folder));
            // A wait for the host's exit that ran out may still be blocked.
            runtime.shutdown_background();
            outcome
        }
        Err(err) => Outcome::Failed(BridgeExit::Failed, format!("could not start: {err}")),
    };
    match &outcome {
        Outcome::Ended => {}
        Outcome::NotOld(why) | Outcome::Failed(_, why) => say(why),
    }
    outcome.code()
}

async fn perform(env: UserEnv, client_folder: &Path) -> Outcome {
    let folders = match folders::resolve(&env) {
        Ok(folders) => folders,
        Err(err) => return Outcome::Failed(BridgeExit::Failed, err.to_string()),
    };
    let keys = match ClientKeys::open_pinned(client_folder) {
        Ok(Some(keys)) => keys,
        Ok(None) => {
            return Outcome::Failed(
                BridgeExit::NotPinned,
                format!(
                    "{} holds no client that has connected to a host, so this PC's host was left running.",
                    client_folder.display()
                ),
            );
        }
        Err(err) => return Outcome::Failed(BridgeExit::Failed, err.to_string()),
    };
    let endpoint = local_endpoint(&folders);
    let (stream, server) = match socket::Native.connect_naming_server(&endpoint).await {
        Ok(connected) => connected,
        Err(err) => {
            return Outcome::Failed(
                BridgeExit::Unreachable,
                format!("no host answered at {endpoint}: {err}"),
            );
        }
    };
    // Held before the host is asked anything, so the process ended is the
    // one that answers on this connection.
    let held = match server {
        Knowable::Known(pid) => OneProcess::hold(pid).map_err(|err| format!("{err}")),
        Knowable::Unknown => Err("the OS would not say which process serves it".to_owned()),
    };
    let mut connection = match keys.connect_over(stream, &endpoint.to_string()).await {
        Ok(connection) => connection,
        Err(err) => return Outcome::Failed(BridgeExit::of_connect(&err), err.to_string()),
    };
    let refused = match greeted(&mut connection).await {
        Ok(Greeted::Welcomed(protocol)) => {
            connection.close().await;
            return Outcome::NotOld(format!(
                "this PC's host speaks protocol {protocol}, which this floti speaks too, so it was left running."
            ));
        }
        Ok(Greeted::Refused(refused)) => refused,
        Err(failed) => return failed,
    };
    connection.close().await;
    if refused.host.major != OLD_MAJOR {
        return Outcome::NotOld(format!(
            "this PC's host speaks protocol {}, not 1.x, so it was left running: {}",
            refused.host, refused.message
        ));
    }
    let held = match held {
        Ok(held) => held,
        Err(why) => {
            return Outcome::Failed(
                BridgeExit::Failed,
                format!(
                    "this PC's host speaks protocol {}, but {why}, so it was left running.",
                    refused.host
                ),
            );
        }
    };
    if let Err(err) = held.end_now() {
        return Outcome::Failed(
            BridgeExit::Failed,
            format!(
                "could not end this PC's host, process {}: {err}",
                held.pid()
            ),
        );
    }
    match host_exited(&folders.data).await {
        Ok(()) => Outcome::Ended,
        Err(why) => Outcome::Failed(BridgeExit::Failed, why),
    }
}

enum Greeted {
    /// Welcomed, on the protocol both speak.
    Welcomed(floti_protocol::ProtocolVersion),
    Refused(Refused),
}

/// Says this floti's hello and reads the host's answer.
async fn greeted(connection: &mut Connection) -> Result<Greeted, Outcome> {
    let hello = Message::Hello(Hello {
        protocol: PROTOCOL_VERSION,
        client: ClientInfo {
            name: "floti end-old-host".to_owned(),
            kind: ClientKind::Desktop,
            device_name: None,
        },
        capabilities: Vec::new(),
    });
    connection
        .send(&hello)
        .await
        .map_err(|err| ended_by(&err))?;
    match connection.next().await {
        Ok(Some(Message::Welcome(welcome))) => Ok(Greeted::Welcomed(welcome.protocol)),
        Ok(Some(Message::Refused(refused))) => Ok(Greeted::Refused(refused)),
        Ok(Some(_)) => Err(Outcome::Failed(
            BridgeExit::Failed,
            "the host answered hello with another message, so it was left running.".to_owned(),
        )),
        Ok(None) => Err(host_closed()),
        Err(err) => Err(ended_by(&err)),
    }
}

fn ended_by(err: &ClientError) -> Outcome {
    match err {
        ClientError::Io(io) if is_closed(io) => host_closed(),
        other => Outcome::Failed(BridgeExit::Failed, other.to_string()),
    }
}

fn host_closed() -> Outcome {
    Outcome::Failed(
        BridgeExit::HostClosed,
        "the host closed the connection, so it was left running.".to_owned(),
    )
}

/// Says `why` on standard error, as one line.
fn say(why: &str) {
    let line = why.replace(['\r', '\n'], " ");
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "floti end-old-host: {line}").and_then(|()| err.flush());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn it_takes_one_client_folder() {
        assert_eq!(
            parse(&args(&["C:\\Users\\a user\\Helm\\host-client"])),
            Some(PathBuf::from("C:\\Users\\a user\\Helm\\host-client"))
        );
        assert_eq!(parse(&args(&[])), None);
        assert_eq!(parse(&args(&[""])), None);
        assert_eq!(parse(&args(&["folder", "--stop"])), None);
    }

    #[test]
    fn ending_it_exits_0_and_a_host_left_running_has_a_status_of_its_own() {
        assert_eq!(Outcome::Ended.code(), 0);
        assert_eq!(Outcome::NotOld(String::new()).code(), NOT_AN_OLD_HOST_EXIT);
        for exit in [
            BridgeExit::Failed,
            BridgeExit::Unreachable,
            BridgeExit::NotPinned,
            BridgeExit::HostNotProven,
            BridgeExit::HostClosed,
        ] {
            let code = Outcome::Failed(exit, String::new()).code();
            assert_ne!(code, 0, "{exit:?}");
            assert_ne!(code, NOT_AN_OLD_HOST_EXIT, "{exit:?}");
        }
    }
}
