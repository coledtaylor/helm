//! Starting a program on macOS and Linux: as it is. A script with a shebang
//! runs through its interpreter without anyone quoting anything.

use std::ffi::{OsStr, OsString};

use super::{Program, ProgramLauncher, as_given};

/// The implementation macOS and Linux share.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl ProgramLauncher for Native {
    fn resolve(&self, program: &OsStr, args: &[OsString]) -> Program {
        as_given(program, args)
    }
}
