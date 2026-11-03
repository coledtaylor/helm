//! The size of the terminal this process writes to.
//!
//! Only the fake agent asks, to say what size its pty has, so a test can see
//! that a resize reached a program's terminal; nothing Floti ships reads it.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(unix)]
mod unix;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::Native;
#[cfg(target_os = "macos")]
pub use macos::Native;
#[cfg(target_os = "windows")]
pub use windows::Native;

use std::io;

/// The OS's way to read the size of the terminal standard output is.
pub trait TerminalSize {
    /// The columns and rows of the terminal standard output is; an error
    /// when standard output is no terminal.
    fn of_standard_output(&self) -> io::Result<(u16, u16)>;
}
