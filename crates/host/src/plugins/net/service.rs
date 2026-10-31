//! What the registry and `floti.fetch` ask of plugin services: each read of
//! a plugin that declares one hands its service over, and a `service:/path`
//! request asks where it listens and the token it requires, starting it if
//! it is not running.
//!
//! A `service:/path` request goes to the plugin's own service, on the
//! loopback port the host gave it, with the token it was given. The host's
//! services are [`ProcessServices`](crate::plugins::services::ProcessServices);
//! [`NoServices`] is a host that runs none, which answers every plugin that
//! declares one with a `service` failure, and the request is never sent.

use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use floti_protocol::channels::plugins::{PluginErrorCode, PluginServiceState};
use url::Url;

use crate::plugins::call::{CallContext, PluginCallError};
use crate::plugins::manifest::ServiceSpec;

/// The header a service is told to require. See `ServiceSpec` in the SDK.
pub const SERVICE_TOKEN_HEADER: &str = "Helm-Service-Token";

/// A running service: its loopback origin and the token for this run.
#[derive(Clone, PartialEq, Eq)]
pub struct ServiceEndpoint {
    pub origin: Url,
    pub token: String,
}

impl std::fmt::Debug for ServiceEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServiceEndpoint")
            .field("origin", &self.origin.as_str())
            .finish_non_exhaustive()
    }
}

pub type EndpointFuture =
    Pin<Box<dyn Future<Output = Result<ServiceEndpoint, PluginCallError>> + Send>>;

/// Says the plugin list moved: a service started, stopped or failed.
pub type ServiceChanged = Arc<dyn Fn() + Send + Sync>;

/// One read of a plugin that declares a service, as the registry hands it
/// over: from that read on, the plugin's service is this one, stopped.
#[derive(Clone)]
pub struct ServicePlugin {
    pub plugin: String,
    /// The read it is for. A call made against another read is not answered
    /// by it.
    pub revision: u64,
    /// The plugin folder, links resolved.
    pub folder: PathBuf,
    pub spec: ServiceSpec,
    /// The manifest's `secrets`: what its declared environment may fill.
    pub secrets: Vec<String>,
    pub changed: ServiceChanged,
}

impl std::fmt::Debug for ServicePlugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServicePlugin")
            .field("plugin", &self.plugin)
            .field("revision", &self.revision)
            .field("folder", &self.folder)
            .field("command", &self.spec.command)
            .finish_non_exhaustive()
    }
}

/// What the plugin list shows of a service now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceStatus {
    pub state: PluginServiceState,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    /// Starts after an exit, this read.
    pub restarts: u32,
    pub error: Option<String>,
}

impl Default for ServiceStatus {
    fn default() -> Self {
        Self {
            state: PluginServiceState::Stopped,
            pid: None,
            port: None,
            restarts: 0,
            error: None,
        }
    }
}

pub trait PluginServices: Send + Sync {
    /// The service of the plugin `context` is for, which declares one,
    /// started if it is not running. Fails as `service` when it cannot be,
    /// and as `unavailable` when it is stopped while the call waits.
    fn endpoint(&self, context: &CallContext) -> EndpointFuture;

    /// A read of a plugin that declares a service: it is the plugin's
    /// service from now on, started at once when it starts with the plugin.
    fn open(&self, service: ServicePlugin) {
        let _ = service;
    }

    /// The read `revision` of `plugin` has stopped (switched off, read
    /// again, removed, or the host is stopping): its service ends, with
    /// everything it started, and calls waiting for it are refused.
    fn close(&self, plugin: &str, revision: u64) {
        let _ = (plugin, revision);
    }

    /// What the read `revision` of `plugin` has running, when it is the one
    /// open.
    fn status(&self, plugin: &str, revision: u64) -> Option<ServiceStatus> {
        let _ = (plugin, revision);
        None
    }
}

/// No plugin service runs on this host: a plugin that declares one is told
/// it could not be started.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoServices;

impl PluginServices for NoServices {
    fn endpoint(&self, _context: &CallContext) -> EndpointFuture {
        Box::pin(async {
            Err(PluginCallError::new(
                PluginErrorCode::Service,
                "the plugin's service could not be started: this host runs no plugin services",
            ))
        })
    }
}
