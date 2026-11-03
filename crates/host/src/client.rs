//! A client's side of a connection, for the clients that link this crate
//! (the TUI, `floti connect` and `floti bridge`): its keys on disk, and a Noise session to a
//! host on the local socket.
//!
//! In the folder a client names it keeps two files and nothing else: its
//! device key ([`DEVICE_KEY_FILE`]), made once and owner-only, and the host
//! key it pinned the first time it connected ([`PINNED_HOST_FILE`]).
//! Screens, files, transcripts and everything else a host sends stay in the
//! client's memory.
//!
//! [`connect`] runs the handshake as the initiator before anything else
//! crosses the socket, and refuses a host that does not prove the pinned key
//! without sending it anything more than the first handshake message, which
//! only the pinned key can read.
//!
//! Nothing else is asked: whatever reaches the host's socket and
//! completes the handshake is served. A client that has pinned no host yet
//! learns the host's key the way it reaches the host (on the host's own
//! computer from the host's data folder, [`ClientKeys::connect_local`];
//! through a transport, from `floti connect --host-key` run over it), holds
//! the host to it, and pins it only once the host has proven it
//! ([`ClientKeys::connect_learning_over`]). From then on a host proving
//! another key is refused.
//!
//! A host on another computer is reached through a transport that carries
//! bytes unchanged, such as `ssh <target> floti connect`: its standard output
//! and input, joined by [`duplex`], are the stream
//! [`ClientKeys::connect_over`] runs the same handshake over. The transport
//! is the access: it is the user's own login on that computer. The handshake
//! holds the host to its key.

use std::fmt;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use floti_protocol::channel::{RequestChannel, from_payload, to_payload};
use floti_protocol::message::{ClientInfo, ClientKind, ErrorReply, Hello, Request, Welcome};
use floti_protocol::noise::{
    Initiator, InitiatorStep, KeyPair, NoiseError, Opener, PublicKey, Sealer,
};
use floti_protocol::{FrameDecoder, Message, PROTOCOL_VERSION, ProtocolError, encode_frame};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};

use crate::keys::{load_or_create_key_pair, read_key_pair};
use crate::platform::private_files::{Native as NativeFiles, PrivateFiles, sweep_stale_temps};
use crate::platform::process_tree;
use crate::platform::socket::{Endpoint, LocalSocket, LocalStream, Native as NativeSocket};
use crate::server::{HANDSHAKE_DEADLINE, host_public_key};
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
    /// program that must reach only a host this client has already connected
    /// to, never pin one, and leave a folder it does not use as it was.
    pub fn open_pinned(folder: &Path) -> Result<Option<Self>> {
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

    /// The device's public key, which names this device to every host.
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
        )
        .await
    }

    /// Connects over `stream`, holding the host to `learned`, the key
    /// learned the way `stream` reaches it, while this client has pinned no
    /// host, and pins that key once the host has proven it. A client that
    /// has pinned one connects as [`Self::connect_over`] does, holding the
    /// host to that one.
    pub async fn connect_learning_over(
        &mut self,
        stream: LocalStream,
        at: &str,
        learned: &PublicKey,
    ) -> Result<Connection, ClientError> {
        if self.pinned.is_some() {
            return self.connect_over(stream, at).await;
        }
        let connection = connect_over(
            stream,
            at,
            TRANSPORT_HANDSHAKE_DEADLINE,
            &self.device,
            learned,
        )
        .await
        .map_err(|err| not_proven_as_learned(err, learned))?;
        self.pin_host(connection.host_key())
            .map_err(ClientError::Local)?;
        Ok(connection)
    }

    /// Connects to the host on this computer at `endpoint`, whose data
    /// folder is `host_data`. A client that has pinned a host connects as
    /// [`Self::connect`] does. One that has pinned none holds the host to the
    /// key kept in that folder, which only this OS user can read, and pins it
    /// once the host has proven it; [`ClientError::NotStarted`] when no host
    /// has started there yet.
    pub async fn connect_local(
        &mut self,
        endpoint: &Endpoint,
        host_data: &Path,
    ) -> Result<Connection, ClientError> {
        if self.pinned.is_some() {
            return self.connect(endpoint).await;
        }
        let host = host_public_key(host_data)
            .map_err(ClientError::Local)?
            .ok_or_else(|| ClientError::NotStarted {
                folder: host_data.display().to_string(),
            })?;
        let connection = connect(endpoint, &self.device, &host)
            .await
            .map_err(|err| not_proven_as_learned(err, &host))?;
        self.pin_host(connection.host_key())
            .map_err(ClientError::Local)?;
        Ok(connection)
    }
}

/// A host that did not prove the key a client learned for it, before the
/// client pinned anything, said as that rather than as a pinned key.
fn not_proven_as_learned(err: ClientError, host: &PublicKey) -> ClientError {
    match err {
        ClientError::HostNotProven { at, .. } | ClientError::HostClosed { at, .. } => {
            ClientError::LearnedKeyNotProven {
                at,
                host: host.fingerprint(),
            }
        }
        other => other,
    }
}

/// A client's `hello` naming it `name`, of `kind`, declaring no capability.
fn hello(name: &str, kind: ClientKind) -> Message {
    Message::Hello(Hello {
        protocol: PROTOCOL_VERSION,
        client: ClientInfo {
            name: name.to_owned(),
            kind,
            device_name: None,
        },
        capabilities: Vec::new(),
    })
}

fn kind_of(message: &Message) -> &'static str {
    match message {
        Message::Welcome(_) => "a welcome",
        Message::Response(_) => "a response",
        Message::Error(_) => "an error",
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
    #[error("this client has pinned no host key yet; connect it to a host first")]
    NotPinned,

    /// No host has started on this computer's data folder yet, so there is
    /// no key to hold one to.
    #[error("no host has started on {folder} yet")]
    NotStarted { folder: String },

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

    /// The host closed the connection without answering, as a host holding
    /// another key than the pinned one does, since it cannot read the first
    /// message.
    #[error(
        "the host at {at} did not prove the key this client pinned ({pinned}): it closed the connection during the handshake, as a host holding another key does"
    )]
    HostClosed { at: String, pinned: String },

    /// A client that had pinned nothing held the host to the key it learned
    /// for it, and the host did not prove it: it holds another key, so it
    /// could not read the first message and closed the connection, or its
    /// answer was not the one that key makes. Nothing more was sent to it
    /// and no key was pinned.
    #[error(
        "the host at {at} did not prove the key it was known by ({host}), so nothing more was sent to it and no host key was pinned"
    )]
    LearnedKeyNotProven { at: String, host: String },

    /// A file of the client's, or the host's key, could not be read or
    /// written.
    #[error("{0}")]
    Local(Error),

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
    let stream = open_socket(endpoint).await?;
    connect_over(
        stream,
        &endpoint.to_string(),
        HANDSHAKE_DEADLINE,
        device,
        host,
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

/// [`connect`], over `stream`, however it reaches the host: the local
/// socket, or a transport's standard input and output. `at` names it in
/// errors.
async fn connect_over(
    mut stream: LocalStream,
    at: &str,
    deadline: Duration,
    device: &KeyPair,
    host: &PublicKey,
) -> Result<Connection, ClientError> {
    let handshake = tokio::time::timeout(deadline, handshake(&mut stream, device, host));
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
) -> std::result::Result<(floti_protocol::noise::Transport, Vec<u8>), Handshake> {
    let (mut initiator, first) =
        Initiator::start(device, host).map_err(|err| Handshake::Failed(err.into()))?;
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
