//! Noise messages on a byte stream: a 2-byte big-endian length, then the
//! message.
//!
//! Noise caps a message at [`MAX_MESSAGE_LEN`] bytes, which two bytes of length
//! cover exactly, so no length a prefix can claim is too large and the most
//! either side ever holds of a message still arriving is one message.

use super::MAX_MESSAGE_LEN;

/// The length prefix in front of every Noise message.
pub(super) const PREFIX_LEN: usize = 2;

/// Writes `message` with its length prefix onto the end of `out`.
pub(super) fn put_prefixed(out: &mut Vec<u8>, message: &[u8]) {
    debug_assert!(message.len() <= MAX_MESSAGE_LEN);
    let len = u16::try_from(message.len()).unwrap_or(u16::MAX);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(message);
}

fn declared_len(prefix: [u8; PREFIX_LEN]) -> usize {
    usize::from(u16::from_be_bytes(prefix))
}

/// One handshake message, whose length the pattern fixes, gathered from
/// bytes however they are split. It takes only the bytes the message lacks,
/// so whatever follows it stays with the caller.
#[derive(Debug)]
pub(super) struct OneMessage {
    expected: usize,
    buffer: Vec<u8>,
}

/// The prefix named a length other than the one this step takes.
pub(super) struct WrongLength;

impl OneMessage {
    pub(super) fn new(expected: usize) -> Self {
        Self {
            expected,
            buffer: Vec::with_capacity(PREFIX_LEN + expected),
        }
    }

    /// Takes what the message still lacks from the front of `bytes`, and says
    /// how many it took. Fails as soon as the prefix names another length.
    pub(super) fn fill(&mut self, bytes: &[u8]) -> Result<usize, WrongLength> {
        let mut used = 0;
        if self.buffer.len() < PREFIX_LEN {
            used = (PREFIX_LEN - self.buffer.len()).min(bytes.len());
            self.buffer.extend_from_slice(&bytes[..used]);
            let Some(prefix) = self.buffer.first_chunk::<PREFIX_LEN>() else {
                return Ok(used);
            };
            if declared_len(*prefix) != self.expected {
                return Err(WrongLength);
            }
        }
        let wanted = PREFIX_LEN + self.expected - self.buffer.len();
        let take = wanted.min(bytes.len() - used);
        self.buffer.extend_from_slice(&bytes[used..used + take]);
        Ok(used + take)
    }

    /// The message's body, once all of it has arrived.
    pub(super) fn message(&self) -> Option<&[u8]> {
        (self.buffer.len() == PREFIX_LEN + self.expected).then(|| &self.buffer[PREFIX_LEN..])
    }
}

/// Transport messages, gathered from bytes however they are split. Whole
/// messages in a push are handed on straight from it; only the one at the
/// end that is still arriving is copied, so the buffer never holds more than
/// one message.
#[derive(Debug, Default)]
pub(super) struct Reassembler {
    pending: Vec<u8>,
}

impl Reassembler {
    /// Hands `each` the body of every message these bytes complete, in order,
    /// and keeps the start of the next one. Stops at the first error `each`
    /// returns.
    pub(super) fn feed<E>(
        &mut self,
        mut bytes: &[u8],
        mut each: impl FnMut(&[u8]) -> Result<(), E>,
    ) -> Result<(), E> {
        if !self.pending.is_empty() {
            if self.pending.len() < PREFIX_LEN {
                let take = (PREFIX_LEN - self.pending.len()).min(bytes.len());
                self.pending.extend_from_slice(&bytes[..take]);
                bytes = &bytes[take..];
            }
            let Some(prefix) = self.pending.first_chunk::<PREFIX_LEN>() else {
                return Ok(());
            };
            let whole = PREFIX_LEN + declared_len(*prefix);
            let take = (whole - self.pending.len()).min(bytes.len());
            self.pending.extend_from_slice(&bytes[..take]);
            bytes = &bytes[take..];
            if self.pending.len() < whole {
                return Ok(());
            }
            let result = each(&self.pending[PREFIX_LEN..]);
            self.pending.clear();
            result?;
        }
        while let Some(prefix) = bytes.first_chunk::<PREFIX_LEN>() {
            let whole = PREFIX_LEN + declared_len(*prefix);
            if bytes.len() < whole {
                break;
            }
            each(&bytes[PREFIX_LEN..whole])?;
            bytes = &bytes[whole..];
        }
        self.pending.extend_from_slice(bytes);
        Ok(())
    }

    /// Bytes of a message still arriving.
    pub(super) fn buffered(&self) -> usize {
        self.pending.len()
    }

    pub(super) fn clear(&mut self) {
        self.pending = Vec::new();
    }
}
