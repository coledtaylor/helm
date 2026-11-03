//! The host's clock for what it times in memory: how long a request to pair
//! waits, and how long a device's confirmed presence lasts.
//!
//! It is tokio's clock, so a unit test on paused time steps it. A test build
//! also moves it ahead by the milliseconds in [`TEST_HOST_CLOCK_MARKER`] in
//! the data folder, read at every check, so the tests against the executable
//! step a ten-minute request or a five-minute presence rather than wait it
//! out. A production build never reads the marker.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::time::Instant;

/// The file in a data folder that moves a test build's host clock ahead by
/// the milliseconds it holds.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_HOST_CLOCK_MARKER: &str = "floti-test-host-clock";

/// The clock of the host whose data folder is `data`.
#[derive(Debug, Clone)]
pub(crate) struct HostClock {
    /// Where a test build finds its marker; a production build never reads it.
    #[cfg_attr(not(any(test, feature = "testkit")), allow(dead_code))]
    data: PathBuf,
}

impl HostClock {
    pub(crate) fn new(data: &Path) -> Self {
        Self {
            data: data.to_path_buf(),
        }
    }

    /// Now, moved ahead in a test build by its marker.
    pub(crate) fn now(&self) -> Instant {
        Instant::now() + self.ahead()
    }

    /// How far a test build's clock is ahead; always nothing in a production
    /// build.
    pub(crate) fn ahead(&self) -> Duration {
        #[cfg(any(test, feature = "testkit"))]
        if let Some(ms) = std::fs::read_to_string(self.data.join(TEST_HOST_CLOCK_MARKER))
            .ok()
            .and_then(|text| text.trim().parse().ok())
        {
            return Duration::from_millis(ms);
        }
        Duration::ZERO
    }
}
