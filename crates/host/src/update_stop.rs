//! `floti update-stop <client folder> --ask | --stop`: what Helm's Windows
//! installer runs, from the copy of `floti` already installed, before it
//! replaces anything. A running `floti.exe` cannot be replaced, and stopping
//! the host ends every session it runs, so the installer asks first.
//!
//! It connects as `floti bridge` does, with the keys in Helm's client folder,
//! so the device key never leaves this process. Unlike the bridge it never
//! pins a host: a folder without a device key and a pinned host key is left
//! as it is, untouched.
//!
//! `floti update-stop --ask | --stop`, with no client folder, is the same
//! run on the host's own computer, as the desktop runs it through ssh or a
//! command before it replaces floti there: it connects as the host itself,
//! proving the key it reads from the host's key file, and never prints it. Its `--ask` prints the number of sessions the
//! host is running, `0` included, on one line, for the desktop to say how
//! many the update ends; its `--stop` is the same stop for an update.
//!
//! - `--ask` counts the sessions the host is running. With one or more it
//!   prints the question to ask, which says how many end, and exits 0; with
//!   none it prints nothing and exits [`NOTHING_TO_END_EXIT`].
//! - `--stop` stops the host for an update ([`HostStopReason::Update`]), so
//!   its sessions end with their rows left running and the next start offers
//!   them back once, then waits until the host has let go of its data folder,
//!   which it holds until it exits.
//!
//! Every other ending is the bridge's exit status for it ([`BridgeExit`]):
//! no host answering is [`BridgeExit::Unreachable`]. Every word besides the
//! question goes to standard error as one line, and none holds key material.

use std::fs::File;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use floti_host::bridge::BridgeExit;
use floti_host::client::{self, ClientError, ClientKeys, Connection, is_closed};
use floti_host::keys::read_key_pair;
use floti_host::platform::folders::{self, Folders, UserEnv};
use floti_host::server::{HOST_KEY_FILE, LOCK_FILE, local_endpoint};
use floti_protocol::channel::{RequestChannel, from_payload, to_payload};
use floti_protocol::channels::common::SessionStatus;
use floti_protocol::channels::host::{HostStop, HostStopReason, HostStopRequest};
use floti_protocol::channels::sessions::SessionList;
use floti_protocol::message::{ClientInfo, ClientKind, Hello, Request};
use floti_protocol::{Message, PROTOCOL_VERSION};

/// `--ask`'s status when the host runs no session: nothing would end, so
/// there is nothing to ask.
pub const NOTHING_TO_END_EXIT: u8 = 7;

/// How long `--stop` waits for the host to exit once it has agreed to stop:
/// it ends every session's process tree first.
const HOST_EXIT_DEADLINE: Duration = Duration::from_secs(60);

/// Who asks: Helm's installer with its client folder, or the host's own
/// user on the host's computer, with the host's key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Asker {
    /// A client that has connected to this host, whose keys are in this folder.
    Client(PathBuf),
    /// The host itself, by its own key.
    Host,
}

/// The step the installer asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// Count the running sessions and say what installing would end.
    Ask,
    /// Stop the host for an update and wait until it has exited.
    Stop,
}

/// What follows `update-stop`: the client folder, or nothing for the host
/// itself, then `--ask` or `--stop`.
pub fn parse(args: &[String]) -> Option<(Asker, Step)> {
    let step = |step: &str| match step {
        "--ask" => Some(Step::Ask),
        "--stop" => Some(Step::Stop),
        _ => None,
    };
    match args {
        [only] => Some((Asker::Host, step(only)?)),
        [folder, which] if !folder.is_empty() => {
            Some((Asker::Client(PathBuf::from(folder)), step(which)?))
        }
        _ => None,
    }
}

/// How a step ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Installing would end sessions: the question that says how many.
    Ask(String),
    /// The host runs no session, so installing ends none.
    NothingToEnd,
    /// The host itself asked: how many sessions the host runs.
    Count(usize),
    /// The host stopped for the update and has exited.
    Stopped,
    /// No host could be reached or talked to, with why.
    Failed(BridgeExit, String),
}

impl Outcome {
    /// The process's exit status.
    pub fn code(&self) -> u8 {
        match self {
            Self::Ask(_) | Self::Count(_) | Self::Stopped => 0,
            Self::NothingToEnd => NOTHING_TO_END_EXIT,
            Self::Failed(exit, _) => exit.code(),
        }
    }

    /// What goes to standard output: the question, or the count on its own
    /// line, and nothing else ever.
    pub fn printed(&self) -> Option<String> {
        match self {
            Self::Ask(question) => Some(question.clone()),
            Self::Count(running) => Some(format!("{running}\n")),
            _ => None,
        }
    }
}

/// What `--ask` ends with, given how many sessions the host runs.
pub fn asked(running: usize) -> Outcome {
    if running == 0 {
        Outcome::NothingToEnd
    } else {
        Outcome::Ask(question(running))
    }
}

/// The installer's question when installing would end `running` sessions,
/// one or more.
pub fn question(running: usize) -> String {
    let (count, them) = if running == 1 {
        ("1 session".to_owned(), "it")
    } else {
        (format!("{running} sessions"), "them")
    };
    format!(
        "Installing this update stops the local host on this PC, ending {count}. \
         Helm offers {them} back when it next starts."
    )
}

/// Runs `step` for `asker`, prints what it says, and answers its exit
/// status.
pub fn run(asker: &Asker, step: Step) -> u8 {
    let outcome = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => {
            let outcome = runtime.block_on(perform(UserEnv::from_process(), asker, step));
            // A wait for the host's exit that ran out may still be blocked.
            runtime.shutdown_background();
            outcome
        }
        Err(err) => Outcome::Failed(BridgeExit::Failed, format!("could not start: {err}")),
    };
    if let Some(text) = outcome.printed().as_deref() {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(text.as_bytes()).and_then(|()| out.flush());
    }
    if let Outcome::Failed(_, why) = &outcome {
        say(why);
    }
    outcome.code()
}

async fn perform(env: UserEnv, asker: &Asker, step: Step) -> Outcome {
    let folders = match folders::resolve(&env) {
        Ok(folders) => folders,
        Err(err) => return Outcome::Failed(BridgeExit::Failed, err.to_string()),
    };
    let connected = match asker {
        Asker::Client(client_folder) => as_client(&folders, client_folder).await,
        Asker::Host => as_host(&folders).await,
    };
    let mut connection = match connected {
        Ok(connection) => connection,
        Err(failed) => return failed,
    };
    let outcome = match (step, asker) {
        (Step::Ask, Asker::Client(_)) => count_running(&mut connection).await.map(asked),
        (Step::Ask, Asker::Host) => count_running(&mut connection).await.map(Outcome::Count),
        (Step::Stop, _) => stop_for_update(&mut connection).await,
    };
    connection.close().await;
    match outcome {
        Ok(Outcome::Stopped) => match host_exited(&folders.data).await {
            Ok(()) => Outcome::Stopped,
            Err(why) => Outcome::Failed(BridgeExit::Failed, why),
        },
        Ok(outcome) | Err(outcome) => outcome,
    }
}

/// A connection to the host on this computer as the client whose
/// keys are in `client_folder`.
async fn as_client(folders: &Folders, client_folder: &Path) -> Result<Connection, Outcome> {
    let keys = match ClientKeys::open_pinned(client_folder) {
        Ok(Some(keys)) => keys,
        Ok(None) => {
            return Err(Outcome::Failed(
                BridgeExit::NotPinned,
                format!(
                    "{} holds no client that has connected to a host, so this PC's host was not asked anything.",
                    client_folder.display()
                ),
            ));
        }
        Err(err) => return Err(Outcome::Failed(BridgeExit::Failed, err.to_string())),
    };
    keys.connect(&local_endpoint(folders))
        .await
        .map_err(|err| Outcome::Failed(BridgeExit::of_connect(&err), err.to_string()))
}

/// A connection to the host on this computer as the host itself, proving the
/// key in its key file, which only its own user can read. The key is held in
/// this process only, and never printed.
async fn as_host(folders: &Folders) -> Result<Connection, Outcome> {
    let no_host = || {
        Outcome::Failed(
            BridgeExit::Unreachable,
            "no host is running on this computer.".to_owned(),
        )
    };
    let host = read_key_pair(&folders.data.join(HOST_KEY_FILE))
        .map_err(|err| Outcome::Failed(BridgeExit::Failed, err.to_string()))?
        .ok_or_else(no_host)?;
    match client::connect(&local_endpoint(folders), &host, &host.public()).await {
        Ok(connection) => Ok(connection),
        Err(ClientError::Unreachable { .. }) => Err(no_host()),
        Err(err) => Err(Outcome::Failed(
            BridgeExit::of_connect(&err),
            err.to_string(),
        )),
    }
}

async fn count_running(connection: &mut Connection) -> Result<usize, Outcome> {
    welcomed(connection).await?;
    let sessions = request::<SessionList>(connection, &()).await?;
    Ok(sessions
        .iter()
        .filter(|session| session.status == SessionStatus::Running)
        .count())
}

/// Asks the host to stop for an update. A host that closes the connection
/// before it answers has taken the request too: it answers, then closes
/// every connection.
async fn stop_for_update(connection: &mut Connection) -> Result<Outcome, Outcome> {
    welcomed(connection).await?;
    let stop = HostStopRequest {
        reason: HostStopReason::Update,
    };
    match request::<HostStop>(connection, &stop).await {
        Ok(()) | Err(Outcome::Failed(BridgeExit::HostClosed, _)) => Ok(Outcome::Stopped),
        Err(failed) => Err(failed),
    }
}

async fn welcomed(connection: &mut Connection) -> Result<(), Outcome> {
    send(
        connection,
        &Message::Hello(Hello {
            protocol: PROTOCOL_VERSION,
            client: ClientInfo {
                name: "Helm installer".to_owned(),
                kind: ClientKind::Desktop,
                device_name: None,
            },
            capabilities: Vec::new(),
        }),
    )
    .await?;
    match next(connection).await? {
        Message::Welcome(_) => Ok(()),
        Message::Refused(refused) => Err(Outcome::Failed(BridgeExit::Failed, refused.message)),
        other => Err(Outcome::Failed(
            BridgeExit::Failed,
            format!("the host answered hello with {}", kind_of(&other)),
        )),
    }
}

/// The one request this connection makes, answered.
async fn request<C: RequestChannel>(
    connection: &mut Connection,
    request: &C::Request,
) -> Result<C::Response, Outcome> {
    const ID: u64 = 1;
    let payload = to_payload(request).map_err(|err| {
        Outcome::Failed(
            BridgeExit::Failed,
            format!("`{}` does not encode: {err}", C::NAME),
        )
    })?;
    send(
        connection,
        &Message::Request(Request {
            id: ID,
            channel: C::NAME.to_owned(),
            payload,
        }),
    )
    .await?;
    loop {
        match next(connection).await? {
            Message::Response(response) if response.id == ID => {
                return from_payload(&response.payload).map_err(|err| {
                    Outcome::Failed(
                        BridgeExit::Failed,
                        format!("the host's answer to `{}` does not decode: {err}", C::NAME),
                    )
                });
            }
            Message::Error(error) if error.id == ID => {
                return Err(Outcome::Failed(BridgeExit::Failed, error.message));
            }
            _ => {}
        }
    }
}

async fn send(connection: &mut Connection, message: &Message) -> Result<(), Outcome> {
    connection.send(message).await.map_err(|err| ended_by(&err))
}

/// The host's next message; its closing the connection is a failure.
async fn next(connection: &mut Connection) -> Result<Message, Outcome> {
    match connection.next().await {
        Ok(Some(message)) => Ok(message),
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
        "the host closed the connection.".to_owned(),
    )
}

fn kind_of(message: &Message) -> &'static str {
    match message {
        Message::Response(_) => "a response",
        Message::Error(_) => "an error",
        _ => "another message",
    }
}

/// Waits until the host whose data folder is `data` has let go of its lock,
/// which it holds for as long as it runs, then lets go of it too.
pub async fn host_exited(data: &Path) -> Result<(), String> {
    let path = data.join(LOCK_FILE);
    let file = match File::options().read(true).open(&path) {
        Ok(file) => file,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(format!("could not open {}: {err}", path.display())),
    };
    let locked = tokio::task::spawn_blocking(move || file.lock());
    match tokio::time::timeout(HOST_EXIT_DEADLINE, locked).await {
        Ok(Ok(Ok(()))) => Ok(()),
        Ok(Ok(Err(err))) => Err(format!("could not lock {}: {err}", path.display())),
        Ok(Err(err)) => Err(format!("the wait for the host to exit failed: {err}")),
        Err(_) => Err(format!(
            "the host agreed to stop but had not exited within {HOST_EXIT_DEADLINE:?}."
        )),
    }
}

/// Says `why` on standard error, as one line.
fn say(why: &str) {
    let line = why.replace(['\r', '\n'], " ");
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "floti update-stop: {line}").and_then(|()| err.flush());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| (*arg).to_owned()).collect()
    }

    #[test]
    fn with_no_host_answering_it_asks_nothing_and_says_so_through_its_exit_status() {
        let outcome = Outcome::Failed(BridgeExit::Unreachable, "no host answered".to_owned());
        assert_eq!(outcome.code(), BridgeExit::Unreachable.code());
        assert_eq!(outcome.printed(), None);
    }

    #[test]
    fn s7_the_host_itself_is_told_the_count_on_one_line_zero_included() {
        assert_eq!(Outcome::Count(2).printed().as_deref(), Some("2\n"));
        assert_eq!(Outcome::Count(0).printed().as_deref(), Some("0\n"));
        assert_eq!(Outcome::Count(0).code(), 0);
    }

    #[test]
    fn with_no_session_running_it_asks_nothing_and_exits_with_its_own_status() {
        let outcome = asked(0);
        assert_eq!(outcome, Outcome::NothingToEnd);
        assert_eq!(outcome.code(), NOTHING_TO_END_EXIT);
        assert_eq!(outcome.printed(), None);
    }

    #[test]
    fn with_sessions_running_it_asks_saying_how_many_end_and_that_helm_offers_them_back() {
        let outcome = asked(3);
        assert_eq!(outcome.code(), 0);
        assert_eq!(
            outcome.printed().as_deref(),
            Some(
                "Installing this update stops the local host on this PC, ending 3 sessions. \
                 Helm offers them back when it next starts."
            )
        );
        assert_eq!(
            asked(1).printed().as_deref(),
            Some(
                "Installing this update stops the local host on this PC, ending 1 session. \
                 Helm offers it back when it next starts."
            )
        );
    }

    #[test]
    fn a_stop_that_finished_exits_0_and_prints_nothing() {
        assert_eq!(Outcome::Stopped.code(), 0);
        assert_eq!(Outcome::Stopped.printed(), None);
    }

    #[test]
    fn every_status_it_can_end_with_is_distinct_from_asking() {
        for exit in [
            BridgeExit::Failed,
            BridgeExit::Unreachable,
            BridgeExit::NotPinned,
            BridgeExit::HostNotProven,
            BridgeExit::HostClosed,
        ] {
            let code = Outcome::Failed(exit, String::new()).code();
            assert_ne!(code, 0, "{exit:?}");
            assert_ne!(code, NOTHING_TO_END_EXIT, "{exit:?}");
        }
    }

    #[test]
    fn it_takes_a_client_folder_and_one_step() {
        assert_eq!(
            parse(&args(&["C:\\Users\\a user\\Helm\\host-client", "--ask"])),
            Some((
                Asker::Client(PathBuf::from("C:\\Users\\a user\\Helm\\host-client")),
                Step::Ask
            ))
        );
        assert_eq!(
            parse(&args(&["/home/me/Helm/host-client", "--stop"])),
            Some((
                Asker::Client(PathBuf::from("/home/me/Helm/host-client")),
                Step::Stop
            ))
        );
        assert_eq!(parse(&args(&["--ask"])), Some((Asker::Host, Step::Ask)));
        assert_eq!(parse(&args(&["--stop"])), Some((Asker::Host, Step::Stop)));
        assert_eq!(parse(&args(&[])), None);
        assert_eq!(parse(&args(&["folder"])), None);
        assert_eq!(parse(&args(&["", "--ask"])), None);
        assert_eq!(parse(&args(&["folder", "--count"])), None);
        assert_eq!(parse(&args(&["folder", "--ask", "--stop"])), None);
    }
}
