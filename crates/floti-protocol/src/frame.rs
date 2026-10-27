//! Frames: a 4-byte big-endian length, then one CBOR value of that length.
//!
//! Binary on purpose: terminal output is most of the traffic, and base64
//! inside JSON would add a third to it. The decoder takes bytes however the
//! transport splits them and hands back whole messages in order.
//!
//! The decoder never allocates what a length prefix claims. It checks the
//! prefix against [`MAX_FRAME_LEN`] before buffering anything of the body, and
//! it buffers only bytes that have arrived. A frame over the limit loses the
//! framing for good, so the decoder stays failed; a malformed body inside a
//! valid frame is reported and skipped, since the next frame still starts
//! where the length said.

use std::io::ErrorKind;

use crate::error::ProtocolError;
use crate::message::Message;

/// The largest frame body, in bytes: 16 MiB.
pub const MAX_FRAME_LEN: u32 = 16 * 1024 * 1024;

const PREFIX_LEN: usize = 4;

/// One message as one frame.
pub fn encode_frame(message: &Message) -> Result<Vec<u8>, ProtocolError> {
    let mut frame = vec![0; PREFIX_LEN];
    ciborium::into_writer(message, &mut frame)
        .map_err(|error| ProtocolError::Encode(error.to_string()))?;
    let body_len = frame.len() - PREFIX_LEN;
    let len = u32::try_from(body_len)
        .ok()
        .filter(|len| *len <= MAX_FRAME_LEN)
        .ok_or(ProtocolError::Encode(format!(
            "a {body_len}-byte frame exceeds the {MAX_FRAME_LEN}-byte limit"
        )))?;
    frame[..PREFIX_LEN].copy_from_slice(&len.to_be_bytes());
    Ok(frame)
}

/// Turns bytes, split anywhere, back into messages.
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buffer: Vec<u8>,
    /// Where the unread bytes in `buffer` start.
    start: usize,
    /// Set once framing is lost; every later call reports it.
    failed: Option<ProtocolError>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Bytes as they arrived. Ignored once the decoder has failed.
    pub fn push(&mut self, bytes: &[u8]) {
        if self.failed.is_some() {
            return;
        }
        if self.start > 0 && self.start >= self.buffer.len() / 2 {
            self.buffer.drain(..self.start);
            self.start = 0;
        }
        self.buffer.extend_from_slice(bytes);
    }

    /// The next whole message, `None` while one is still arriving.
    pub fn next_message(&mut self) -> Result<Option<Message>, ProtocolError> {
        if let Some(error) = &self.failed {
            return Err(error.clone());
        }
        let unread = &self.buffer[self.start..];
        let Some(prefix) = unread.first_chunk::<PREFIX_LEN>() else {
            return Ok(None);
        };
        let len = u32::from_be_bytes(*prefix);
        if len > MAX_FRAME_LEN {
            let error = ProtocolError::FrameTooLarge {
                len: u64::from(len),
                max: MAX_FRAME_LEN,
            };
            self.failed = Some(error.clone());
            self.buffer = Vec::new();
            self.start = 0;
            return Err(error);
        }
        let frame_len = PREFIX_LEN + len as usize;
        if unread.len() < frame_len {
            return Ok(None);
        }
        let body = &unread[PREFIX_LEN..frame_len];
        let decoded = decode_body(body);
        self.start += frame_len;
        if self.start == self.buffer.len() {
            self.buffer.clear();
            self.start = 0;
        }
        decoded.map(Some)
    }

    /// Every whole message buffered so far, stopping at the first error.
    pub fn drain(&mut self) -> Result<Vec<Message>, ProtocolError> {
        let mut messages = Vec::new();
        while let Some(message) = self.next_message()? {
            messages.push(message);
        }
        Ok(messages)
    }

    /// Bytes received and not yet returned as a message.
    pub fn buffered(&self) -> usize {
        self.buffer.len() - self.start
    }

    /// Call when the connection ends: an error if it ended inside a frame.
    pub fn finish(&self) -> Result<(), ProtocolError> {
        if let Some(error) = &self.failed {
            return Err(error.clone());
        }
        match self.buffered() {
            0 => Ok(()),
            partial => Err(ProtocolError::Truncated(format!(
                "the connection ended {partial} bytes into a frame"
            ))),
        }
    }
}

fn decode_body(body: &[u8]) -> Result<Message, ProtocolError> {
    let mut rest = body;
    let message = ciborium::from_reader::<Message, _>(&mut rest).map_err(|error| match error {
        ciborium::de::Error::Io(io) if io.kind() == ErrorKind::UnexpectedEof => {
            ProtocolError::Truncated(format!(
                "the {}-byte body ends before its CBOR value does",
                body.len()
            ))
        }
        other => ProtocolError::Malformed(other.to_string()),
    })?;
    if !rest.is_empty() {
        return Err(ProtocolError::Malformed(format!(
            "{} bytes follow the frame's CBOR value",
            rest.len()
        )));
    }
    Ok(message)
}
