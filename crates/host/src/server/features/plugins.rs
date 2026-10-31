//! Registered plugin folders: `plugins:list`, `add`, `remove`, `setEnabled`,
//! `setTools`, `reload`, `setSetting`, `command`, `log`, `metrics`,
//! `ownSecrets` and `file`, and `plugins:changed`.
//!
//! A plugin runs code on the host with the user's rights, so adding,
//! removing or switching one, or its tools, is an admin's to do: any other
//! device is refused with a sentence saying so, and nothing changes. The
//! rest is open to every paired device.
//!
//! `plugins:changed` carries the whole list: a subscription starts with it,
//! and every change a client asks for that moved something, and whatever a
//! plugin paints, sends it again to every subscriber. A change is answered
//! with the list it came to, which is the one subscribers were sent.
//!
//! The folder picker stays in the client: `plugins:add` is given the folder
//! it produced, and the client asks before it sends `plugins:remove`.
//!
//! The pages a client frames call the host through it ([`pages`]), and hear
//! from it on `plugins:deliver`, which goes to every client: each delivers
//! an event to the frames it holds of that plugin. Settings, secrets,
//! commands, the sessions a plugin may see ([`sessions`]) and a
//! `BroadcastChannel` post all go out that way, and into the plugin's
//! background script when it runs in the host's own engine.

mod pages;
mod secrets;
mod sessions;

use std::sync::{Arc, Weak};

use floti_protocol::EventChannel;
use floti_protocol::channel::{Router, from_payload};
use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::plugins::{
    PluginsAdd, PluginsChanged, PluginsCommand, PluginsDeliver, PluginsFile, PluginsList,
    PluginsLog, PluginsMetrics, PluginsOwnSecrets, PluginsReload, PluginsRemove, PluginsSetEnabled,
    PluginsSetSetting, PluginsSetTools,
};
use floti_protocol::channels::sessions::{
    SessionActivityChanged, SessionActivityState, SessionExit,
};
use tokio::sync::broadcast;

use super::{ActivityHandle, Caller, Feature, FeatureContext};
use crate::devices::Role;
use crate::plugins::log::PluginLogs;
use crate::plugins::net::Net;
use crate::plugins::runtime::{ChannelMessage, IsolateRuntime};
use crate::plugins::services::{ProcessServices, ServicesConfig};
use crate::plugins::{Registry, RegistryParts, WeakRegistry};
use crate::server::events::Publication;
use crate::session::ClientId;
pub(crate) use sessions::PluginSessions;
use sessions::now_ms;

/// Refuses a change only an admin device may make, naming what the caller
/// is paired as.
fn admin_only(caller: Caller) -> Result<(), String> {
    let paired_as = match caller.role {
        Role::Admin => return Ok(()),
        Role::Operator => "an operator",
        Role::Viewer => "a viewer",
    };
    Err(format!(
        "Adding, removing or switching a plugin takes an admin device, and this device is paired as {paired_as}."
    ))
}

pub(crate) struct Plugins {
    registry: Registry,
    secrets: secrets::Secrets,
    pages: Arc<pages::Pages>,
}

impl Plugins {
    /// Builds the registry and starts every plugin that is on. `activity`
    /// is read again when a plugin starts a session; `sessions` is what
    /// plugins are told of the host's sessions. Call it from inside a Tokio
    /// runtime: it starts the tasks that carry sessions and background
    /// posts to plugins.
    pub fn new(
        context: &FeatureContext,
        activity: ActivityHandle,
        sessions: Arc<PluginSessions>,
    ) -> crate::Result<Self> {
        let events = Arc::clone(&context.events);
        let delivering = Arc::clone(&context.events);
        context.events.serve_events::<PluginsDeliver>();
        let secrets = secrets::Secrets::new(context)?;
        let logs = Arc::new(PluginLogs::default());
        let runtime = IsolateRuntime::with_logs(Arc::clone(&logs));
        // Started only when a plugin needs one, on the Node this host ships
        // (or the one FLOTI_NODE names), and ended with the registry.
        let services = Arc::new(ProcessServices::new(ServicesConfig::new(
            context.workspace.run.node.clone(),
            secrets.store(),
            Arc::clone(&logs),
        )));
        let registry = Registry::new(RegistryParts {
            store: context.hosted.ledger().shared_store(),
            background: Arc::new(runtime.clone()),
            secrets: secrets.store(),
            services: Arc::clone(&services) as _,
            logs,
            publish: Box::new(move |list| {
                // A list nobody could be sent is not a reason to fail the
                // change that made it: the next one carries it.
                let _ = events.set_state::<PluginsChanged, _>(list);
            }),
            deliver: Box::new(move |delivery| {
                // No client framing the plugin is nothing to fail over.
                let _ = delivering.emit::<PluginsDeliver>(delivery);
            }),
        });
        runtime.connect(&registry);
        let pages = Arc::new(pages::Pages::new(
            &context.events,
            &context.hosted,
            activity,
        ));
        crate::plugins::secrets::register_methods(registry.methods(), secrets.store());
        crate::plugins::exec::register_methods(registry.methods(), secrets.store());
        crate::plugins::net::register_methods(
            registry.methods(),
            Arc::new(Net::new(secrets.store(), services)),
        );
        pages.register_methods(registry.methods(), secrets.store(), Arc::clone(&sessions));
        registry.watch_folders();
        registry.start()?;
        context
            .events
            .serve_state::<PluginsChanged, _>(&registry.list())?;
        tokio::spawn(tell_sessions(
            context.events.observe(),
            registry.downgrade(),
            sessions,
        ));
        tokio::spawn(relay_background_posts(
            runtime.channel_messages(),
            registry.downgrade(),
        ));
        Ok(Self {
            registry,
            secrets,
            pages,
        })
    }
}

/// Tells every plugin that sees sessions each time one starts, ends, is
/// renamed or changes what it is doing, from what the host publishes about
/// its sessions. Ends with the events, or with the registry.
async fn tell_sessions(
    mut published: broadcast::Receiver<Publication>,
    registry: WeakRegistry,
    sessions: Arc<PluginSessions>,
) {
    loop {
        let publication = match published.recv().await {
            Ok(publication) => publication,
            // Missed publications: the next one carries the whole state.
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => return,
        };
        let now = now_ms();
        let moved = if publication.channel == SessionActivityChanged::NAME {
            let Ok(states) = from_payload::<Vec<SessionActivityState>>(&publication.payload) else {
                continue;
            };
            let running: Vec<u64> = states.iter().map(|state| state.id).collect();
            let met = sessions.activity(&states, now);
            sessions.running_now(&running, now) || met
        } else if publication.channel == SessionExit::NAME {
            let Ok(record) = from_payload::<SessionRecord>(&publication.payload) else {
                continue;
            };
            sessions.ended(&record, now)
        } else {
            continue;
        };
        let Some(registry) = registry.upgrade() else {
            return;
        };
        if moved {
            registry.sessions_changed(&sessions.list());
        }
    }
}

/// Carries each post a background script in the host's engine makes on a
/// `BroadcastChannel` to the plugin's pages on every client.
async fn relay_background_posts(
    mut posts: broadcast::Receiver<ChannelMessage>,
    registry: WeakRegistry,
) {
    loop {
        let post = match posts.recv().await {
            Ok(post) => post,
            Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => return,
        };
        let Some(registry) = registry.upgrade() else {
            return;
        };
        registry.background_posted(&post.plugin, &post.channel, post.data);
    }
}

/// The caller a plugin's tool is told of for a call from session `row`,
/// while `sessions` is there.
pub(crate) fn tool_caller(
    sessions: Weak<PluginSessions>,
) -> impl Fn(u64) -> Option<floti_protocol::channels::agent_plugin::AgentPluginCaller> + Send + Sync
{
    move |row| sessions.upgrade()?.caller(row)
}

impl Drop for Plugins {
    fn drop(&mut self) {
        self.registry.shutdown();
    }
}

impl Feature for Plugins {
    fn requests<'a>(&'a self, caller: Caller, router: &mut Router<'a>) {
        let registry = &self.registry;
        router
            .handle::<PluginsList>(|()| Ok(registry.list()))
            .handle::<PluginsAdd>(move |request| {
                admin_only(caller)?;
                registry.add(&request.path)
            })
            .handle::<PluginsRemove>(move |request| {
                admin_only(caller)?;
                registry.remove(&request.path, &request.delete_secrets)
            })
            .handle::<PluginsSetEnabled>(move |request| {
                admin_only(caller)?;
                registry.set_enabled(&request.path, request.enabled)
            })
            .handle::<PluginsSetTools>(move |request| {
                admin_only(caller)?;
                registry.set_tools(&request.path, request.enabled)
            })
            .handle::<PluginsReload>(|request| registry.reload(&request.path))
            .handle::<PluginsLog>(|request| registry.log(&request.path))
            .handle::<PluginsMetrics>(|()| Ok(registry.metrics()))
            .handle::<PluginsFile>(|request| {
                Ok(registry.file(&request.plugin, &request.path, request.offset))
            })
            .handle::<PluginsSetSetting>(|request| {
                registry.set_setting(&request.plugin, &request.key, &request.value)
            })
            .handle::<PluginsCommand>(|request| registry.command(&request.plugin, &request.id))
            .handle::<PluginsOwnSecrets>(|request| registry.own_secrets(&request.path));
        self.secrets.requests(registry, router);
        self.pages.requests(registry, caller, router);
    }

    fn client_left(&self, client: ClientId) {
        self.pages.client_left(client);
    }
}
