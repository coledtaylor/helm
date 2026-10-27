//! What can go wrong below the level of a single request.
//!
//! A [`ProtocolError`] means the peer broke the protocol itself: a frame that
//! cannot be read, or stream data it had no credit for. A request that names an
//! unknown channel or carries an ill-typed payload is not one of these; it gets
//! an error reply and the connection carries on (see [`crate::channel`]).

use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProtocolError {
    /// The length prefix claims more than [`crate::MAX_FRAME_LEN`]. The
    /// claimed length is never allocated.
    #[error("frame of {len} bytes exceeds the {max}-byte limit")]
    FrameTooLarge { len: u64, max: u32 },

    /// The bytes ended inside a frame, or a frame's body ended before its
    /// CBOR value did.
    #[error("truncated frame: {0}")]
    Truncated(String),

    /// The frame's body is not one well-formed CBOR value, or that value is
    /// not a message.
    #[error("malformed frame: {0}")]
    Malformed(String),

    /// A stream's sender went past the credit its receiver granted.
    #[error("stream {stream} sent {len} bytes with {credit} bytes of credit left")]
    CreditExceeded { stream: u64, len: u64, credit: u64 },

    /// Data, credit or a close for a stream that is not open.
    #[error("stream {0} is not open")]
    UnknownStream(u64),

    /// A message could not be encoded, or encodes to more than a frame holds.
    #[error("could not encode message: {0}")]
    Encode(String),
}
