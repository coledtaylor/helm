//! macOS: a shell is installed on `PATH`, so there is nowhere else to look.

use std::path::PathBuf;

use super::ShellFolders;
use crate::platform::folders::UserEnv;

/// The macOS folders: none.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl ShellFolders for Native {
    fn folders(&self, _env: &UserEnv) -> Vec<PathBuf> {
        Vec::new()
    }
}
