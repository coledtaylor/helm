//! Ending a process tree on Windows, with `taskkill /T`, which walks the
//! tree from the root by parent process id, as today's app does.
//!
//! The polite ending is `taskkill` without `/F`, which asks each process's
//! windows to close. A console program has none, so for a session the polite
//! ending that counts is the session closing its pseudoconsole, which sends
//! every program attached to it the console's close event.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use floti_protocol::Knowable;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, GetLastError, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    WaitForSingleObject,
};

use super::{Ending, ProcessTree};
use crate::{Error, Result};

/// The Windows implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl ProcessTree for Native {
    fn end_tree(&self, root_pid: u32, how: Ending) -> Result<()> {
        if root_pid == 0 {
            return Ok(());
        }
        let pid = root_pid.to_string();
        let mut args = vec!["/PID", pid.as_str(), "/T"];
        if how == Ending::Forced {
            args.push("/F");
        }
        let status = Command::new(taskkill())
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|err| Error::io("run taskkill", err))?;
        // taskkill answers 128 for a process that is already gone, and a
        // polite request a console program cannot take fails by design.
        if status.success()
            || how == Ending::Polite
            || self.is_alive(root_pid) != Knowable::Known(true)
        {
            return Ok(());
        }
        Err(Error::io(
            format!("end process tree {root_pid}"),
            std::io::Error::other(format!("taskkill exited with {status}")),
        ))
    }

    fn is_alive(&self, pid: u32) -> Knowable<bool> {
        if pid == 0 {
            return Knowable::Unknown;
        }
        // SAFETY: OpenProcess takes plain values and returns a handle or null.
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            // SAFETY: reads the calling thread's last error.
            return match unsafe { GetLastError() } {
                ERROR_INVALID_PARAMETER => Knowable::Known(false),
                // It exists; it belongs to someone this user may not query.
                ERROR_ACCESS_DENIED => Knowable::Known(true),
                _ => Knowable::Unknown,
            };
        }
        // SAFETY: `handle` is a process handle opened above with SYNCHRONIZE,
        // waited on without blocking and closed once.
        let waited = unsafe { WaitForSingleObject(handle, 0) };
        unsafe { CloseHandle(handle) };
        match waited {
            WAIT_TIMEOUT => Knowable::Known(true),
            WAIT_OBJECT_0 => Knowable::Known(false),
            _ => Knowable::Unknown,
        }
    }
}

/// `taskkill.exe` in the system folder, rather than whatever `PATH` finds
/// first under that name.
fn taskkill() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join("System32").join("taskkill.exe"))
        .unwrap_or_else(|| PathBuf::from("taskkill.exe"))
}
