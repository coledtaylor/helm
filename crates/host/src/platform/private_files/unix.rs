//! Owner-only files on macOS and Linux: mode `0600`, owned by this user.
//!
//! The file is created with mode `0600`, which the umask can only narrow, and
//! then set to exactly `0600`, so it is never wider than the user's own at
//! any moment and never narrower once created.

use std::fs::{File, OpenOptions, Permissions};
use std::io;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;

use super::PrivateFiles;
use crate::{Error, Result};

/// The mode of an owner-only file.
pub(super) const FILE_MODE: u32 = 0o600;

/// The macOS and Linux implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl PrivateFiles for Native {
    fn create_new(&self, path: &Path) -> io::Result<File> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(FILE_MODE)
            .open(path)?;
        file.set_permissions(Permissions::from_mode(FILE_MODE))?;
        Ok(file)
    }

    /// A rename is an entry in the folder, made durable by syncing it.
    fn sync_folder(&self, folder: &Path) -> io::Result<()> {
        File::open(folder)?.sync_all()
    }

    fn owner_only(&self, path: &Path) -> Result<bool> {
        let metadata =
            std::fs::symlink_metadata(path).map_err(|e| Error::path("check", path, e))?;
        // SAFETY: geteuid has no preconditions and cannot fail.
        let me = unsafe { libc::geteuid() };
        Ok(metadata.is_file() && metadata.uid() == me && metadata.mode() & 0o077 == 0)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::testkit::TestDirs;

    fn mode(path: &Path) -> u32 {
        fs::symlink_metadata(path).unwrap().mode() & 0o777
    }

    #[test]
    fn a_written_file_is_0600_and_the_users() {
        let dirs = TestDirs::new();
        let path = dirs.folder("keys").join("host.key");
        Native.write(&path, b"secret").unwrap();

        assert_eq!(mode(&path), FILE_MODE);
        // SAFETY: geteuid has no preconditions and cannot fail.
        assert_eq!(fs::metadata(&path).unwrap().uid(), unsafe {
            libc::geteuid()
        });
        assert!(Native.owner_only(&path).unwrap());
    }

    #[test]
    fn a_replace_leaves_the_file_0600_whatever_the_old_one_was() {
        let dirs = TestDirs::new();
        let path = dirs.folder("keys").join("devices.json");
        Native.write(&path, b"one").unwrap();
        fs::set_permissions(&path, Permissions::from_mode(0o644)).unwrap();
        assert!(
            !Native.owner_only(&path).unwrap(),
            "the control: 0644 is not owner-only"
        );

        Native.write(&path, b"two").unwrap();
        assert_eq!(mode(&path), FILE_MODE);
        assert!(Native.owner_only(&path).unwrap());
        assert_eq!(fs::read(&path).unwrap(), b"two");
    }
}
