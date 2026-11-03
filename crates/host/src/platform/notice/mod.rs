//! Showing a notification on the host's computer: what the host raises when
//! a device attaches to it from another computer.
//!
//! The way it is shown is the OS's: one file per OS, each defining `Native`.
//! Windows shows a balloon from the notification area, which Windows 10 and
//! 11 show as a toast; macOS runs `osascript`'s `display notification`; Linux
//! runs `notify-send` in a desktop session. The texts are passed as
//! arguments, never written into a script or markup, so a device's name is
//! shown as the plain text it is. A computer that gives the host no way to
//! show one (no desktop session, no `notify-send`) answers
//! [`Error::Unsupported`](crate::Error::Unsupported), and the host carries
//! on without it.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::Native;
#[cfg(target_os = "macos")]
pub use macos::Native;
#[cfg(target_os = "windows")]
pub use windows::Native;

use crate::Result;

/// A notification: a title, which carries the device's name, and a line of
/// the host's own text under it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Notice {
    pub title: String,
    pub body: String,
}

/// The OS's way of showing a notification on this computer.
pub trait ShowNotice: Send + Sync {
    /// Shows `notice`, returning once the OS has taken it. Blocks the
    /// calling thread while it does: call it off the async runtime's.
    fn show(&self, notice: &Notice) -> Result<()>;
}
