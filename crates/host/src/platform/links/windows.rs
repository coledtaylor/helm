//! Folder links on Windows: directory junctions, which need no elevation and
//! no developer mode, as today's app makes them.

use std::io;
use std::path::Path;

use super::FolderLinks;
use crate::{Error, Result};

/// The Windows implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl FolderLinks for Native {
    fn link_folder(&self, target: &Path, link: &Path) -> Result<()> {
        junction::create(target, link)
            .map_err(|source| Error::path("link a folder at", link, source))
    }

    /// `RemoveDirectory` on a junction removes the junction, not the folder
    /// behind it.
    fn unlink_folder(&self, link: &Path) -> io::Result<()> {
        std::fs::remove_dir(link)
    }
}
