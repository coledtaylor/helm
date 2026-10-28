//! A client's side of a connection, for the clients that link this crate
//! (the TUI and `floti connect`): its keys on disk, and a Noise session to a
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

use std::fmt;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use floti_protocol::noise::{
    Initiator, InitiatorStep, KeyPair, NoiseError, Opener, PublicKey, Sealer,
};
use floti_protocol::{FrameDecoder, Message, ProtocolError, encode_frame};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::keys::load_or_create_key_pair;
use crate::platform::private_files::{Native as NativeFiles, PrivateFiles, sweep_stale_temps};
use crate::platform::process_tree;
use crate::platform::socket::{Endpoint, LocalSocket, LocalStream, Native as NativeSocket};
use crate::server::HANDSHAKE_DEADLINE;
use crate::{Error, Result};

/// The client's device key in its folder.
pub const DEVICE_KEY_FILE: &str = "device.key";

/// The host key the client pinned, as 64 hex digits, in its folder.
pub const PINNED_HOST_FILE: &str = "host.pub";

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
        let pinned_path = folder.join(PINNED_HOST_FILE);
        let pinned = NativeFiles
            .read(&pinned_path)?
            .map(|bytes| {
                String::from_utf8_lossy(&bytes)
                    .trim()
                    .parse::<PublicKey>()
                    .map_err(|_| {
                        Error::Refused(format!(
                            "{} does not hold a host key: it should be 64 hex digits.",
                            pinned_path.display()
                        ))
                    })
            })
            .transpose()?;
        Ok(Self {
            folder: folder.to_path_buf(),
            device,
            pinned,
        })
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

    #[error("no host answered at {endpoint}: {source}")]
    Unreachable {
        endpoint: Endpoint,
        #[source]
        source: Error,
    },

    /// The host on the socket holds another key than the pinned one, or did
    /// not answer with a handshake at all. Nothing more was sent to it.
    #[error(
        "the host at {endpoint} did not prove the key this client pinned ({pinned}), so nothing was sent to it"
    )]
    HostNotProven { endpoint: Endpoint, pinned: String },

    /// The host closed the connection without answering. A host holding
    /// another key than the pinned one does that, since it cannot read the
    /// first message, and so does the pinned host to a device it does not
    /// know or has revoked; a host never says which.
    #[error(
        "the host at {endpoint} did not prove the key this client pinned ({pinned}): it closed the connection during the handshake, as a host holding another key does, and as a host does to a device it has not paired or has revoked"
    )]
    HostClosed { endpoint: Endpoint, pinned: String },

    #[error("the host at {endpoint} did not finish the handshake within {HANDSHAKE_DEADLINE:?}")]
    TimedOut { endpoint: Endpoint },

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
    let mut stream =
        NativeSocket
            .connect(endpoint)
            .await
            .map_err(|source| ClientError::Unreachable {
                endpoint: endpoint.clone(),
                source,
            })?;
    let handshake = tokio::time::timeout(HANDSHAKE_DEADLINE, handshake(&mut stream, device, host));
    let (transport, rest) = match handshake.await {
        Ok(Ok(done)) => done,
        Ok(Err(Handshake::NotProven)) => {
            return Err(ClientError::HostNotProven {
                endpoint: endpoint.clone(),
                pinned: host.fingerprint(),
            });
        }
        Ok(Err(Handshake::Closed)) => {
            return Err(ClientError::HostClosed {
                endpoint: endpoint.clone(),
                pinned: host.fingerprint(),
            });
        }
        Ok(Err(Handshake::Failed(err))) => return Err(err),
        Err(_) => {
            return Err(ClientError::TimedOut {
                endpoint: endpoint.clone(),
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
}

impl fmt::Debug for Connection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Connection")
            .field("host", &self.host)
            .field("ended", &self.ended)
            .finish_non_exhaustive()
    }
}

/// A read error that is the other end having closed: what a pipe reports on
/// Windows where a Unix socket reads as ended.
fn is_closed(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        ErrorKind::BrokenPipe | ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted
    )
}
