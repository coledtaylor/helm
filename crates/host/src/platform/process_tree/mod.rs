//! Ending a session's whole process tree: the program and everything it
//! started. `taskkill /T` on Windows; the process group on macOS and Linux,
//! where the pty makes each session's program a group leader.
//!
//! The same concern ties the host's own tree to its life
//! ([`ProcessTree::end_tree_with_this_process`]), so a host that is killed or
//! crashes takes its sessions with it, as a stop does: a job object on
//! Windows, the terminal hang-up on macOS and Linux.

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

#[cfg(all(target_os = "linux", any(test, feature = "testkit")))]
pub use linux::descendants;
#[cfg(all(target_os = "macos", any(test, feature = "testkit")))]
pub use macos::descendants;
#[cfg(all(target_os = "windows", any(test, feature = "testkit")))]
pub use windows::descendants;

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

    /// Ends the tree rooted at this process when this process ends, however
    /// it ends: from now on, every program it runs in a terminal and
    /// everything those start end with it, killed or crashed as much as
    /// stopped. Asking again changes nothing.
    ///
    /// Known(true) once that holds. Unknown when the OS would not arrange
    /// it, which is said once on stderr and is no reason to stop: the
    /// process keeps working, and what it started can outlive a crash.
    fn end_tree_with_this_process(&self) -> Knowable<bool>;
}

/// Every process under `root` in `table`, a list of (pid, parent pid): its
/// children, theirs and so on. `is_child(parent, pid)` says whether a row
/// naming `parent` really is that process's child, for an OS that hands a
/// dead parent's pid to a new process without telling its children.
#[cfg(any(test, feature = "testkit"))]
fn tree_under(table: &[(u32, u32)], root: u32, is_child: impl Fn(u32, u32) -> bool) -> Vec<u32> {
    let mut found: Vec<u32> = Vec::new();
    let mut parents = vec![root];
    while let Some(parent) = parents.pop() {
        for &(pid, of) in table {
            if of == parent && pid != root && !found.contains(&pid) && is_child(parent, pid) {
                found.push(pid);
                parents.push(pid);
            }
        }
    }
    found
}
