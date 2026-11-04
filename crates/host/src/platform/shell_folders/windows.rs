//! Windows: the app execution aliases of apps installed from the Microsoft
//! Store, `%LOCALAPPDATA%\Microsoft\WindowsApps`.

use std::path::PathBuf;

use super::ShellFolders;
use crate::platform::folders::UserEnv;

/// The Windows folders.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl ShellFolders for Native {
    fn folders(&self, env: &UserEnv) -> Vec<PathBuf> {
        env.var_any_case("LOCALAPPDATA")
            .map(PathBuf::from)
            .filter(|folder| folder.is_absolute())
            .map(|folder| folder.join("Microsoft").join("WindowsApps"))
            .into_iter()
            .collect()
    }
}
