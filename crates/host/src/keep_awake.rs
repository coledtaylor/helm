//! `floti keep-awake`: what the Windows host runs inside a WSL distro, as
//! `wsl.exe -d <distro> -- floti keep-awake`, to keep the distro running
//! while the host there has sessions (`wsl:keepAwake`).
//!
//! WSL keeps a distro running while a Windows process is attached to it
//! through `wsl.exe`, which is this process for as long as it runs. It
//! connects to its own host on this computer as a local client with a device
//! key of its own ([`CLIENT_FOLDER`]), holding the host to the public key in
//! the host's key file, follows the host's
//! sessions by subscription (`session:exit`, each one followed by a fresh
//! `session:list`), and exits with status 0 once none runs or the host
//! stops; at once when none runs or no host answers. It writes nothing on
//! standard output, and a failure as one line on standard error, status 1.

use std::io::Write;

use floti_protocol::channel::{RequestChannel, from_payload, to_payload};
use floti_protocol::channels::common::{SessionRecord, SessionStatus};
use floti_protocol::channels::sessions::{SessionExit, SessionList};
use floti_protocol::message::{ClientKind, Request, Subscribe};
use floti_protocol::{EventChannel, Message};

use crate::client::{ClientKeys, Connection};
use crate::platform::folders::{self, UserEnv};
use crate::server::{host_public_key, local_endpoint};

/// The name the host's log sees it as.
const CLIENT_NAME: &str = "floti keep-awake";

/// Its own client folder, in the host's data folder: a device key of its
/// own, and the host's public key, pinned from the host's key file, which
/// only this user can read.
pub const CLIENT_FOLDER: &str = "keep-awake";

/// The one subscription it makes.
const EXITS: u64 = 1;

/// How it ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeepAwakeEnd {
    /// No session runs, the host stopped, or none answers: the distro may go.
    LetGo,
    /// It could not follow the host, as one line.
    Failed(String),
}

impl KeepAwakeEnd {
    pub fn code(&self) -> u8 {
        match self {
            Self::LetGo => 0,
            Self::Failed(_) => 1,
        }
    }
}

/// Runs `floti keep-awake` and answers its exit status.
pub fn run_keep_awake() -> u8 {
    let end = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime.block_on(keep_awake(&UserEnv::from_process())),
        Err(err) => KeepAwakeEnd::Failed(format!("could not start: {err}")),
    };
    if let KeepAwakeEnd::Failed(why) = &end {
        let mut err = std::io::stderr().lock();
        let _ = writeln!(err, "floti keep-awake: {}", why.replace(['\r', '\n'], " "))
            .and_then(|()| err.flush());
    }
    end.code()
}

/// Follows the sessions of the host `env` finds until none runs or it stops.
pub async fn keep_awake(env: &UserEnv) -> KeepAwakeEnd {
    let folders = match folders::resolve(env) {
        Ok(folders) => folders,
        Err(err) => return KeepAwakeEnd::Failed(err.to_string()),
    };
    let host = match host_public_key(&folders.data) {
        Ok(Some(host)) => host,
        // No host has ever run here, so none runs a session.
        Ok(None) => return KeepAwakeEnd::LetGo,
        Err(err) => return KeepAwakeEnd::Failed(err.to_string()),
    };
    let mut keys = match ClientKeys::open(&folders.data.join(CLIENT_FOLDER)) {
        Ok(keys) => keys,
        Err(err) => return KeepAwakeEnd::Failed(err.to_string()),
    };
    if keys.pinned_host() != Some(host)
        && let Err(err) = keys.pin_host(host)
    {
        return KeepAwakeEnd::Failed(err.to_string());
    }
    let Ok(mut connection) = keys.connect(&local_endpoint(&folders)).await else {
        return KeepAwakeEnd::LetGo;
    };
    let end = follow(&mut connection).await;
    connection.close().await;
    end
}

async fn follow(connection: &mut Connection) -> KeepAwakeEnd {
    if connection
        .say_hello(CLIENT_NAME, ClientKind::Other)
        .await
        .is_err()
    {
        return KeepAwakeEnd::LetGo;
    }
    let subscribe = Message::Subscribe(Subscribe {
        subscription: EXITS,
        channel: SessionExit::NAME.to_owned(),
    });
    if connection.send(&subscribe).await.is_err() {
        return KeepAwakeEnd::LetGo;
    }
    let mut id = 0;
    loop {
        id += 1;
        let payload = match to_payload(&()) {
            Ok(payload) => payload,
            Err(err) => return KeepAwakeEnd::Failed(err.to_string()),
        };
        let asked = Message::Request(Request {
            id,
            channel: SessionList::NAME.to_owned(),
            payload,
        });
        if connection.send(&asked).await.is_err() {
            return KeepAwakeEnd::LetGo;
        }
        // An exit seen before the answer may not be in it: ask again.
        let mut exited_meanwhile = false;
        let running = loop {
            match connection.next().await {
                Ok(Some(Message::Response(answer))) if answer.id == id => {
                    match from_payload::<Vec<SessionRecord>>(&answer.payload) {
                        Ok(sessions) => {
                            break sessions
                                .iter()
                                .filter(|session| session.status == SessionStatus::Running)
                                .count();
                        }
                        Err(err) => {
                            return KeepAwakeEnd::Failed(format!(
                                "the host's session list does not decode: {err}"
                            ));
                        }
                    }
                }
                Ok(Some(Message::Error(error))) if error.id == id => {
                    return KeepAwakeEnd::Failed(error.message);
                }
                Ok(Some(Message::Event(event))) if event.subscription == EXITS => {
                    exited_meanwhile = true;
                }
                Ok(Some(Message::SubscriptionError(refused))) => {
                    return KeepAwakeEnd::Failed(refused.message);
                }
                Ok(Some(_)) => {}
                // The host stopped or closed the connection.
                Ok(None) | Err(_) => return KeepAwakeEnd::LetGo,
            }
        };
        if running == 0 {
            return KeepAwakeEnd::LetGo;
        }
        if exited_meanwhile {
            continue;
        }
        loop {
            match connection.next().await {
                Ok(Some(Message::Event(event))) if event.subscription == EXITS => break,
                Ok(Some(Message::SubscriptionError(refused))) => {
                    return KeepAwakeEnd::Failed(refused.message);
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => return KeepAwakeEnd::LetGo,
            }
        }
    }
}
