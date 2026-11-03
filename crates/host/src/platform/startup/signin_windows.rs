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

/// The machine's Windows build number, from `RtlGetVersion`, which answers
/// the real version where `GetVersionEx` answers what the program's manifest
/// claims to support.
pub(super) fn windows_build() -> Option<u32> {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    // SAFETY: a zeroed OSVERSIONINFOW with its size set is what
    // RtlGetVersion fills; it writes only inside it.
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    let status = unsafe { RtlGetVersion(&mut info) };
    (status == 0).then_some(info.dwBuildNumber)
}

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

/// Whether this user (`USERDOMAIN\USERNAME`) has a desktop session on this
/// computer: a session other than session 0, where services run, whose
/// user it is, at the console or over remote desktop, connected or not. An
/// ssh login runs outside any such session, so it never counts.
pub(super) fn desktop_session() -> io::Result<bool> {
    use windows_sys::Win32::System::RemoteDesktop::{
        WTS_CURRENT_SERVER_HANDLE, WTS_SESSION_INFOW, WTSActive, WTSDisconnected, WTSDomainName,
        WTSEnumerateSessionsW, WTSFreeMemory, WTSUserName,
    };

    let var = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_owned())
    };
    let Some(user) = var("USERNAME").filter(|user| !user.is_empty()) else {
        return Err(io::Error::other(
            "USERNAME is not set, so the user's sessions cannot be told apart",
        ));
    };
    let domain = var("USERDOMAIN").unwrap_or_default();

    let query = |session: u32, class| -> Option<String> {
        let mut text: windows_sys::core::PWSTR = ptr::null_mut();
        let mut bytes = 0u32;
        // SAFETY: on success `text` is a NUL-terminated string the API
        // allocated, freed below.
        let ok = unsafe {
            windows_sys::Win32::System::RemoteDesktop::WTSQuerySessionInformationW(
                WTS_CURRENT_SERVER_HANDLE,
                session,
                class,
                &mut text,
                &mut bytes,
            )
        };
        if ok == 0 || text.is_null() {
            return None;
        }
        // SAFETY: `text` is NUL-terminated.
        let len = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
        // SAFETY: `len` units precede the NUL.
        let value = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
        // SAFETY: allocated by WTSQuerySessionInformationW.
        unsafe { WTSFreeMemory(text.cast()) };
        Some(value)
    };

    let mut sessions: *mut WTS_SESSION_INFOW = ptr::null_mut();
    let mut count = 0u32;
    // SAFETY: on success `sessions` points at `count` entries the API
    // allocated, freed below.
    if unsafe { WTSEnumerateSessionsW(WTS_CURRENT_SERVER_HANDLE, 0, 1, &mut sessions, &mut count) }
        == 0
    {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `count` entries were written at `sessions`.
    let listed = unsafe { std::slice::from_raw_parts(sessions, count as usize) };
    let found = listed.iter().any(|session| {
        session.SessionId != 0
            && (session.State == WTSActive || session.State == WTSDisconnected)
            && query(session.SessionId, WTSUserName)
                .is_some_and(|name| name.eq_ignore_ascii_case(&user))
            && (domain.is_empty()
                || query(session.SessionId, WTSDomainName)
                    .is_some_and(|name| name.eq_ignore_ascii_case(&domain)))
    });
    // SAFETY: allocated by WTSEnumerateSessionsW.
    unsafe { WTSFreeMemory(sessions.cast()) };
    Ok(found)
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
