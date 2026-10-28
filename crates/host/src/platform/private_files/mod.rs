//! Files only the current user can read and write: where Floti keeps its own
//! secrets, the host key and the device registry on the host, and a client's
//! device key and the host key it pinned.
//!
//! On macOS and Linux a file is `0600`, set when it is created and never left
//! to the umask. On Windows it carries a protected access list with one
//! entry, full access for the user Floti runs as, the same list the local
//! pipe has: no entry for administrators, SYSTEM or anyone else, and nothing
//! inherited from the folder.
//!
//! A write replaces the file atomically. The bytes go into a new file in the
//! same folder, owner-only from the moment it exists, which is then renamed
//! over the old one: a reader sees the old file or the new one, never part of
//! either, and the file is never readable by anyone else, not even for an
//! instant. A write killed partway can leave its new file behind;
//! [`sweep_stale_temps`] removes those once the process that made them is
//! gone. A file that must be made once and never replaced, such as a key,
//! is made with [`PrivateFiles::write_new`], which refuses a name already
//! taken.

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
pub use linux::Native;
#[cfg(target_os = "macos")]
pub use macos::Native;
#[cfg(target_os = "windows")]
pub use windows::Native;

use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use floti_protocol::Knowable;

use crate::platform::process_tree::ProcessTree;
use crate::{Error, Result};

/// How many names a write tries for its new file before giving up: a name is
/// taken only by a file a write killed partway through left behind.
const TEMP_ATTEMPTS: u32 = 16;

/// Numbers each write's new file, so two writes in one process never pick
/// the same name.
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// The OS's way to keep a file to the current user.
pub trait PrivateFiles {
    /// Creates `path`, which must not exist, open for writing and readable
    /// and writable by the current user alone from the moment it exists.
    /// Fails with [`io::ErrorKind::AlreadyExists`] when something is there.
    fn create_new(&self, path: &Path) -> io::Result<File>;

    /// Makes a rename inside `folder` durable, where the OS needs telling.
    fn sync_folder(&self, folder: &Path) -> io::Result<()>;

    /// Whether the file at `path` can be opened by the current user alone,
    /// as [`write`](Self::write) leaves it.
    fn owner_only(&self, path: &Path) -> Result<bool>;

    /// Replaces the file at `path` with `bytes`, atomically, owner-only. The
    /// folder must exist.
    fn write(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        let fail = |source: io::Error| Error::path("write", path, source);
        let (folder, temp) = write_temp(self, path, bytes).map_err(fail)?;
        if let Err(source) = fs::rename(&temp, path) {
            // Best effort: the new file holds nothing anyone else can read.
            let _ = fs::remove_file(&temp);
            return Err(fail(source));
        }
        self.sync_folder(folder).map_err(fail)
    }

    /// Writes `bytes` to `path` only when nothing is there yet: `Ok(true)`
    /// when this call made the file, `Ok(false)`, with the file left as it
    /// is, when something already was. Of two writes racing for one name,
    /// in this process or another, exactly one makes it, and the file is
    /// whole and owner-only from the moment it has the name.
    ///
    /// The bytes go into a new file first, which is then given the name as a
    /// hard link, the one step that both refuses a name already taken and
    /// never shows part of a file. The folder must exist.
    fn write_new(&self, path: &Path, bytes: &[u8]) -> Result<bool> {
        let fail = |source: io::Error| Error::path("write", path, source);
        let (folder, temp) = write_temp(self, path, bytes).map_err(fail)?;
        let linked = fs::hard_link(&temp, path);
        // The temp name goes whatever happened: the file lives on under
        // `path` when it was linked, and is not wanted when it was not.
        let _ = fs::remove_file(&temp);
        match linked {
            Ok(()) => self.sync_folder(folder).map(|()| true).map_err(fail),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => Ok(false),
            Err(source) => Err(fail(source)),
        }
    }

    /// The bytes of the file at `path`, or `None` when there is no file
    /// there. Any other failure is an error.
    fn read(&self, path: &Path) -> Result<Option<Vec<u8>>> {
        match fs::read(path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(source) => Err(Error::path("read", path, source)),
        }
    }
}

/// Removes the new files that writes to `names` in `folder` left behind
/// when they were killed partway, and answers what it removed. A file is
/// removed only when the process named in it is provably gone: one the OS
/// will not answer about counts as running, and a name that does not parse
/// is not one of these files. Nothing anyone else can read is ever in them;
/// this keeps a folder holding only what it should.
pub fn sweep_stale_temps(folder: &Path, names: &[&str], tree: &dyn ProcessTree) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut removed = Vec::new();
    for entry in entries.flatten() {
        let file_name = entry.file_name();
        let Some(pid) = names
            .iter()
            .find_map(|name| temp_owner(&file_name, OsStr::new(name)))
        else {
            continue;
        };
        let is_file = entry.file_type().is_ok_and(|kind| kind.is_file());
        if is_file
            && pid != std::process::id()
            && tree.is_alive(pid) == Knowable::Known(false)
            && fs::remove_file(entry.path()).is_ok()
        {
            removed.push(entry.path());
        }
    }
    removed
}

/// The process that made `file_name`, when it is a new file a write to
/// `name` makes (`.<name>.<pid>-<n>.tmp`).
fn temp_owner(file_name: &OsStr, name: &OsStr) -> Option<u32> {
    let file_name = file_name.to_str()?;
    let rest = file_name
        .strip_prefix('.')?
        .strip_prefix(name.to_str()?)?
        .strip_prefix('.')?
        .strip_suffix(".tmp")?;
    let (pid, n) = rest.split_once('-')?;
    n.parse::<u64>().ok()?;
    pid.parse().ok()
}

/// Writes `bytes` to a new owner-only file beside `path`, synced and closed,
/// and answers the folder and the new file's path. Removes the new file
/// again when the write fails.
fn write_temp<'p, F: PrivateFiles + ?Sized>(
    files: &F,
    path: &'p Path,
    bytes: &[u8],
) -> io::Result<(&'p Path, PathBuf)> {
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "the path names no file"))?;
    let folder = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let (temp, mut file) = create_temp(files, folder, name)?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    // Closed before the rename or link: Windows renames no file that is open
    // without delete sharing.
    drop(file);
    if let Err(err) = written {
        let _ = fs::remove_file(&temp);
        return Err(err);
    }
    Ok((folder, temp))
}

/// A new owner-only file in `folder` for a write to `name`, and its path:
/// hidden by its leading dot, and named for this process and this write.
fn create_temp<F: PrivateFiles + ?Sized>(
    files: &F,
    folder: &Path,
    name: &OsStr,
) -> io::Result<(PathBuf, File)> {
    let mut last = None;
    for _ in 0..TEMP_ATTEMPTS {
        let mut temp = OsString::from(".");
        temp.push(name);
        temp.push(format!(
            ".{}-{}.tmp",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let temp = folder.join(temp);
        match files.create_new(&temp) {
            Ok(file) => return Ok((temp, file)),
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => last = Some(err),
            Err(err) => return Err(err),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::from(io::ErrorKind::AlreadyExists)))
}
