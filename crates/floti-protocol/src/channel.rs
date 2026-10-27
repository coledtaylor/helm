//! Channels: the typed requests, events and streams the host offers.
//!
//! A channel is declared once, as a type implementing [`RequestChannel`],
//! [`EventChannel`] or [`StreamChannel`], and registered in the [`Catalogue`].
//! The declaration gives its wire name, its payload types and the capability a
//! client needs to use it. Everything else follows from it: typed decoding
//! here, and the JSON Schema and TypeScript in [`crate::generate`].
//!
//! Wire names keep the strings `shared/ipc.ts` gives them, so the desktop's
//! move onto the protocol is mechanical.

use std::collections::{BTreeMap, HashMap};

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::Serialize;
use serde::de::DeserializeOwned;
use ts_rs::TS;

use crate::capability::{Capability, CapabilitySet};
use crate::error::ProtocolError;
use crate::generate::TsCollector;
use crate::message::{
    ErrorCode, ErrorReply, Message, Payload, Request, Response, StreamClose, StreamOpen, Subscribe,
    SubscriptionError,
};
use crate::version::PROTOCOL_VERSION;

/// A type that can travel as a channel payload and be generated for clients.
pub trait PayloadType: Serialize + DeserializeOwned + JsonSchema + TS + 'static {}

impl<T> PayloadType for T where T: Serialize + DeserializeOwned + JsonSchema + TS + 'static {}

/// A channel a client calls and the host answers. A request with nothing to
/// say is `()`, which travels as CBOR null.
pub trait RequestChannel: 'static {
    const NAME: &'static str;
    /// The capability a client needs to call it, or `None`.
    const CAPABILITY: Option<Capability> = None;
    type Request: PayloadType;
    type Response: PayloadType;
}

/// A channel the host pushes events on.
pub trait EventChannel: 'static {
    const NAME: &'static str;
    const CAPABILITY: Option<Capability> = None;
    /// Whether it carries state. A subscription to one that does starts with
    /// a [`Self::Snapshot`]; one that does not uses `()` there.
    const SNAPSHOT: bool;
    type Event: PayloadType;
    type Snapshot: PayloadType;
}

/// A channel that carries bytes both ways, such as a terminal's input and
/// output.
pub trait StreamChannel: 'static {
    const NAME: &'static str;
    const CAPABILITY: Option<Capability> = None;
    /// What a `streamOpen` names, such as which session.
    type Open: PayloadType;
}

/// Encodes a value as a channel payload.
pub fn to_payload<T: Serialize + ?Sized>(value: &T) -> Result<Payload, ProtocolError> {
    Payload::serialized(value).map_err(|error| ProtocolError::Encode(error.to_string()))
}

/// Decodes a channel payload as `T`, or says why it does not fit.
pub fn from_payload<T: DeserializeOwned>(payload: &Payload) -> Result<T, String> {
    payload
        .deserialized::<T>()
        .map_err(|error| error.to_string())
}

/// One payload type, kept as functions so a catalogue can hold many.
#[derive(Clone, Copy)]
pub(crate) struct TypeInfo {
    pub(crate) ts_name: fn() -> String,
    pub(crate) collect_ts: fn(&mut TsCollector),
    pub(crate) schema: fn(&mut SchemaGenerator) -> Schema,
    check: fn(&Payload) -> Result<(), String>,
}

impl TypeInfo {
    pub(crate) fn of<T: PayloadType>() -> Self {
        Self {
            ts_name: T::name,
            collect_ts: TsCollector::root::<T>,
            schema: |generator| generator.subschema_for::<T>(),
            check: |payload| from_payload::<T>(payload).map(drop),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelKind {
    Request,
    Event { snapshot: bool },
    Stream,
}

#[derive(Clone, Copy)]
pub(crate) enum Shape {
    Request {
        request: TypeInfo,
        response: TypeInfo,
    },
    Event {
        event: TypeInfo,
        snapshot: Option<TypeInfo>,
    },
    Stream {
        open: TypeInfo,
    },
}

/// One declared channel.
#[derive(Clone, Copy)]
pub struct ChannelDecl {
    name: &'static str,
    capability: Option<Capability>,
    pub(crate) shape: Shape,
}

impl ChannelDecl {
    pub fn name(&self) -> &'static str {
        self.name
    }

    pub fn capability(&self) -> Option<Capability> {
        self.capability
    }

    pub fn kind(&self) -> ChannelKind {
        match self.shape {
            Shape::Request { .. } => ChannelKind::Request,
            Shape::Event { snapshot, .. } => ChannelKind::Event {
                snapshot: snapshot.is_some(),
            },
            Shape::Stream { .. } => ChannelKind::Stream,
        }
    }

    /// Whether a client with `capabilities` may use this channel.
    pub fn covered_by(&self, capabilities: &CapabilitySet) -> bool {
        capabilities.covers(self.capability)
    }
}

impl std::fmt::Debug for ChannelDecl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChannelDecl")
            .field("name", &self.name)
            .field("kind", &self.kind())
            .field("capability", &self.capability)
            .finish()
    }
}

/// Every declared channel, by name, and the payload types that stand on their
/// own.
#[derive(Clone, Default)]
pub struct Catalogue {
    channels: BTreeMap<&'static str, ChannelDecl>,
    pub(crate) payloads: Vec<TypeInfo>,
}

impl Catalogue {
    /// An empty catalogue, for tests and for building the protocol's own.
    pub fn new() -> Self {
        Self::default()
    }

    /// The protocol's catalogue: every channel the host offers.
    pub fn protocol() -> Self {
        let mut catalogue = Self::new();
        crate::channels::declare(&mut catalogue);
        catalogue
    }

    pub fn request<C: RequestChannel>(&mut self) -> &mut Self {
        self.insert(
            C::NAME,
            C::CAPABILITY,
            Shape::Request {
                request: TypeInfo::of::<C::Request>(),
                response: TypeInfo::of::<C::Response>(),
            },
        )
    }

    pub fn event<C: EventChannel>(&mut self) -> &mut Self {
        let snapshot = C::SNAPSHOT.then(TypeInfo::of::<C::Snapshot>);
        self.insert(
            C::NAME,
            C::CAPABILITY,
            Shape::Event {
                event: TypeInfo::of::<C::Event>(),
                snapshot,
            },
        )
    }

    pub fn stream<C: StreamChannel>(&mut self) -> &mut Self {
        self.insert(
            C::NAME,
            C::CAPABILITY,
            Shape::Stream {
                open: TypeInfo::of::<C::Open>(),
            },
        )
    }

    /// A payload type generated for clients even before a channel uses it,
    /// such as one several domains share.
    pub fn payload<T: PayloadType>(&mut self) -> &mut Self {
        self.payloads.push(TypeInfo::of::<T>());
        self
    }

    fn insert(
        &mut self,
        name: &'static str,
        capability: Option<Capability>,
        shape: Shape,
    ) -> &mut Self {
        let previous = self.channels.insert(
            name,
            ChannelDecl {
                name,
                capability,
                shape,
            },
        );
        assert!(previous.is_none(), "channel `{name}` is declared twice");
        self
    }

    pub fn get(&self, name: &str) -> Option<&ChannelDecl> {
        self.channels.get(name)
    }

    /// Every channel, by name.
    pub fn channels(&self) -> impl Iterator<Item = &ChannelDecl> {
        self.channels.values()
    }

    pub fn len(&self) -> usize {
        self.channels.len()
    }

    pub fn is_empty(&self) -> bool {
        self.channels.is_empty()
    }

    /// The request channel a request names, once its payload fits that
    /// channel's type; otherwise the error reply that names the channel.
    ///
    /// This checks the request against the protocol alone. A host answering a
    /// client uses [`Self::check_request_from`], which also holds the request
    /// to the capabilities that client declared.
    pub fn check_request(&self, request: &Request) -> Result<&ChannelDecl, ErrorReply> {
        self.check_request_against(request, None)
    }

    /// [`Self::check_request`] for a client that declared `capabilities`: a
    /// request on a channel needing a capability it did not declare is
    /// refused with [`ErrorCode::MissingCapability`], naming the capability.
    pub fn check_request_from(
        &self,
        request: &Request,
        capabilities: &CapabilitySet,
    ) -> Result<&ChannelDecl, ErrorReply> {
        self.check_request_against(request, Some(capabilities))
    }

    fn check_request_against(
        &self,
        request: &Request,
        capabilities: Option<&CapabilitySet>,
    ) -> Result<&ChannelDecl, ErrorReply> {
        let reply = |(code, message): (ErrorCode, String)| ErrorReply {
            id: request.id,
            channel: request.channel.clone(),
            code,
            message,
        };
        let decl = self.find(&request.channel).map_err(reply)?;
        let Shape::Request {
            request: request_type,
            ..
        } = decl.shape
        else {
            return Err(reply((
                ErrorCode::NotARequest,
                format!("`{}` is not a request channel.", decl.name),
            )));
        };
        if let Some(capabilities) = capabilities {
            decl.require(capabilities).map_err(reply)?;
        }
        (request_type.check)(&request.payload).map_err(|why| reply(decl.bad_payload(&why)))?;
        Ok(decl)
    }

    /// The event channel a subscription names, once the client's
    /// capabilities cover it; otherwise why it is refused.
    pub fn check_subscribe(
        &self,
        subscribe: &Subscribe,
        capabilities: &CapabilitySet,
    ) -> Result<&ChannelDecl, SubscriptionError> {
        let refuse = |(code, message): (ErrorCode, String)| SubscriptionError {
            subscription: subscribe.subscription,
            channel: subscribe.channel.clone(),
            code,
            message,
        };
        let decl = self.find(&subscribe.channel).map_err(refuse)?;
        if !matches!(decl.shape, Shape::Event { .. }) {
            return Err(refuse((
                ErrorCode::NotAnEvent,
                format!("`{}` is not an event channel.", decl.name),
            )));
        }
        decl.require(capabilities).map_err(refuse)?;
        Ok(decl)
    }

    /// The stream channel a `streamOpen` names, once the client's
    /// capabilities cover it and its params fit; otherwise the close that
    /// refuses it, with why.
    pub fn check_stream_open(
        &self,
        open: &StreamOpen,
        capabilities: &CapabilitySet,
    ) -> Result<&ChannelDecl, StreamClose> {
        let close = |(_, why): (ErrorCode, String)| StreamClose {
            stream: open.stream,
            reason: Some(why),
        };
        let decl = self.find(&open.channel).map_err(close)?;
        let Shape::Stream { open: open_type } = decl.shape else {
            return Err(close((
                ErrorCode::Other,
                format!("`{}` is not a stream channel.", decl.name),
            )));
        };
        decl.require(capabilities).map_err(close)?;
        (open_type.check)(&open.params).map_err(|why| close(decl.bad_payload(&why)))?;
        Ok(decl)
    }

    fn find(&self, name: &str) -> Result<&ChannelDecl, (ErrorCode, String)> {
        self.get(name).ok_or_else(|| {
            (
                ErrorCode::UnknownChannel,
                format!("Floti protocol {PROTOCOL_VERSION} has no channel `{name}`."),
            )
        })
    }
}

impl ChannelDecl {
    /// `Ok` when `capabilities` cover this channel; otherwise the refusal
    /// naming the capability it needs.
    fn require(&self, capabilities: &CapabilitySet) -> Result<(), (ErrorCode, String)> {
        match self.capability {
            Some(needed) if !capabilities.contains(needed) => Err((
                ErrorCode::MissingCapability,
                format!(
                    "`{}` needs the `{}` capability, which this client did not declare at connect.",
                    self.name,
                    needed.name()
                ),
            )),
            _ => Ok(()),
        }
    }

    fn bad_payload(&self, why: &str) -> (ErrorCode, String) {
        (
            ErrorCode::BadPayload,
            format!(
                "The payload for `{}` does not fit its type: {why}",
                self.name
            ),
        )
    }
}

impl std::fmt::Debug for Catalogue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list().entries(self.channels.values()).finish()
    }
}

/// Decodes a request on channel `C`, or the error reply naming the channel.
pub fn decode_request<C: RequestChannel>(request: &Request) -> Result<C::Request, ErrorReply> {
    if request.channel != C::NAME {
        return Err(ErrorReply {
            id: request.id,
            channel: request.channel.clone(),
            code: ErrorCode::UnknownChannel,
            message: format!("expected a request on `{}`", C::NAME),
        });
    }
    from_payload::<C::Request>(&request.payload).map_err(|why| ErrorReply {
        id: request.id,
        channel: request.channel.clone(),
        code: ErrorCode::BadPayload,
        message: format!("The payload for `{}` does not fit its type: {why}", C::NAME),
    })
}

type Handler<'a> = Box<dyn FnMut(&Payload) -> Result<Payload, String> + 'a>;

/// Answers one client's requests from typed handlers. Every request gets
/// exactly one message back, a response or an error reply, so a bad request
/// never costs the connection. A request on a channel needing a capability
/// the client did not declare is refused before any handler sees it.
pub struct Router<'a> {
    catalogue: &'a Catalogue,
    capabilities: CapabilitySet,
    handlers: HashMap<&'static str, Handler<'a>>,
}

impl<'a> Router<'a> {
    /// A router for a client that declared `capabilities` at connect.
    pub fn new(catalogue: &'a Catalogue, capabilities: CapabilitySet) -> Self {
        Self {
            catalogue,
            capabilities,
            handlers: HashMap::new(),
        }
    }

    /// Serves channel `C`. The handler's `Err` is a sentence for the client.
    pub fn handle<C: RequestChannel>(
        &mut self,
        mut handler: impl FnMut(C::Request) -> Result<C::Response, String> + 'a,
    ) -> &mut Self {
        assert!(
            self.catalogue.get(C::NAME).is_some(),
            "channel `{}` is not in the catalogue",
            C::NAME
        );
        self.handlers.insert(
            C::NAME,
            Box::new(move |payload| {
                let request = from_payload::<C::Request>(payload)?;
                let response = handler(request)?;
                to_payload(&response).map_err(|error| error.to_string())
            }),
        );
        self
    }

    pub fn dispatch(&mut self, request: &Request) -> Message {
        let decl = match self
            .catalogue
            .check_request_from(request, &self.capabilities)
        {
            Ok(decl) => decl,
            Err(reply) => return Message::Error(reply),
        };
        let error = |code, message| {
            Message::Error(ErrorReply {
                id: request.id,
                channel: request.channel.clone(),
                code,
                message,
            })
        };
        let Some(handler) = self.handlers.get_mut(decl.name()) else {
            return error(
                ErrorCode::Unavailable,
                format!("This host does not serve `{}`.", decl.name()),
            );
        };
        match handler(&request.payload) {
            Ok(payload) => Message::Response(Response {
                id: request.id,
                payload,
            }),
            Err(why) => error(ErrorCode::Failed, why),
        }
    }
}
