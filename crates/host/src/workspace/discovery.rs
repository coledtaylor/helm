//! Project discovery: scan roots, harnesses and each project's git state, as
//! `packages/core/src/discovery` and the desktop's `services.ts` do it.
//!
//! - [`scan`]: walking the roots into harnesses and projects, and which
//!   cached rows a scan or a removed root proves wrong.
//! - [`inventory`]: what a project's `.claude/` holds.
//! - [`git`]: a working tree's branch and change counts, by running `git`.
//! - [`suggest`]: first-run guesses for a scan root.
//!
//! [`DiscoveryService`] is what the host keeps between requests: the last
//! scan, the discovery cache in the store (which [`KnownRoots`] reads, so a
//! scan's folders are known the moment it lands), and the scan roots in the
//! host's settings. Pins are settings too, and nothing here writes them: a
//! scan never takes a pin away, one whose folder is gone included.
//!
//! [`KnownRoots`]: crate::workspace::roots::KnownRoots

pub mod git;
pub mod inventory;
pub mod scan;
pub mod suggest;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use floti_protocol::channels::workspace::{
    CachedProject, DiscoveryResult, GitState, HostSettingsPatch,
};

use crate::config_console::time::now_iso;
use crate::store::Store;
use crate::store::projects::{cache_projects, forget_projects, read_cached_projects};
use crate::workspace::settings::SettingsService;
use crate::{Error, Result};

/// Git state by project path; `None` where the folder is not a repository.
pub type GitStates = BTreeMap<String, Option<GitState>>;

/// A scan that has started: the roots it walks and its place in the order
/// scans started in.
#[derive(Debug, Clone)]
pub struct ScanTicket {
    number: u64,
    pub roots: Vec<String>,
}

#[derive(Default)]
struct Scans {
    /// How many scans have started.
    started: u64,
    /// The ticket of the scan whose result is current.
    applied: u64,
    last: Option<DiscoveryResult>,
}

/// Discovery as the host keeps it.
pub struct DiscoveryService {
    store: Arc<Mutex<Store>>,
    settings: Arc<SettingsService>,
    /// Where suggestions look for `~/.harness`.
    home: Option<PathBuf>,
    scans: Mutex<Scans>,
    /// Held while git is read again, so refreshes never overlap.
    refreshing: Mutex<()>,
    /// How many refreshes have finished: one asked while another ran sees
    /// it move and answers that one's result.
    refreshed: AtomicU64,
    last_git: Mutex<GitStates>,
}

impl DiscoveryService {
    pub fn new(
        store: Arc<Mutex<Store>>,
        settings: Arc<SettingsService>,
        home: Option<PathBuf>,
    ) -> Self {
        Self {
            store,
            settings,
            home,
            scans: Mutex::new(Scans::default()),
            refreshing: Mutex::new(()),
            refreshed: AtomicU64::new(0),
            last_git: Mutex::new(GitStates::new()),
        }
    }

    /// The rows the last scans left, for painting before a fresh one lands.
    pub fn cached(&self) -> Result<Vec<CachedProject>> {
        read_cached_projects(lock(&self.store).connection())
    }

    /// The last scan's result, if one has landed.
    pub fn last(&self) -> Option<DiscoveryResult> {
        lock(&self.scans).last.clone()
    }

    /// Scans the roots, reading git state when `include_git`, and keeps the
    /// result.
    pub fn scan(&self, include_git: bool) -> Result<DiscoveryResult> {
        let ticket = self.begin_scan()?;
        let result = scan::scan(&ticket.roots, include_git);
        self.finish_scan(&ticket, result)
    }

    /// Decides what a scan walks and gives it its place in the order: the
    /// roots, adopting what discovery can justify when setup is finished and
    /// there are none (see [`Self::ensure_scan_roots`]).
    pub fn begin_scan(&self) -> Result<ScanTicket> {
        let roots = self.ensure_scan_roots()?;
        let mut scans = lock(&self.scans);
        scans.started += 1;
        Ok(ScanTicket {
            number: scans.started,
            roots,
        })
    }

    /// Keeps `result`, from the scan `ticket` began, unless a scan that
    /// started later has already landed: that one describes the roots as
    /// they are now, so it is the answer, and nothing is written.
    ///
    /// Kept means cached, and the cached rows this walk proves wrong
    /// forgotten ([`scan::disproved_project_paths`]).
    pub fn finish_scan(
        &self,
        ticket: &ScanTicket,
        result: DiscoveryResult,
    ) -> Result<DiscoveryResult> {
        let mut scans = lock(&self.scans);
        if ticket.number < scans.applied
            && let Some(last) = &scans.last
        {
            return Ok(last.clone());
        }
        scans.applied = ticket.number;
        {
            let mut store = lock(&self.store);
            let conn = store.connection_mut();
            cache_projects(conn, &result.projects, &result.harnesses, &now_iso())?;
            let cached: Vec<String> = read_cached_projects(conn)?
                .into_iter()
                .map(|row| row.path)
                .collect();
            forget_projects(conn, &scan::disproved_project_paths(&cached, &result))?;
        }
        scans.last = Some(result.clone());
        Ok(result)
    }

    /// Reads git again for the projects the last scan found, or the cached
    /// ones before any scan, and records it on the last scan and its cached
    /// rows. A refresh asked while one runs waits for it and answers what it
    /// read rather than reading again.
    pub fn refresh_git(&self) -> Result<GitStates> {
        let seen = self.refreshed.load(Ordering::SeqCst);
        let _one_at_a_time = lock(&self.refreshing);
        if self.refreshed.load(Ordering::SeqCst) != seen {
            return Ok(lock(&self.last_git).clone());
        }
        let paths: Vec<String> = match self.last() {
            Some(last) => last.projects.into_iter().map(|p| p.path).collect(),
            None => self.cached()?.into_iter().map(|row| row.path).collect(),
        };
        let states = git::read_git_states(&paths);
        {
            let mut scans = lock(&self.scans);
            if let Some(last) = &mut scans.last {
                // A project a scan found after the paths were read keeps the
                // git state that scan read.
                for project in &mut last.projects {
                    if let Some(state) = states.get(&project.path) {
                        project.git = state.clone();
                    }
                }
                // The harnesses go in with them: the write is an upsert over
                // the same rows, and the projects alone would put null over
                // every recorded `template:`.
                cache_projects(
                    lock(&self.store).connection_mut(),
                    &last.projects,
                    &last.harnesses,
                    &now_iso(),
                )?;
            }
        }
        *lock(&self.last_git) = states.clone();
        self.refreshed.fetch_add(1, Ordering::SeqCst);
        Ok(states)
    }

    /// Best guesses for a first-run scan root.
    pub fn suggest(&self) -> Vec<String> {
        let start = std::env::current_dir().unwrap_or_default();
        suggest::suggest_roots(&start, self.home.as_deref())
    }

    /// Adds `path` to the scan roots unless it is one already, compared
    /// ignoring case, and answers the roots after.
    pub fn accept(&self, path: &str) -> std::result::Result<Vec<String>, String> {
        add_roots(&self.settings, &[path.to_owned()])
    }

    /// Takes `path` out of the scan roots, compared ignoring case, and
    /// forgets the cached rows only it covered; rows a remaining root still
    /// covers stay, and nothing on disk is touched. Answers the roots after.
    pub fn remove(&self, path: &str) -> std::result::Result<Vec<String>, String> {
        let after = self
            .settings
            .update(|settings| {
                Some(HostSettingsPatch {
                    scan_roots: Some(
                        settings
                            .scan_roots
                            .iter()
                            .filter(|root| !same_text(root, path))
                            .cloned()
                            .collect(),
                    ),
                    ..HostSettingsPatch::default()
                })
            })
            .map_err(|err| err.to_string())?;
        self.forget_orphans(path, &after.scan_roots)
            .map_err(|err| err.to_string())?;
        Ok(after.scan_roots)
    }

    /// Forgets the cached rows under `removed` that none of `remaining`
    /// covers.
    fn forget_orphans(&self, removed: &str, remaining: &[String]) -> Result<()> {
        let mut store = lock(&self.store);
        let conn = store.connection_mut();
        let cached: Vec<String> = read_cached_projects(conn)?
            .into_iter()
            .map(|row| row.path)
            .collect();
        forget_projects(
            conn,
            &scan::orphaned_project_paths(&cached, removed, remaining),
        )?;
        Ok(())
    }

    /// The scan roots, adopting the suggestions when there are none and
    /// setup has been finished. Before setup nothing is adopted: the
    /// suggestions are offered there, where they can be declined.
    fn ensure_scan_roots(&self) -> Result<Vec<String>> {
        let settings = self
            .settings
            .update(|settings| {
                if !settings.scan_roots.is_empty() || settings.first_run_completed_at.is_none() {
                    return None;
                }
                let suggested = self.suggest();
                (!suggested.is_empty()).then(|| HostSettingsPatch {
                    scan_roots: Some(suggested),
                    ..HostSettingsPatch::default()
                })
            })
            .map_err(|err| Error::Refused(err.to_string()))?;
        Ok(settings.scan_roots)
    }
}

/// Adds each of `paths` that is not a scan root already, compared ignoring
/// case, in order, and answers the roots after. Nothing is written when
/// every one is a root already. A harness made from a template becomes a
/// root through this too.
pub fn add_roots(
    settings: &SettingsService,
    paths: &[String],
) -> std::result::Result<Vec<String>, String> {
    settings
        .update(|current| {
            let mut merged = current.scan_roots.clone();
            for path in paths {
                if !merged.iter().any(|root| same_text(root, path)) {
                    merged.push(path.clone());
                }
            }
            (merged.len() != current.scan_roots.len()).then(|| HostSettingsPatch {
                scan_roots: Some(merged),
                ..HostSettingsPatch::default()
            })
        })
        .map(|after| after.scan_roots)
        .map_err(|err| err.to_string())
}

/// Two spellings of one root: equal ignoring case, as today's app compares
/// them.
fn same_text(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests;
