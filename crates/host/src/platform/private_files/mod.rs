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
//! instant.

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
        let name = path.file_name().ok_or_else(|| {
            fail(io::Error::new(
                io::ErrorKind::InvalidInput,
                "the path names no file",
            ))
        })?;
        let folder = match path.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            _ => Path::new("."),
        };

        let (temp, mut file) = create_temp(self, folder, name).map_err(fail)?;
        let written = file.write_all(bytes).and_then(|()| file.sync_all());
        // Closed before the rename: Windows renames no file that is open
        // without delete sharing.
        drop(file);
        if let Err(source) = written.and_then(|()| fs::rename(&temp, path)) {
            // Best effort: the new file holds nothing anyone else can read.
            let _ = fs::remove_file(&temp);
            return Err(fail(source));
        }
        self.sync_folder(folder).map_err(fail)
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
