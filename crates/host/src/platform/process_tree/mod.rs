//! Ending a session's whole process tree: the program and everything it
//! started. `taskkill /T` on Windows; the process group on macOS and Linux,
//! where the pty makes each session's program a group leader.
//!
//! The same concern ties the host's own tree to its life
//! ([`ProcessTree::end_tree_with_this_process`]), so a host that is killed or
//! crashes takes its sessions with it, as a stop does: a job object on
//! Windows, a guard process on macOS and Linux. The host itself ties only
//! its plugins' programs this way; every session's and plain terminal's
//! tree is the session keeper's (`crate::keeper`), which ties them to its
//! own life instead and is started to outlive the host
//! ([`ProcessTree::prepare_lasting_root`]).
//!
//! Beside the trees, [`OneProcess`] ends one process alone, at once, as a
//! crash would (`TerminateProcess` on Windows, SIGKILL to that pid alone on
//! macOS and Linux), never its tree or group: what `floti end-old-host` ends
//! an older host with, so its session keeper and every program in it carry
//! on.

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
pub use linux::{Native, OneProcess};
#[cfg(target_os = "macos")]
pub use macos::{Native, OneProcess};
#[cfg(target_os = "windows")]
pub use windows::{Native, OneProcess};

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
    /// it ends: from now on, every program it runs in a terminal (each named
    /// with [`ProcessTree::tie_tree`]) and everything those start end with
    /// it, killed or crashed as much as stopped. Asking again changes
    /// nothing.
    ///
    /// Known(true) once that holds. Unknown when the OS would not arrange
    /// it, which is said once on stderr and is no reason to stop: the
    /// process keeps working, and what it started can outlive a crash.
    fn end_tree_with_this_process(&self) -> Knowable<bool>;

    /// `root_pid`, a program this process has just started in a terminal,
    /// is running: once [`ProcessTree::end_tree_with_this_process`] has
    /// arranged it, its tree ends with this process until
    /// [`ProcessTree::untie_tree`].
    fn tie_tree(&self, root_pid: u32);

    /// The program `root_pid` has exited and been reaped, so its id may be
    /// handed to another process: its tree no longer ends with this one.
    fn untie_tree(&self, root_pid: u32);

    /// Makes `command`, about to be started outside a terminal, the root of
    /// a tree [`ProcessTree::end_tree`] can end: on macOS and Linux the
    /// leader of a process group of its own, since a group is the tree; on
    /// Windows, started with no console window, since `taskkill /T` finds
    /// the tree by parent. It holds no descriptor of this process's but its
    /// standard three. Nothing else about how it starts changes.
    fn prepare_root(&self, command: &mut std::process::Command) {
        let _ = command;
    }

    /// Makes `command` the root of a tree as [`ProcessTree::prepare_root`]
    /// does, and one that outlives this process: it is not tied to this
    /// process's life ([`ProcessTree::end_tree_with_this_process`]). The
    /// session keeper starts this way. On Windows it leaves this process's
    /// job; on macOS and Linux a program outside a terminal is never tied.
    fn prepare_lasting_root(&self, command: &mut std::process::Command) {
        self.prepare_root(command);
    }

    /// Starts `program` with `args` alone: as a lasting root
    /// ([`ProcessTree::prepare_lasting_root`]), with nothing on its standard
    /// input, output and error, and holding nothing of this process's open,
    /// so a pipe this process was handed closes once this process and the
    /// pipe's other holders end, whatever it started. `floti connect` starts
    /// the host this way. On macOS and Linux every descriptor but the
    /// standard three is closed at exec already; Windows hands a child every
    /// handle marked inheritable unless it is started with none.
    fn start_alone(
        &self,
        program: &std::path::Path,
        args: &[&str],
    ) -> std::io::Result<Box<dyn Started>> {
        let mut command = std::process::Command::new(program);
        command
            .args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        self.prepare_lasting_root(&mut command);
        Ok(Box::new(command.spawn()?))
    }
}

/// A program [`ProcessTree::start_alone`] started.
pub trait Started: Send {
    /// Its exit code once it has exited (no code when a signal ended it),
    /// nothing while it runs or when that cannot be told.
    fn exited(&mut self) -> Option<Option<i32>>;
}

impl Started for std::process::Child {
    fn exited(&mut self) -> Option<Option<i32>> {
        match self.try_wait() {
            Ok(Some(status)) => Some(status.code()),
            _ => None,
        }
    }
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
