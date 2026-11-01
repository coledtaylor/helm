//! Usage: the latest reading of each backend that declares usage, shipped
//! raw. What may be painted from a reading is the client's to decide,
//! because a reading goes stale and a window rolls over without anything
//! changing here.
//!
//! A reading the host could not take carries its problem and no limits,
//! which paints Unknown; it is never a zero. A backend that does not declare
//! usage has no reading at all.
//!
//! The estimated spend's "today" runs from local midnight, which a
//! [`LocalDay`] says: the host's own zone ([`SystemDay`]) in the host. Where
//! it cannot, the spend is left out of the reading: an estimate over the
//! wrong day is a wrong number, and a missing estimate paints nothing.
//!
//! The spend is summed from the agent's transcripts on disk, and from the
//! usage `floti.db` keeps ([`read_kept`]): rows Helm indexed from Claude
//! Code's transcripts before the host ran its sessions and carried into the
//! host, some for conversations whose transcripts are gone. A message on
//! disk is counted from disk; a kept row counts only when no transcript had
//! that message. Those rows are Claude Code's, so only Claude Code is given
//! them, and a kept usage that cannot be read leaves its spend out rather
//! than reading smaller.

mod day;

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use floti_protocol::channels::sessions::UsageSnapshot;
use floti_protocol::{BackendId, Knowable};
use rusqlite::{Connection, params};

pub use self::day::{LocalDay, SystemDay, ZonedDay};
use crate::agent::{AgentBackend, BackendAnswers};
use crate::history::sql;

/// How far back kept usage is read: the longest window spend is summed over
/// is a week; a day more covers a local midnight before it.
const KEPT_SINCE_MS: u64 = 8 * 24 * 3_600_000;

/// One assistant message's tokens, as `floti.db` keeps them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeptUsage {
    pub uuid: String,
    /// Epoch ms.
    pub at: u64,
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,
    pub cache_read: u64,
}

/// The usage `conn` keeps for messages at or after `since_ms`.
pub fn read_kept(conn: &Connection, since_ms: u64) -> crate::Result<Vec<KeptUsage>> {
    let to_u64 = |value: i64| u64::try_from(value).unwrap_or(0);
    let mut select = conn
        .prepare(
            "SELECT uuid, at, model, input_tokens, output_tokens,
                    cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens
             FROM usage_messages WHERE at >= ?",
        )
        .map_err(sql("read the kept usage"))?;
    select
        .query_map(
            params![i64::try_from(since_ms).unwrap_or(i64::MAX)],
            |row| {
                Ok(KeptUsage {
                    uuid: row.get(0)?,
                    at: to_u64(row.get(1)?),
                    model: row.get(2)?,
                    input: to_u64(row.get(3)?),
                    output: to_u64(row.get(4)?),
                    cache_write_5m: to_u64(row.get(5)?),
                    cache_write_1h: to_u64(row.get(6)?),
                    cache_read: to_u64(row.get(7)?),
                })
            },
        )
        .and_then(Iterator::collect)
        .map_err(sql("read the kept usage"))
}

/// Where kept usage is read from: given the earliest time wanted, the rows
/// since then.
pub type KeptSource = Box<dyn Fn(u64) -> crate::Result<Vec<KeptUsage>> + Send + Sync>;

/// The readings of every backend that declares usage, and the latest set.
pub struct UsageReader {
    backends: Vec<Arc<dyn AgentBackend>>,
    day: Box<dyn LocalDay>,
    kept: Option<KeptSource>,
    latest: Mutex<Vec<UsageSnapshot>>,
}

impl UsageReader {
    /// Reads `backends` that declare usage, telling the day by `day`.
    pub fn new(backends: &[Arc<dyn AgentBackend>], day: Box<dyn LocalDay>) -> Self {
        Self {
            backends: backends
                .iter()
                .filter(|backend| backend.usage().is_some())
                .cloned()
                .collect(),
            day,
            kept: None,
            latest: Mutex::new(Vec::new()),
        }
    }

    /// Also counts the usage `kept` reads in Claude Code's spend.
    #[must_use]
    pub fn keeping(mut self, kept: KeptSource) -> Self {
        self.kept = Some(kept);
        self
    }

    /// The latest set of readings, as last taken.
    pub fn latest(&self) -> Vec<UsageSnapshot> {
        self.latest
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Takes a reading of each backend now and keeps it as the latest. Says
    /// whether it reads differently from the set before.
    pub fn read(&self) -> (Vec<UsageSnapshot>, bool) {
        let now = now_ms();
        let today = self.day.today_start_ms(now);
        let kept = match &self.kept {
            Some(read) => read(now.saturating_sub(KEPT_SINCE_MS)).ok(),
            None => Some(Vec::new()),
        };
        let claude_code = BackendId::claude_code();
        let readings: Vec<UsageSnapshot> = self
            .backends
            .iter()
            .filter_map(|backend| {
                let keeps = backend.id() == &claude_code;
                let rows = if keeps {
                    kept.as_deref()
                } else {
                    Some(&[][..])
                };
                match backend.read_usage_keeping(
                    now,
                    today.unwrap_or(now),
                    rows.unwrap_or_default(),
                ) {
                    Knowable::Known(mut reading) => {
                        if today.is_none() || rows.is_none() {
                            reading.spend = None;
                        }
                        Some(reading)
                    }
                    // Not reachable for a backend that declares usage.
                    Knowable::Unknown => None,
                }
            })
            .collect();
        let mut latest = self.latest.lock().unwrap_or_else(PoisonError::into_inner);
        let changed = !same_readings(&latest, &readings);
        latest.clone_from(&readings);
        (readings, changed)
    }
}

/// Whether two sets of readings say the same, leaving out how long the
/// estimate took to sum, which differs on every reading.
pub fn same_readings(a: &[UsageSnapshot], b: &[UsageSnapshot]) -> bool {
    let timeless = |readings: &[UsageSnapshot]| -> Vec<UsageSnapshot> {
        readings
            .iter()
            .cloned()
            .map(|mut reading| {
                if let Some(spend) = &mut reading.spend {
                    spend.index_ms = 0.0;
                }
                reading
            })
            .collect()
    };
    timeless(a) == timeless(b)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}
