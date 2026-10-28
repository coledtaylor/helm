//! A finished handshake: plaintext sealed into Noise messages one way, and a
//! byte stream opened back into plaintext the other.
//!
//! Each direction keeps its own message counter, which is the nonce, so the
//! two halves can be [split](Transport::split) between a reading task and a
//! writing one. A stream is in order and loses nothing, so a message opens
//! only under the next counter: one replayed, dropped or reordered fails to
//! authenticate like a tampered one.

use std::fmt;
use std::sync::Arc;

use snow::StatelessTransportState;

use super::keys::PublicKey;
use super::wire::{PREFIX_LEN, Reassembler, put_prefixed};
use super::{MAX_PLAINTEXT_LEN, NoiseError, TAG_LEN};

/// Both directions of one session.
pub struct Transport {
    sealer: Sealer,
    opener: Opener,
}

impl Transport {
    pub(super) fn new(state: StatelessTransportState, peer: PublicKey) -> Self {
        let state = Arc::new(state);
        Self {
            sealer: Sealer {
                state: Arc::clone(&state),
                nonce: 0,
            },
            opener: Opener {
                state,
                peer,
                nonce: 0,
                inbound: Reassembler::default(),
                failed: false,
            },
        }
    }

    /// The other side's static key, as the handshake proved it.
    pub fn peer(&self) -> PublicKey {
        self.opener.peer
    }

    /// See [`Sealer::seal`].
    pub fn seal(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        self.sealer.seal(plaintext)
    }

    /// See [`Opener::open`].
    pub fn open(&mut self, bytes: &[u8]) -> Result<Vec<u8>, NoiseError> {
        self.opener.open(bytes)
    }

    /// See [`Opener::buffered`].
    pub fn buffered(&self) -> usize {
        self.opener.buffered()
    }

    /// See [`Opener::finish`].
    pub fn finish(&self) -> Result<(), NoiseError> {
        self.opener.finish()
    }

    /// The writing half and the reading half, to move to separate tasks.
    pub fn split(self) -> (Sealer, Opener) {
        (self.sealer, self.opener)
    }
}

impl fmt::Debug for Transport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Transport")
            .field("peer", &self.opener.peer)
            .finish_non_exhaustive()
    }
}

/// The writing half of a session.
pub struct Sealer {
    state: Arc<StatelessTransportState>,
    nonce: u64,
}

impl Sealer {
    /// `plaintext` as the bytes to write: one Noise message for every
    /// [`MAX_PLAINTEXT_LEN`] bytes of it, each behind its length, so a frame
    /// of any size spans as many as it needs. Nothing to send makes no
    /// message.
    pub fn seal(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let messages = plaintext.len().div_ceil(MAX_PLAINTEXT_LEN);
        let mut out = Vec::with_capacity(plaintext.len() + messages * (PREFIX_LEN + TAG_LEN));
        let mut message = vec![0; plaintext.len().min(MAX_PLAINTEXT_LEN) + TAG_LEN];
        for chunk in plaintext.chunks(MAX_PLAINTEXT_LEN) {
            let nonce = next_nonce(&mut self.nonce)?;
            let len = self
                .state
                .write_message(nonce, chunk, &mut message)
                .map_err(super::library)?;
            put_prefixed(&mut out, &message[..len]);
        }
        Ok(out)
    }
}

impl fmt::Debug for Sealer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Sealer")
            .field("sent", &self.nonce)
            .finish_non_exhaustive()
    }
}

/// The reading half of a session.
pub struct Opener {
    state: Arc<StatelessTransportState>,
    peer: PublicKey,
    nonce: u64,
    inbound: Reassembler,
    /// Set by the first message that does not open; the session is over.
    failed: bool,
}

impl Opener {
    /// The plaintext of every message these bytes complete, split anywhere.
    /// The start of a message still arriving is kept for the next call, and
    /// that is all that is kept: at most one message.
    ///
    /// A message that does not authenticate fails this call and every later
    /// one with [`NoiseError::Unauthenticated`]; the plaintext of messages
    /// before it in the same call is not returned either, since nothing read
    /// on this session can be acted on any more.
    pub fn open(&mut self, bytes: &[u8]) -> Result<Vec<u8>, NoiseError> {
        if self.failed {
            return Err(NoiseError::Unauthenticated);
        }
        let mut out = Vec::with_capacity(bytes.len());
        let Self {
            state,
            nonce,
            inbound,
            ..
        } = self;
        let opened = inbound.feed(bytes, |message| open_one(state, nonce, message, &mut out));
        match opened {
            Ok(()) => Ok(out),
            Err(error) => {
                self.failed = true;
                self.inbound.clear();
                Err(error)
            }
        }
    }

    /// Bytes of a message still arriving: never more than one message.
    pub fn buffered(&self) -> usize {
        self.inbound.buffered()
    }

    /// Call when the stream ends: an error if it failed, or ended inside a
    /// message.
    pub fn finish(&self) -> Result<(), NoiseError> {
        if self.failed {
            return Err(NoiseError::Unauthenticated);
        }
        match self.buffered() {
            0 => Ok(()),
            partial => Err(NoiseError::Truncated { partial }),
        }
    }
}

impl fmt::Debug for Opener {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Opener")
            .field("peer", &self.peer)
            .field("received", &self.nonce)
            .field("failed", &self.failed)
            .finish_non_exhaustive()
    }
}

fn open_one(
    state: &StatelessTransportState,
    nonce: &mut u64,
    message: &[u8],
    out: &mut Vec<u8>,
) -> Result<(), NoiseError> {
    if message.len() < TAG_LEN {
        return Err(NoiseError::Unauthenticated);
    }
    let counter = next_nonce(nonce)?;
    let start = out.len();
    out.resize(start + message.len() - TAG_LEN, 0);
    match state.read_message(counter, message, &mut out[start..]) {
        Ok(len) => {
            out.truncate(start + len);
            Ok(())
        }
        Err(_) => {
            out.truncate(start);
            Err(NoiseError::Unauthenticated)
        }
    }
}

/// The counter for the next message. Noise reserves the last value, so a
/// session ends before it rather than reusing a nonce.
fn next_nonce(nonce: &mut u64) -> Result<u64, NoiseError> {
    if *nonce == u64::MAX {
        return Err(NoiseError::Exhausted);
    }
    let current = *nonce;
    *nonce += 1;
    Ok(current)
}
