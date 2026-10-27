//! Folder links: an overlay's skills, commands and agents are links into the
//! harness's real folders, so editing a skill in its repository changes what
//! the next session loads, with nothing copied to drift.
//!
//! A junction on Windows, which any user may make where a symlink needs
//! elevation or developer mode; a symlink on macOS and Linux.
//!
//! Removing a tree that holds links goes through [`remove_tree`], which
//! removes each link itself and never walks into one: a link points into a
//! real repository, and a removal that followed it would delete the user's
//! files.

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

use std::io;
use std::path::Path;

use crate::{Error, Result};

/// The OS's way to link one folder to another.
pub trait FolderLinks {
    /// Makes `link`, which must not exist, a link to the folder `target`.
    fn link_folder(&self, target: &Path, link: &Path) -> Result<()>;

    /// Removes the link at `link`, leaving what it points to untouched.
    fn unlink_folder(&self, link: &Path) -> io::Result<()>;
}

/// Whether `path` is a link of any kind (a symlink, or a junction on
/// Windows), judged without following it.
pub fn is_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

/// Removes `root` and everything in it, unlinking every link it meets and
/// never walking into one. A tree that is not there is already removed.
///
/// Refuses, leaving the rest in place, when a link cannot be unlinked: a
/// folder left behind is a stale folder, and a repository emptied through a
/// link is not recoverable.
pub fn remove_tree(links: &dyn FolderLinks, root: &Path) -> Result<()> {
    let meta = match std::fs::symlink_metadata(root) {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(source) => return Err(Error::path("look at", root, source)),
    };
    if meta.file_type().is_symlink() {
        return unlink(links, root);
    }
    if !meta.is_dir() {
        return std::fs::remove_file(root).map_err(|source| Error::path("remove", root, source));
    }
    let entries = std::fs::read_dir(root).map_err(|source| Error::path("list", root, source))?;
    for entry in entries {
        let entry = entry.map_err(|source| Error::path("list", root, source))?;
        remove_tree(links, &entry.path())?;
    }
    std::fs::remove_dir(root).map_err(|source| Error::path("remove", root, source))
}

/// Unlinks one link, whichever kind it is: a folder link goes the OS's way,
/// and a link to a file is removed as a file.
fn unlink(links: &dyn FolderLinks, link: &Path) -> Result<()> {
    if links.unlink_folder(link).is_ok() || std::fs::remove_file(link).is_ok() {
        return Ok(());
    }
    Err(Error::Refused(format!(
        "Floti left {} in place: it is a link that could not be removed, and removing the folder around it could reach the folder it points to.",
        link.display()
    )))
}
