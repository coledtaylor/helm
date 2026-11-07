//! The user's shell running one command line, as if they had typed it there.
//!
//! A command child (`floti agent run`) is a plain command on the user's own
//! shell: PowerShell on Windows (`pwsh.exe` where it is found, else
//! `powershell.exe`), the login shell on macOS and Linux (`$SHELL`, else
//! `/bin/sh`). What differs is which shell, how it is told to run a line and
//! quote the words of one, and how its exit code comes out, so each OS is a
//! file here. Each is plain arithmetic over the user's environment and the
//! shells found, so all three are compiled and tested on every OS; the build
//! picks one as [`Native`].

pub mod linux;
pub mod macos;
mod posix;
pub mod windows;

#[cfg(target_os = "linux")]
pub use linux::Native;
#[cfg(target_os = "macos")]
pub use macos::Native;
#[cfg(target_os = "windows")]
pub use windows::Native;

use std::ffi::OsString;
use std::path::PathBuf;

use super::folders::UserEnv;

#[cfg(test)]
mod tests;

/// A shell and the arguments that make it run one line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellCommand {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

/// Where a shell is looked for by file name, such as `pwsh.exe`: its path
/// where it is installed.
pub type FindShell<'a> = &'a dyn Fn(&str) -> Option<PathBuf>;

/// One OS's way to run a command line in the user's shell.
pub trait CommandShell {
    /// The shell for the user `env` describes, found through `find`, and its
    /// arguments to run `line` and exit with the line's own exit code.
    fn run_line(&self, env: &UserEnv, find: FindShell<'_>, line: &str) -> ShellCommand;

    /// `words` (a program and its arguments) as the one line this OS's shell
    /// reads back as exactly those words.
    fn command_line(&self, words: &[String]) -> String;
}
