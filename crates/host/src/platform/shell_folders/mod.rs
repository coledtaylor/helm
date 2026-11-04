//! Folders a shell may be installed in that `PATH` can leave out.
//!
//! On Windows, a PowerShell 7 installed from the Microsoft Store runs through
//! an app execution alias in `%LOCALAPPDATA%\Microsoft\WindowsApps`, and that
//! folder is on the user's `PATH` only as long as nothing has rewritten it.
//! macOS and Linux have no such folder: what is installed is on `PATH`.
//!
//! Each OS's folders are plain path arithmetic over a [`UserEnv`], so all
//! three are compiled and tested on every OS; the build picks one as
//! [`Native`].

pub mod linux;
pub mod macos;
pub mod windows;

#[cfg(target_os = "linux")]
pub use linux::Native;
#[cfg(target_os = "macos")]
pub use macos::Native;
#[cfg(target_os = "windows")]
pub use windows::Native;

use std::path::PathBuf;

use super::folders::UserEnv;

#[cfg(test)]
mod tests;

/// The OS's folders to look for a shell in after `PATH`.
pub trait ShellFolders {
    /// The folders for the user `env` describes, in the order to look. None
    /// of them need exist.
    fn folders(&self, env: &UserEnv) -> Vec<PathBuf>;
}
