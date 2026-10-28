//! Ending a process tree on macOS and Linux, through its process group.
//!
//! A session's program starts a session of its own in its pty, which makes
//! it the leader of a process group that everything it starts joins unless
//! it moves itself out. Signalling the group reaches the whole tree: SIGTERM
//! to ask, SIGKILL to end it, as today's app does.
//!
//! When the host ends, however it ends, each pty's terminal hangs up, but the
//! hang-up signals only the program the terminal runs (and on Linux, once
//! that program has gone, the group in the foreground). On macOS what a
//! program run without a shell started outlives it. So the host forks a
//! guard, which holds the read end of a pipe whose only write end the host
//! holds, and tells it each program it starts in a terminal and each that
//! exits. The pipe closes when the host ends, however it ends, and the guard
//! then ends the group of each program still running, as a stop does.

use std::io::{self, PipeWriter, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::sync::OnceLock;
use std::time::Duration;

use floti_protocol::Knowable;

use super::{Ending, ProcessTree};
use crate::{Error, Result};

/// The host's end of the pipe to the guard, decided at the first ask: None
/// where the guard could not be started.
static GUARD: OnceLock<Option<PipeWriter>> = OnceLock::new();

/// One message to the guard: [`TIE`] or [`UNTIE`], then a pid as four bytes,
/// little-endian. Far below `PIPE_BUF`, so one write is never split or mixed
/// with another thread's.
const RECORD: usize = 5;
const TIE: u8 = b'+';
const UNTIE: u8 = b'-';

/// The most programs the guard holds at once. Any beyond them do not end
/// with the host.
const MOST_TIED: usize = 4096;

/// How long the guard gives the groups it hung up before it ends what is
/// left outright: what closing a session gives its program.
const GRACE: Duration = Duration::from_millis(1500);

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
        let guard = GUARD.get_or_init(|| match start_guard() {
            Ok(pipe) => Some(pipe),
            Err(err) => {
                eprintln!(
                    "floti host: {}. Sessions still run, but if the host crashes, what they started may keep running.",
                    Error::io("start the guard that ends sessions with the host", err)
                );
                None
            }
        });
        if guard.is_some() {
            Knowable::Known(true)
        } else {
            Knowable::Unknown
        }
    }

    fn tie_tree(&self, root_pid: u32) {
        tell_guard(TIE, root_pid);
    }

    fn untie_tree(&self, root_pid: u32) {
        tell_guard(UNTIE, root_pid);
    }
}

/// Tells the guard, once it runs, that the program `pid` started ([`TIE`])
/// or exited ([`UNTIE`]).
fn tell_guard(what: u8, pid: u32) {
    let Some(Some(mut pipe)) = GUARD.get().map(Option::as_ref) else {
        return;
    };
    let [a, b, c, d] = pid.to_le_bytes();
    // A guard that has gone can be told nothing, and the session runs on.
    let _ = pipe.write_all(&[what, a, b, c, d]);
}

/// Forks the guard and returns the host's end of the pipe to it.
fn start_guard() -> io::Result<PipeWriter> {
    // Both ends close on exec, so no program the host starts holds the write
    // end open and keeps the guard from seeing the host go.
    let (reader, writer) = io::pipe()?;
    let open_max = open_max();
    // SAFETY: the child runs only `guard`, which makes no call a fork of a
    // process with other threads may not make.
    match unsafe { libc::fork() } {
        -1 => Err(io::Error::last_os_error()),
        0 => guard(reader.as_raw_fd(), open_max),
        _ => Ok(writer),
    }
}

/// One past the highest descriptor this process may open, at most 2^20.
fn open_max() -> RawFd {
    const MOST: RawFd = 1 << 20;
    // SAFETY: sysconf reads a limit.
    let max = unsafe { libc::sysconf(libc::_SC_OPEN_MAX) };
    RawFd::try_from(max)
        .ok()
        .filter(|max| *max > 0)
        .map_or(MOST, |max| max.min(MOST))
}

/// The guard: a fork of the host that reads which programs are running until
/// `pipe` closes, then ends their groups and exits.
///
/// A fork of a process with other threads may only make the calls a signal
/// handler may: nothing that allocates, takes a lock or prints. So it keeps
/// what it is told in a table on its own stack, and says nothing.
fn guard(pipe: RawFd, open_max: RawFd) -> ! {
    // SAFETY: each call is async-signal-safe and takes plain values.
    unsafe {
        // A session of its own, so that a signal to the host's group, or a
        // hang-up of the terminal the host was started from, does not end it
        // before it has done its work.
        libc::setsid();
        libc::chdir(c"/".as_ptr());
        // Nothing open but its end of the pipe: a copy of a pty's end would
        // keep that terminal from hanging up, a copy of the data folder's
        // lock would keep the next host out, and a copy of the host's output
        // would keep whoever reads it waiting.
        for fd in 0..open_max {
            if fd != pipe {
                libc::close(fd);
            }
        }
        // The host's signal handlers came with the fork, for a program that
        // is not here: a signal ends the guard as it would any program.
        let mut none: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut none);
        libc::sigprocmask(libc::SIG_SETMASK, &none, std::ptr::null_mut());
        for signal in [libc::SIGHUP, libc::SIGINT, libc::SIGTERM, libc::SIGPIPE] {
            libc::signal(signal, libc::SIG_DFL);
        }
    }

    let mut tied = Tied::new();
    let mut record = [0u8; RECORD];
    let mut filled = 0;
    loop {
        // SAFETY: reads into the part of `record` not yet filled.
        let read =
            unsafe { libc::read(pipe, record[filled..].as_mut_ptr().cast(), RECORD - filled) };
        match usize::try_from(read) {
            // The host has ended.
            Ok(0) => break,
            Ok(read) => {
                filled += read;
                if filled == RECORD {
                    tied.take(record);
                    filled = 0;
                }
            }
            Err(_) if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted => {}
            // A pipe that cannot be read is no sign the host has gone: end
            // nothing.
            // SAFETY: _exit ends this process without running anything.
            Err(_) => unsafe { libc::_exit(1) },
        }
    }
    tied.end();
    // SAFETY: as above.
    unsafe { libc::_exit(0) }
}

/// The process groups of the programs the host is running, as the guard
/// keeps them: each program leads its own group, by its pid.
struct Tied {
    groups: [libc::pid_t; MOST_TIED],
    len: usize,
}

impl Tied {
    fn new() -> Self {
        Self {
            groups: [0; MOST_TIED],
            len: 0,
        }
    }

    fn groups(&self) -> &[libc::pid_t] {
        &self.groups[..self.len]
    }

    /// Takes one message: a program started, or one exited.
    fn take(&mut self, [what, a, b, c, d]: [u8; RECORD]) {
        // 0 and 1 would signal the guard's own group or every process.
        let Some(group) = libc::pid_t::try_from(u32::from_le_bytes([a, b, c, d]))
            .ok()
            .filter(|pid| *pid > 1)
        else {
            return;
        };
        match (what, self.groups().iter().position(|tied| *tied == group)) {
            (TIE, None) if self.len < MOST_TIED => {
                self.groups[self.len] = group;
                self.len += 1;
            }
            (UNTIE, Some(at)) => {
                self.len -= 1;
                self.groups[at] = self.groups[self.len];
            }
            _ => {}
        }
    }

    /// Hangs up every group, as a terminal's hang-up does, and ends outright
    /// whatever is still running after [`GRACE`], as a stop does.
    fn end(&self) {
        for &group in self.groups() {
            signal_group(group, libc::SIGHUP);
            // Lets a stopped process take the hang-up.
            signal_group(group, libc::SIGCONT);
        }
        let step = Duration::from_millis(50);
        let mut waited = Duration::ZERO;
        // Signal 0 checks a group still has a process and sends nothing.
        while waited < GRACE && self.groups().iter().any(|&group| signal_group(group, 0)) {
            pause(step);
            waited += step;
        }
        for &group in self.groups() {
            signal_group(group, libc::SIGKILL);
        }
    }
}

/// Sends `signal` to every process in `group`; false when there is none.
fn signal_group(group: libc::pid_t, signal: libc::c_int) -> bool {
    // SAFETY: killpg takes plain values.
    unsafe { libc::killpg(group, signal) == 0 }
}

/// Sleeps for `step`, under a second.
fn pause(step: Duration) {
    let time = libc::timespec {
        tv_sec: 0,
        tv_nsec: step.subsec_nanos().into(),
    };
    // SAFETY: nanosleep reads `time`.
    unsafe { libc::nanosleep(&time, std::ptr::null_mut()) };
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

#[cfg(test)]
mod tests {
    use super::{RECORD, TIE, Tied, UNTIE};

    fn message(what: u8, pid: u32) -> [u8; RECORD] {
        let [a, b, c, d] = pid.to_le_bytes();
        [what, a, b, c, d]
    }

    fn groups(tied: &Tied) -> Vec<libc::pid_t> {
        let mut groups = tied.groups().to_vec();
        groups.sort_unstable();
        groups
    }

    /// The guard keeps each running program once, and lets go of one that
    /// exits, whose pid may be handed on.
    #[test]
    fn the_guard_keeps_each_running_program_once_until_it_exits() {
        let mut tied = Tied::new();
        for pid in [100, 200, 100, 300] {
            tied.take(message(TIE, pid));
        }
        tied.take(message(UNTIE, 100));
        tied.take(message(UNTIE, 999));
        assert_eq!(groups(&tied), [200, 300]);

        tied.take(message(TIE, 100));
        assert_eq!(groups(&tied), [100, 200, 300]);
    }

    /// 0 and 1 would signal the guard's own group or every process, and a
    /// number past any pid is no program.
    #[test]
    fn the_guard_keeps_no_group_that_is_not_one_programs() {
        let mut tied = Tied::new();
        for pid in [0, 1, u32::MAX] {
            tied.take(message(TIE, pid));
        }
        tied.take(message(b'?', 400));
        assert!(tied.groups().is_empty());
    }
}
