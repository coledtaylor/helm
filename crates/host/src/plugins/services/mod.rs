//! Plugin services on the host, with today's rules
//! (`desktop/main/plugins/service.ts`).
//!
//! A service is one long-running process a plugin declares: a `node`
//! script in its folder, run on the Node runtime the host ships, or a
//! `command`, any program found the way `floti.exec` finds programs. It is
//! started only when it is needed: on the plugin's first `service:` fetch,
//! or with the plugin for `start: "enable"`. A host with no service running
//! has no Node running.
//!
//! Every service is HTTP on loopback. It is told a free port on 127.0.0.1
//! (`HELM_SERVICE_PORT`), a token minted for this run (`HELM_SERVICE_TOKEN`)
//! and its plugin's id (`HELM_PLUGIN_ID`), with its declared environment,
//! secrets filled as `floti.exec` fills them, over the user's environment
//! less the host's own variables. A fetch reaches it with the token in
//! `Helm-Service-Token`. The token is never logged, listed or put in an
//! error, and nothing that holds it prints it in `Debug`.
//!
//! - [`supervisor`]: one read's service: start, readiness, restarts, stop.
//! - [`launcher`]: starting the process and ending its tree.

pub mod launcher;
pub mod supervisor;

#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use floti_protocol::channels::plugins::PluginServiceStart;

use self::launcher::{ProcessLauncher, ServiceLauncher};
use self::supervisor::Supervisor;
use super::call::{CallContext, PluginCallError};
use super::net::service::{EndpointFuture, PluginServices, ServicePlugin, ServiceStatus};
use super::secrets::SecretsAccess;

/// Where a service's lines about itself go: the plugin's id, then the line.
/// Never given the token or the service's environment.
pub type ServiceLog = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// The environment a service inherits before its own is added.
pub type Inherited = Arc<dyn Fn() -> Vec<(OsString, OsString)> + Send + Sync>;

/// What every service of a host is started with.
pub struct ServicesConfig {
    /// The Node binary `node` services run on, or none.
    pub node: Option<PathBuf>,
    pub secrets: Arc<dyn SecretsAccess>,
    pub launcher: Arc<dyn ServiceLauncher>,
    pub inherited: Inherited,
    pub log: ServiceLog,
}

impl ServicesConfig {
    /// The host's: real processes over its own environment, logging to its
    /// standard error.
    pub fn new(node: Option<PathBuf>, secrets: Arc<dyn SecretsAccess>) -> Self {
        Self {
            node,
            secrets,
            launcher: Arc::new(ProcessLauncher),
            inherited: Arc::new(|| std::env::vars_os().collect()),
            log: Arc::new(|plugin, line| {
                eprintln!("floti host: plugin {plugin}'s service: {line}");
            }),
        }
    }
}

/// What a supervisor shares with the others.
pub(crate) struct Deps {
    pub node: Option<PathBuf>,
    pub secrets: Arc<dyn SecretsAccess>,
    pub launcher: Arc<dyn ServiceLauncher>,
    pub inherited: Inherited,
    pub log: ServiceLog,
    pub runtime: tokio::runtime::Handle,
}

/// The services of every plugin read, one per plugin id.
pub struct ProcessServices {
    deps: Arc<Deps>,
    open: Mutex<HashMap<String, Supervisor>>,
}

impl ProcessServices {
    /// Services that start their tasks on the current Tokio runtime.
    ///
    /// # Panics
    ///
    /// Outside a Tokio runtime.
    pub fn new(config: ServicesConfig) -> Self {
        let ServicesConfig {
            node,
            secrets,
            launcher,
            inherited,
            log,
        } = config;
        Self {
            deps: Arc::new(Deps {
                node,
                secrets,
                launcher,
                inherited,
                log,
                runtime: tokio::runtime::Handle::current(),
            }),
            open: Mutex::new(HashMap::new()),
        }
    }

    fn open_services(&self) -> MutexGuard<'_, HashMap<String, Supervisor>> {
        self.open.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn supervisor(&self, plugin: &str, revision: u64) -> Option<Supervisor> {
        self.open_services()
            .get(plugin)
            .filter(|supervisor| supervisor.revision() == revision)
            .cloned()
    }
}

impl PluginServices for ProcessServices {
    fn endpoint(&self, context: &CallContext) -> EndpointFuture {
        let supervisor = self.supervisor(&context.plugin, context.revision);
        Box::pin(async move {
            match supervisor {
                Some(supervisor) => supervisor.ensure().await,
                None => Err(PluginCallError::unavailable("the service was stopped")),
            }
        })
    }

    fn open(&self, service: ServicePlugin) {
        let start = service.spec.start == PluginServiceStart::Enable;
        let plugin = service.plugin.clone();
        let supervisor = Supervisor::new(service, Arc::clone(&self.deps));
        let replaced = self.open_services().insert(plugin, supervisor.clone());
        if let Some(replaced) = replaced {
            replaced.close();
        }
        if start {
            supervisor.start();
        }
    }

    fn close(&self, plugin: &str, revision: u64) {
        let closed = {
            let mut open = self.open_services();
            match open.get(plugin) {
                Some(supervisor) if supervisor.revision() == revision => open.remove(plugin),
                _ => None,
            }
        };
        if let Some(supervisor) = closed {
            supervisor.close();
        }
    }

    fn status(&self, plugin: &str, revision: u64) -> Option<ServiceStatus> {
        self.supervisor(plugin, revision)
            .map(|supervisor| supervisor.status())
    }
}

impl Drop for ProcessServices {
    /// Whatever is still open ends with the services: nothing they started
    /// outlives them.
    fn drop(&mut self) {
        let open: Vec<Supervisor> = self.open_services().drain().map(|(_, s)| s).collect();
        for supervisor in open {
            supervisor.close();
        }
    }
}
