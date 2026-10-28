//! The machine's process table and its listening TCP sockets, read through
//! the OS's own calls: what the processes-and-ports pass shapes into each
//! hosted session's tree and ports.
//!
//! Every reader uses file reads and system calls only and starts no program:
//! a Toolhelp snapshot, `NtQueryInformationProcess` and `GetExtendedTcpTable`
//! on Windows; `libproc` and `sysctl` on macOS; `/proc` on Linux. Starting
//! PowerShell, `ps`, `lsof` or `ss` for this is what made a pass cost half a
//! second, and is what this concern exists to avoid.
//!
//! The two halves are separate queries that fail separately, so each is
//! Unknown or known on its own: a machine can answer for processes and refuse
//! for sockets, and the shape keeps "could not look" apart from "nothing
//! there". A process whose command line the OS will not give an unelevated
//! user is listed with none; no elevation is ever attempted.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(test)]
mod tests;

#[cfg(target_os = "linux")]
pub use linux::Native;
#[cfg(target_os = "macos")]
pub use macos::Native;
#[cfg(target_os = "windows")]
pub use windows::Native;

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use floti_protocol::Knowable;

use crate::Result;

/// One row of the process table.
///
/// Deliberately four fields. Anything richer (memory, CPU, start time) is a
/// number that would have to be kept true, and none of it answers what the
/// pass is for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessRow {
    pub pid: u32,
    pub parent_pid: u32,
    /// The image name, such as `node.exe`.
    pub name: String,
    /// The full command line, or `None` where the OS would not give it up.
    pub command_line: Option<String>,
}

/// One listening TCP socket, and the process holding it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortRow {
    pub pid: u32,
    pub port: u16,
    /// The local address it is bound to: `127.0.0.1`, `0.0.0.0` for every
    /// IPv4 address, `::1`, `::` for every IPv6 address.
    pub address: Option<String>,
}

/// What one pass saw of the machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessSnapshot {
    pub processes: Knowable<Vec<ProcessRow>>,
    pub ports: Knowable<Vec<PortRow>>,
    /// When the pass ran, epoch ms.
    pub at_ms: u64,
    /// How long the reading took. For the budget, not for display.
    pub duration: Duration,
}

impl ProcessSnapshot {
    /// The answer for a machine that could not be asked.
    pub fn unknown(at_ms: u64) -> Self {
        Self {
            processes: Knowable::Unknown,
            ports: Knowable::Unknown,
            at_ms,
            duration: Duration::ZERO,
        }
    }
}

/// The OS's way to read its process table and listening sockets.
pub trait ProcessTable: Send + Sync {
    /// Every process the OS lists. A process that ends while it is read is
    /// left out; a command line the OS refuses is `None`. An error only when
    /// the table itself cannot be read.
    fn processes(&self) -> Result<Vec<ProcessRow>>;

    /// Every listening TCP socket, IPv4 and IPv6, with the process holding
    /// it, as far as this user may see. An error only when the sockets
    /// cannot be listed at all.
    fn listening(&self) -> Result<Vec<PortRow>>;
}

/// One pass over `table`: both halves, each Unknown when its query failed,
/// [`Error::Unsupported`](crate::Error::Unsupported) included, with when it
/// ran and how long it took.
pub fn snapshot(table: &dyn ProcessTable) -> ProcessSnapshot {
    let at_ms = now_ms();
    let started = Instant::now();
    let processes = known(table.processes());
    let ports = known(table.listening());
    ProcessSnapshot {
        processes,
        ports,
        at_ms,
        duration: started.elapsed(),
    }
}

fn known<T>(read: Result<T>) -> Knowable<T> {
    match read {
        Ok(value) => Knowable::Known(value),
        Err(_) => Knowable::Unknown,
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}
