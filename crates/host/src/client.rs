//! A client's side of a connection, for the clients that link this crate
//! (the TUI, `floti connect` and `floti bridge`): its keys on disk, and a Noise session to a
//! host on the local socket.
//!
//! In the folder a client names it keeps two files and nothing else: its
//! device key ([`DEVICE_KEY_FILE`]), made once and owner-only, and the host
//! key it pinned at pairing ([`PINNED_HOST_FILE`]). Screens, files,
//! transcripts and everything else a host sends stay in the client's memory.
//!
//! [`connect`] runs the handshake as the initiator before anything else
//! crosses the socket, and refuses a host that does not prove the pinned key
//! without sending it anything more than the first handshake message, which
//! only the pinned key can read.
//!
//! A client on the host's own computer that has pinned no host yet enrols
//! with [`ClientKeys::connect_local`]: while the host waits for its first
//! admin, its data folder holds the enrolment file
//! ([`ENROLMENT_FILE`](crate::server::ENROLMENT_FILE)) naming its key and a
//! one-time code. The client carries the code in its first handshake
//! message, holds the host to the file's key, and pins that key only once
//! the host has proven it. The code is never printed or stored by the client.
//!
//! Any other client pairs by asking: [`ClientKeys::ask_to_pair`] holds the
//! host to a key the client learned another way (a client on the host's
//! computer reads it from the host's data folder,
//! [`ClientKeys::ask_local_to_pair`]), asks in its first handshake message,
//! says `hello`, and is told a short code to show. Someone on the host's
//! computer approves that code with `floti devices approve`;
//! [`ClientKeys::finish_pairing`] waits for that, and pins the host key only
//! once the host says the device is paired. From then on the client connects
//! as itself ([`ClientKeys::connect`]).
//!
//! A host on another computer is reached through a transport that carries
//! bytes unchanged, such as `ssh <target> floti connect`: its standard output
//! and input, joined by [`duplex`], are the stream
//! [`ClientKeys::connect_over`] and [`ClientKeys::ask_to_pair_over`] run the
//! same handshake over. The transport only makes the host reachable; the
//! handshake is what lets the client in, and holds the host to its key.

use std::fmt;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use floti_protocol::channel::{RequestChannel, from_payload, to_payload};
use floti_protocol::channels::devices::DeviceRole;
use floti_protocol::message::{
    ClientInfo, ClientKind, ErrorReply, Hello, Pairing, Request, Welcome,
};
use floti_protocol::noise::{
    EnrolmentCode, Initiator, InitiatorStep, KeyPair, NoiseError, Opener, PublicKey, Sealer,
};
use floti_protocol::{FrameDecoder, Message, PROTOCOL_VERSION, ProtocolError, encode_frame};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};

use crate::keys::{load_or_create_key_pair, read_key_pair};
use crate::platform::private_files::{Native as NativeFiles, PrivateFiles, sweep_stale_temps};
use crate::platform::process_tree;
use crate::platform::socket::{Endpoint, LocalSocket, LocalStream, Native as NativeSocket};
use crate::server::{HANDSHAKE_DEADLINE, host_public_key, read_enrolment};
use crate::{Error, Result};

/// The client's device key in its folder.
pub const DEVICE_KEY_FILE: &str = "device.key";

/// The host key the client pinned, as 64 hex digits, in its folder.
pub const PINNED_HOST_FILE: &str = "host.pub";

/// How long a client gives a host reached through a transport to finish the
/// handshake, from when the transport starts. Longer than the local socket's
/// [`HANDSHAKE_DEADLINE`]: the transport's own login comes first (`ssh`
/// connecting and signing in with the user's keys or agent), which in batch
/// mode never waits on a person but may cross a slow network.
pub const TRANSPORT_HANDSHAKE_DEADLINE: Duration = Duration::from_secs(30);

const READ_CHUNK: usize = 64 * 1024;

/// What a client keeps on disk: its device key and the host key it pinned.
pub struct ClientKeys {
    folder: PathBuf,
    device: KeyPair,
    pinned: Option<PublicKey>,
}

impl ClientKeys {
    /// The keys in `folder`, which is made if it is new. The device key is
    /// made the first time and the same key is read back every time after.
    pub fn open(folder: &Path) -> Result<Self> {
        std::fs::create_dir_all(folder)
            .map_err(|source| Error::path("create the client's folder", folder, source))?;
        // A key write killed partway leaves its new file; it goes once the
        // process that made it is gone, so the folder holds the two files.
        sweep_stale_temps(
            folder,
            &[DEVICE_KEY_FILE, PINNED_HOST_FILE],
            &process_tree::Native,
        );
        let device = load_or_create_key_pair(&folder.join(DEVICE_KEY_FILE))?;
        let pinned = read_pinned(folder)?;
        Ok(Self {
            folder: folder.to_path_buf(),
            device,
            pinned,
        })
    }

    /// The keys in `folder` when it holds both a device key and a pinned
    /// host key, and `None` otherwise, making and changing nothing: for a
    /// program that must reach only a host this client already paired with,
    /// never pair or enrol, and leave a folder it does not use as it was.
    pub fn open_paired(folder: &Path) -> Result<Option<Self>> {
        let Some(device) = read_key_pair(&folder.join(DEVICE_KEY_FILE))? else {
            return Ok(None);
        };
        Ok(read_pinned(folder)?.map(|pinned| Self {
            folder: folder.to_path_buf(),
            device,
            pinned: Some(pinned),
        }))
    }

    pub fn folder(&self) -> &Path {
        &self.folder
    }

    /// The device's public key, the one a host's registry holds.
    pub fn device_key(&self) -> PublicKey {
        self.device.public()
    }

    /// The host key this client pinned, once it has.
    pub fn pinned_host(&self) -> Option<PublicKey> {
        self.pinned
    }

    /// Pins `host`, replacing any key pinned before.
    pub fn pin_host(&mut self, host: PublicKey) -> Result<()> {
        let mut text = host.to_hex();
        text.push('\n');
        NativeFiles.write(&self.folder.join(PINNED_HOST_FILE), text.as_bytes())?;
        self.pinned = Some(host);
        Ok(())
    }

    /// Connects to the host at `endpoint` as this device, holding it to the
    /// pinned key.
    pub async fn connect(&self, endpoint: &Endpoint) -> Result<Connection, ClientError> {
        let pinned = self.pinned.ok_or(ClientError::NotPinned)?;
        connect(endpoint, &self.device, &pinned).await
    }

    /// [`Self::connect`], over `stream`, a byte stream that reaches the host
    /// some other way than its local socket: a transport such as
    /// `ssh <target> floti connect`, which carries the bytes unchanged.
    /// `at` names it in errors. The handshake holds the host to the pinned
    /// key exactly as on the socket.
    pub async fn connect_over(
        &self,
        stream: LocalStream,
        at: &str,
    ) -> Result<Connection, ClientError> {
        let pinned = self.pinned.ok_or(ClientError::NotPinned)?;
        connect_over(
            stream,
            at,
            TRANSPORT_HANDSHAKE_DEADLINE,
            &self.device,
            &pinned,
            Ask::Plain,
        )
        .await
    }

    /// Connects to the host on this computer at `endpoint`, whose data
    /// folder is `host_data`. While that host waits for its first admin, its
    /// enrolment file is there: a client that has pinned no host enrols with
    /// it, holding the host to the file's key, and pins that key once the
    /// host has proven it; one pinned to the file's key carries the code
    /// too. Otherwise it connects as [`Self::connect`] does, and a client
    /// with no pinned key reports [`ClientError::NotPinned`] without
    /// connecting.
    pub async fn connect_local(
        &mut self,
        endpoint: &Endpoint,
        host_data: &Path,
    ) -> Result<Connection, ClientError> {
        let enrolment = read_enrolment(host_data).map_err(ClientError::Local)?;
        match (self.pinned, enrolment) {
            (None, Some(enrolment)) => {
                let host = enrolment.host_key;
                let connection =
                    connect_with(endpoint, &self.device, &host, Ask::Enrol(&enrolment.code))
                        .await
                        .map_err(|err| match err {
                            ClientError::HostNotProven { at, .. }
                            | ClientError::HostClosed { at, .. } => {
                                ClientError::EnrolmentNotProven {
                                    at,
                                    host: host.fingerprint(),
                                }
                            }
                            other => other,
                        })?;
                drop(enrolment);
                self.pin_host(connection.host_key())
                    .map_err(ClientError::Local)?;
                Ok(connection)
            }
            (Some(pinned), Some(enrolment)) if enrolment.host_key == pinned => {
                connect_with(endpoint, &self.device, &pinned, Ask::Enrol(&enrolment.code)).await
            }
            _ => self.connect(endpoint).await,
        }
    }

    /// Asks the host at `endpoint`, holding it to `host`, to pair this
    /// device, which it does not know yet, named `name`: the handshake asking,
    /// then `hello`, then the code the host answers with, to show. Pins
    /// nothing; [`Self::finish_pairing`] waits for the outcome.
    pub async fn ask_to_pair(
        &self,
        endpoint: &Endpoint,
        host: &PublicKey,
        name: &str,
        kind: ClientKind,
    ) -> Result<PairingRequest, ClientError> {
        let stream = open_socket(endpoint).await?;
        let at = endpoint.to_string();
        self.ask_to_pair_with(stream, &at, HANDSHAKE_DEADLINE, host, name, kind)
            .await
    }

    /// [`Self::ask_to_pair`], over `stream`, a byte stream that reaches the
    /// host some other way than its local socket ([`Self::connect_over`]),
    /// named `at` in errors. `host` is the key learned through the same
    /// transport (`floti connect --host-key`), and the host is held to it.
    pub async fn ask_to_pair_over(
        &self,
        stream: LocalStream,
        at: &str,
        host: &PublicKey,
        name: &str,
        kind: ClientKind,
    ) -> Result<PairingRequest, ClientError> {
        self.ask_to_pair_with(stream, at, TRANSPORT_HANDSHAKE_DEADLINE, host, name, kind)
            .await
    }

    async fn ask_to_pair_with(
        &self,
        stream: LocalStream,
        at: &str,
        deadline: Duration,
        host: &PublicKey,
        name: &str,
        kind: ClientKind,
    ) -> Result<PairingRequest, ClientError> {
        let mut connection = connect_over(stream, at, deadline, &self.device, host, Ask::Pair)
            .await
            .map_err(|err| match err {
                ClientError::HostNotProven { at, .. } | ClientError::HostClosed { at, .. } => {
                    ClientError::PairingNotAnswered {
                        at,
                        host: host.fingerprint(),
                    }
                }
                other => other,
            })?;
        connection.send(&hello(name, kind)).await?;
        match connection.next().await? {
            Some(Message::Pairing(Pairing::Waiting(waiting))) => Ok(PairingRequest {
                connection,
                code: waiting.code,
                expires_in_seconds: waiting.expires_in_seconds,
            }),
            Some(Message::Refused(refused)) => Err(ClientError::Refused(refused.message)),
            Some(other) => Err(ClientError::Unexpected(kind_of(&other))),
            None => Err(ClientError::PairingEnded),
        }
    }

    /// [`Self::ask_to_pair`], to the host on this computer at `endpoint`,
    /// whose data folder is `host_data`: the host is held to the key kept
    /// there.
    pub async fn ask_local_to_pair(
        &self,
        endpoint: &Endpoint,
        host_data: &Path,
        name: &str,
        kind: ClientKind,
    ) -> Result<PairingRequest, ClientError> {
        let host = host_public_key(host_data)
            .map_err(ClientError::Local)?
            .ok_or_else(|| ClientError::Unreachable {
                at: endpoint.to_string(),
                source: Error::Refused(format!(
                    "no host has started on {} yet",
                    host_data.display()
                )),
            })?;
        self.ask_to_pair(endpoint, &host, name, kind).await
    }

    /// Waits for `request` to be approved or to expire. Once approved, the
    /// host key it proved is pinned, and the client connects as itself from
    /// then on.
    pub async fn finish_pairing(
        &mut self,
        mut request: PairingRequest,
    ) -> Result<PairingOutcome, ClientError> {
        loop {
            match request.connection.next().await? {
                Some(Message::Pairing(Pairing::Approved(approved))) => {
                    self.pin_host(request.connection.host_key())
                        .map_err(ClientError::Local)?;
                    return Ok(PairingOutcome::Approved(approved.role));
                }
                Some(Message::Pairing(Pairing::Expired)) => return Ok(PairingOutcome::Expired),
                Some(_) => {}
                None => return Err(ClientError::PairingEnded),
            }
        }
    }
}

/// A request to pair that waits on the host: its connection, held open until
/// the host says how it ended, and the code to show. Dropping it withdraws
/// the request.
pub struct PairingRequest {
    connection: Connection,
    code: String,
    expires_in_seconds: u64,
}

impl PairingRequest {
    /// The code to show, for `floti devices approve <code>` on the host's
    /// computer.
    pub fn code(&self) -> &str {
        &self.code
    }

    /// How long, from when the host answered, the request waits.
    pub fn expires_in_seconds(&self) -> u64 {
        self.expires_in_seconds
    }

    /// The key the host proved, which the client pins once approved.
    pub fn host_key(&self) -> PublicKey {
        self.connection.host_key()
    }

    /// Sends the host `message` on the waiting connection, which the host
    /// answers by withdrawing the request: for a test of just that.
    pub async fn send(&mut self, message: &Message) -> Result<(), ClientError> {
        self.connection.send(message).await
    }
}

impl fmt::Debug for PairingRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PairingRequest")
            .field("host", &self.connection.host_key())
            .finish_non_exhaustive()
    }
}

/// How a request to pair ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingOutcome {
    /// Approved with this role; the host key is pinned.
    Approved(DeviceRole),
    /// Nobody approved it in time; nothing was pinned.
    Expired,
}

/// A client's `hello` naming it `name`, of `kind`, declaring no capability.
fn hello(name: &str, kind: ClientKind) -> Message {
    Message::Hello(Hello {
        protocol: PROTOCOL_VERSION,
        client: ClientInfo {
            name: name.to_owned(),
            kind,
        },
        capabilities: Vec::new(),
    })
}

fn kind_of(message: &Message) -> &'static str {
    match message {
        Message::Welcome(_) => "a welcome",
        Message::Response(_) => "a response",
        Message::Error(_) => "an error",
        Message::Pairing(_) => "a pairing message",
        _ => "another message",
    }
}

/// The host key pinned in `folder`, or `None` when it has pinned none.
fn read_pinned(folder: &Path) -> Result<Option<PublicKey>> {
    let path = folder.join(PINNED_HOST_FILE);
    NativeFiles
        .read(&path)?
        .map(|bytes| {
            String::from_utf8_lossy(&bytes)
                .trim()
                .parse::<PublicKey>()
                .map_err(|_| {
                    Error::Refused(format!(
                        "{} does not hold a host key: it should be 64 hex digits.",
                        path.display()
                    ))
                })
        })
        .transpose()
}

impl fmt::Debug for ClientKeys {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientKeys")
            .field("folder", &self.folder)
            .field("device", &self.device.public())
            .field("pinned", &self.pinned)
            .finish()
    }
}

/// Why a client could not connect or talk to a host.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("this client has pinned no host key yet; pair it with a host first")]
    NotPinned,

    #[error("no host answered at {at}: {source}")]
    Unreachable {
        at: String,
        #[source]
        source: Error,
    },

    /// The host on the socket holds another key than the pinned one, or did
    /// not answer with a handshake at all. Nothing more was sent to it.
    #[error(
        "the host at {at} did not prove the key this client pinned ({pinned}), so nothing was sent to it"
    )]
    HostNotProven { at: String, pinned: String },

    /// The host closed the connection without answering. A host holding
    /// another key than the pinned one does that, since it cannot read the
    /// first message, and so does the pinned host to a device it does not
    /// know or has revoked; a host never says which.
    #[error(
        "the host at {at} did not prove the key this client pinned ({pinned}): it closed the connection during the handshake, as a host holding another key does, and as a host does to a device it has not paired or has revoked"
    )]
    HostClosed { at: String, pinned: String },

    /// The host on the socket is not the one the enrolment file names: it
    /// holds another key, so it could not read the first message and closed
    /// the connection, or its answer was not the one that key makes. Nothing
    /// more was sent to it and no key was pinned.
    #[error(
        "the host at {at} did not prove the key its enrolment file names ({host}), so nothing more was sent to it and no host key was pinned"
    )]
    EnrolmentNotProven { at: String, host: String },

    /// A file of the client's or the host's enrolment file could not be read
    /// or written.
    #[error("{0}")]
    Local(Error),

    /// The host closed a connection asking to pair during the handshake, or
    /// its answer was not the one the key the client held it to makes.
    /// Nothing more was sent to it and no key was pinned.
    #[error(
        "the host at {at} did not answer this device's request to pair: it holds another key than {host}, has paired or revoked this device already, or has as many requests waiting as it takes"
    )]
    PairingNotAnswered { at: String, host: String },

    /// The host closed a connection asking to pair without saying how the
    /// request ended: the device asked again elsewhere, or the host stopped.
    #[error("the host closed the connection without saying how the request to pair ended")]
    PairingEnded,

    /// The host refused the client's `hello`, saying why.
    #[error("{0}")]
    Refused(String),

    /// The host answered with a message the client did not expect there.
    #[error("the host answered with {0}")]
    Unexpected(&'static str),

    #[error("the host at {at} did not finish the handshake within {within:?}")]
    TimedOut { at: String, within: Duration },

    #[error("the session with the host failed: {0}")]
    Session(#[from] NoiseError),

    #[error("the host sent a message that does not decode: {0}")]
    Protocol(#[from] ProtocolError),

    #[error("could not talk to the host: {0}")]
    Io(#[from] std::io::Error),
}

/// Connects to the host at `endpoint` as `device`, holding it to `host`, the
/// pinned key: the handshake, then a connection that seals every frame it
/// sends and opens every one it receives.
pub async fn connect(
    endpoint: &Endpoint,
    device: &KeyPair,
    host: &PublicKey,
) -> Result<Connection, ClientError> {
    connect_with(endpoint, device, host, Ask::Plain).await
}

/// What a first handshake message carries besides the device's key.
#[derive(Clone, Copy)]
enum Ask<'a> {
    /// Nothing: a paired device.
    Plain,
    /// The code a first admin enrols with.
    Enrol(&'a EnrolmentCode),
    /// The ask to pair.
    Pair,
}

/// [`connect`], with the first handshake message carrying `ask`.
async fn connect_with(
    endpoint: &Endpoint,
    device: &KeyPair,
    host: &PublicKey,
    ask: Ask<'_>,
) -> Result<Connection, ClientError> {
    let stream = open_socket(endpoint).await?;
    connect_over(
        stream,
        &endpoint.to_string(),
        HANDSHAKE_DEADLINE,
        device,
        host,
        ask,
    )
    .await
}

/// The host's local socket at `endpoint`, opened.
async fn open_socket(endpoint: &Endpoint) -> Result<LocalStream, ClientError> {
    NativeSocket
        .connect(endpoint)
        .await
        .map_err(|source| ClientError::Unreachable {
            at: endpoint.to_string(),
            source,
        })
}

/// [`connect_with`], over `stream`, however it reaches the host: the local
/// socket, or a transport's standard input and output. `at` names it in
/// errors.
async fn connect_over(
    mut stream: LocalStream,
    at: &str,
    deadline: Duration,
    device: &KeyPair,
    host: &PublicKey,
    ask: Ask<'_>,
) -> Result<Connection, ClientError> {
    let handshake = tokio::time::timeout(deadline, handshake(&mut stream, device, host, ask));
    let (transport, rest) = match handshake.await {
        Ok(Ok(done)) => done,
        Ok(Err(Handshake::NotProven)) => {
            return Err(ClientError::HostNotProven {
                at: at.to_owned(),
                pinned: host.fingerprint(),
            });
        }
        Ok(Err(Handshake::Closed)) => {
            return Err(ClientError::HostClosed {
                at: at.to_owned(),
                pinned: host.fingerprint(),
            });
        }
        Ok(Err(Handshake::Failed(err))) => return Err(err),
        Err(_) => {
            return Err(ClientError::TimedOut {
                at: at.to_owned(),
                within: deadline,
            });
        }
    };
    let host = transport.peer();
    let (sealer, mut opener) = transport.split();
    let mut decoder = FrameDecoder::new();
    decoder.push(&opener.open(&rest)?);
    Ok(Connection {
        stream,
        sealer,
        opener,
        decoder,
        host,
        buf: vec![0; READ_CHUNK],
        ended: false,
    })
}

enum Handshake {
    NotProven,
    Closed,
    Failed(ClientError),
}

/// The initiator's half of the handshake: the session, and any bytes read
/// past the host's answer, which belong to it.
async fn handshake(
    stream: &mut LocalStream,
    device: &KeyPair,
    host: &PublicKey,
    ask: Ask<'_>,
) -> std::result::Result<(floti_protocol::noise::Transport, Vec<u8>), Handshake> {
    let started = match ask {
        Ask::Plain => Initiator::start(device, host),
        Ask::Enrol(code) => Initiator::start_enrolling(device, host, code),
        Ask::Pair => Initiator::start_pairing(device, host),
    };
    let (mut initiator, first) = started.map_err(|err| Handshake::Failed(err.into()))?;
    stream
        .write_all(&first)
        .await
        .map_err(|err| Handshake::Failed(err.into()))?;
    let mut buf = vec![0; READ_CHUNK];
    loop {
        let n = match stream.read(&mut buf).await {
            Ok(0) => return Err(Handshake::Closed),
            Ok(n) => n,
            Err(err) if is_closed(&err) => return Err(Handshake::Closed),
            Err(err) => return Err(Handshake::Failed(err.into())),
        };
        match initiator.push(&buf[..n]) {
            Ok(InitiatorStep::Pending(next)) => initiator = next,
            Ok(InitiatorStep::Done { transport, used }) => {
                return Ok((transport, buf[used..n].to_vec()));
            }
            Err(NoiseError::HostNotProven) => return Err(Handshake::NotProven),
            Err(err) => return Err(Handshake::Failed(err.into())),
        }
    }
}

/// A connection the host has proven its key on: every frame sealed on the
/// way out and opened on the way in.
pub struct Connection {
    stream: LocalStream,
    sealer: Sealer,
    opener: Opener,
    decoder: FrameDecoder,
    host: PublicKey,
    buf: Vec<u8>,
    ended: bool,
}

impl Connection {
    /// The key the host proved.
    pub fn host_key(&self) -> PublicKey {
        self.host
    }

    /// Sends one message, sealed.
    pub async fn send(&mut self, message: &Message) -> Result<(), ClientError> {
        let frame = encode_frame(message)?;
        let sealed = self.sealer.seal(&frame)?;
        self.stream.write_all(&sealed).await?;
        Ok(())
    }

    /// The next message from the host, or `None` once it has closed the
    /// connection. Safe to cancel, as in a `select!` or a timeout: nothing
    /// read is lost.
    pub async fn next(&mut self) -> Result<Option<Message>, ClientError> {
        loop {
            if let Some(message) = self.decoder.next_message()? {
                return Ok(Some(message));
            }
            if self.ended {
                return Ok(None);
            }
            let n = match self.stream.read(&mut self.buf).await {
                Ok(n) => n,
                Err(err) if is_closed(&err) => 0,
                Err(err) => return Err(err.into()),
            };
            if n == 0 {
                self.ended = true;
                self.opener.finish()?;
                continue;
            }
            let opened = self.opener.open(&self.buf[..n])?;
            self.decoder.push(&opened);
        }
    }

    /// Says `hello` as `name`, of `kind`, declaring no capability, and is
    /// welcomed; the host's refusal is [`ClientError::Refused`].
    pub async fn say_hello(
        &mut self,
        name: &str,
        kind: ClientKind,
    ) -> Result<Welcome, ClientError> {
        self.send(&hello(name, kind)).await?;
        match self.next().await? {
            Some(Message::Welcome(welcome)) => Ok(welcome),
            Some(Message::Refused(refused)) => Err(ClientError::Refused(refused.message)),
            Some(other) => Err(ClientError::Unexpected(kind_of(&other))),
            None => Err(ClientError::Io(ErrorKind::UnexpectedEof.into())),
        }
    }

    /// Makes request `id` on `C` and waits for its answer, setting aside
    /// nothing else: for a client that makes one request at a time. The
    /// host's error reply is the inner `Err`.
    pub async fn request<C: RequestChannel>(
        &mut self,
        id: u64,
        request: &C::Request,
    ) -> Result<Result<C::Response, ErrorReply>, ClientError> {
        let payload = to_payload(request).map_err(|err| {
            ClientError::Local(Error::Refused(format!(
                "`{}` does not encode: {err}",
                C::NAME
            )))
        })?;
        self.send(&Message::Request(Request {
            id,
            channel: C::NAME.to_owned(),
            payload,
        }))
        .await?;
        loop {
            match self.next().await? {
                Some(Message::Response(response)) if response.id == id => {
                    return from_payload(&response.payload).map(Ok).map_err(|err| {
                        ClientError::Local(Error::Refused(format!(
                            "the host's answer to `{}` does not decode: {err}",
                            C::NAME
                        )))
                    });
                }
                Some(Message::Error(error)) if error.id == id => return Ok(Err(error)),
                Some(_) => {}
                None => return Err(ClientError::Io(ErrorKind::UnexpectedEof.into())),
            }
        }
    }

    /// Closes the connection: everything sent before it reaches the host,
    /// which then reads the connection as ended.
    pub async fn close(mut self) {
        let _ = self.stream.shutdown().await;
    }
}

impl fmt::Debug for Connection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Connection")
            .field("host", &self.host)
            .field("ended", &self.ended)
            .finish_non_exhaustive()
    }
}

/// One byte stream made of a reader and a writer, for a [`Connection`] to
/// run over ([`ClientKeys::connect_over`]): a transport's standard output and
/// standard input. Shutting it down shuts the writer down; dropping it closes
/// both, which is what ends a transport's standard input.
pub fn duplex(
    reader: impl AsyncRead + Send + Unpin + 'static,
    writer: impl AsyncWrite + Send + Unpin + 'static,
) -> LocalStream {
    Box::pin(Duplex { reader, writer })
}

struct Duplex<R, W> {
    reader: R,
    writer: W,
}

impl<R: AsyncRead + Unpin, W: Unpin> AsyncRead for Duplex<R, W> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().reader).poll_read(cx, buf)
    }
}

impl<R: Unpin, W: AsyncWrite + Unpin> AsyncWrite for Duplex<R, W> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.get_mut().writer).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().writer).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().writer).poll_shutdown(cx)
    }
}

/// A read error that is the other end having closed: what a pipe reports on
/// Windows where a Unix socket reads as ended.
pub fn is_closed(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        ErrorKind::BrokenPipe | ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted
    )
}
