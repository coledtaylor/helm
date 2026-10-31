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

mod secrets;

use std::sync::Arc;

use floti_protocol::channel::Router;
use floti_protocol::channels::plugins::{
    PluginsAdd, PluginsChanged, PluginsCommand, PluginsFile, PluginsList, PluginsLog,
    PluginsMetrics, PluginsOwnSecrets, PluginsReload, PluginsRemove, PluginsSetEnabled,
    PluginsSetSetting, PluginsSetTools,
};

use super::{Caller, Feature, FeatureContext};
use crate::devices::Role;
use crate::plugins::log::PluginLogs;
use crate::plugins::net::Net;
use crate::plugins::runtime::IsolateRuntime;
use crate::plugins::services::{ProcessServices, ServicesConfig};
use crate::plugins::{Registry, RegistryParts};

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
        });
        runtime.connect(&registry);
        crate::plugins::secrets::register_methods(registry.methods(), secrets.store());
        crate::plugins::exec::register_methods(registry.methods(), secrets.store());
        crate::plugins::net::register_methods(
            registry.methods(),
            Arc::new(Net::new(secrets.store(), services)),
        );
        registry.watch_folders();
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
    }
}
