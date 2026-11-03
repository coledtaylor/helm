//! Standard error on macOS and Linux: file descriptor 2, made a copy of the
//! file's own with `dup2`, which closes whatever it was before in the same
//! step, so no write ever finds it closed.

use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;

use super::StandardError;

/// The macOS and Linux implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl StandardError for Native {
    fn point_at(&self, file: &File) -> io::Result<()> {
        loop {
            // SAFETY: both are open file descriptors: `file`'s for as long as
            // it is borrowed, and standard error's, which `dup2` replaces.
            if unsafe { libc::dup2(file.as_raw_fd(), libc::STDERR_FILENO) } != -1 {
                return Ok(());
            }
            let err = io::Error::last_os_error();
            if err.kind() != io::ErrorKind::Interrupted {
                return Err(err);
            }
        }
    }
}
