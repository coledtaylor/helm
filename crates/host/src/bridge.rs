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
//!
//! `floti bridge <client folder> [--pair <device name>] -- <program>
//! [<arg>...]` reaches a host on another computer through a transport
//! ([`Transport`]): a program that carries bytes unchanged, such as the
//! user's own `ssh -o BatchMode=yes <target>`, or any command of the user's
//! choosing. It runs the program as given, with no shell, adding one last
//! argument, the line to run on the other side: `floti connect`
//! ([`crate::connect`]). The handshake then runs over the program's standard
//! input and output exactly as over the socket, holding the host to the key
//! the client pinned; the transport only makes the host reachable. The
//! client folder is the one kept for that host, and nothing about the
//! transport is written to it.
//!
//! A client that has pinned no host and is given `--pair <device name>`
//! pairs first: it learns the host's public key through the same transport
//! (`floti connect --host-key`), asks to pair while holding the host to it,
//! writes the code and its expiry on standard error as one line
//! ([`PAIRING_LINE_PREFIX`]), and waits for someone to run `floti devices
//! approve <code>` on the host's computer. Once approved it pins the key,
//! connects again as itself, and relays. A request nobody approves in time
//! ends with [`BridgeExit::PairingExpired`].
//!
//! Given `--approve <role>` after the name as well, it pairs in one step:
//! once the code is shown it runs the transport again with `floti devices
//! approve - --role <role>` ([`approve_line`]) and writes the code, and a
//! line ending, to that command's standard input, so the code is in no
//! command line. The transport's own sign-in is what lets that command
//! approve: it runs as the host's user on the host's computer. When it
//! fails, the bridge says the last line it wrote on standard error,
//! unedited, then the code line again, and keeps waiting for someone to
//! approve by hand.
//!
//! A transport that cannot be started ends with
//! [`BridgeExit::TransportNotStarted`]. One that ends before the handshake
//! finished ends with [`BridgeExit::TransportEnded`], and the last line it
//! wrote on standard error is the bridge's one line, passed through
//! unedited, since that line (ssh's own message) says what went wrong;
//! when that line is `floti connect` saying no host is running there, the
//! status is [`BridgeExit::Unreachable`] instead.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{ExitStatus, Stdio};

use floti_protocol::channels::devices::DeviceRole;
use floti_protocol::message::ClientKind;
use floti_protocol::noise::PublicKey;
use floti_protocol::{FrameDecoder, Message, encode_frame};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::client::{
    ClientError, ClientKeys, Connection, PairingOutcome, TRANSPORT_HANDSHAKE_DEADLINE, duplex,
    is_closed,
};
use crate::connect::ConnectExit;
use crate::platform::folders::{self, UserEnv};
use crate::platform::launcher::{self, ProgramLauncher};
use crate::platform::socket::LocalStream;
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
    /// The transport's program could not be started.
    TransportNotStarted,
    /// The transport ended before the handshake finished. The bridge's line
    /// on standard error is the last one the transport wrote there,
    /// unedited.
    TransportEnded,
    /// The request to pair through a transport expired before anyone
    /// approved it. Nothing was pinned.
    PairingExpired,
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
            Self::TransportNotStarted => 7,
            Self::TransportEnded => 8,
            Self::PairingExpired => 9,
        }
    }

    /// The status a failure to connect ends with.
    pub fn of_connect(err: &ClientError) -> Self {
        match err {
            ClientError::Unreachable { .. } => Self::Unreachable,
            ClientError::NotPinned => Self::NotPinned,
            ClientError::HostNotProven { .. }
            | ClientError::HostClosed { .. }
            | ClientError::EnrolmentNotProven { .. }
            | ClientError::PairingNotAnswered { .. } => Self::HostNotProven,
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

/// A program that carries bytes unchanged to the computer a host runs on,
/// such as `ssh -o BatchMode=yes <target>`, given the line to run there as
/// one last argument.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transport {
    pub program: OsString,
    pub args: Vec<OsString>,
    /// The floti the lines run on the host's computer: its full path there,
    /// for a login whose non-interactive shell does not have the folder it
    /// was installed in on its `PATH`, or `None` for `floti` on that `PATH`.
    /// A path [`remote_floti_problem`] refuses is never given here.
    pub floti: Option<String>,
}

impl Transport {
    /// The line that runs floti with `rest` on the host's computer: `floti
    /// <rest>`, or `<path> <rest>` with the path in double quotes when it
    /// holds a blank or a backslash, which both a POSIX shell and Windows'
    /// `cmd`, the shell Windows' OpenSSH runs a line in, read as one word,
    /// backslashes kept.
    pub fn line(&self, rest: &str) -> String {
        match &self.floti {
            None => format!("floti {rest}"),
            Some(path) if path.contains([' ', '\t', '\\']) => format!("\"{path}\" {rest}"),
            Some(path) => format!("{path} {rest}"),
        }
    }
}

/// Why `path` cannot name floti in a line run on the host's computer, or
/// `None` when it can: it must be absolute there (`/...`, `C:\...` or
/// `C:/...`), and hold nothing a shell would read as more than a word in
/// double quotes: no quote, `$`, backtick, `%` or control character.
pub fn remote_floti_problem(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let absolute = path.starts_with('/')
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'\\' | b'/'));
    if !absolute {
        return Some(format!(
            "the floti to run there, {path:?}, is not a full path"
        ));
    }
    if path
        .chars()
        .any(|c| c.is_control() || matches!(c, '"' | '$' | '`' | '%'))
    {
        return Some(format!(
            "the floti to run there, {path:?}, holds a character a shell would not read as part of a path"
        ));
    }
    None
}

/// The line a transport runs on the host's computer to reach the host, with
/// `floti` on that login's `PATH`.
pub const CONNECT_LINE: &str = "floti connect";

/// The line a transport runs on the host's computer to learn its public key,
/// with `floti` on that login's `PATH`.
pub const HOST_KEY_LINE: &str = "floti connect --host-key";

/// What follows floti in [`CONNECT_LINE`].
const CONNECT: &str = "connect";

/// What follows floti in [`HOST_KEY_LINE`].
const HOST_KEY: &str = "connect --host-key";

/// How the one line on standard error that shows a pairing code starts. The
/// whole line is `floti bridge: pairing code <code>, expires in <seconds>
/// seconds: run "floti devices approve <code>" on the host.`, for the
/// desktop to show.
pub const PAIRING_LINE_PREFIX: &str = "floti bridge: pairing code ";

/// The line a transport runs on the host's computer to approve, with `role`,
/// the request whose code it is given on standard input, with `floti` on
/// that login's `PATH`.
pub fn approve_line(role: DeviceRole) -> String {
    format!("floti {}", approve(role))
}

/// What follows floti in [`approve_line`].
fn approve(role: DeviceRole) -> String {
    let role = match role {
        DeviceRole::Viewer => "viewer",
        DeviceRole::Operator => "operator",
        DeviceRole::Admin => "admin",
    };
    format!("devices approve - --role {role}")
}

/// How a client that has pinned no host pairs through a transport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pair {
    /// The device name it asks to pair as.
    pub name: String,
    /// The role to approve it with through the same transport, in one step;
    /// `None` waits for someone to approve it on the host's computer.
    pub approve: Option<DeviceRole>,
}

/// Runs the bridge for the client whose keys are in `client_folder`, to the
/// host `transport` reaches, pairing first as `pair` when the client has
/// pinned no host, until its standard input closes or the connection ends,
/// and says how it ended.
pub fn run_bridge_through(
    client_folder: &Path,
    pair: Option<&Pair>,
    transport: &Transport,
) -> BridgeExit {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => return fail(BridgeExit::Failed, &format!("could not start: {err}")),
    };
    let exit = runtime.block_on(bridge_through(client_folder, pair, transport));
    runtime.shutdown_background();
    exit
}

async fn bridge_through(
    client_folder: &Path,
    pair: Option<&Pair>,
    transport: &Transport,
) -> BridgeExit {
    let mut keys = match ClientKeys::open(client_folder) {
        Ok(keys) => keys,
        Err(err) => return fail(BridgeExit::Failed, &err.to_string()),
    };
    if keys.pinned_host().is_none() {
        let Some(pair) = pair else {
            return fail(BridgeExit::NotPinned, &ClientError::NotPinned.to_string());
        };
        if let Err(exit) = pair_through(&mut keys, pair, transport).await {
            return exit;
        }
    }
    let mut running = match Running::start(transport, &transport.line(CONNECT)) {
        Ok(running) => running,
        Err(exit) => return exit,
    };
    let stream = running.stream();
    match keys.connect_over(stream, &running.described).await {
        Ok(connection) => {
            let exit = relay(connection).await;
            running.finish().await;
            exit
        }
        Err(err) => running.not_connected(err).await,
    }
}

/// Pairs the client in `keys` as `pair` says with the host `transport`
/// reaches: learns its key, asks, shows the code, approves through the
/// transport when `pair` names a role, waits for approval and pins the key.
async fn pair_through(
    keys: &mut ClientKeys,
    pair: &Pair,
    transport: &Transport,
) -> Result<(), BridgeExit> {
    let name = pair.name.as_str();
    let host = read_host_key(transport).await?;
    let mut running = Running::start(transport, &transport.line(CONNECT))?;
    let stream = running.stream();
    let request = match keys
        .ask_to_pair_over(stream, &running.described, &host, name, ClientKind::Desktop)
        .await
    {
        Ok(request) => request,
        Err(err) => return Err(running.not_connected(err).await),
    };
    let code = request.code().to_owned();
    let code_line = format!(
        "{PAIRING_LINE_PREFIX}{code}, expires in {} seconds: run \"floti devices approve {code}\" on the host.",
        request.expires_in_seconds()
    );
    say(&code_line);
    let outcome = {
        let answered = keys.finish_pairing(request);
        tokio::pin!(answered);
        match pair.approve {
            None => answered.await,
            Some(role) => {
                let approving = approve_through(transport, role, &code);
                tokio::pin!(approving);
                tokio::select! {
                    // Approved (or expired) before the command ended: it is
                    // ended with the bridge's wait.
                    outcome = &mut answered => outcome,
                    approved = &mut approving => {
                        if let Err(line) = approved {
                            say(&line);
                            say(&code_line);
                        }
                        answered.await
                    }
                }
            }
        }
    };
    running.finish().await;
    match outcome {
        Ok(PairingOutcome::Approved(_)) => Ok(()),
        Ok(PairingOutcome::Expired) => Err(fail(
            BridgeExit::PairingExpired,
            "nobody approved the request to pair before it expired; nothing was pinned.",
        )),
        Err(err) => Err(fail(BridgeExit::Failed, &err.to_string())),
    }
}

/// Approves the request waiting under `code` with `role`, by running
/// [`approve_line`] through `transport` with the code on its standard input.
/// `Err` holds the line to say when it fails: the last line the command
/// wrote on standard error, unedited.
async fn approve_through(
    transport: &Transport,
    role: DeviceRole,
    code: &str,
) -> Result<(), String> {
    let mut running = Running::start(transport, &transport.line(&approve(role))).map_err(|_| {
        format!(
            "could not run {} to approve the request",
            transport.program.to_string_lossy()
        )
    })?;
    let mut stdin = running
        .child
        .stdin
        .take()
        .expect("the transport's stdin is piped");
    // A command that ends without reading its input fails below, saying why.
    let _ = stdin.write_all(format!("{code}\n").as_bytes()).await;
    drop(stdin);
    // What it prints on success is a sentence for a person; nobody reads it
    // here, so it is drained rather than left to fill the pipe.
    let mut stdout = running
        .child
        .stdout
        .take()
        .expect("the transport's stdout is piped");
    let drained = tokio::spawn(async move {
        let mut sink = Vec::new();
        let _ = stdout.read_to_end(&mut sink).await;
    });
    let status = running.child.wait().await;
    drained.abort();
    match status {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(running.last_written().await.unwrap_or_else(|| {
            format!(
                "{} failed ({status}) and wrote nothing on standard error",
                running.described
            )
        })),
        Err(err) => Err(format!(
            "{} could not be waited on: {err}",
            running.described
        )),
    }
}

/// The host's public key, as `floti connect --host-key` prints it through
/// `transport`.
async fn read_host_key(transport: &Transport) -> Result<PublicKey, BridgeExit> {
    let mut running = Running::start(transport, &transport.line(HOST_KEY))?;
    let mut stdout = running
        .child
        .stdout
        .take()
        .expect("the transport's stdout is piped");
    let mut printed = Vec::new();
    let read = tokio::time::timeout(
        TRANSPORT_HANDSHAKE_DEADLINE,
        stdout.read_to_end(&mut printed),
    );
    if !matches!(read.await, Ok(Ok(_))) {
        return Err(fail(
            BridgeExit::Failed,
            &format!(
                "{} printed no host key within {TRANSPORT_HANDSHAKE_DEADLINE:?}",
                running.described
            ),
        ));
    }
    match running.exited().await {
        Some(status) if status.success() => {}
        Some(status) => return Err(running.ended_with(status).await),
        None => {
            return Err(fail(
                BridgeExit::Failed,
                &format!("{} did not exit once it had printed", running.described),
            ));
        }
    }
    String::from_utf8_lossy(&printed)
        .trim()
        .parse::<PublicKey>()
        .map_err(|_| {
            fail(
                BridgeExit::Failed,
                &format!("{} did not print a host key", running.described),
            )
        })
}

/// A transport's program, running with `floti connect` (or the line to run)
/// as its last argument.
struct Running {
    child: Child,
    /// The command line, for errors.
    described: String,
    /// The last line the program wrote on standard error, once it ends.
    last_line: Option<JoinHandle<Option<String>>>,
}

impl Running {
    /// Starts `transport` with `line` as its last argument, its standard
    /// input and output piped to the bridge, opening no window of its own.
    fn start(transport: &Transport, line: &str) -> Result<Self, BridgeExit> {
        let described = transport.args.iter().map(|arg| arg.to_string_lossy()).fold(
            transport.program.to_string_lossy().into_owned(),
            |mut all, arg| {
                all.push(' ');
                all.push_str(&arg);
                all
            },
        ) + " "
            + line;
        let mut command = tokio::process::Command::new(&transport.program);
        command
            .args(&transport.args)
            .arg(line)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        launcher::Native.windowless(command.as_std_mut());
        let mut child = command.spawn().map_err(|err| {
            fail(
                BridgeExit::TransportNotStarted,
                &format!(
                    "could not run {}: {err}",
                    transport.program.to_string_lossy()
                ),
            )
        })?;
        let stderr = child
            .stderr
            .take()
            .expect("the transport's stderr is piped");
        Ok(Self {
            child,
            described,
            last_line: Some(tokio::spawn(last_line(stderr))),
        })
    }

    /// The program's standard output and input, as one stream.
    fn stream(&mut self) -> LocalStream {
        let stdout = self
            .child
            .stdout
            .take()
            .expect("the transport's stdout is piped");
        let stdin = self
            .child
            .stdin
            .take()
            .expect("the transport's stdin is piped");
        duplex(stdout, stdin)
    }

    /// Its exit status once it has exited, waiting for that as long as a
    /// transport's handshake may take; `None` if it is still running then.
    async fn exited(&mut self) -> Option<ExitStatus> {
        tokio::time::timeout(TRANSPORT_HANDSHAKE_DEADLINE, self.child.wait())
            .await
            .ok()
            .and_then(Result::ok)
    }

    /// Lets the program end once its standard input has closed, as `floti
    /// connect` does, and ends it if it has not by then.
    async fn finish(mut self) {
        if self.exited().await.is_none() {
            let _ = self.child.kill().await;
        }
    }

    /// The status for a handshake that did not finish with `err`: the
    /// transport's own when it ended with a failure first, the host's
    /// otherwise.
    async fn not_connected(mut self, err: ClientError) -> BridgeExit {
        let ended_early = matches!(
            err,
            ClientError::HostClosed { .. }
                | ClientError::PairingNotAnswered { .. }
                | ClientError::PairingEnded
                | ClientError::Io(_)
        );
        if ended_early
            && let Some(status) = self.exited().await
            && !status.success()
        {
            return self.ended_with(status).await;
        }
        let _ = self.child.kill().await;
        fail(BridgeExit::of_connect(&err), &err.to_string())
    }

    /// The last line it wrote on standard error, once it has ended.
    async fn last_written(&mut self) -> Option<String> {
        match self.last_line.take() {
            Some(reading) => tokio::time::timeout(TRANSPORT_HANDSHAKE_DEADLINE, reading)
                .await
                .ok()
                .and_then(Result::ok)
                .flatten(),
            None => None,
        }
    }

    /// The status for a transport that ended with `status`, a failure,
    /// before the handshake finished, saying the last line it wrote.
    async fn ended_with(&mut self, status: ExitStatus) -> BridgeExit {
        match self.last_written().await {
            Some(line) => {
                let no_host = status.code() == Some(i32::from(ConnectExit::NoHost.code()))
                    && line.starts_with("floti connect: ");
                say(&line);
                if no_host {
                    BridgeExit::Unreachable
                } else {
                    BridgeExit::TransportEnded
                }
            }
            None => fail(
                BridgeExit::TransportEnded,
                &format!(
                    "{} ended before the handshake finished ({status}) and wrote nothing on standard error",
                    self.described
                ),
            ),
        }
    }
}

/// Reads `stderr` to its end, keeping the last line that is not blank, as
/// written but for its line ending.
async fn last_line(stderr: ChildStderr) -> Option<String> {
    let mut reader = BufReader::new(stderr);
    let mut last = None;
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => return last,
            Ok(_) => {
                let text = String::from_utf8_lossy(&line);
                let text = text.trim_end_matches(['\r', '\n']);
                if !text.trim().is_empty() {
                    last = Some(text.to_owned());
                }
            }
        }
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
    say(&format!("floti bridge: {}", why.replace(['\r', '\n'], " ")));
    exit
}

/// Writes `line` on standard error as it is.
fn say(line: &str) {
    let mut err = std::io::stderr().lock();
    let _ = writeln!(err, "{line}").and_then(|()| err.flush());
}
