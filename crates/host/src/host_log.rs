//! The host's log: `host.log` in its logs folder.
//!
//! `floti host` opens it as soon as it knows its folders and points its own
//! standard error at it ([`StandardError`]), so every line the host writes
//! about itself lands there, and so does what the standard library writes as
//! the process ends: a panic's message, and the line a failed allocation
//! leaves before the process aborts. The file stays once the process has
//! ended. Its first line for each run names the host's version, its process
//! and when it started ([`start_line`]).
//!
//! What the host writes there names a key by its fingerprint and never holds
//! a private key, an enrolment or pairing code, a credential, a prompt or
//! anything a session reads or writes.
//!
//! It is bounded. Once the host holds its data folder, a log past
//! [`LOG_LIMIT`] becomes `host.log.1`, the one before it `host.log.2`, and so
//! on up to [`KEPT_LOGS`] older files, and standard error is pointed at a new
//! `host.log`; the same happens whenever a line the host writes
//! ([`log_line!`](crate::log_line)) finds the file past the limit.
//!
//! Only the executable does any of this. A host started inside a test process
//! leaves that process's standard error alone, and its lines go there.

#[cfg(test)]
mod tests;

use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock, PoisonError};

use jiff::Timestamp;

use crate::platform::private_files::{Native as NativeFiles, PrivateFiles};
use crate::platform::standard_error::StandardError;
use crate::{Error, Result};

/// The log's name in the logs folder.
pub const LOG_FILE: &str = "host.log";

/// How large the log may grow before it is rotated.
pub const LOG_LIMIT: u64 = 5 * 1024 * 1024;

/// How many rotated logs are kept beside `host.log`: `host.log.1` (the most
/// recent) to `host.log.3`.
pub const KEPT_LOGS: u32 = 3;

/// The file in a data folder that gives a test build's log a limit of its
/// own, in bytes, so a test reaches it without writing megabytes. A
/// production build never reads it.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_LOG_LIMIT_MARKER: &str = "floti-test-log-limit";

/// The file in a data folder that makes a test build's `floti host` end
/// itself just after its start line, the way a fault would: `panic` panics,
/// and `abort` fails an allocation, which aborts the process. A production
/// build never reads it.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_CRASH_MARKER: &str = "floti-test-crash";

/// The file in a data folder that makes a test build's `floti host` abort
/// once it has started a session: a host that dies with sessions running.
/// `panic` panics where no panic may unwind, which aborts the process;
/// anything else fails an allocation. A production build never reads it.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_CRASH_AFTER_SESSION_MARKER: &str = "floti-test-crash-after-session";

/// Aborts this process as [`TEST_CRASH_AFTER_SESSION_MARKER`] in `data`
/// asks, in a test build; nothing otherwise.
#[cfg(any(test, feature = "testkit"))]
pub fn crash_after_session_if_asked(data: &Path) {
    /// A panic here cannot unwind out of a function that may not unwind, so
    /// the process aborts: the way a panic in a host built to abort ends it.
    extern "C" fn panic_and_abort() {
        panic!("the test asked this host to panic with sessions running");
    }
    match fs::read_to_string(data.join(TEST_CRASH_AFTER_SESSION_MARKER))
        .ok()
        .as_deref()
        .map(str::trim)
    {
        None => {}
        Some("panic") => panic_and_abort(),
        Some(_) => std::alloc::handle_alloc_error(
            std::alloc::Layout::from_size_align(1 << 40, 8).expect("a valid layout"),
        ),
    }
}

/// The log of the host running in this process, once [`install`] opened it.
static INSTALLED: OnceLock<HostLog> = OnceLock::new();

/// How large the log of the host over the data folder `data` may grow:
/// [`LOG_LIMIT`], or in a test build what [`TEST_LOG_LIMIT_MARKER`] there
/// says.
pub fn log_limit(data: &Path) -> u64 {
    #[cfg(any(test, feature = "testkit"))]
    if let Some(limit) = fs::read_to_string(data.join(TEST_LOG_LIMIT_MARKER))
        .ok()
        .and_then(|text| text.trim().parse().ok())
    {
        return limit;
    }
    let _ = data;
    LOG_LIMIT
}

/// Opens the log in `folder` for the host running in this process, points
/// standard error at it through `target`, and keeps it for the life of the
/// process. A second call answers the log the first one opened.
pub fn install(
    folder: &Path,
    limit: u64,
    target: impl StandardError + Send + Sync + 'static,
) -> Result<&'static HostLog> {
    if let Some(log) = INSTALLED.get() {
        return Ok(log);
    }
    let log = HostLog::open(folder, limit, target)?;
    Ok(INSTALLED.get_or_init(|| log))
}

/// Called after every line the host writes ([`log_line!`](crate::log_line)):
/// rotates the log when that line took it past its limit. Nothing where no
/// log was installed, as in a test process.
pub fn wrote() {
    if let Some(log) = INSTALLED.get()
        && let Err(err) = log.rotate_if_full()
    {
        // Said once: a log that failed to rotate is not tried again.
        eprintln!("floti host: the log was not rotated: {err}");
    }
}

/// The line that opens each run's part of the log: the host's version, its
/// process and when it started, in UTC.
pub fn start_line(started: Timestamp) -> String {
    format!(
        "floti host {} started at {started}, process {}",
        crate::version::FLOTI_VERSION,
        std::process::id()
    )
}

/// Makes every panic say when it happened before the standard library's own
/// message, both on standard error, which in `floti host` is the log.
pub fn note_panics() {
    let report = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Not through `log_line!`: a panic may come from inside the log.
        eprintln!("floti host: panicked at {}", Timestamp::now());
        report(info);
    }));
}

/// Ends this process as [`TEST_CRASH_MARKER`] in `data` asks, in a test
/// build; nothing otherwise.
#[cfg(any(test, feature = "testkit"))]
pub fn crash_if_asked(data: &Path) {
    match fs::read_to_string(data.join(TEST_CRASH_MARKER))
        .ok()
        .as_deref()
        .map(str::trim)
    {
        Some("panic") => panic!("the test asked this host to panic"),
        Some("abort") => std::alloc::handle_alloc_error(
            std::alloc::Layout::from_size_align(1 << 40, 8).expect("a valid layout"),
        ),
        _ => {}
    }
}

/// The host's log file, which standard error points at.
pub struct HostLog {
    path: PathBuf,
    limit: u64,
    target: Box<dyn StandardError + Send + Sync>,
    /// Whether this host holds its data folder, and so is the only one that
    /// may rotate the log. Until then another host may be writing to it.
    owned: AtomicBool,
    open: Mutex<Open>,
}

/// The files the log has open.
struct Open {
    /// The file standard error points at.
    current: File,
    /// The one it pointed at before the last rotation, kept open until the
    /// next one: on Windows a write may have looked up its handle just
    /// before it changed.
    previous: Option<File>,
    /// A rotation failed. It is not tried again in this run, so the failure
    /// is said once rather than after every line.
    stuck: bool,
}

impl HostLog {
    /// Opens `host.log` in `folder` for appending, creating the folder and
    /// the file, owner-only, when they are new, and points standard error at
    /// it through `target`. Nothing is rotated until the host
    /// [`own`](Self::own)s it.
    pub fn open(
        folder: &Path,
        limit: u64,
        target: impl StandardError + Send + Sync + 'static,
    ) -> Result<Self> {
        fs::create_dir_all(folder)
            .map_err(|source| Error::path("create the logs folder", folder, source))?;
        let path = folder.join(LOG_FILE);
        let current = open_append(&path).map_err(|source| Error::path("open", &path, source))?;
        target
            .point_at(&current)
            .map_err(|source| Error::path("write standard error to", &path, source))?;
        Ok(Self {
            path,
            limit,
            target: Box::new(target),
            owned: AtomicBool::new(false),
            open: Mutex::new(Open {
                current,
                previous: None,
                stuck: false,
            }),
        })
    }

    /// The log file's path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Says the host holds its data folder, so no other host writes here:
    /// from now on the log rotates when full, starting with now. `Ok(true)`
    /// when it rotated.
    pub fn own(&self) -> Result<bool> {
        self.owned.store(true, Ordering::Release);
        self.rotate_if_full()
    }

    /// Rotates the log when it is past its limit and the host owns it.
    /// `Ok(true)` when it rotated. After a rotation that failed, it answers
    /// `Ok(false)` for the rest of the run.
    pub fn rotate_if_full(&self) -> Result<bool> {
        if !self.owned.load(Ordering::Acquire) {
            return Ok(false);
        }
        let mut open = self.open.lock().unwrap_or_else(PoisonError::into_inner);
        if open.stuck {
            return Ok(false);
        }
        let fail = |source: io::Error| Error::path("rotate", &self.path, source);
        let size = match open.current.metadata() {
            Ok(metadata) => metadata.len(),
            Err(source) => {
                open.stuck = true;
                return Err(fail(source));
            }
        };
        if size <= self.limit {
            return Ok(false);
        }
        match self.rotate(&mut open) {
            Ok(()) => Ok(true),
            Err(source) => {
                open.stuck = true;
                Err(fail(source))
            }
        }
    }

    /// Moves each kept log one number up, the oldest over the one past
    /// [`KEPT_LOGS`]'s, `host.log` to `host.log.1`, and points standard
    /// error at a new `host.log`.
    fn rotate(&self, open: &mut Open) -> io::Result<()> {
        for n in (1..KEPT_LOGS).rev() {
            if let Err(err) = fs::rename(self.numbered(n), self.numbered(n + 1))
                && err.kind() != io::ErrorKind::NotFound
            {
                return Err(err);
            }
        }
        fs::rename(&self.path, self.numbered(1))?;
        let fresh = open_append(&self.path)?;
        self.target.point_at(&fresh)?;
        open.previous = Some(std::mem::replace(&mut open.current, fresh));
        Ok(())
    }

    /// `host.log.<n>`.
    fn numbered(&self, n: u32) -> PathBuf {
        let mut name = OsString::from(self.path.as_os_str());
        name.push(format!(".{n}"));
        PathBuf::from(name)
    }
}

/// `path` open for appending, made owner-only when it is new.
fn open_append(path: &Path) -> io::Result<File> {
    match NativeFiles.create_new(path) {
        Ok(made) => drop(made),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
        Err(err) => return Err(err),
    }
    OpenOptions::new().append(true).open(path)
}
