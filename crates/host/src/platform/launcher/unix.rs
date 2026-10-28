//! Starting a program on macOS and Linux: as it is. A script with a shebang
//! runs through its interpreter without anyone quoting anything.

use std::ffi::{OsStr, OsString};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::{Program, ProgramLauncher, as_given};

/// The implementation macOS and Linux share.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl ProgramLauncher for Native {
    fn resolve(&self, program: &OsStr, args: &[OsString]) -> Program {
        as_given(program, args)
    }

    /// As `execvp` looks: as given for a name with a slash in it, otherwise
    /// in each `PATH` folder, for a file with an execute bit set.
    fn find(&self, program: &OsStr) -> Option<PathBuf> {
        let named = Path::new(program);
        if named.components().count() > 1 || named.is_absolute() {
            return runnable(named).then(|| named.to_path_buf());
        }
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .filter(|dir| !dir.as_os_str().is_empty())
            .map(|dir| dir.join(named))
            .find(|candidate| runnable(candidate))
    }
}

/// A file, following links, with an execute bit set.
fn runnable(path: &Path) -> bool {
    std::fs::metadata(path)
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}
