//! The Noise session every connection runs before anything else crosses it.
//!
//! The pattern is [`PATTERN`], from snow, never hand-rolled. The device
//! starts it as the initiator, already holding the host key it pinned at
//! pairing; IK hands the host the device key, encrypted, in the very first
//! message, so a host can refuse an unknown or revoked device before it has
//! written a byte. The host proves its key by answering with a second message
//! only its private key could make, and from there both sides hold fresh keys
//! for this connection alone. Both messages are bound to [`PROLOGUE`], so
//! nothing that is not this session layer can be mistaken for it.
//!
//! On the stream every Noise message, handshake and transport alike, is a
//! 2-byte big-endian length and then at most [`MAX_MESSAGE_LEN`] bytes. A
//! frame (up to [`crate::MAX_FRAME_LEN`]) spans as many transport messages as
//! it needs; the frames inside are the ones [`crate::frame`] describes.
//!
//! Like [`crate::FrameDecoder`], everything here is sans-IO: it takes bytes
//! however the transport splits them and hands back bytes to write, and the
//! caller owns the socket and the deadline.
//!
//! ```text
//! device: Initiator::start ── message 1 ──▶ host: Responder::push
//!                                                  └ PendingDevice: accept or refuse
//! device: Initiator::push ◀── message 2 ── host: PendingDevice::accept
//!                   both: Transport::seal and Transport::open
//! ```

mod keys;
mod transport;
mod wire;

use std::fmt;

use snow::params::NoiseParams;
use snow::{Builder, HandshakeState};
use thiserror::Error;

pub use keys::{KEY_LEN, KeyPair, PrivateKey, PublicKey};
pub use transport::{Opener, Sealer, Transport};

use wire::{OneMessage, put_prefixed};

/// The Noise protocol name: IK, Curve25519, ChaCha20-Poly1305, BLAKE2s.
pub const PATTERN: &str = "Noise_IK_25519_ChaChaPoly_BLAKE2s";

/// Mixed into the handshake on both sides: a session of anything else, or of
/// another version of this layer, cannot complete against it.
pub const PROLOGUE: &[u8] = b"floti session layer 1";

/// The largest Noise message, its tag included.
pub const MAX_MESSAGE_LEN: usize = 65535;

/// The authentication tag every message ends with.
pub const TAG_LEN: usize = 16;

/// The most plaintext one transport message carries.
pub const MAX_PLAINTEXT_LEN: usize = MAX_MESSAGE_LEN - TAG_LEN;

/// IK's first message with no payload: the device's ephemeral key, its static
/// key encrypted, and the empty payload's tag.
const MESSAGE_1_LEN: usize = KEY_LEN + KEY_LEN + TAG_LEN + TAG_LEN;

/// IK's second message with no payload: the host's ephemeral key and the
/// empty payload's tag.
const MESSAGE_2_LEN: usize = KEY_LEN + TAG_LEN;

/// What can go wrong in the session layer. No variant carries key material
/// or anything a message held.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum NoiseError {
    /// The host's answer was not the one only the pinned key could make: the
    /// host on the other end holds another key, or the answer was not a
    /// handshake message at all.
    #[error("the host did not prove the key this device pinned")]
    HostNotProven,

    /// The bytes a device opened with are not a first handshake message
    /// made for this host's key.
    #[error("the first handshake message does not decrypt")]
    FirstMessageUnreadable,

    /// A transport message failed its authentication: tampered, replayed,
    /// out of order, or not made under this session's keys. The session
    /// stays failed.
    #[error("a message does not authenticate")]
    Unauthenticated,

    /// The stream ended inside a transport message.
    #[error("the connection ended {partial} bytes into a message")]
    Truncated { partial: usize },

    /// One direction has used every nonce a session has.
    #[error("the session has carried as many messages as one session can")]
    Exhausted,

    /// Bytes that are not a Curve25519 key, or a key written in another form
    /// than 64 hex digits.
    #[error("not a Curve25519 key")]
    InvalidKey,

    /// The Noise library could not do what was asked, such as reading the
    /// operating system's random source.
    #[error("the Noise library failed: {0}")]
    Library(String),
}

/// snow's errors name a stage or a kind, never a key.
fn library(error: snow::Error) -> NoiseError {
    NoiseError::Library(error.to_string())
}

fn params() -> Result<NoiseParams, NoiseError> {
    PATTERN.parse().map_err(library)
}

/// The device's side of a handshake, waiting for the host's answer.
pub struct Initiator {
    state: Box<HandshakeState>,
    host: PublicKey,
    inbound: OneMessage,
}

/// Where a device's handshake stands after a push.
#[derive(Debug)]
pub enum InitiatorStep {
    /// The host's answer has not all arrived.
    Pending(Initiator),
    /// The host proved the pinned key. Bytes of the push after `used` belong
    /// to the transport.
    Done { transport: Transport, used: usize },
}

impl Initiator {
    /// Starts a handshake as `device`, to the host holding `host`. Returns
    /// the bytes to send first.
    pub fn start(device: &KeyPair, host: &PublicKey) -> Result<(Self, Vec<u8>), NoiseError> {
        let mut state = Builder::new(params()?)
            .local_private_key(device.private().expose_secret())
            .and_then(|builder| builder.remote_public_key(host.as_bytes()))
            .and_then(|builder| builder.prologue(PROLOGUE))
            .and_then(Builder::build_initiator)
            .map_err(library)?;
        let mut message = [0; MESSAGE_1_LEN];
        let len = state.write_message(&[], &mut message).map_err(library)?;
        let mut out = Vec::with_capacity(wire::PREFIX_LEN + len);
        put_prefixed(&mut out, &message[..len]);
        let initiator = Self {
            state: Box::new(state),
            host: *host,
            inbound: OneMessage::new(MESSAGE_2_LEN),
        };
        Ok((initiator, out))
    }

    /// Bytes from the host, split anywhere. Fails as soon as they cannot be
    /// the pinned host's answer.
    pub fn push(mut self, bytes: &[u8]) -> Result<InitiatorStep, NoiseError> {
        let used = self
            .inbound
            .fill(bytes)
            .map_err(|_| NoiseError::HostNotProven)?;
        let Some(message) = self.inbound.message() else {
            return Ok(InitiatorStep::Pending(self));
        };
        let mut payload = [0; MESSAGE_2_LEN];
        let payload_len = self
            .state
            .read_message(message, &mut payload)
            .map_err(|_| NoiseError::HostNotProven)?;
        let proven = keys::public_from(self.state.get_remote_static()) == Some(self.host);
        if payload_len != 0 || !proven || !self.state.is_handshake_finished() {
            return Err(NoiseError::HostNotProven);
        }
        let state = (*self.state)
            .into_stateless_transport_mode()
            .map_err(library)?;
        Ok(InitiatorStep::Done {
            transport: Transport::new(state, self.host),
            used,
        })
    }
}

impl fmt::Debug for Initiator {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Initiator")
            .field("host", &self.host)
            .finish_non_exhaustive()
    }
}

/// The host's side of a handshake, waiting for a device's first message.
pub struct Responder {
    state: Box<HandshakeState>,
    inbound: OneMessage,
}

/// Where the host's handshake stands after a push.
#[derive(Debug)]
pub enum ResponderStep {
    /// The first message has not all arrived.
    Pending(Responder),
    /// The device has said who it is. Bytes of the push after `used` belong
    /// to the transport, should the device be let in.
    Received { device: PendingDevice, used: usize },
}

impl Responder {
    /// Waits for a device to open a session with the host holding `host`.
    pub fn new(host: &KeyPair) -> Result<Self, NoiseError> {
        let state = Builder::new(params()?)
            .local_private_key(host.private().expose_secret())
            .and_then(|builder| builder.prologue(PROLOGUE))
            .and_then(Builder::build_responder)
            .map_err(library)?;
        Ok(Self {
            state: Box::new(state),
            inbound: OneMessage::new(MESSAGE_1_LEN),
        })
    }

    /// Bytes from the device, split anywhere. Fails as soon as they cannot be
    /// a first message to this host, and when the whole message does not
    /// decrypt.
    pub fn push(mut self, bytes: &[u8]) -> Result<ResponderStep, NoiseError> {
        let used = self
            .inbound
            .fill(bytes)
            .map_err(|_| NoiseError::FirstMessageUnreadable)?;
        let Some(message) = self.inbound.message() else {
            return Ok(ResponderStep::Pending(self));
        };
        let mut payload = [0; MESSAGE_1_LEN];
        let payload_len = self
            .state
            .read_message(message, &mut payload)
            .map_err(|_| NoiseError::FirstMessageUnreadable)?;
        let key = keys::public_from(self.state.get_remote_static())
            .filter(|_| payload_len == 0)
            .ok_or(NoiseError::FirstMessageUnreadable)?;
        Ok(ResponderStep::Received {
            device: PendingDevice {
                state: self.state,
                key,
            },
            used,
        })
    }
}

impl fmt::Debug for Responder {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Responder").finish_non_exhaustive()
    }
}

/// A device that has proven its key and not yet been answered. The host
/// accepts it, or refuses it by dropping this and closing the connection
/// without writing a byte.
pub struct PendingDevice {
    state: Box<HandshakeState>,
    key: PublicKey,
}

impl PendingDevice {
    /// The device's static key, proven by the message that carried it.
    pub fn device_key(&self) -> PublicKey {
        self.key
    }

    /// Lets the device in: the session, and the host's answer to send.
    pub fn accept(mut self) -> Result<(Transport, Vec<u8>), NoiseError> {
        let mut message = [0; MESSAGE_2_LEN];
        let len = self
            .state
            .write_message(&[], &mut message)
            .map_err(library)?;
        let mut out = Vec::with_capacity(wire::PREFIX_LEN + len);
        put_prefixed(&mut out, &message[..len]);
        let state = (*self.state)
            .into_stateless_transport_mode()
            .map_err(library)?;
        Ok((Transport::new(state, self.key), out))
    }
}

impl fmt::Debug for PendingDevice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PendingDevice")
            .field("key", &self.key)
            .finish_non_exhaustive()
    }
}
