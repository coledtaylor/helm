//! Where the local day starts, for the estimated spend's "today".
//!
//! "Today" is the calendar day the user is in, so it starts at local
//! midnight rather than 24 hours before now: a day a daylight-saving change
//! falls on runs 23 or 25 hours. The start is the first instant of the civil
//! day in the zone, which is also right in a zone whose clocks skip midnight.

use jiff::Timestamp;
use jiff::tz::TimeZone;

/// Where local midnight falls, for the estimate's "today".
pub trait LocalDay: Send + Sync {
    /// Epoch ms of the local midnight that starts the day `now_ms` is in,
    /// or `None` when it cannot be told.
    fn today_start_ms(&self, now_ms: u64) -> Option<u64>;
}

/// The day as it runs in one given time zone.
#[derive(Debug, Clone)]
pub struct ZonedDay {
    zone: TimeZone,
}

impl ZonedDay {
    pub fn new(zone: TimeZone) -> Self {
        Self { zone }
    }
}

impl LocalDay for ZonedDay {
    fn today_start_ms(&self, now_ms: u64) -> Option<u64> {
        start_of_day(&self.zone, now_ms)
    }
}

/// The day as it runs in the host's own time zone.
///
/// The zone is asked of the system at each reading rather than once at
/// start, so a host whose user changes zone follows it; the system's answer
/// is cached for a few minutes, which keeps a reading every few seconds
/// cheap. A host that cannot tell its zone has no "today".
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemDay;

impl LocalDay for SystemDay {
    fn today_start_ms(&self, now_ms: u64) -> Option<u64> {
        start_of_day(&TimeZone::try_system().ok()?, now_ms)
    }
}

/// Epoch ms of the first instant of the civil day `now_ms` falls on in
/// `zone`, or `None` for a zone nobody can tell or an instant out of range.
fn start_of_day(zone: &TimeZone, now_ms: u64) -> Option<u64> {
    if zone.is_unknown() {
        return None;
    }
    let now = Timestamp::from_millisecond(i64::try_from(now_ms).ok()?).ok()?;
    let start = now.to_zoned(zone.clone()).start_of_day().ok()?;
    u64::try_from(start.timestamp().as_millisecond()).ok()
}
