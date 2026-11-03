//! History, the transcript archive and usage: `history:*` (resuming is the
//! sessions feature's), `archive:*` and `usage:*`.
//!
//! History and the archive are indexed from the first backend that declares
//! history, by a pass ([`crate::history::index_history`]) that runs on a
//! timer, starting with the host, when a session the host runs ends, so its
//! conversation is listed without anybody asking, and when a client asks for
//! a refresh. A pass waits for the one before it to finish, so passes never
//! overlap.
//! Every pass that changed what the index or the archive holds sends the
//! whole state on `history:changed` or `archive:changed`; a rename sends
//! `history:changed` too, so every client lists the new name.
//!
//! Usage is read from every backend that declares it, on its own timer for
//! the agent's own figures, and at once when the usage the store keeps
//! changed ([`HistoryHandle::usage_changed`]); only that, or a read of it
//! that failed, reads the kept rows from the store again. `usage:changed`
//! carries the whole set whenever a reading changed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::Duration;

use floti_protocol::BackendId;
use floti_protocol::channel::Router;
use floti_protocol::channels::sessions::{
    ArchiveChanged, ArchiveConversation, HistoryChanged, HistoryProjects, HistoryPrompts,
    HistoryRefresh, HistoryRename, HistorySessions, ReadArchiveStats, ReadHistorySummary,
    ReadUsage, UsageChanged,
};
use tokio::sync::broadcast::{self, error::RecvError};
use tokio::time::MissedTickBehavior;

use super::{Caller, Feature, FeatureContext};
use crate::agent::AgentBackend;
use crate::history::index::HistoryIndex;
use crate::history::{Indexed, archive, index_history, read_indexed};
use crate::server::events::Events;
use crate::server::hosted::Hosted;
use crate::server::records::ExitNotice;
use crate::store::Store;
use crate::usage::{SystemDay, UsageReader, read_kept};

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
    usage: Arc<UsageFeed>,
}

/// The usage readings and the channel they are sent on, read again every
/// period for the agent's own figures.
struct UsageFeed {
    reader: UsageReader,
    events: Arc<Events>,
    stopping: AtomicBool,
}

impl UsageFeed {
    /// Takes the first reading, serves it on `usage:changed`, and reads again
    /// every `period` until the feed is let go or told to stop.
    fn start(
        reader: UsageReader,
        events: Arc<Events>,
        period: Duration,
    ) -> crate::Result<Arc<Self>> {
        let (readings, _) = reader.read();
        events.serve_state::<UsageChanged, _>(&readings)?;
        let feed = Arc::new(Self {
            reader,
            events,
            stopping: AtomicBool::new(false),
        });
        every(&feed, period, Self::read);
        Ok(feed)
    }

    /// Takes a reading, and sends it when it reads differently.
    fn read(&self) -> crate::Result<()> {
        let (readings, changed) = self.reader.read();
        if changed {
            self.events.set_state::<UsageChanged, _>(&readings)?;
        }
        Ok(())
    }

    /// The usage the store keeps changed: reads it again, now.
    fn kept_changed(&self) -> crate::Result<()> {
        self.reader.kept_changed();
        self.read()
    }
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
        let kept_from = Arc::clone(&hosted);
        let reader = UsageReader::new(hosted.backends(), Box::new(SystemDay)).keeping(Box::new(
            move |since| read_kept(kept_from.ledger().store().connection(), since),
        ));

        context
            .events
            .serve_state::<HistoryChanged, _>(&indexed.summary)?;
        context
            .events
            .serve_state::<ArchiveChanged, _>(&indexed.stats)?;
        let usage = UsageFeed::start(reader, Arc::clone(&context.events), USAGE_EVERY)?;

        let exits = hosted.ledger().exits();
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
        tokio::spawn(pass_on_exits(exits, Arc::downgrade(&shared)));
        Ok(Self { shared })
    }

    /// Tells the feature something else wrote what it serves.
    pub fn handle(&self) -> HistoryHandle {
        HistoryHandle(Arc::downgrade(&self.shared))
    }
}

/// For a feature that writes what History, the archive or usage read: tells
/// every subscriber the new state. Holds the feature weakly.
#[derive(Clone)]
pub(crate) struct HistoryHandle(Weak<Shared>);

impl HistoryHandle {
    /// The archive, or History's names, changed in the store: sends the
    /// archive's state when it moved, and History's state when it moved or
    /// `names` says a name changed.
    pub fn stored_changed(&self, names: bool) -> crate::Result<()> {
        match self.0.upgrade() {
            Some(shared) => shared.republish(names),
            None => Ok(()),
        }
    }

    /// The usage the store keeps changed: reads it again and takes a reading
    /// now.
    pub fn usage_changed(&self) -> crate::Result<()> {
        match self.0.upgrade() {
            Some(shared) => shared.usage.kept_changed(),
            None => Ok(()),
        }
    }
}

impl Drop for History {
    fn drop(&mut self) {
        self.shared.stopping.store(true, Ordering::SeqCst);
        self.shared.usage.stopping.store(true, Ordering::SeqCst);
    }
}

impl Feature for History {
    fn requests<'a>(&'a self, _caller: Caller, router: &mut Router<'a>) {
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
            .handle::<ReadUsage>(|()| Ok(shared.usage.reader.latest()));
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

    /// Sends what the store holds now, as a pass would, without reading the
    /// agent's files.
    fn republish(&self, names: bool) -> crate::Result<()> {
        let indexed = read_indexed(self.store().connection(), &self.backend)?;
        let mut last = self.last();
        if names || indexed.summary != last.summary {
            self.events
                .set_state::<HistoryChanged, _>(&indexed.summary)?;
        }
        if indexed.stats != last.stats {
            self.events.set_state::<ArchiveChanged, _>(&indexed.stats)?;
        }
        last.clone_from(&indexed);
        Ok(())
    }
}

/// What a timer works on: told to stop when the host lets the feature go.
trait Timed: Send + Sync + 'static {
    fn stopping(&self) -> bool;
}

impl Timed for Shared {
    fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }
}

impl Timed for UsageFeed {
    fn stopping(&self) -> bool {
        self.stopping.load(Ordering::SeqCst)
    }
}

/// A pass each time a session the host runs ends: what it said is in the
/// agent's record by then, and every client lists it at once rather than at
/// the next tick. Exits that arrive while a pass runs are taken together by
/// the next one, which reads everything recorded since. Holds the feature
/// weakly; the exits close with the host and this ends.
async fn pass_on_exits(mut exits: broadcast::Receiver<ExitNotice>, shared: Weak<Shared>) {
    loop {
        match exits.recv().await {
            Ok(_) | Err(RecvError::Lagged(_)) => {
                let Some(shared) = shared
                    .upgrade()
                    .filter(|shared| !shared.stopping.load(Ordering::SeqCst))
                else {
                    return;
                };
                match tokio::task::spawn_blocking(move || shared.pass().map(drop)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(err)) => eprintln!("floti host: {err}"),
                    Err(_) => return,
                }
            }
            Err(RecvError::Closed) => return,
        }
    }
}

/// Runs `work` every `period`, starting now, off the runtime's threads. It
/// holds `shared` only while it works, so it ends when the host lets go.
fn every<T: Timed>(shared: &Arc<T>, period: Duration, work: fn(&T) -> crate::Result<()>) {
    let shared = Arc::downgrade(shared);
    tokio::spawn(async move {
        let mut ticks = tokio::time::interval(period);
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticks.tick().await;
            let Some(shared) = shared.upgrade().filter(|shared| !shared.stopping()) else {
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

#[cfg(test)]
mod tests {
    //! The usage feed on paused time, so a period passes when a test steps
    //! it and never because the machine was slow.

    use std::sync::atomic::AtomicUsize;
    use std::time::{SystemTime, UNIX_EPOCH};

    use floti_protocol::EventChannel;
    use floti_protocol::channels::sessions::UsageSnapshot;
    use serde_json::json;

    use super::*;
    use crate::agent::claude_code::{ClaudeCodeBackend, ClaudeCodeSettings};
    use crate::platform::process_tree::Native;
    use crate::server::events::Publication;
    use crate::testkit::{PATIENCE, TestDirs};
    use crate::usage::KeptUsage;

    const DAY_MS: u64 = 86_400_000;

    /// A home with Claude Code's config folder in it, and a store of kept
    /// usage that counts how often it is read.
    struct World {
        dirs: TestDirs,
        kept: Arc<Mutex<Vec<KeptUsage>>>,
        reads: Arc<AtomicUsize>,
    }

    impl World {
        fn new() -> Self {
            let dirs = TestDirs::new();
            std::fs::create_dir_all(dirs.home.join(".claude").join("projects")).unwrap();
            Self {
                dirs,
                kept: Arc::new(Mutex::new(Vec::new())),
                reads: Arc::new(AtomicUsize::new(0)),
            }
        }

        fn reader(&self) -> UsageReader {
            let backend: Arc<dyn AgentBackend> = Arc::new(ClaudeCodeBackend::new(
                ClaudeCodeSettings {
                    search_first: Vec::new(),
                    program: "claude".into(),
                    leading_args: Vec::new(),
                    config_dir: self.dirs.home.join(".claude"),
                    pass_config_dir: true,
                    api_key_set: false,
                },
                Arc::new(Native),
            ));
            let (kept, reads) = (Arc::clone(&self.kept), Arc::clone(&self.reads));
            UsageReader::new(&[backend], Box::new(SystemDay)).keeping(Box::new(move |since| {
                reads.fetch_add(1, Ordering::SeqCst);
                Ok(kept
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|row| row.at >= since)
                    .cloned()
                    .collect())
            }))
        }

        fn reads(&self) -> usize {
            self.reads.load(Ordering::SeqCst)
        }

        /// The agent caches new figures, as Claude Code writes them.
        fn agent_figures(&self, fetched_at_ms: u64, percent: u64) {
            let root = json!({
                "numStartups": 1,
                "projects": {},
                "cachedUsageUtilization": {
                    "fetchedAtMs": fetched_at_ms,
                    "utilization": {
                        "limits": [
                            { "kind": "session", "group": "session", "percent": percent,
                              "resets_at": null },
                        ],
                    },
                },
            });
            std::fs::write(self.dirs.home.join(".claude.json"), root.to_string()).unwrap();
        }

        /// Helm's copy adds a row to the store.
        fn keep(&self, uuid: &str, at: u64) {
            self.kept.lock().unwrap().push(KeptUsage {
                uuid: uuid.to_owned(),
                at,
                model: "claude-opus-5".to_owned(),
                input: 1000,
                output: 100,
                cache_write_5m: 0,
                cache_write_1h: 0,
                cache_read: 0,
            });
        }
    }

    fn now_ms() -> u64 {
        u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis(),
        )
        .unwrap()
    }

    /// The next `usage:changed` publication. On paused time, waiting lets the
    /// clock run on to the feed's next period.
    async fn next_reading(heard: &mut broadcast::Receiver<Publication>) -> Vec<UsageSnapshot> {
        let deadline = tokio::time::Instant::now() + PATIENCE;
        loop {
            match tokio::time::timeout_at(deadline, heard.recv()).await {
                Ok(Ok(publication)) if publication.channel == UsageChanged::NAME => {
                    return floti_protocol::channel::from_payload(&publication.payload).unwrap();
                }
                Ok(Ok(_)) => {}
                Ok(Err(err)) => panic!("the events closed: {err}"),
                Err(_) => panic!("no usage reading within {PATIENCE:?}"),
            }
        }
    }

    fn week_messages(readings: &[UsageSnapshot]) -> u32 {
        readings[0]
            .spend
            .as_ref()
            .expect("the kept usage was read")
            .week
            .messages
    }

    #[tokio::test(start_paused = true)]
    async fn kept_usage_is_read_from_the_store_once_while_readings_follow_the_agents_own_figures() {
        let world = World::new();
        let now = now_ms();
        world.keep("kept-1", now - DAY_MS);
        world.agent_figures(now, 10);
        let events = Arc::new(Events::new());
        let mut heard = events.observe();
        let feed = UsageFeed::start(world.reader(), Arc::clone(&events), USAGE_EVERY).unwrap();
        assert_eq!(world.reads(), 1);

        // Period after period, the agent's figures move and every reading
        // follows them, without reading the store again.
        for step in 1..=20 {
            world.agent_figures(now + step, 10 + step);
            let reading = next_reading(&mut heard).await;
            assert_eq!(reading[0].fetched_at_ms, Some(now + step));
            assert_eq!(reading[0].limits[0].percent, (10 + step) as f64);
            assert_eq!(week_messages(&reading), 1);
        }
        assert_eq!(world.reads(), 1);
        feed.stopping.store(true, Ordering::SeqCst);
    }

    #[tokio::test(start_paused = true)]
    async fn kept_usage_the_store_gains_is_read_once_more_and_reaches_subscribers() {
        let world = World::new();
        let now = now_ms();
        world.keep("kept-1", now - DAY_MS);
        world.agent_figures(now, 10);
        let events = Arc::new(Events::new());
        let mut heard = events.observe();
        let feed = UsageFeed::start(world.reader(), Arc::clone(&events), USAGE_EVERY).unwrap();
        assert_eq!(week_messages(&feed.reader.latest()), 1);

        world.keep("copied-1", now - 2 * DAY_MS);
        world.keep("copied-2", now - 3 * DAY_MS);
        feed.kept_changed().unwrap();
        assert_eq!(world.reads(), 2);
        assert_eq!(week_messages(&next_reading(&mut heard).await), 3);

        // The timer goes on reading the agent's figures from the rows it has.
        world.agent_figures(now + 1, 11);
        let reading = next_reading(&mut heard).await;
        assert_eq!(reading[0].fetched_at_ms, Some(now + 1));
        assert_eq!(week_messages(&reading), 3);
        assert_eq!(world.reads(), 2);
        feed.stopping.store(true, Ordering::SeqCst);
    }
}
