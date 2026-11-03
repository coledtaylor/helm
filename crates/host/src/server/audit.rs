//! The host's audit log: `audit.log` in its data folder ([`AUDIT_FILE`]).
//!
//! It records who came and went and what was done to the host: each device
//! attaching and detaching, every connection refused, every request to pair
//! and what became of it, a first admin enrolling, role changes, revokes,
//! presence confirmed, and every admin action asked for, done or refused.
//! Reading it (`devices:audit`, `floti devices audit`) and listing devices
//! add no entry.
//!
//! An entry holds only the fixed fields `floti_protocol`'s [`AuditEntry`]
//! declares: never a key, a pairing or enrolment code, a request's contents,
//! a session's input or output, a prompt, a transcript, file, note or config
//! text, or a plugin secret. A device's name, as the device gave it, is its
//! one free text, with any control character taken out so it cannot move a
//! terminal's cursor or start a new line. The sentences saying why a
//! connection was refused or what an admin action does are the host's own.
//!
//! The file is owner-only from the moment it exists
//! ([`private_files`](crate::platform::private_files)), JSON Lines, one entry
//! a line, and only ever appended to: it is opened for appending and never
//! rewritten, and nothing the host serves edits or removes an entry. Entries
//! are numbered from 1, and the numbers carry on across restarts: a new
//! start reads the last entry's number back.
//!
//! It is bounded like the host's log: once past [`AUDIT_LIMIT`] it becomes
//! `audit.log.1`, the one before that `audit.log.2`, up to
//! [`KEPT_AUDIT_LOGS`] older files, and a new `audit.log` is begun. Reading
//! runs across them, newest first.
//!
//! It is not in `floti.db`: that database's migrations are shared with the
//! desktop's `helm.db` schema, and the audit log is the host's alone.
//!
//! Writing it never stops the host serving: an entry that cannot be written
//! is said once in the host's log, and the host carries on.

#[cfg(test)]
mod tests;

use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use floti_protocol::channels::devices::{
    AuditActor, AuditDevice, AuditEntry, AuditEvent, AuditPage, AuditQuery,
};
use jiff::Timestamp;

use crate::platform::private_files::{Native as NativeFiles, PrivateFiles};
use crate::{Error, Result};

/// The audit log's name in the host's data folder.
pub const AUDIT_FILE: &str = "audit.log";

/// How large the audit log may grow before it is rotated.
pub const AUDIT_LIMIT: u64 = 5 * 1024 * 1024;

/// How many rotated audit logs are kept beside `audit.log`: `audit.log.1`
/// (the most recent) to `audit.log.3`.
pub const KEPT_AUDIT_LOGS: u32 = 3;

/// How many entries a page holds when the asker names no limit.
pub const AUDIT_PAGE: u32 = 50;

/// The most entries a page holds, whatever the asker names.
pub const AUDIT_PAGE_MAX: u32 = 200;

/// The file in a data folder that gives a test build's audit log a limit of
/// its own, in bytes, so a test reaches a rotation without writing
/// megabytes. A production build never reads it.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_AUDIT_LIMIT_MARKER: &str = "floti-test-audit-limit";

/// How far back from a file's end the last entry is looked for at a time.
const TAIL_CHUNK: u64 = 16 * 1024;

/// The host's audit log.
pub(crate) struct AuditLog {
    path: PathBuf,
    limit: u64,
    open: Mutex<Option<Open>>,
    /// A write failed and was said in the host's log; later failures are not.
    said_failure: AtomicBool,
}

/// The file entries are appended to, and the next entry's number.
struct Open {
    file: File,
    next: u64,
}

impl AuditLog {
    /// The audit log of the host whose data folder is `data`, bounded by
    /// [`AUDIT_LIMIT`] (or, in a test build, what
    /// [`TEST_AUDIT_LIMIT_MARKER`] there says). Nothing is opened until the
    /// first entry is written or read.
    pub(crate) fn in_data_folder(data: &Path) -> Self {
        Self::with_limit(data, audit_limit(data))
    }

    /// The audit log in `data`, rotated past `limit` bytes.
    pub(crate) fn with_limit(data: &Path, limit: u64) -> Self {
        Self {
            path: data.join(AUDIT_FILE),
            limit,
            open: Mutex::new(None),
            said_failure: AtomicBool::new(false),
        }
    }

    fn open(&self) -> MutexGuard<'_, Option<Open>> {
        self.open.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Records `event` now. A failure to write it is said once in the
    /// host's log; the host carries on either way.
    pub(crate) fn record(&self, event: AuditEvent) {
        if let Err(err) = self.append(event, Timestamp::now())
            && !self.said_failure.swap(true, Ordering::AcqRel)
        {
            log_line!(
                "floti host: the audit log {} could not be written, and entries are missing from it: {err}",
                self.path.display()
            );
        }
    }

    /// Appends `event`, which happened `at`, as the next entry: its number.
    fn append(&self, event: AuditEvent, at: Timestamp) -> io::Result<u64> {
        let mut open = self.open();
        if open.is_none() {
            *open = Some(Open {
                next: self.last_number()? + 1,
                file: open_append(&self.path)?,
            });
        }
        let Some(current) = open.as_mut() else {
            unreachable!("opened just above");
        };
        let entry = AuditEntry {
            number: current.next,
            at: at.to_string(),
            event: cleaned(event),
        };
        let mut line = serde_json::to_vec(&entry).map_err(io::Error::other)?;
        line.push(b'\n');
        // One write of the whole line: appended at the file's end, never
        // over what is there.
        current.file.write_all(&line)?;
        current.next += 1;
        if current.file.metadata()?.len() > self.limit {
            self.rotate()?;
            current.file = open_append(&self.path)?;
        }
        Ok(entry.number)
    }

    /// Moves each kept file one number up, the oldest over the one past
    /// [`KEPT_AUDIT_LOGS`]'s, and `audit.log` to `audit.log.1`.
    fn rotate(&self) -> io::Result<()> {
        for n in (1..KEPT_AUDIT_LOGS).rev() {
            if let Err(err) = std::fs::rename(self.numbered(n), self.numbered(n + 1))
                && err.kind() != io::ErrorKind::NotFound
            {
                return Err(err);
            }
        }
        std::fs::rename(&self.path, self.numbered(1))
    }

    /// `audit.log.<n>`, or `audit.log` itself for 0.
    fn numbered(&self, n: u32) -> PathBuf {
        if n == 0 {
            return self.path.clone();
        }
        let mut name = OsString::from(self.path.as_os_str());
        name.push(format!(".{n}"));
        PathBuf::from(name)
    }

    /// Every file of the log, newest first, whether or not it exists.
    fn files(&self) -> impl Iterator<Item = PathBuf> + '_ {
        (0..=KEPT_AUDIT_LOGS).map(|n| self.numbered(n))
    }

    /// The number of the last entry written, in this run or an earlier one;
    /// 0 before the first.
    fn last_number(&self) -> io::Result<u64> {
        for path in self.files() {
            if let Some(number) = last_entry_number(&path)? {
                return Ok(number);
            }
        }
        Ok(0)
    }

    /// A page of entries, newest first: those numbered below `query.before`
    /// (all of them when it is absent), at most `query.limit` (50 when it is
    /// absent, never more than 200), and whether older ones remain.
    pub(crate) fn page(&self, query: &AuditQuery) -> Result<AuditPage> {
        let limit = query.limit.unwrap_or(AUDIT_PAGE).clamp(1, AUDIT_PAGE_MAX) as usize;
        // Held while reading, so a rotation does not move a file mid-read.
        let _open = self.open();
        let mut entries = Vec::with_capacity(limit + 1);
        for path in self.files() {
            let mut in_file = read_entries(&path)
                .map_err(|source| Error::path("read the audit log", &path, source))?;
            in_file.retain(|entry| query.before.is_none_or(|before| entry.number < before));
            in_file.reverse();
            entries.extend(in_file.into_iter().take(limit + 1 - entries.len()));
            if entries.len() > limit {
                break;
            }
        }
        let more = entries.len() > limit;
        entries.truncate(limit);
        Ok(AuditPage { entries, more })
    }
}

/// How large the audit log of the host over `data` may grow: [`AUDIT_LIMIT`],
/// or in a test build what [`TEST_AUDIT_LIMIT_MARKER`] there says.
fn audit_limit(data: &Path) -> u64 {
    #[cfg(any(test, feature = "testkit"))]
    if let Some(limit) = std::fs::read_to_string(data.join(TEST_AUDIT_LIMIT_MARKER))
        .ok()
        .and_then(|text| text.trim().parse().ok())
    {
        return limit;
    }
    let _ = data;
    AUDIT_LIMIT
}

/// `path` open for appending only, made owner-only when it is new. A file
/// whose last line a crash cut short is given the line's end first, so the
/// next entry begins a line of its own.
fn open_append(path: &Path) -> io::Result<File> {
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)?;
    }
    match NativeFiles.create_new(path) {
        Ok(made) => drop(made),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {}
        Err(err) => return Err(err),
    }
    let mut file = OpenOptions::new().read(true).append(true).open(path)?;
    let len = file.metadata()?.len();
    if len > 0 {
        let mut last = [0u8; 1];
        file.seek(SeekFrom::Start(len - 1))?;
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            file.write_all(b"\n")?;
        }
    }
    Ok(file)
}

/// Every entry in the file at `path`, oldest first; none when there is no
/// file. A line that is not a whole entry (one a crash cut short) is
/// skipped.
fn read_entries(path: &Path) -> io::Result<Vec<AuditEntry>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut entries = Vec::new();
    for line in BufReader::new(file).split(b'\n') {
        if let Ok(entry) = serde_json::from_slice::<AuditEntry>(&line?) {
            entries.push(entry);
        }
    }
    Ok(entries)
}

/// The number of the last whole entry in the file at `path`, read from its
/// end; `None` when it has none or there is no file.
fn last_entry_number(path: &Path) -> io::Result<Option<u64>> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    let mut end = file.metadata()?.len();
    // What is read so far from the end, and how much of its front is a part
    // of a line whose start is not read yet.
    let mut tail: Vec<u8> = Vec::new();
    while end > 0 {
        let start = end.saturating_sub(TAIL_CHUNK);
        let mut chunk = vec![0; usize::try_from(end - start).map_err(io::Error::other)?];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut chunk)?;
        chunk.extend_from_slice(&tail);
        tail = chunk;
        // Whole lines are those after the first newline, or every line once
        // the file's start is reached.
        let whole_from = if start == 0 {
            0
        } else {
            match tail.iter().position(|&b| b == b'\n') {
                Some(at) => at + 1,
                None => {
                    end = start;
                    continue;
                }
            }
        };
        for line in tail[whole_from..].rsplit(|&b| b == b'\n') {
            if let Ok(entry) = serde_json::from_slice::<AuditEntry>(line) {
                return Ok(Some(entry.number));
            }
        }
        // Only a part line remains unread past here: keep it for the next
        // chunk, which holds its start.
        tail.truncate(whole_from);
        end = start;
    }
    Ok(None)
}

/// `event` with every text it carries free of control characters: a
/// device's name, as the device gave it, is the one free text an entry
/// holds, and it may not move a terminal's cursor or begin a new line.
fn cleaned(event: AuditEvent) -> AuditEvent {
    match event {
        AuditEvent::Connected { device, away } => AuditEvent::Connected {
            device: clean_device(device),
            away,
        },
        AuditEvent::Disconnected { device, away } => AuditEvent::Disconnected {
            device: clean_device(device),
            away,
        },
        AuditEvent::Refused {
            reason,
            fingerprint,
            away,
        } => AuditEvent::Refused {
            reason: clean(&reason),
            fingerprint: fingerprint.as_deref().map(clean),
            away,
        },
        AuditEvent::PairingAsked { device, away } => AuditEvent::PairingAsked {
            device: clean_device(device),
            away,
        },
        AuditEvent::PairingApproved { device, by, away } => AuditEvent::PairingApproved {
            device: clean_device(device),
            by: clean_actor(by),
            away,
        },
        AuditEvent::PairingEnded { device, why } => AuditEvent::PairingEnded {
            device: clean_device(device),
            why,
        },
        AuditEvent::Enrolled { device } => AuditEvent::Enrolled {
            device: clean_device(device),
        },
        AuditEvent::RoleChanged {
            device,
            from,
            to,
            by,
            away,
        } => AuditEvent::RoleChanged {
            device: clean_device(device),
            from,
            to,
            by: clean_actor(by),
            away,
        },
        AuditEvent::Revoked { device, by, away } => AuditEvent::Revoked {
            device: clean_device(device),
            by: clean_actor(by),
            away,
        },
        AuditEvent::PresenceConfirmed { device, away } => AuditEvent::PresenceConfirmed {
            device: clean_device(device),
            away,
        },
        AuditEvent::AdminAction {
            channel,
            doing,
            by,
            away,
            outcome,
        } => AuditEvent::AdminAction {
            channel: clean(&channel),
            doing: clean(&doing),
            by: clean_actor(by),
            away,
            outcome,
        },
    }
}

fn clean_device(device: AuditDevice) -> AuditDevice {
    AuditDevice {
        fingerprint: clean(&device.fingerprint),
        name: device.name.as_deref().map(clean),
        role: device.role,
    }
}

fn clean_actor(actor: AuditActor) -> AuditActor {
    match actor {
        AuditActor::Device { fingerprint, name } => AuditActor::Device {
            fingerprint: clean(&fingerprint),
            name: clean(&name),
        },
        AuditActor::HostShell => AuditActor::HostShell,
    }
}

/// `text` without its control characters.
pub(crate) fn clean(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).collect()
}
