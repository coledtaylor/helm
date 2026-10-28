//! What `floti.fetch` asks of a plugin's service: where it listens and the
//! token it requires, starting it if it is not running.
//!
//! A `service:/path` request goes to the plugin's own service, on the
//! loopback port the host gave it, with the token it was given. The host does
//! not run plugin services yet, so [`NoServices`] answers every plugin that
//! declares one with a `service` failure, and the request is never sent.

use std::future::Future;
use std::pin::Pin;

use floti_protocol::channels::plugins::PluginErrorCode;
use url::Url;

use crate::plugins::call::{CallContext, PluginCallError};

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

pub trait PluginServices: Send + Sync {
    /// The service of the plugin `context` is for, which declares one,
    /// started if it is not running. Fails as `service` when it cannot be.
    fn endpoint(&self, context: &CallContext) -> EndpointFuture;
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
                "the plugin's service could not be started: this host does not run plugin services yet",
            ))
        })
    }
}
