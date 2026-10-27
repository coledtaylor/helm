//! Running an agent's program as the OS needs it run.
//!
//! On Windows an agent CLI is often installed as a batch file (`claude.cmd`,
//! which npm and scoop write), and a batch file only runs through `cmd.exe`,
//! which parses its command line under rules of its own. The Windows
//! implementation finds the program on `PATH` and, for a batch file, runs
//! `cmd.exe` with the line it should read handed over in a variable
//! ([`batch`]), so no argument is ever re-parsed by a shell. On macOS and
//! Linux a program runs as it is.

pub mod batch;
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

use std::ffi::{OsStr, OsString};

/// A program ready to start: what to run, its arguments, and variables it
/// needs on top of the session's environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Program {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
}

/// The OS's way to start a program by name with an argument list.
pub trait ProgramLauncher {
    /// What to start for `program` with `args`, each argument reaching the
    /// program as one argument, unchanged.
    fn resolve(&self, program: &OsStr, args: &[OsString]) -> Program;
}

/// `program` with `args`, unchanged.
pub(crate) fn as_given(program: &OsStr, args: &[OsString]) -> Program {
    Program {
        program: program.to_owned(),
        args: args.to_vec(),
        env: Vec::new(),
    }
}
