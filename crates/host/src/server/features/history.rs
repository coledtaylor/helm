//! History, the transcript archive and usage: `history:*` (resuming is the
//! sessions feature's), `archive:*` and `usage:*`.
//!
//! History and the archive are indexed from the first backend that declares
//! history, by a pass ([`crate::history::index_history`]) that runs on a
//! timer, starting with the host, and when a client asks for a refresh. A
//! pass waits for the one before it to finish, so passes never overlap.
//! Every pass that changed what the index or the archive holds sends the
//! whole state on `history:changed` or `archive:changed`; a rename sends
//! `history:changed` too, so every client lists the new name.
//!
//! Usage is read from every backend that declares it, on its own timer, and
//! `usage:changed` carries the whole set whenever a reading changed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use floti_protocol::BackendId;
use floti_protocol::channel::Router;
use floti_protocol::channels::sessions::{
    ArchiveChanged, ArchiveConversation, HistoryChanged, HistoryProjects, HistoryPrompts,
    HistoryRefresh, HistoryRename, HistorySessions, ReadArchiveStats, ReadHistorySummary,
    ReadUsage, UsageChanged,
};
use tokio::time::MissedTickBehavior;

use super::{Feature, FeatureContext};
use crate::agent::AgentBackend;
use crate::history::index::HistoryIndex;
use crate::history::{Indexed, archive, index_history, read_indexed};
use crate::server::events::Events;
use crate::server::hosted::Hosted;
use crate::session::ClientId;
use crate::store::Store;
use crate::usage::{UnknownLocalDay, UsageReader};

/// How often history and the archive are indexed without being asked.
const PASS_EVERY: Duration = Duration::from_secs(15);

/// How often usage is read: the agent rewrites its cached figures on its own
/// schedule, so a client sees a new reading within this of it landing.
const USAGE_EVERY: Duration = Duration::from_secs(4);

pub(crate) struct History {
    shared: Arc<Shared>,
}

/// What the requests and the timers share.
struct Shared {
    hosted: Arc<Hosted>,
    events: Arc<Events>,
    /// The backend whose history is indexed, when one declares history.
    source: Option<Arc<dyn AgentBackend>>,
    /// The backend history sessions are said to come from.
    backend: BackendId,
    /// Held for the length of a pass.
    passing: Mutex<()>,
    /// Set when the host lets the feature go: a pass in flight stops at the
    /// next transcript, so the host's stop does not wait on a long first pass.
    stopping: AtomicBool,
    /// What the last pass left, as last sent.
    indexed: Mutex<Indexed>,
    usage: UsageReader,
}

impl History {
    pub fn new(context: &FeatureContext) -> crate::Result<Self> {
        let hosted = Arc::clone(&context.hosted);
        let source = hosted
            .backends()
            .iter()
            .find(|backend| backend.history().is_some())
            .cloned();
        let backend = source
            .as_ref()
            .or_else(|| hosted.backends().first())
            .map_or_else(BackendId::claude_code, |backend| backend.id().clone());
        let indexed = read_indexed(hosted.ledger().store().connection(), &backend)?;
        let usage = UsageReader::new(hosted.backends(), Box::new(UnknownLocalDay));
        let (readings, _) = usage.read();

        context
            .events
            .serve_state::<HistoryChanged, _>(&indexed.summary)?;
        context
            .events
            .serve_state::<ArchiveChanged, _>(&indexed.stats)?;
        context.events.serve_state::<UsageChanged, _>(&readings)?;

        let shared = Arc::new(Shared {
            hosted,
            events: Arc::clone(&context.events),
            source,
            backend,
            passing: Mutex::new(()),
            stopping: AtomicBool::new(false),
            indexed: Mutex::new(indexed),
            usage,
        });
        every(&shared, PASS_EVERY, |shared| shared.pass().map(drop));
        every(&shared, USAGE_EVERY, Shared::read_usage);
        Ok(Self { shared })
    }
}

impl Drop for History {
    fn drop(&mut self) {
        self.shared.stopping.store(true, Ordering::SeqCst);
    }
}

impl Feature for History {
    fn requests<'a>(&'a self, _client: ClientId, router: &mut Router<'a>) {
        let shared = &*self.shared;
        router
            .handle::<ReadHistorySummary>(|()| Ok(shared.last().summary.clone()))
            .handle::<HistorySessions>(|query| shared.with_index(|index| index.sessions(&query)))
            .handle::<HistoryPrompts>(|request| {
                shared.with_index(|index| index.prompts(&request.session_id))
            })
            .handle::<HistoryProjects>(|()| shared.with_index(|index| index.projects()))
            .handle::<HistoryRefresh>(|()| {
                shared
                    .pass()
                    .map(|indexed| indexed.summary)
                    .map_err(|err| err.to_string())
            })
            .handle::<HistoryRename>(|request| {
                shared.rename(&request.session_id, request.name.as_deref())
            })
            .handle::<ArchiveConversation>(|request| {
                let store = shared.store();
                archive::read_conversation(store.connection(), &request.session_id)
                    .map_err(|err| err.to_string())
            })
            .handle::<ReadArchiveStats>(|()| {
                let store = shared.store();
                let conn = store.connection();
                archive::ceiling(conn)
                    .and_then(|ceiling| archive::read_stats(conn, ceiling))
                    .map_err(|err| err.to_string())
            })
            .handle::<ReadUsage>(|()| Ok(shared.usage.latest()));
    }
}

impl Shared {
    fn store(&self) -> MutexGuard<'_, Store> {
        self.hosted.ledger().store()
    }

    fn last(&self) -> MutexGuard<'_, Indexed> {
        self.indexed.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn with_index<T>(
        &self,
        read: impl FnOnce(&HistoryIndex<'_>) -> crate::Result<T>,
    ) -> Result<T, String> {
        let store = self.store();
        read(&HistoryIndex::new(store.connection(), &self.backend)).map_err(|err| err.to_string())
    }

    /// One pass over the history, after any pass already running.
    fn pass(&self) -> crate::Result<Indexed> {
        let _passing = self.passing.lock().unwrap_or_else(PoisonError::into_inner);
        let indexed = match &self.source {
            Some(backend) => match backend.history() {
                Some(history) => index_history(|| self.store(), history, &self.backend, &|| {
                    !self.stopping.load(Ordering::SeqCst)
                })?,
                None => read_indexed(self.store().connection(), &self.backend)?,
            },
            None => read_indexed(self.store().connection(), &self.backend)?,
        };
        let mut last = self.last();
        if indexed.summary != last.summary {
            self.events
                .set_state::<HistoryChanged, _>(&indexed.summary)?;
        }
        if indexed.stats != last.stats {
            self.events.set_state::<ArchiveChanged, _>(&indexed.stats)?;
        }
        last.clone_from(&indexed);
        Ok(indexed)
    }

    fn rename(
        &self,
        session_id: &str,
        name: Option<&str>,
    ) -> Result<Option<floti_protocol::channels::sessions::HistorySession>, String> {
        let renamed = self.with_index(|index| index.rename(session_id, name))?;
        if renamed.is_some() {
            let summary = self.last().summary.clone();
            self.events
                .set_state::<HistoryChanged, _>(&summary)
                .map_err(|err| err.to_string())?;
        }
        Ok(renamed)
    }

    fn read_usage(&self) -> crate::Result<()> {
        let (readings, changed) = self.usage.read();
        if changed {
            self.events.set_state::<UsageChanged, _>(&readings)?;
        }
        Ok(())
    }
}

/// Runs `work` every `period`, starting now, off the runtime's threads. It
/// holds `shared` only while it works, so it ends when the host lets go.
fn every(shared: &Arc<Shared>, period: Duration, work: fn(&Shared) -> crate::Result<()>) {
    let shared = Arc::downgrade(shared);
    tokio::spawn(async move {
        let mut ticks = tokio::time::interval(period);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticks.tick().await;
            let Some(shared) = shared
                .upgrade()
                .filter(|shared| !shared.stopping.load(Ordering::SeqCst))
            else {
                return;
            };
            match tokio::task::spawn_blocking(move || work(&shared)).await {
                Ok(Ok(())) => {}
                Ok(Err(err)) => eprintln!("floti host: {err}"),
                Err(_) => return,
            }
        }
    });
}
