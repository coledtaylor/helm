//! Pointing this process's standard error at a file.
//!
//! `floti host` points its standard error at its log file
//! ([`crate::host_log`]), so that everything written there lands in the file:
//! its own lines, and what the standard library writes just before it ends
//! the process, a panic's message and a failed allocation's line included,
//! which no handler of the host's own gets to see first. Only the executable
//! does this; a host started inside a test process leaves that process's
//! standard error alone.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(unix)]
mod unix;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::Native;
#[cfg(target_os = "macos")]
pub use macos::Native;
#[cfg(target_os = "windows")]
pub use windows::Native;

use std::fs::File;
use std::io;

/// The OS's way to point standard error at a file.
pub trait StandardError {
    /// Points this process's standard error at `file`, open for writing,
    /// from the next write on.
    ///
    /// The caller keeps `file` open for as long as standard error may still
    /// be pointed at it: on Windows the process's standard error is the
    /// file's own handle, not a copy of it.
    fn point_at(&self, file: &File) -> io::Result<()>;
}
