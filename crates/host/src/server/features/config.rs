//! The config console: `config:*` but `config:render`, which is the
//! workspace's.
//!
//! The console is built for the first backend whose config source has one
//! ([`ConfigSource::console`](crate::agent::ConfigSource::console)), the way
//! history is indexed from the first backend that declares history. Every
//! channel is served whether or not such a backend exists; with none, each
//! is answered with a sentence saying so.
//!
//! Snapshots are kept in floti.db. `config:watch` records the file the
//! calling client's editor has open, until it says otherwise or its
//! connection ends. `config:externalChange` is served one client at a time:
//! an outside change to a watched file goes, carrying its path, only to the
//! clients watching that file, each once, and a client watching another
//! file or none hears nothing. A change made through the host is no outside
//! change and goes to nobody.
//!
//! The MCP commands and the doctor run the agent's CLI for up to a minute.
//! They run off the runtime's workers, so other clients are never kept
//! waiting on them; one client's requests are still answered in order.

use std::sync::Arc;

use floti_protocol::channel::Router;
use floti_protocol::channels::workspace::{
    AddMcpServer, ApproveMcpServer, ConfigChangedOutside, CreateConfigFile, DeleteConfigFile,
    ListConfigScopes, ListConfigSnapshots, ListMcpServers, PreviewMcpServer, ReadConfigFile,
    ReadConfigSnapshot, ReadConfigTree, ReadEffectiveView, RemoveMcpServer, RenameConfigFile,
    RestoreConfigSnapshot, RunDoctor, WatchConfigFile, WriteConfigFile,
};
use tokio::runtime::{Handle, RuntimeFlavor};

use super::{Caller, Feature, FeatureContext};
use crate::config_console::{ConfigConsole, SnapshotStore, change_sink};
use crate::session::ClientId;

/// The answer to every config channel on a host none of whose agents has a
/// config console.
const NO_CONSOLE: &str = "No agent on this host has a config console.";

pub(crate) struct Config {
    console: Option<ConfigConsole>,
}

impl Config {
    pub fn new(context: &FeatureContext) -> crate::Result<Self> {
        context.events.serve_per_client::<ConfigChangedOutside>();
        let console = context
            .hosted
            .backends()
            .iter()
            .find_map(|backend| Some((Arc::clone(backend), backend.config()?.console()?)))
            .map(|(backend, agent)| {
                let events = Arc::clone(&context.events);
                let store: Arc<dyn SnapshotStore> = context.hosted.ledger().shared_store();
                let sink = change_sink(move |client, change| {
                    if let Err(err) = events.emit_to::<ConfigChangedOutside>(client, change) {
                        eprintln!("floti host: {err}");
                    }
                });
                ConfigConsole::new(backend, agent, store, sink)
            });
        Ok(Self { console })
    }

    fn console(&self) -> Result<&ConfigConsole, String> {
        self.console.as_ref().ok_or_else(|| NO_CONSOLE.to_owned())
    }
}

impl Feature for Config {
    fn requests<'a>(&'a self, Caller { client, .. }: Caller, router: &mut Router<'a>) {
        router
            .handle::<ListConfigScopes>(|()| self.console()?.scopes())
            .handle::<ReadConfigTree>(|scope| self.console()?.tree(&scope.scope_path))
            .handle::<ReadConfigFile>(|file| self.console()?.read(&file.path))
            .handle::<WriteConfigFile>(|request| self.console()?.write(&request))
            .handle::<ListConfigSnapshots>(|file| {
                self.console()?.snapshots(&file.scope_path, &file.path)
            })
            .handle::<ReadConfigSnapshot>(|snapshot| self.console()?.snapshot(snapshot.id))
            .handle::<RestoreConfigSnapshot>(|request| {
                self.console()?.restore(request.id, &request.path)
            })
            .handle::<WatchConfigFile>(move |request| {
                self.console()?.watch(client, request.path.as_deref())
            })
            .handle::<CreateConfigFile>(|request| self.console()?.create(&request))
            .handle::<RenameConfigFile>(|request| self.console()?.rename(&request))
            .handle::<DeleteConfigFile>(|request| self.console()?.delete(&request))
            .handle::<ReadEffectiveView>(|request| self.console()?.effective(&request))
            .handle::<PreviewMcpServer>(|request| Ok(self.console()?.mcp_preview(&request)))
            .handle::<AddMcpServer>(|request| {
                let console = self.console()?;
                off_the_workers(|| console.mcp_add(&request))
            })
            .handle::<RemoveMcpServer>(|request| {
                let console = self.console()?;
                off_the_workers(|| console.mcp_remove(&request))
            })
            .handle::<ApproveMcpServer>(|request| self.console()?.mcp_approve(&request))
            .handle::<ListMcpServers>(|request| {
                let console = self.console()?;
                Ok(off_the_workers(|| console.mcp_list(&request.cwd)))
            })
            .handle::<RunDoctor>(|()| {
                let console = self.console()?;
                Ok(off_the_workers(|| console.doctor()))
            });
    }

    fn client_left(&self, client: ClientId) {
        if let Some(console) = &self.console {
            // Forgetting a watch opens nothing, so it cannot be refused.
            let _ = console.watch(client, None);
        }
    }
}

/// Runs `work`, which may wait on a child process for a long time, without
/// holding up a runtime worker: on a multi-threaded runtime the worker's
/// other tasks move to another thread while it runs.
pub(super) fn off_the_workers<T>(work: impl FnOnce() -> T) -> T {
    match Handle::try_current() {
        Ok(handle) if handle.runtime_flavor() == RuntimeFlavor::MultiThread => {
            tokio::task::block_in_place(work)
        }
        _ => work(),
    }
}
