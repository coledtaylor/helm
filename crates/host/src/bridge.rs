//! `floti bridge <client folder>`: a client's connection to the host on this
//! computer, for a program that does not link this crate (the desktop). It
//! runs the client's half of the Noise handshake from the keys in the folder
//! it is given, then relays the protocol between its standard input and
//! output and the host.
//!
//! It finds the host exactly as `floti host` finds its own folders and
//! socket: from the user's environment, `FLOTI_DATA_DIR`, `FLOTI_RUNTIME_DIR`
//! and the other overrides included. It connects with
//! [`ClientKeys::connect_local`]: a client that has pinned no host holds the
//! host to the key in its data folder, which only this OS user can read, and
//! pins it once the host has proven it; one that has connects holding the
//! host to the key it pinned. The client's folder holds the device key and
//! the pinned host key and nothing else.
//!
//! After the handshake both directions are `floti_protocol::frame` frames (a
//! 4-byte big-endian length, then one CBOR message), each relayed in the
//! order it came. Standard output carries the host's messages and nothing
//! else; standard input carries the program's, starting with its `hello`,
//! which the bridge does not send itself. Every other word goes to standard
//! error as one line, and no line holds key material or frame bytes:
//! a key is named by its fingerprint.
//!
//! How it ends is its exit status ([`BridgeExit`]): standard input closing
//! closes the connection and is a success, and every failure has a status of
//! its own.
//!
//! `floti bridge <client folder> -- <program> [<arg>...]` reaches a host on
//! another computer through a transport ([`Transport`]): a program that
//! carries bytes unchanged, such as the user's own `ssh -o BatchMode=yes
//! <target>`, or any command of the user's choosing. It runs the program as
//! given, with no shell, adding one last argument, the line to run on the
//! other side: `floti connect` ([`crate::connect`]). The handshake then runs
//! over the program's standard input and output exactly as over the socket,
//! holding the host to the key the client pinned. The transport is the
//! access: it is the user's own login on that computer, and nothing is
//! approved there. The client folder is the one kept for that host, and
//! nothing about the transport is written to it.
//!
//! A client that has pinned no host first learns the host's public key
//! through the same transport (`floti connect --host-key`), holds the host
//! to it, pins it once the host has proven it, and relays. A client that has
//! pinned one refuses a host proving another, with
//! [`BridgeExit::HostNotProven`], until the user removes the host and adds
//! it again.
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

use floti_protocol::noise::PublicKey;
use floti_protocol::{FrameDecoder, Message, encode_frame};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, ChildStderr};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::client::{
    ClientError, ClientKeys, Connection, TRANSPORT_HANDSHAKE_DEADLINE, duplex, is_closed,
};
use crate::connect::ConnectExit;
use crate::platform::folders::{self, UserEnv};
use crate::platform::launcher::{self, ProgramLauncher};
use crate::platform::socket::LocalStream;
use crate::platform::wsl::UTF8_VAR;
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
    /// The client has pinned no host key and no host has started on this
    /// computer's data folder yet, so there is no key to hold one to.
    NotPinned,
    /// The host did not prove the key the client expected: the one it
    /// pinned, or, before it had pinned one, the one it learned for the
    /// host. Nothing past the first handshake message was sent to it.
    HostNotProven,
    /// The host closed the connection after the handshake.
    HostClosed,
    /// The transport's program could not be started.
    TransportNotStarted,
    /// The transport ended before the handshake finished. The bridge's line
    /// on standard error is the last one the transport wrote there,
    /// unedited.
    TransportEnded,
}

impl BridgeExit {
    /// The process's exit status. 9 is retired and never given again: an
    /// earlier version used it for a status this one no longer has.
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
        }
    }

    /// The status a failure to connect ends with.
    pub fn of_connect(err: &ClientError) -> Self {
        match err {
            ClientError::Unreachable { .. } => Self::Unreachable,
            ClientError::NotPinned | ClientError::NotStarted { .. } => Self::NotPinned,
            ClientError::HostNotProven { .. }
            | ClientError::HostClosed { .. }
            | ClientError::LearnedKeyNotProven { .. } => Self::HostNotProven,
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
    /// The program reads the rest of its own command line as written, as
    /// `wsl.exe -d <distro> --` on this computer does ("Pass the remaining
    /// command line as is"): the line is appended to it unquoted
    /// ([`ProgramLauncher::append_as_written`]) rather than as one argument,
    /// and it runs with `WSL_UTF8=1` (`floti bridge ... --as-written -- ...`).
    pub as_written: bool,
}

impl Transport {
    /// The line that runs floti with `rest` on the host's computer: `floti
    /// <rest>`, or `<path> <rest>` with the path in double quotes when it
    /// holds a blank or a backslash, which both a POSIX shell and Windows'
    /// `cmd`, the shell Windows' OpenSSH runs a line in, read as one word,
    /// backslashes kept.
    pub fn line(&self, rest: &str) -> String {
        floti_line(self.floti.as_deref(), rest)
    }
}

/// The line that runs floti with `rest` on another computer or in a distro:
/// `floti <rest>`, or `<path> <rest>` with the path in double quotes when it
/// holds a blank or a backslash ([`Transport::line`]).
pub fn floti_line(floti: Option<&str>, rest: &str) -> String {
    match floti {
        None => format!("floti {rest}"),
        Some(path) if path.contains([' ', '\t', '\\']) => format!("\"{path}\" {rest}"),
        Some(path) => format!("{path} {rest}"),
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

/// Runs the bridge for the client whose keys are in `client_folder`, to the
/// host `transport` reaches, learning and pinning its key first when the
/// client has pinned none, until its standard input closes or the connection
/// ends, and says how it ended.
pub fn run_bridge_through(client_folder: &Path, transport: &Transport) -> BridgeExit {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => return fail(BridgeExit::Failed, &format!("could not start: {err}")),
    };
    let exit = runtime.block_on(bridge_through(client_folder, transport));
    runtime.shutdown_background();
    exit
}

async fn bridge_through(client_folder: &Path, transport: &Transport) -> BridgeExit {
    let mut keys = match ClientKeys::open(client_folder) {
        Ok(keys) => keys,
        Err(err) => return fail(BridgeExit::Failed, &err.to_string()),
    };
    // Learned before the connection that relays: the line that prints it
    // ends once it has.
    let learned = match keys.pinned_host() {
        Some(pinned) => pinned,
        None => match read_host_key(transport).await {
            Ok(host) => host,
            Err(exit) => return exit,
        },
    };
    let mut running = match Running::start(transport, &transport.line(CONNECT)) {
        Ok(running) => running,
        Err(exit) => return exit,
    };
    let stream = running.stream();
    match keys
        .connect_learning_over(stream, &running.described, &learned)
        .await
    {
        Ok(connection) => {
            let exit = relay(connection).await;
            running.finish().await;
            exit
        }
        Err(err) => running.not_connected(err).await,
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

/// Connects to the host `transport` reaches as the client whose keys are
/// `keys`, holding it to the key the client pinned and pinning nothing, for
/// `floti doctor`. The error is one line: the last one the transport wrote
/// on standard error, unedited, when it ended with a failure first, and a
/// sentence otherwise.
pub(crate) async fn reach_through(
    keys: &ClientKeys,
    transport: &Transport,
) -> Result<(Connection, Running), String> {
    let mut running = Running::spawn(transport, &transport.line(CONNECT))?;
    let stream = running.stream();
    match keys.connect_over(stream, &running.described).await {
        Ok(connection) => Ok((connection, running)),
        Err(err) => Err(running.failure_line(err).await),
    }
}

/// A transport's program, running with `floti connect` (or the line to run)
/// as its last argument.
pub(crate) struct Running {
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
        Self::spawn(transport, line).map_err(|why| fail(BridgeExit::TransportNotStarted, &why))
    }

    /// [`Self::start`], saying why it could not start rather than ending.
    fn spawn(transport: &Transport, line: &str) -> Result<Self, String> {
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
        command.args(&transport.args);
        if transport.as_written {
            command.env(UTF8_VAR, "1");
            launcher::Native.append_as_written(command.as_std_mut(), line);
        } else {
            command.arg(line);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        launcher::Native.windowless(command.as_std_mut());
        let mut child = command.spawn().map_err(|err| {
            format!(
                "could not run {}: {err}",
                transport.program.to_string_lossy()
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

    /// Why a handshake that did not finish with `err` failed, as one line:
    /// the last one the transport wrote, unedited, when it ended with a
    /// failure first, `err` otherwise.
    async fn failure_line(mut self, err: ClientError) -> String {
        let ended_early = matches!(
            err,
            ClientError::HostClosed { .. }
                | ClientError::LearnedKeyNotProven { .. }
                | ClientError::Io(_)
        );
        if ended_early
            && let Some(status) = self.exited().await
            && !status.success()
        {
            return self.last_written().await.unwrap_or_else(|| {
                format!(
                    "{} ended before the handshake finished ({status}) and wrote nothing on standard error",
                    self.described
                )
            });
        }
        let _ = self.child.kill().await;
        err.to_string()
    }

    /// Lets the program end once its standard input has closed, as `floti
    /// connect` does, and ends it if it has not by then.
    pub(crate) async fn finish(mut self) {
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
                | ClientError::LearnedKeyNotProven { .. }
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

/// How much of the end of a transport's standard error is kept to find its
/// last line in.
const STDERR_KEPT: usize = 64 * 1024;

/// Reads `stderr` to its end, keeping the last line that is not blank, as
/// written but for its line ending.
async fn last_line(stderr: ChildStderr) -> Option<String> {
    let mut reader = stderr;
    let mut kept: Vec<u8> = Vec::new();
    let mut buf = vec![0; 8 * 1024];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                kept.extend_from_slice(&buf[..n]);
                if kept.len() > STDERR_KEPT * 2 {
                    // An even cut keeps UTF-16 aligned.
                    let cut = (kept.len() - STDERR_KEPT) & !1;
                    kept.drain(..cut);
                }
            }
        }
    }
    last_line_of(&kept)
}

/// The last line in `bytes` that is not blank, without its line ending.
/// `wsl.exe` writes UTF-16LE (always, when it runs on another PC through
/// ssh), so bytes that are UTF-16LE are read as that, others as UTF-8.
pub fn last_line_of(bytes: &[u8]) -> Option<String> {
    let text = decode_output(bytes);
    text.lines()
        .map(|line| line.trim_end_matches(['\r', '\n']))
        .rfind(|line| !line.trim().is_empty())
        .map(str::to_owned)
}

/// `bytes` as text: UTF-16LE when they are, else UTF-8 with anything that is
/// not replaced.
pub fn decode_output(bytes: &[u8]) -> String {
    if looks_utf16le(bytes) {
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect();
        let text = String::from_utf16_lossy(&units);
        return text.strip_prefix('\u{feff}').unwrap_or(&text).to_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// Whether `bytes` read as UTF-16LE: a byte-order mark, or text whose every
/// other byte is mostly zero, as ASCII is in UTF-16LE and never in UTF-8.
fn looks_utf16le(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0xff, 0xfe]) {
        return true;
    }
    if bytes.len() < 2 {
        return false;
    }
    let pairs = bytes.len() / 2;
    let high_zero = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .filter(|pair| pair[1] == 0)
        .count();
    let low_zero = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .filter(|pair| pair[0] == 0)
        .count();
    high_zero * 2 > pairs && low_zero * 4 < pairs
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
