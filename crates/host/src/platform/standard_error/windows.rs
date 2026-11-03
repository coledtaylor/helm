//! Standard error on Windows: the process's standard error handle, set with
//! `SetStdHandle`. The standard library looks the handle up at every write,
//! so its own lines, a panic's message and a failed allocation's line all go
//! to the file from then on.

use std::fs::File;
use std::io;
use std::os::windows::io::AsRawHandle;

use windows_sys::Win32::System::Console::{STD_ERROR_HANDLE, SetStdHandle};

use super::StandardError;

/// The Windows implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl StandardError for Native {
    fn point_at(&self, file: &File) -> io::Result<()> {
        // SAFETY: the handle is `file`'s, open while it is borrowed; the
        // caller keeps it open for as long as standard error is it.
        if unsafe { SetStdHandle(STD_ERROR_HANDLE, file.as_raw_handle()) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}
