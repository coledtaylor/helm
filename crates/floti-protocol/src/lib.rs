//! The one contract between the Floti host and its clients.
//!
//! Every client builds against this crate: the desktop and the website through
//! the TypeScript it generates, the TUI by linking it, the phone through the
//! JSON Schema. It says nothing about how bytes get from one side to the other;
//! the host wraps it in its own transport, so there is no async runtime and no
//! OS-specific code here.
//!
//! The pieces, in the order a connection meets them:
//!
//! - [`frame`]: length-prefixed CBOR, one [`Message`] per frame.
//! - [`handshake`] and [`version`]: `hello`, then `welcome` or `refused`.
//! - [`capability`] and [`delivery`]: what a client can draw, declared at
//!   connect, and the host sending it only what that covers.
//! - [`backend`]: which agent runs a session, and what each agent declares.
//! - [`channel`] and [`channels`]: every typed request, event and stream.
//! - [`subscription`]: snapshots and numbered events.
//! - [`flow`]: credit-based flow control for byte streams.
//! - [`generate`]: the JSON Schema and TypeScript that clients build against.
//!
//! Changes follow one rule: additions in a minor version, removals only in a
//! major one, after a minor that deprecates them.

pub mod backend;
pub mod bytes;
pub mod capability;
pub mod channel;
pub mod channels;
pub mod delivery;
pub mod error;
pub mod flow;
pub mod frame;
pub mod generate;
pub mod handshake;
pub mod message;
pub mod subscription;
pub mod version;

pub use backend::{
    BackendDescriptor, BackendFeature, BackendId, HarnessPart, HarnessSupport, Knowable, Support,
};
pub use bytes::Bytes;
pub use capability::{Capability, CapabilitySet};
pub use channel::{
    Catalogue, ChannelDecl, ChannelKind, EventChannel, RequestChannel, Router, StreamChannel,
};
pub use delivery::ClientChannels;
pub use error::ProtocolError;
pub use flow::{CreditReceiver, CreditSender, DEFAULT_INITIAL_CREDIT, Outbox};
pub use frame::{FrameDecoder, MAX_FRAME_LEN, encode_frame};
pub use handshake::HostIdentity;
pub use message::{Message, Payload};
pub use subscription::{Delivery, EventCursor, Topic};
pub use version::{PROTOCOL_VERSION, ProtocolVersion, UpdateSide};
