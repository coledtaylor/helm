//! Ending a session's whole process tree: the program and everything it
//! started. `taskkill /T` on Windows; the process group on macOS and Linux,
//! where the pty makes each session's program a group leader.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(unix)]
mod unix;
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

use floti_protocol::Knowable;

use crate::Result;

/// How to end a tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ending {
    /// Ask it to end, so it can clean up (SIGTERM to the group, or
    /// `taskkill /T` without `/F`).
    Polite,
    /// End it now (SIGKILL, or `taskkill /F`).
    Forced,
}

/// The OS's way to end a tree of processes.
pub trait ProcessTree {
    /// Ends the tree rooted at `root_pid`. A tree that has already ended is
    /// not an error.
    fn end_tree(&self, root_pid: u32, how: Ending) -> Result<()>;

    /// Whether `pid` is running. Unknown when the OS would not say, never a
    /// guess.
    fn is_alive(&self, pid: u32) -> Knowable<bool>;
}
