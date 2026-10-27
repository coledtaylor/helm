//! Folder links on macOS and Linux: symlinks, which any user may make.

use std::io;
use std::path::Path;

use super::FolderLinks;
use crate::{Error, Result};

/// The implementation macOS and Linux share.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl FolderLinks for Native {
    fn link_folder(&self, target: &Path, link: &Path) -> Result<()> {
        std::os::unix::fs::symlink(target, link)
            .map_err(|source| Error::path("link a folder at", link, source))
    }

    /// `unlink` on a symlink removes the link, whatever it points to.
    fn unlink_folder(&self, link: &Path) -> io::Result<()> {
        std::fs::remove_file(link)
    }
}
