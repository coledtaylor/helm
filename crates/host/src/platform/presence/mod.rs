//! Asking the computer to confirm that its user is present: Windows Hello on
//! Windows, Touch ID or the account password on macOS. A host asks an admin
//! device on another computer for this before an admin action
//! (`devices:presence`); the device's own computer is what can tell.
//!
//! The check is the OS's: one file per OS, each defining `Native`. An OS with
//! no check Floti can ask (Linux today) answers [`Presence::Unavailable`],
//! and the user confirms the action another way: `floti devices` run over
//! ssh on the host, which no presence is asked of.

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

/// What the check said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Presence {
    /// The user confirmed it is them.
    Confirmed,
    /// The user cancelled the check, or did not pass it.
    Declined,
    /// This computer cannot check, saying why.
    Unavailable(String),
}

/// The OS's own check of the user at the computer.
pub trait PresenceCheck {
    /// Asks the user to confirm it is them, giving `reason`, over the window
    /// `window` (an `HWND` on Windows) when one is named, and waits for the
    /// answer.
    fn confirm(&self, window: Option<isize>, reason: &str) -> Presence;
}
