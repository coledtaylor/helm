//! The message envelope: everything that crosses a connection.
//!
//! Three kinds of traffic share one connection. Requests get a response or an
//! error. Subscriptions get a snapshot, when the channel carries state, and
//! then numbered events. Byte streams carry terminal input and output under
//! credit-based flow control. A channel's payload travels as an untyped CBOR
//! value here and is decoded against the channel's declared type by
//! [`crate::channel`], so a payload that does not fit costs one error reply,
//! not the connection.
//!
//! `hello` and `refused` are frozen across majors: their fields are never
//! renamed or removed, so any client, however old, can read why it was
//! refused.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::backend::{BackendDescriptor, BackendId, Support, feature_table};
use crate::bytes::Bytes;
use crate::capability::Capability;
use crate::version::{ProtocolVersion, UpdateSide};

/// A channel payload before it is decoded against the channel's type.
pub type Payload = ciborium::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Message {
    Hello(Hello),
    Welcome(Welcome),
    Refused(Refused),
    Request(Request),
    Response(Response),
    Error(ErrorReply),
    Subscribe(Subscribe),
    Unsubscribe(Unsubscribe),
    SubscriptionError(SubscriptionError),
    Snapshot(Snapshot),
    Event(Event),
    StreamOpen(StreamOpen),
    StreamData(StreamData),
    StreamCredit(StreamCredit),
    StreamClose(StreamClose),
}

/// The client's first message. Frozen across majors.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub protocol: ProtocolVersion,
    pub client: ClientInfo,
    /// Capability names. Names the host does not know are ignored.
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    /// What the client calls itself, such as "Floti desktop 3.0.0".
    pub name: String,
    pub kind: ClientKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ClientKind {
    Desktop,
    Tui,
    Phone,
    Website,
    /// A kind this version does not know.
    #[serde(other)]
    Other,
}

/// The host's answer to an accepted `hello`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Welcome {
    /// The version this connection speaks.
    pub protocol: ProtocolVersion,
    /// The host program's own version, such as "0.4.1".
    pub host_version: String,
    /// The capabilities the host accepted: those the client declared that
    /// the host knows.
    pub capabilities: Vec<Capability>,
    /// Every backend the host can run, with the features it declares.
    pub backends: Vec<BackendDescriptor>,
}

impl Welcome {
    pub fn backend(&self, id: &BackendId) -> Option<&BackendDescriptor> {
        self.backends.iter().find(|backend| &backend.id == id)
    }

    /// Whether `backend` declares `feature`. A backend the host did not
    /// describe declares nothing.
    pub fn support(&self, backend: &BackendId, feature: crate::backend::BackendFeature) -> Support {
        self.backend(backend)
            .map_or(Support::Unknown, |descriptor| descriptor.support(feature))
    }

    /// Every feature with its support for `backend`; see [`feature_table`].
    pub fn feature_table(
        &self,
        backend: &BackendId,
    ) -> [(crate::backend::BackendFeature, Support); 8] {
        feature_table(self.backend(backend))
    }
}

/// The host's answer to a `hello` it cannot accept. Frozen across majors.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Refused {
    /// The host's version.
    pub host: ProtocolVersion,
    /// The version the client said.
    pub client: ProtocolVersion,
    pub update: UpdateSide,
    /// A sentence naming both versions and which side to update.
    pub message: String,
}

/// A call on a request channel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    /// Chosen by the client, unique among its requests in flight.
    #[ts(type = "number")]
    pub id: u64,
    pub channel: String,
    #[schemars(with = "serde_json::Value")]
    #[ts(type = "unknown")]
    pub payload: Payload,
}

/// The answer to a request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    #[ts(type = "number")]
    pub id: u64,
    #[schemars(with = "serde_json::Value")]
    #[ts(type = "unknown")]
    pub payload: Payload,
}

/// A request that failed. The connection stays open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ErrorReply {
    /// The request it answers.
    #[ts(type = "number")]
    pub id: u64,
    /// The channel the request named, as it named it.
    pub channel: String,
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    /// The protocol has no channel by that name.
    UnknownChannel,
    /// The channel exists but is not a request channel.
    NotARequest,
    /// The payload does not fit the channel's type.
    BadPayload,
    /// The host declares the channel but does not serve it.
    Unavailable,
    /// The host tried and failed; the message says why.
    Failed,
    /// The channel needs a capability the client did not declare at connect;
    /// the message names it.
    MissingCapability,
    /// A subscription names a channel that is not an event channel.
    NotAnEvent,
    /// A code this version does not know.
    #[serde(other)]
    Other,
}

/// Start receiving an event channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Subscribe {
    /// Chosen by the client; every snapshot and event for it carries it.
    #[ts(type = "number")]
    pub subscription: u64,
    pub channel: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Unsubscribe {
    #[ts(type = "number")]
    pub subscription: u64,
}

/// A subscription the host did not start, and why. Nothing is ever sent for
/// it; the client may subscribe again under the same number.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionError {
    /// The subscription it refuses.
    #[ts(type = "number")]
    pub subscription: u64,
    /// The channel the subscription named, as it named it.
    pub channel: String,
    pub code: ErrorCode,
    pub message: String,
}

/// The whole current state of a channel that carries state, sent first on
/// every subscription.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[ts(type = "number")]
    pub subscription: u64,
    /// The number of the last event this state includes. The next event is
    /// `seq + 1`.
    #[ts(type = "number")]
    pub seq: u64,
    #[schemars(with = "serde_json::Value")]
    #[ts(type = "unknown")]
    pub state: Payload,
}

/// One numbered event. A client that sees a number other than the one it
/// expects has missed one, and resubscribes for a fresh snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    #[ts(type = "number")]
    pub subscription: u64,
    #[ts(type = "number")]
    pub seq: u64,
    #[schemars(with = "serde_json::Value")]
    #[ts(type = "unknown")]
    pub payload: Payload,
}

/// Open a byte stream on a stream channel. Each direction starts with
/// `DEFAULT_INITIAL_CREDIT` bytes of credit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct StreamOpen {
    /// Chosen by the side that opens it.
    #[ts(type = "number")]
    pub stream: u64,
    pub channel: String,
    /// What to open, typed by the channel.
    #[schemars(with = "serde_json::Value")]
    #[ts(type = "unknown")]
    pub params: Payload,
}

/// Bytes on a stream, never more than the receiver's credit allows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct StreamData {
    #[ts(type = "number")]
    pub stream: u64,
    pub data: Bytes,
}

/// More credit from a stream's receiver: the sender may send `bytes` more.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct StreamCredit {
    #[ts(type = "number")]
    pub stream: u64,
    #[ts(type = "number")]
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct StreamClose {
    #[ts(type = "number")]
    pub stream: u64,
    /// Why, when it did not end normally.
    pub reason: Option<String>,
}
