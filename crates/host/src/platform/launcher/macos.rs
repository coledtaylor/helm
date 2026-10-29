//! Starting a program on macOS: the implementation it shares with Linux,
//! with Homebrew's folders among the user's program folders. An app or agent
//! started by launchd gets launchd's `PATH`, which has neither.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use super::{Program, ProgramLauncher, unix};

/// The macOS implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl ProgramLauncher for Native {
    fn resolve(&self, program: &OsStr, args: &[OsString]) -> Program {
        unix::Native.resolve(program, args)
    }

    fn find(&self, program: &OsStr) -> Option<PathBuf> {
        unix::Native.find(program)
    }

    /// `~/.local/bin`, then Homebrew's on Apple silicon, then on Intel.
    fn user_bin_folders(&self, home: &Path) -> Vec<PathBuf> {
        vec![
            home.join(".local").join("bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]
    }

    #[cfg(any(test, feature = "testkit"))]
    fn write_wrapper_script(&self, folder: &Path, name: &str, program: &Path) -> String {
        unix::Native.write_wrapper_script(folder, name, program)
    }
}
