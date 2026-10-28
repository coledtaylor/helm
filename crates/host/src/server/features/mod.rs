//! What the host serves, one module per feature.
//!
//! Each feature registers its own request handlers ([`Feature::requests`]),
//! its terminal streams ([`Feature::streams`]) and, when it is built, the
//! event channels it publishes on ([`Events`]). The connection knows none of
//! them by name: it asks the features, so a feature grows without touching
//! the connection.
//!
//! - [`sessions`]: launch and live sessions, and plain terminals.
//! - [`history`]: history, the transcript archive and usage.
//! - [`config`]: the config console.
//! - [`resources`]: processes and ports, what each hosted session holds.

mod config;
mod history;
mod resources;
mod sessions;

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use floti_protocol::Payload;
use floti_protocol::channel::{Router, StreamChannel, from_payload};
use tokio::sync::mpsc::UnboundedReceiver;

use super::events::Events;
use super::hosted::Hosted;
use crate::session::{ClientId, Session, SessionOutput};
pub use resources::ResourcesHandle;

/// What every feature is built with.
pub(crate) struct FeatureContext {
    pub hosted: Arc<Hosted>,
    pub events: Arc<Events>,
}

/// One feature of the host.
pub(crate) trait Feature: Send + Sync {
    /// Registers a handler for each request channel it serves, answering
    /// `client`.
    fn requests<'a>(&'a self, client: ClientId, router: &mut Router<'a>);

    /// Registers each terminal stream it serves.
    fn streams<'a>(&'a self, streams: &mut Streams<'a>) {
        let _ = streams;
    }

    /// `client`'s connection has ended: whatever the feature holds for it
    /// alone goes.
    fn client_left(&self, client: ClientId) {
        let _ = client;
    }
}

/// A terminal a client opened a stream on: the bytes that draw its screen,
/// then its live output; what the client types goes to `session`.
pub(crate) struct TerminalAttachment {
    pub session: Arc<Session>,
    pub redraw: Vec<u8>,
    pub output: UnboundedReceiver<SessionOutput>,
}

type StreamHandler<'a> = Box<dyn Fn(ClientId, &Payload) -> Result<TerminalAttachment, String> + 'a>;

/// The stream channels the features serve, each with how a stream on it is
/// opened.
pub(crate) struct Streams<'a> {
    handlers: HashMap<&'static str, StreamHandler<'a>>,
}

impl<'a> Streams<'a> {
    fn new() -> Self {
        Self {
            handlers: HashMap::new(),
        }
    }

    /// Serves `C`. The handler's `Err` is the sentence the stream is closed
    /// with.
    pub fn handle<C: StreamChannel>(
        &mut self,
        handler: impl Fn(ClientId, C::Open) -> Result<TerminalAttachment, String> + 'a,
    ) -> &mut Self {
        let previous = self.handlers.insert(
            C::NAME,
            Box::new(move |client, params| handler(client, from_payload::<C::Open>(params)?)),
        );
        assert!(previous.is_none(), "stream `{}` is served twice", C::NAME);
        self
    }

    /// Opens a stream on `channel` for `client`, or `None` when no feature
    /// serves it.
    pub fn open(
        &self,
        channel: &str,
        client: ClientId,
        params: &Payload,
    ) -> Option<Result<TerminalAttachment, String>> {
        self.handlers
            .get(channel)
            .map(|handler| handler(client, params))
    }

    fn served(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.handlers.keys().copied()
    }
}

/// Every feature the host serves.
pub(crate) struct Features {
    features: Vec<Box<dyn Feature>>,
    events: Arc<Events>,
    resources: ResourcesHandle,
}

impl Features {
    /// Builds each feature. Call it from inside a Tokio runtime: a feature
    /// may start the tasks that feed its events.
    pub fn new(hosted: Arc<Hosted>) -> crate::Result<Self> {
        let context = FeatureContext {
            hosted,
            events: Arc::new(Events::new()),
        };
        let resources = resources::Resources::new(&context)?;
        let handle = resources.handle();
        let features: Vec<Box<dyn Feature>> = vec![
            Box::new(sessions::Sessions::new(&context)?),
            Box::new(history::History::new(&context)?),
            Box::new(config::Config::new(&context)?),
            Box::new(resources),
        ];
        Ok(Self {
            features,
            events: context.events,
            resources: handle,
        })
    }

    pub fn events(&self) -> &Events {
        &self.events
    }

    /// The processes-and-ports pass, for what inside the host asks for it.
    pub fn resources(&self) -> &ResourcesHandle {
        &self.resources
    }

    /// Registers every feature's request handlers for `client`.
    pub fn requests<'a>(&'a self, client: ClientId, router: &mut Router<'a>) {
        for feature in &self.features {
            feature.requests(client, router);
        }
    }

    /// Tells every feature `client`'s connection has ended.
    pub fn client_left(&self, client: ClientId) {
        for feature in &self.features {
            feature.client_left(client);
        }
    }

    /// Every feature's terminal streams.
    pub fn streams(&self) -> Streams<'_> {
        let mut streams = Streams::new();
        for feature in &self.features {
            feature.streams(&mut streams);
        }
        streams
    }

    /// The event and stream channels the features serve. Request channels
    /// are the router's to say.
    pub fn served_events_and_streams(&self) -> BTreeSet<&'static str> {
        let mut served = self.events.served();
        served.extend(self.streams().served());
        served
    }
}
