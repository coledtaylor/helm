//! The host's identity, settings and setup: `app:info`, `settings:*` and
//! `setup:*`; and what every workspace feature shares ([`WorkspaceContext`]).
//!
//! `settings:changed` carries the whole settings: a subscription starts with
//! them, and every accepted write, whichever client made it and through
//! whichever channel (`settings:write`, `setup:locateBackend`,
//! `setup:complete`), sends them again to every subscriber. A write refused
//! by validation changes nothing and sends nothing.
//!
//! A backend executable the user chose is used from the host's start and
//! from the moment it is chosen or cleared: every launch, version check and
//! config-console command runs it.

#[cfg(test)]
mod tests;

use std::sync::Arc;

use floti_protocol::BackendId;
use floti_protocol::channel::Router;
use floti_protocol::channels::workspace::{
    BackendStatus, CompleteSetup, HostSettings, HostSettingsPatch, LocateBackend,
    LocateBackendRequest, ReadAppInfo, ReadSettings, ReadSetupStatus, SettingsChanged, SetupStatus,
    WriteSettings,
};

use super::config::off_the_workers;
use super::{Caller, Feature, FeatureContext};
use crate::agent::AgentBackend;
use crate::config_console::time::now_iso;
use crate::platform::folders::Folders;
use crate::server::HostRun;
use crate::server::hosted::Hosted;
use crate::workspace::roots::KnownRoots;
use crate::workspace::settings::SettingsService;
use crate::workspace::{app, setup};

/// What every workspace feature is built with.
pub(crate) struct WorkspaceContext {
    pub settings: Arc<SettingsService>,
    pub roots: Arc<KnownRoots>,
    pub folders: Folders,
    pub run: HostRun,
}

impl WorkspaceContext {
    /// The settings over the host's store, with each backend set to run the
    /// executable they choose for it, and the known folders: the store's
    /// and each hosted session's working directory.
    pub fn new(hosted: &Arc<Hosted>, folders: Folders, run: HostRun) -> crate::Result<Self> {
        let store = hosted.ledger().shared_store();
        let settings = Arc::new(SettingsService::new(Arc::clone(&store)));
        use_chosen_executables(hosted.backends(), &settings.read()?);
        let backends: Vec<Arc<dyn AgentBackend>> = hosted.backends().to_vec();
        settings.on_change(move |settings| use_chosen_executables(&backends, settings));
        let sessions = Arc::clone(hosted);
        let roots = Arc::new(KnownRoots::new(store, move || {
            sessions
                .list()
                .map(|records| records.into_iter().map(|record| record.cwd).collect())
                .unwrap_or_default()
        }));
        Ok(Self {
            settings,
            roots,
            folders,
            run,
        })
    }
}

/// Points every backend that has an executable at the one `settings` choose
/// for it, or back at the one it finds.
fn use_chosen_executables(backends: &[Arc<dyn AgentBackend>], settings: &HostSettings) {
    for backend in backends {
        if let Some(executable) = backend.executable() {
            let chosen = settings
                .backend_paths
                .get(backend.id())
                .map(|path| path.trim())
                .filter(|path| !path.is_empty())
                .map(std::path::PathBuf::from);
            executable.use_executable(chosen);
        }
    }
}

pub(crate) struct Workspace {
    hosted: Arc<Hosted>,
    context: Arc<WorkspaceContext>,
}

impl Workspace {
    pub fn new(context: &FeatureContext) -> crate::Result<Self> {
        let workspace = Arc::clone(&context.workspace);
        context
            .events
            .serve_state::<SettingsChanged, _>(&workspace.settings.read()?)?;
        let events = Arc::clone(&context.events);
        workspace.settings.on_change(move |settings| {
            if let Err(err) = events.set_state::<SettingsChanged, _>(settings) {
                eprintln!("floti host: {err}");
            }
        });
        Ok(Self {
            hosted: Arc::clone(&context.hosted),
            context: workspace,
        })
    }

    fn settings(&self) -> Result<HostSettings, String> {
        self.context.settings.read().map_err(|err| err.to_string())
    }

    fn write(&self, patch: &HostSettingsPatch) -> Result<HostSettings, String> {
        self.context
            .settings
            .write(patch)
            .map_err(|err| err.to_string())
    }

    fn setup_status(&self) -> Result<SetupStatus, String> {
        Ok(setup::setup_status(
            self.hosted.backends(),
            &self.settings()?.backend_paths,
        ))
    }

    fn backend(&self, id: &BackendId) -> Result<&Arc<dyn AgentBackend>, String> {
        self.hosted
            .backends()
            .iter()
            .find(|backend| backend.id() == id)
            .ok_or_else(|| format!("This Floti host has no agent backend `{id}`."))
    }

    /// Keeps `request.path` as the backend's executable once it has answered
    /// its version, and answers what setup finds for the backend after. A
    /// file that is not one is the answer's `error`, and nothing is kept.
    fn locate(&self, request: &LocateBackendRequest) -> Result<BackendStatus, String> {
        let backend = self.backend(&request.backend)?;
        let no_status = || format!("{} has no executable to choose.", backend.name());
        let current = self.settings()?.backend_paths;
        if let Err(problem) = setup::check_chosen(backend.as_ref(), &request.path) {
            let mut status = setup::backend_status(
                backend.as_ref(),
                current.get(&request.backend).map(String::as_str),
            )
            .ok_or_else(no_status)?;
            status.error = Some(problem);
            return Ok(status);
        }
        let mut paths = current;
        paths.insert(request.backend.clone(), request.path.clone());
        let after = self.write(&HostSettingsPatch {
            backend_paths: Some(paths),
            ..HostSettingsPatch::default()
        })?;
        setup::backend_status(
            backend.as_ref(),
            after
                .backend_paths
                .get(&request.backend)
                .map(String::as_str),
        )
        .ok_or_else(no_status)
    }
}

impl Feature for Workspace {
    fn requests<'a>(&'a self, _caller: Caller, router: &mut Router<'a>) {
        router
            .handle::<ReadAppInfo>(|()| {
                let store = self.hosted.ledger().store();
                Ok(app::app_info(
                    &self.context.run,
                    &self.context.folders,
                    &store,
                ))
            })
            .handle::<ReadSettings>(|()| self.settings())
            .handle::<WriteSettings>(|patch| self.write(&patch))
            .handle::<ReadSetupStatus>(|()| off_the_workers(|| self.setup_status()))
            .handle::<LocateBackend>(|request| off_the_workers(|| self.locate(&request)))
            .handle::<CompleteSetup>(|()| {
                self.write(&HostSettingsPatch {
                    first_run_completed_at: Some(Some(now_iso())),
                    ..HostSettingsPatch::default()
                })
            });
    }
}
