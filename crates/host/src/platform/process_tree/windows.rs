//! Ending a process tree on Windows, with `taskkill /T`, which walks the
//! tree from the root by parent process id, as today's app does.
//!
//! The polite ending is `taskkill` without `/F`, which asks each process's
//! windows to close. A console program has none, so for a session the polite
//! ending that counts is the session closing its pseudoconsole, which sends
//! every program attached to it the console's close event.
//!
//! A host that is killed ends no tree. Its pseudoconsoles close with it, and
//! that close event reaches the programs attached to them, but not a program
//! a session started with no console of its own: a GUI app, or a tool a CLI
//! starts with its window hidden, which would run on with nobody to reach
//! it. So the host puts itself in a job object that ends every process in it
//! when the job's last handle closes, and keeps the only handle: whatever it
//! starts afterwards is in the job, each pseudoconsole's `conhost.exe`
//! included, and Windows closes the handle when the host ends, however it
//! ends.

use std::io;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use floti_protocol::Knowable;
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, GetLastError, HANDLE, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, GetCurrentProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SYNCHRONIZE, WaitForSingleObject,
};

use super::{Ending, ProcessTree};
use crate::{Error, Result};

/// Whether this process's tree ends with it: decided at the first ask, and
/// the same answer every time after.
static TREE_ENDS_WITH_THIS_PROCESS: OnceLock<Knowable<bool>> = OnceLock::new();

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
        let Some(handle) =
            open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)
        else {
            // SAFETY: reads the calling thread's last error.
            return match unsafe { GetLastError() } {
                ERROR_INVALID_PARAMETER => Knowable::Known(false),
                // It exists; it belongs to someone this user may not query.
                ERROR_ACCESS_DENIED => Knowable::Known(true),
                _ => Knowable::Unknown,
            };
        };
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

    fn end_tree_with_this_process(&self) -> Knowable<bool> {
        TREE_ENDS_WITH_THIS_PROCESS
            .get_or_init(|| match join_a_job_that_ends_with_this_process() {
                Ok(()) => Knowable::Known(true),
                Err(err) => {
                    eprintln!(
                        "floti host: {}. Sessions still run, but if the host crashes, what they started keeps running.",
                        Error::io("tie what the host starts to its own life", err)
                    );
                    Knowable::Unknown
                }
            })
            .clone()
    }
}

/// Puts this process in a new job that ends every process in it when its
/// last handle closes, and leaves the handle open for the rest of the
/// process's life. Nested jobs (Windows 8 on) let a process already in a job
/// join this one too; one whose job forbids that is refused.
///
/// A program that asks to leave the job (`CREATE_BREAKAWAY_FROM_JOB`) may,
/// as one on macOS or Linux may leave its terminal's session to outlive the
/// hang-up; refused, it would not start at all. Nothing the host starts
/// itself asks.
fn join_a_job_that_ends_with_this_process() -> io::Result<()> {
    // SAFETY: no attributes (so the handle is not inherited) and no name.
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
    let size = u32::try_from(size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
        .expect("the job's limits fit in a u32");
    // SAFETY: `job` is the job created above, and `limits` is the structure
    // this information class names, `size` bytes long.
    let limited = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&limits).cast(),
            size,
        )
    };
    // SAFETY: the pseudo-handle for this process has every access right.
    if limited == 0 || unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) } == 0 {
        let err = io::Error::last_os_error();
        // SAFETY: `job` is open and closed once, here; nothing is in it.
        unsafe { CloseHandle(job) };
        return Err(err);
    }
    // The handle is never closed: Windows closes it when this process ends,
    // and that is what ends the job.
    Ok(())
}

/// `pid` opened with `access`, or `None` with the reason in the thread's
/// last error.
fn open_process(pid: u32, access: u32) -> Option<HANDLE> {
    // SAFETY: OpenProcess takes plain values and returns a handle or null.
    let handle = unsafe { OpenProcess(access, 0, pid) };
    (!handle.is_null()).then_some(handle)
}

/// `taskkill.exe` in the system folder, rather than whatever `PATH` finds
/// first under that name.
fn taskkill() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(|root| PathBuf::from(root).join("System32").join("taskkill.exe"))
        .unwrap_or_else(|| PathBuf::from("taskkill.exe"))
}

/// Every process running now that `root_pid` started, and every process
/// those started, by parent process id. Windows hands a dead process's id to
/// a new one without telling its children, so a process counts as a child
/// only when it started after its parent. Unknown when Windows would not
/// list the processes or say when `root_pid` started.
#[cfg(any(test, feature = "testkit"))]
pub fn descendants(root_pid: u32) -> Knowable<Vec<u32>> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };

    if started_at(root_pid).is_none() {
        return Knowable::Unknown;
    }
    // SAFETY: takes plain values and returns a snapshot handle or
    // INVALID_HANDLE_VALUE.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Knowable::Unknown;
    }
    let mut table = Vec::new();
    let mut entry = PROCESSENTRY32W {
        dwSize: u32::try_from(size_of::<PROCESSENTRY32W>()).expect("an entry's size fits"),
        ..PROCESSENTRY32W::default()
    };
    // SAFETY: `snapshot` is open, `entry` is sized as the calls require, and
    // the snapshot is closed once after the walk.
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while more {
        table.push((entry.th32ProcessID, entry.th32ParentProcessID));
        more = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(snapshot) };
    Knowable::Known(super::tree_under(&table, root_pid, |parent, pid| {
        match (started_at(parent), started_at(pid)) {
            (Some(parent), Some(child)) => child >= parent,
            _ => false,
        }
    }))
}

/// When process `pid` started, in 100-nanosecond ticks since 1601, or
/// `None` when it cannot be opened.
#[cfg(any(test, feature = "testkit"))]
fn started_at(pid: u32) -> Option<u64> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;

    let handle = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: `handle` is a process handle opened with the access
    // GetProcessTimes needs, closed once after the call.
    let read =
        unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
    unsafe { CloseHandle(handle) };
    (read != 0)
        .then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

#[cfg(test)]
mod tests {
    use windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB;

    use super::*;
    use crate::session::tests::fake_agent_exe;

    /// A program that asks to leave the job this process put itself in
    /// starts, outside it.
    #[test]
    fn a_program_that_asks_to_leave_the_job_starts() {
        assert_eq!(Native.end_tree_with_this_process(), Knowable::Known(true));
        let status = Command::new(fake_agent_exe())
            .arg("--fake-exit=0")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_BREAKAWAY_FROM_JOB)
            .status()
            .expect("a program that asks to leave the job may");
        assert!(status.success(), "{status}");
    }
}
