//! The agent worktrees of a project: `worktrees:list` and `worktrees:remove`.
//!
//! Every request names a project, which the host checks is one it knows (a
//! scanned project, a harness root or a saved profile's folder) before git is
//! asked anything; a folder a hosted session merely runs in is not one. git
//! runs as a program, off the runtime's workers, so other clients are never
//! kept waiting on it.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use floti_protocol::channel::Router;
use floti_protocol::channels::workspace::{
    AgentWorktrees, ListAgentWorktrees, RemoveAgentWorktree, WorktreeRemoval,
};

use super::config::off_the_workers;
use super::{Caller, Feature, FeatureContext};
use crate::store::Store;
use crate::workspace::roots::{KnownRoots, RootKind, refusal};
use crate::workspace::worktrees;

pub(crate) struct Worktrees {
    roots: Arc<KnownRoots>,
    store: Arc<Mutex<Store>>,
}

impl Worktrees {
    pub fn new(context: &FeatureContext) -> crate::Result<Self> {
        Ok(Self {
            roots: Arc::clone(&context.workspace.roots),
            store: context.hosted.ledger().shared_store(),
        })
    }

    /// The project folder, or the sentence for one the host does not know.
    fn project(&self, project: &str) -> Result<std::path::PathBuf, String> {
        let known = self.roots.known(project)?;
        if known.kind == RootKind::Session {
            return Err(refusal(project));
        }
        Ok(known.path)
    }

    fn list(&self, project: &str) -> Result<AgentWorktrees, String> {
        let project = self.project(project)?;
        let store = self.store.lock().unwrap_or_else(PoisonError::into_inner);
        worktrees::list(&project, store.connection())
    }

    fn remove(&self, project: &str, folder: &str) -> Result<WorktreeRemoval, String> {
        let project = self.project(project)?;
        let store = self.store.lock().unwrap_or_else(PoisonError::into_inner);
        worktrees::remove(&project, Path::new(folder), store.connection())
    }
}

impl Feature for Worktrees {
    fn requests<'a>(&'a self, _caller: Caller, router: &mut Router<'a>) {
        router
            .handle::<ListAgentWorktrees>(|request| off_the_workers(|| self.list(&request.project)))
            .handle::<RemoveAgentWorktree>(|request| {
                off_the_workers(|| self.remove(&request.project, &request.folder))
            });
    }
}
