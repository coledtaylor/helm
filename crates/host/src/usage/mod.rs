//! Usage: the latest reading of each backend that declares usage, shipped
//! raw. What may be painted from a reading is the client's to decide,
//! because a reading goes stale and a window rolls over without anything
//! changing here.
//!
//! A reading the host could not take carries its problem and no limits,
//! which paints Unknown; it is never a zero. A backend that does not declare
//! usage has no reading at all.
//!
//! The estimated spend's "today" runs from local midnight, which only a
//! [`LocalDay`] can say. Where it cannot, the spend is left out of the
//! reading: an estimate over the wrong day is a wrong number, and a missing
//! estimate paints nothing.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use floti_protocol::Knowable;
use floti_protocol::channels::sessions::UsageSnapshot;

use crate::agent::{AgentBackend, BackendAnswers};

/// Where local midnight falls, for the estimate's "today".
pub trait LocalDay: Send + Sync {
    /// Epoch ms of the local midnight that starts the day `now_ms` is in,
    /// or `None` when it cannot be told.
    fn today_start_ms(&self, now_ms: u64) -> Option<u64>;
}

/// A local day nobody can tell.
#[derive(Debug, Clone, Copy, Default)]
pub struct UnknownLocalDay;

impl LocalDay for UnknownLocalDay {
    fn today_start_ms(&self, _now_ms: u64) -> Option<u64> {
        None
    }
}

/// The readings of every backend that declares usage, and the latest set.
pub struct UsageReader {
    backends: Vec<Arc<dyn AgentBackend>>,
    day: Box<dyn LocalDay>,
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
            latest: Mutex::new(Vec::new()),
        }
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
        let readings: Vec<UsageSnapshot> = self
            .backends
            .iter()
            .filter_map(|backend| {
                match backend.read_usage(now, today.unwrap_or(now)) {
                    Knowable::Known(mut reading) => {
                        if today.is_none() {
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
