//! Registered plugin folders: `plugins:list`, `add`, `remove`, `setEnabled`,
//! `reload`, `setSetting`, `command` and `ownSecrets`, and `plugins:changed`.
//!
//! `plugins:changed` carries the whole list: a subscription starts with it,
//! and every change a client asks for that moved something, and whatever a
//! plugin paints, sends it again to every subscriber. A change is answered
//! with the list it came to, which is the one subscribers were sent.
//!
//! The folder picker stays in the client: `plugins:add` is given the folder
//! it produced, and the client asks before it sends `plugins:remove`.

mod secrets;

use std::sync::Arc;

use floti_protocol::channel::Router;
use floti_protocol::channels::plugins::{
    PluginsAdd, PluginsChanged, PluginsCommand, PluginsList, PluginsOwnSecrets, PluginsReload,
    PluginsRemove, PluginsSetEnabled, PluginsSetSetting,
};

use super::{Feature, FeatureContext};
use crate::plugins::runtime::IsolateRuntime;
use crate::plugins::{Registry, RegistryParts};
use crate::session::ClientId;

pub(crate) struct Plugins {
    registry: Registry,
    /// Every background script; the plugin pages and tool families reach
    /// them through it.
    #[allow(dead_code)]
    runtime: IsolateRuntime,
    secrets: secrets::Secrets,
}

impl Plugins {
    pub fn new(context: &FeatureContext) -> crate::Result<Self> {
        let events = Arc::clone(&context.events);
        let secrets = secrets::Secrets::new(context)?;
        let runtime = IsolateRuntime::new();
        let registry = Registry::new(RegistryParts {
            store: context.hosted.ledger().shared_store(),
            background: Arc::new(runtime.clone()),
            secrets: secrets.store(),
            publish: Box::new(move |list| {
                // A list nobody could be sent is not a reason to fail the
                // change that made it: the next one carries it.
                let _ = events.set_state::<PluginsChanged, _>(list);
            }),
        });
        runtime.connect(&registry);
        crate::plugins::secrets::register_methods(registry.methods(), secrets.store());
        registry.start()?;
        context
            .events
            .serve_state::<PluginsChanged, _>(&registry.list())?;
        Ok(Self {
            registry,
            runtime,
            secrets,
        })
    }
}

impl Drop for Plugins {
    fn drop(&mut self) {
        self.registry.shutdown();
    }
}

impl Feature for Plugins {
    fn requests<'a>(&'a self, _client: ClientId, router: &mut Router<'a>) {
        let registry = &self.registry;
        router
            .handle::<PluginsList>(|()| Ok(registry.list()))
            .handle::<PluginsAdd>(|request| registry.add(&request.path))
            .handle::<PluginsRemove>(|request| {
                registry.remove(&request.path, &request.delete_secrets)
            })
            .handle::<PluginsSetEnabled>(|request| {
                registry.set_enabled(&request.path, request.enabled)
            })
            .handle::<PluginsReload>(|request| registry.reload(&request.path))
            .handle::<PluginsSetSetting>(|request| {
                registry.set_setting(&request.plugin, &request.key, &request.value)
            })
            .handle::<PluginsCommand>(|request| registry.command(&request.plugin, &request.id))
            .handle::<PluginsOwnSecrets>(|request| registry.own_secrets(&request.path));
        self.secrets.requests(registry, router);
    }
}
