//! The terminal's size on Windows: the visible window of the console screen
//! buffer standard output is, which a pseudo console's resize sets.

use std::io;

use windows_sys::Win32::System::Console::{
    CONSOLE_SCREEN_BUFFER_INFO, GetConsoleScreenBufferInfo, GetStdHandle, STD_OUTPUT_HANDLE,
};

use super::TerminalSize;

/// The Windows implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl TerminalSize for Native {
    fn of_standard_output(&self) -> io::Result<(u16, u16)> {
        // SAFETY: a plain query of this process's standard output handle.
        let output = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
        // SAFETY: an all-zero `CONSOLE_SCREEN_BUFFER_INFO` is a valid value
        // of the plain struct the call writes into.
        let mut info: CONSOLE_SCREEN_BUFFER_INFO = unsafe { std::mem::zeroed() };
        // SAFETY: `info` is alive for the call, which only writes into it.
        if unsafe { GetConsoleScreenBufferInfo(output, &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let window = info.srWindow;
        let cols = u16::try_from(window.Right - window.Left + 1).map_err(io::Error::other)?;
        let rows = u16::try_from(window.Bottom - window.Top + 1).map_err(io::Error::other)?;
        Ok((cols, rows))
    }
}
