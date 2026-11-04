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
//! - [`forwards`]: connections to the loopback ports a session's own process
//!   tree listens on (`sessions:port`).
//! - [`workspace`]: the host's identity, settings and setup, and what the
//!   workspace features below share.
//! - [`discovery`]: project discovery, scan roots and harnesses.
//! - [`profiles`]: saved profiles.
//! - [`templates`]: harness templates.
//! - [`content`]: notes and documents, and the renderer.
//! - [`files`]: the Files view.
//! - [`plugins`]: registered plugin folders and `plugins:changed`, and the
//!   calls, asks and deliveries of the plugin pages clients frame.
//! - [`agent_browser`]: the agent browser tools' calls, carried to a client
//!   with a browser pane, and its answers.
//! - [`agent_plugin`]: the plugin tool servers a client offers, their calls
//!   carried to it, and its answers.
//! - [`carry`]: a client's own data, merged into the host's store once.
//! - [`wsl`]: keeping a WSL distro on this computer running while the host
//!   inside it has sessions (`wsl:keepAwake`).

mod agent_browser;
mod agent_plugin;
mod carry;
mod config;
mod content;
mod discovery;
mod files;
mod forwards;
mod history;
mod plugins;
mod profiles;
mod resources;
mod sessions;
mod templates;
mod workspace;
mod wsl;

use std::collections::{BTreeSet, HashMap};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use floti_protocol::channel::{Router, StreamChannel, from_payload};
use floti_protocol::{ClientChannels, Payload};
use tokio::net::TcpStream;
use tokio::sync::mpsc::UnboundedReceiver;

use super::HostRun;
use super::attached::Attached;
use super::events::Events;
use super::hosted::Hosted;
use crate::platform::folders::Folders;
use crate::session::{ClientId, Session, SessionOutput};
pub(crate) use agent_browser::BrowserRelay;
pub(crate) use agent_plugin::{PluginRelay, PluginServer};
pub use resources::ResourcesHandle;
pub(crate) use sessions::ActivityHandle;
pub(crate) use workspace::WorkspaceContext;

use crate::workspace::settings::SettingsService;

/// What every feature is built with.
pub(crate) struct FeatureContext {
    pub hosted: Arc<Hosted>,
    pub events: Arc<Events>,
    pub workspace: Arc<WorkspaceContext>,
}

/// Who a request comes from: the client. Every client is served in full,
/// so nothing else about it changes what it may ask.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Caller {
    pub client: ClientId,
}

impl Caller {
    pub fn new(client: ClientId) -> Self {
        Self { client }
    }
}

/// One feature of the host.
pub(crate) trait Feature: Send + Sync {
    /// Registers a handler for each request channel it serves, answering
    /// `caller`.
    fn requests<'a>(&'a self, caller: Caller, router: &mut Router<'a>);

    /// Registers each terminal stream it serves.
    fn streams<'a>(&'a self, streams: &mut Streams<'a>) {
        let _ = streams;
    }

    /// `client` subscribed or unsubscribed: `channels` are its
    /// subscriptions now.
    fn subscriptions_changed(&self, client: ClientId, channels: &ClientChannels<'_>) {
        let _ = (client, channels);
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

/// A connection on the host's own loopback a client opened a stream on: what
/// the client sends is written to it, and what it answers is sent back.
pub(crate) struct SocketAttachment {
    pub socket: TcpStream,
    /// Settles, with the sentence the stream is closed with, when what the
    /// connection was opened for has ended (its session).
    pub ended: Pin<Box<dyn Future<Output = String> + Send>>,
}

/// What a stream carries once it is open.
pub(crate) enum StreamAttachment {
    Terminal(TerminalAttachment),
    Socket(SocketAttachment),
}

/// A stream being opened by work that takes time (a process-and-ports pass,
/// a connection), which the connection waits on while it serves on.
pub(crate) type Opening = Pin<Box<dyn Future<Output = Result<StreamAttachment, String>> + Send>>;

/// How a stream opens: now, or once its work is done. Either way an `Err` is
/// the sentence the stream is closed with.
pub(crate) enum StreamOpening {
    Now(Result<StreamAttachment, String>),
    Later(Opening),
}

type StreamHandler<'a> = Box<dyn Fn(ClientId, &Payload) -> StreamOpening + 'a>;

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

    fn insert(&mut self, name: &'static str, handler: StreamHandler<'a>) {
        let previous = self.handlers.insert(name, handler);
        assert!(previous.is_none(), "stream `{name}` is served twice");
    }

    /// Serves `C`, a terminal attached at once. The handler's `Err` is the
    /// sentence the stream is closed with.
    pub fn handle<C: StreamChannel>(
        &mut self,
        handler: impl Fn(ClientId, C::Open) -> Result<TerminalAttachment, String> + 'a,
    ) -> &mut Self {
        self.insert(
            C::NAME,
            Box::new(move |client, params| {
                StreamOpening::Now(
                    from_payload::<C::Open>(params)
                        .and_then(|open| handler(client, open))
                        .map(StreamAttachment::Terminal),
                )
            }),
        );
        self
    }

    /// Serves `C`, opened by work the handler returns, which the connection
    /// waits on while it serves on.
    pub fn handle_later<C: StreamChannel>(
        &mut self,
        handler: impl Fn(ClientId, C::Open) -> Opening + 'a,
    ) -> &mut Self {
        self.insert(
            C::NAME,
            Box::new(
                move |client, params| match from_payload::<C::Open>(params) {
                    Ok(open) => StreamOpening::Later(handler(client, open)),
                    Err(why) => StreamOpening::Now(Err(why)),
                },
            ),
        );
        self
    }

    /// Opens a stream on `channel` for `client`, or `None` when no feature
    /// serves it.
    pub fn open(&self, channel: &str, client: ClientId, params: &Payload) -> Option<StreamOpening> {
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
    attached: Arc<Attached>,
    resources: ResourcesHandle,
    activity: ActivityHandle,
    settings: Arc<SettingsService>,
    browser: Arc<BrowserRelay>,
    plugin_tools: Arc<PluginRelay>,
    /// The plugin registry the plugins feature keeps: the host waits on its
    /// shutdown before it lets go of the store.
    plugins: crate::plugins::Registry,
}

impl Features {
    /// Builds each feature. Call it from inside a Tokio runtime: a feature
    /// may start the tasks that feed its events.
    ///
    /// The workspace's shared state is built first: it points each backend
    /// at the executable the settings choose before any feature captures how
    /// a backend runs.
    pub fn new(hosted: Arc<Hosted>, folders: Folders, run: HostRun) -> crate::Result<Self> {
        let wsl_program = run.wsl.clone();
        let workspace = Arc::new(WorkspaceContext::new(&hosted, folders, run)?);
        let context = FeatureContext {
            hosted,
            events: Arc::new(Events::new()),
            workspace,
        };
        let resources = resources::Resources::new(&context)?;
        let handle = resources.handle();
        let sessions = sessions::Sessions::new(&context)?;
        let activity = sessions.activity();
        let browser = Arc::new(BrowserRelay::new(&context.events));
        let plugin_sessions = Arc::new(plugins::PluginSessions::new(&context.hosted));
        let plugin_tools = Arc::new(
            PluginRelay::new(&context.events)
                .naming_callers(plugins::tool_caller(Arc::downgrade(&plugin_sessions))),
        );
        let attached = Arc::new(Attached::serve(Arc::clone(&context.events))?);
        let history = history::History::new(&context)?;
        let carry = carry::Carry::new(&context, history.handle());
        let forwards = forwards::Forwards::new(&context, handle.clone());
        let mut features: Vec<Box<dyn Feature>> = vec![
            Box::new(sessions),
            Box::new(forwards),
            Box::new(history),
            Box::new(carry),
            Box::new(config::Config::new(&context)?),
            Box::new(resources),
            Box::new(workspace::Workspace::new(&context)?),
            Box::new(discovery::Discovery::new(&context)?),
            Box::new(profiles::Profiles::new(&context)?),
            Box::new(templates::Templates::new(&context)?),
            Box::new(content::Content::new(&context)?),
            Box::new(files::Files::new(&context)?),
        ];
        let plugins = plugins::Plugins::new(
            &context,
            activity.clone(),
            plugin_sessions,
            Arc::clone(&plugin_tools),
        )?;
        let plugin_registry = plugins.registry().clone();
        features.push(Box::new(plugins));
        features.push(Box::new(Arc::clone(&browser)));
        features.push(Box::new(Arc::clone(&plugin_tools)));
        features.push(Box::new(wsl::Wsl::new(&context, wsl_program)));
        Ok(Self {
            features,
            events: context.events,
            attached,
            resources: handle,
            activity,
            settings: Arc::clone(&context.workspace.settings),
            browser,
            plugin_tools,
            plugins: plugin_registry,
        })
    }

    /// The plugin registry, for the host to shut down as it stops.
    pub fn plugins(&self) -> &crate::plugins::Registry {
        &self.plugins
    }

    pub fn events(&self) -> &Events {
        &self.events
    }

    /// Who is attached now, which each welcomed connection enters.
    pub fn attached(&self) -> &Arc<Attached> {
        &self.attached
    }

    /// The activity pass, for what inside the host reads the listing now.
    pub fn activity(&self) -> &ActivityHandle {
        &self.activity
    }

    /// The host's settings, for what inside the host follows them.
    pub fn settings(&self) -> &Arc<SettingsService> {
        &self.settings
    }

    /// The agent browser tools' relay, for the family that carries calls on
    /// it.
    pub fn browser(&self) -> &Arc<BrowserRelay> {
        &self.browser
    }

    /// The plugin tools' relay, for the families served from what clients
    /// offer.
    pub fn plugin_tools(&self) -> &Arc<PluginRelay> {
        &self.plugin_tools
    }

    /// The processes-and-ports pass, for what inside the host asks for it.
    pub fn resources(&self) -> &ResourcesHandle {
        &self.resources
    }

    /// Registers every feature's request handlers for `caller`.
    pub fn requests<'a>(&'a self, caller: Caller, router: &mut Router<'a>) {
        for feature in &self.features {
            feature.requests(caller, router);
        }
    }

    /// Tells every feature `client`'s subscriptions are now `channels`.
    pub fn subscriptions_changed(&self, client: ClientId, channels: &ClientChannels<'_>) {
        for feature in &self.features {
            feature.subscriptions_changed(client, channels);
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
