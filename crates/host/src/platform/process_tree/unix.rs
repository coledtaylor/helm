//! Ending a process tree on macOS and Linux, through its process group.
//!
//! A session's program starts a session of its own in its pty, which makes
//! it the leader of a process group that everything it starts joins unless
//! it moves itself out. Signalling the group reaches the whole tree: SIGTERM
//! to ask, SIGKILL to end it, as today's app does.
//!
//! The same pty ends the tree when the host ends, however it ends: the pty
//! is that session's controlling terminal, and when the host's end of it
//! closes the kernel hangs the terminal up, sending SIGHUP to the program
//! and to the process group in the foreground.

use std::io;

use floti_protocol::Knowable;

use super::{Ending, ProcessTree};
use crate::{Error, Result};

/// The implementation macOS and Linux share.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl ProcessTree for Native {
    fn end_tree(&self, root_pid: u32, how: Ending) -> Result<()> {
        // 0 and 1 would signal the host's own group or every process.
        let Some(pid) = libc::pid_t::try_from(root_pid).ok().filter(|pid| *pid > 1) else {
            return Ok(());
        };
        let signal = match how {
            Ending::Polite => libc::SIGTERM,
            Ending::Forced => libc::SIGKILL,
        };
        // SAFETY: killpg and kill take plain values.
        if unsafe { libc::killpg(pid, signal) } == 0 {
            return Ok(());
        }
        let err = io::Error::last_os_error();
        if err.raw_os_error() != Some(libc::ESRCH) {
            return Err(Error::io(format!("end process tree {root_pid}"), err));
        }
        // No group of that id: a process that never led one, or one already
        // gone.
        // SAFETY: as above.
        if unsafe { libc::kill(pid, signal) } == 0 {
            return Ok(());
        }
        let err = io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(Error::io(format!("end process {root_pid}"), err))
        }
    }

    fn is_alive(&self, pid: u32) -> Knowable<bool> {
        let Some(pid) = libc::pid_t::try_from(pid).ok().filter(|pid| *pid > 0) else {
            return Knowable::Unknown;
        };
        // SAFETY: signal 0 checks the process exists and sends nothing.
        if unsafe { libc::kill(pid, 0) } == 0 {
            return Knowable::Known(true);
        }
        match io::Error::last_os_error().raw_os_error() {
            Some(libc::ESRCH) => Knowable::Known(false),
            // It exists; it belongs to another user.
            Some(libc::EPERM) => Knowable::Known(true),
            _ => Knowable::Unknown,
        }
    }

    fn end_tree_with_this_process(&self) -> Knowable<bool> {
        // Nothing to arrange: the terminal hang-up does it. A process ends
        // with its files closed, the pty's master among them, whether it
        // returned, crashed or was killed.
        Knowable::Known(true)
    }
}

/// Every process running now that `root_pid` started, and every process
/// those started, by parent process id, as `ps` lists them on macOS and
/// Linux alike. A process whose parent ends is handed to another, so a
/// parent id always names the live parent. Unknown when `ps` would not run.
#[cfg(any(test, feature = "testkit"))]
pub fn descendants(root_pid: u32) -> Knowable<Vec<u32>> {
    use std::process::{Command, Stdio};

    let Ok(output) = Command::new("ps")
        .args(["-A", "-o", "pid=", "-o", "ppid="])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return Knowable::Unknown;
    };
    if !output.status.success() {
        return Knowable::Unknown;
    }
    let table: Vec<(u32, u32)> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut ids = line.split_whitespace().map(str::parse::<u32>);
            Some((ids.next()?.ok()?, ids.next()?.ok()?))
        })
        .collect();
    Knowable::Known(super::tree_under(&table, root_pid, |_, _| true))
}
