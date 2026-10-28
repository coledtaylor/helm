//! Project discovery: `discovery:*`, `scan:status`, `git:updated`,
//! `git:refresh` and `roots:*`. `harness:create` is served with templates.
//!
//! Scans happen when today's app has them: one when the host starts, as the
//! desktop's main process scans once its window is up, and one whenever a
//! client asks (after it adds or removes a root, say). Git is read again
//! when a client asks with `git:refresh`, which a client sends when its
//! window comes back to the front, as the desktop's main process does on
//! its window's focus.
//!
//! What subscribers see of a scan, in order: `scan:status` running, then the
//! result on `discovery:updated` (and, when it read git, the same git state
//! on `git:updated`, so that snapshot is never older than the scan's), then
//! `scan:status` stopped. Scans that overlap are one running stretch.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use floti_protocol::channel::Router;
use floti_protocol::channels::workspace::{
    AcceptRoot, DiscoveryResult, DiscoveryUpdated, GitUpdated, ReadCachedDiscovery, RefreshGit,
    RemoveRoot, ScanForProjects, ScanStatus, ScanStatusChanged, SuggestRoots,
};

use super::config::off_the_workers;
use super::{Feature, FeatureContext};
use crate::server::events::Events;
use crate::session::ClientId;
use crate::workspace::discovery::{DiscoveryService, GitStates, ScanTicket, scan};

pub(crate) struct Discovery {
    scanner: Arc<Scanner>,
}

/// The discovery service and what its subscribers are told.
struct Scanner {
    service: DiscoveryService,
    events: Arc<Events>,
    running: Mutex<Running>,
}

#[derive(Default)]
struct Running {
    scans: usize,
    /// Why a scan of the current stretch failed outright, if one did.
    error: Option<String>,
}

impl Discovery {
    /// Serves the discovery channels and starts the host's first scan. Its
    /// roots are decided here; only the walk runs in the background, and a
    /// walk the host outlives writes nothing.
    pub fn new(context: &FeatureContext) -> crate::Result<Self> {
        let workspace = &context.workspace;
        let service = DiscoveryService::new(
            context.hosted.ledger().shared_store(),
            Arc::clone(&workspace.settings),
            workspace.run.home.clone(),
        );
        context.events.serve_state_from::<DiscoveryUpdated>(&None)?;
        context
            .events
            .serve_state::<ScanStatusChanged, _>(&ScanStatus {
                running: false,
                error: None,
            })?;
        context
            .events
            .serve_state::<GitUpdated, _>(&GitStates::new())?;
        let scanner = Arc::new(Scanner {
            service,
            events: Arc::clone(&context.events),
            running: Mutex::new(Running::default()),
        });
        let ticket = scanner.service.begin_scan()?;
        scanner.started();
        let first = Arc::downgrade(&scanner);
        tokio::task::spawn_blocking(move || first_scan(&first, &ticket));
        Ok(Self { scanner })
    }
}

fn first_scan(scanner: &Weak<Scanner>, ticket: &ScanTicket) {
    let result = scan::scan(&ticket.roots, true);
    let Some(scanner) = scanner.upgrade() else {
        return;
    };
    let outcome = scanner.service.finish_scan(ticket, result);
    // Nobody asked for this one: its result goes to the subscribers alone.
    let _ = scanner.landed(outcome, true);
}

impl Scanner {
    fn lock(&self) -> MutexGuard<'_, Running> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn status(&self, status: &ScanStatus) {
        if let Err(err) = self.events.set_state::<ScanStatusChanged, _>(status) {
            eprintln!("floti host: {err}");
        }
    }

    /// A scan has started: the first of a stretch says so.
    fn started(&self) {
        let mut running = self.lock();
        running.scans += 1;
        if running.scans == 1 {
            running.error = None;
            self.status(&ScanStatus {
                running: true,
                error: None,
            });
        }
    }

    /// A scan has finished with `outcome`: its result is pushed, and the
    /// last of a stretch says the scans have stopped.
    fn landed(
        &self,
        outcome: crate::Result<DiscoveryResult>,
        read_git: bool,
    ) -> Result<DiscoveryResult, String> {
        let outcome = outcome.map_err(|err| err.to_string());
        if let Ok(result) = &outcome {
            self.publish(result, read_git);
        }
        let mut running = self.lock();
        running.scans = running.scans.saturating_sub(1);
        if let Err(error) = &outcome {
            running.error = Some(error.clone());
        }
        if running.scans == 0 {
            let error = running.error.take();
            self.status(&ScanStatus {
                running: false,
                error,
            });
        }
        outcome
    }

    fn publish(&self, result: &DiscoveryResult, read_git: bool) {
        let pushed = self
            .events
            .set_state_as::<DiscoveryUpdated>(result, &Some(result.clone()));
        if let Err(err) = pushed {
            eprintln!("floti host: {err}");
        }
        if read_git {
            let states: GitStates = result
                .projects
                .iter()
                .map(|project| (project.path.clone(), project.git.clone()))
                .collect();
            self.git(&states);
        }
    }

    fn git(&self, states: &GitStates) {
        if let Err(err) = self.events.set_state::<GitUpdated, _>(states) {
            eprintln!("floti host: {err}");
        }
    }

    fn scan(&self, include_git: bool) -> Result<DiscoveryResult, String> {
        self.started();
        let outcome = self.service.scan(include_git);
        self.landed(outcome, include_git)
    }

    fn refresh_git(&self) -> Result<GitStates, String> {
        let states = self.service.refresh_git().map_err(|err| err.to_string())?;
        self.git(&states);
        Ok(states)
    }
}

impl Feature for Discovery {
    fn requests<'a>(&'a self, _client: ClientId, router: &mut Router<'a>) {
        let scanner = &self.scanner;
        router
            .handle::<ReadCachedDiscovery>(|()| {
                scanner.service.cached().map_err(|err| err.to_string())
            })
            .handle::<ScanForProjects>(|request| {
                off_the_workers(|| scanner.scan(request.include_git.unwrap_or(true)))
            })
            .handle::<RefreshGit>(|()| off_the_workers(|| scanner.refresh_git()))
            .handle::<SuggestRoots>(|()| Ok(scanner.service.suggest()))
            .handle::<AcceptRoot>(|root| scanner.service.accept(&root.path))
            .handle::<RemoveRoot>(|root| scanner.service.remove(&root.path));
    }
}
