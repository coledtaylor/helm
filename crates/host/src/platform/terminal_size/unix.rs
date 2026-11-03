//! The terminal's size on macOS and Linux: the window size the pty keeps,
//! read with `TIOCGWINSZ` on standard output.

use std::io;

use super::TerminalSize;

/// The macOS and Linux implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl TerminalSize for Native {
    fn of_standard_output(&self) -> io::Result<(u16, u16)> {
        let mut size = libc::winsize {
            ws_row: 0,
            ws_col: 0,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: `size` is a `winsize` the call writes into, alive for it.
        if unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut size) } == -1 {
            return Err(io::Error::last_os_error());
        }
        Ok((size.ws_col, size.ws_row))
    }
}
