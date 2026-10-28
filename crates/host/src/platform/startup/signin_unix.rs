//! The host's place in the user's sign-in on macOS and Linux: whether it
//! runs as root, and the signals that stop it (SIGINT for Ctrl+C, SIGTERM
//! from launchd or systemd when the user signs out, SIGHUP when its terminal
//! goes).

use tokio::signal::unix::{Signal, SignalKind, signal};

use super::Account;
use crate::{Error, Result};

pub(super) fn account() -> Account {
    // SAFETY: geteuid has no preconditions and cannot fail.
    if unsafe { libc::geteuid() } == 0 {
        Account::Privileged("root")
    } else {
        Account::User
    }
}

/// Windows' build number, which no other OS has.
pub(super) fn windows_build() -> Option<u32> {
    None
}

/// The signals that stop the host, registered while this lives.
pub(super) struct Signals {
    interrupt: Signal,
    terminate: Signal,
    hangup: Signal,
}

impl Signals {
    pub(super) fn register() -> Result<Self> {
        let listen = |kind| {
            signal(kind).map_err(|err| Error::io("listen for the signals that stop it", err))
        };
        Ok(Self {
            interrupt: listen(SignalKind::interrupt())?,
            terminate: listen(SignalKind::terminate())?,
            hangup: listen(SignalKind::hangup())?,
        })
    }

    pub(super) async fn recv(&mut self) -> &'static str {
        tokio::select! {
            _ = self.interrupt.recv() => "Ctrl+C",
            _ = self.terminate.recv() => "SIGTERM",
            _ = self.hangup.recv() => "SIGHUP",
        }
    }
}

/// Makes `command` a process [`interrupt`] can reach. Any process can be
/// signalled, so there is nothing to do.
#[cfg(any(test, feature = "testkit"))]
pub fn stoppable(_command: &mut std::process::Command) {}

/// Sends process `pid` SIGINT, as Ctrl+C in its terminal would.
#[cfg(any(test, feature = "testkit"))]
pub fn interrupt(pid: u32) -> std::io::Result<()> {
    send(pid, libc::SIGINT)
}

/// Sends process `pid` SIGTERM, as launchd and systemd do when the user
/// signs out.
#[cfg(any(test, feature = "testkit"))]
pub fn terminate(pid: u32) -> std::io::Result<()> {
    send(pid, libc::SIGTERM)
}

#[cfg(any(test, feature = "testkit"))]
fn send(pid: u32, signal: libc::c_int) -> std::io::Result<()> {
    let pid = libc::pid_t::try_from(pid)
        .ok()
        .filter(|pid| *pid > 1)
        .ok_or_else(|| std::io::Error::other("no process to signal"))?;
    // SAFETY: plain call on a positive pid.
    if unsafe { libc::kill(pid, signal) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
