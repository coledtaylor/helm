//! The host's place in the user's sign-in on Windows: whether it runs as a
//! service account, and the console events that stop it (Ctrl+C, Ctrl+Break,
//! the console closing, signing out and shutting down).

use std::ffi::c_void;
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::ptr;

use tokio::signal::windows::{CtrlBreak, CtrlC, CtrlClose, CtrlLogoff, CtrlShutdown};
use windows_sys::Win32::Foundation::{HANDLE, LocalFree};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::{GetTokenInformation, TOKEN_QUERY, TOKEN_USER, TokenUser};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

use super::Account;
use crate::{Error, Result};

/// The service accounts a host must never run as, by their well-known SIDs.
const SERVICE_ACCOUNTS: [(&str, &str); 3] = [
    ("S-1-5-18", "the SYSTEM account"),
    ("S-1-5-19", "the LOCAL SERVICE account"),
    ("S-1-5-20", "the NETWORK SERVICE account"),
];

pub(super) fn account() -> Account {
    match token_user_sid() {
        Ok(sid) => SERVICE_ACCOUNTS
            .iter()
            .find(|(known, _)| *known == sid)
            .map_or(Account::User, |(_, name)| Account::Privileged(name)),
        Err(_) => Account::Unknown,
    }
}

/// The SID of the user this process's token belongs to, as text.
fn token_user_sid() -> io::Result<String> {
    let mut raw: HANDLE = ptr::null_mut();
    // SAFETY: the pseudo handle needs no closing; `raw` receives a token
    // handle, owned below.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: OpenProcessToken succeeded, so `raw` is a handle we own.
    let token = unsafe { OwnedHandle::from_raw_handle(raw as RawHandle) };
    let token = token.as_raw_handle() as HANDLE;

    let mut needed = 0u32;
    // SAFETY: a size query with no buffer; it fails and sets `needed`.
    unsafe { GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut needed) };
    if needed == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0u64; (needed as usize).div_ceil(size_of::<u64>())];
    // SAFETY: `buffer` holds at least `needed` bytes, aligned for TOKEN_USER.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: GetTokenInformation(TokenUser) wrote a TOKEN_USER at the start
    // of the buffer, whose SID points into the same buffer.
    let sid = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    let mut text: *mut u16 = ptr::null_mut();
    // SAFETY: `sid` is valid while `buffer` lives; on success `text` is a
    // NUL-terminated string from LocalAlloc, freed below.
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `text` is NUL-terminated.
    let len = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
    // SAFETY: `len` units precede the NUL.
    let sid = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
    // SAFETY: allocated by ConvertSidToStringSidW.
    unsafe { LocalFree(text.cast::<c_void>()) };
    Ok(sid)
}

/// The console events that stop the host, registered while this lives.
pub(super) struct Signals {
    ctrl_c: CtrlC,
    ctrl_break: CtrlBreak,
    close: CtrlClose,
    logoff: CtrlLogoff,
    shutdown: CtrlShutdown,
}

impl Signals {
    pub(super) fn register() -> Result<Self> {
        let failed = |err| Error::io("listen for the console's stop events", err);
        Ok(Self {
            ctrl_c: tokio::signal::windows::ctrl_c().map_err(failed)?,
            ctrl_break: tokio::signal::windows::ctrl_break().map_err(failed)?,
            close: tokio::signal::windows::ctrl_close().map_err(failed)?,
            logoff: tokio::signal::windows::ctrl_logoff().map_err(failed)?,
            shutdown: tokio::signal::windows::ctrl_shutdown().map_err(failed)?,
        })
    }

    pub(super) async fn recv(&mut self) -> &'static str {
        tokio::select! {
            _ = self.ctrl_c.recv() => "Ctrl+C",
            _ = self.ctrl_break.recv() => "Ctrl+Break",
            _ = self.close.recv() => "the console closing",
            _ = self.logoff.recv() => "signing out",
            _ = self.shutdown.recv() => "the computer shutting down",
        }
    }
}

/// Makes `command` a process [`interrupt`] can reach: the console sends
/// Ctrl+Break to a process group, so it gets one of its own.
#[cfg(any(test, feature = "testkit"))]
pub fn stoppable(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP);
}

/// Interrupts process `pid`, started through [`stoppable`], as the keyboard
/// would: Ctrl+Break, the interrupt a console delivers to a process group of
/// its own.
#[cfg(any(test, feature = "testkit"))]
pub fn interrupt(pid: u32) -> io::Result<()> {
    use windows_sys::Win32::System::Console::{CTRL_BREAK_EVENT, GenerateConsoleCtrlEvent};
    // A group id of 0 would mean every process on this console, the caller
    // included.
    if pid == 0 {
        return Err(io::Error::other("no process to interrupt"));
    }
    // SAFETY: plain call; `pid` names the group `stoppable` created.
    if unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Asks process `pid` to terminate. Windows has no SIGTERM for a console
/// program; the request it gets is a console event, as [`interrupt`] sends.
#[cfg(any(test, feature = "testkit"))]
pub fn terminate(pid: u32) -> io::Result<()> {
    interrupt(pid)
}
