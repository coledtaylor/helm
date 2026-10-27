//! Floti's folders on Windows: data and logs under `%LOCALAPPDATA%\Floti`,
//! the user's own files in `~/.config/floti`.

use super::{FolderLayout, Folders, UserEnv, config_folder};
use crate::Result;

/// The Windows layout.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl FolderLayout for Native {
    fn resolve(&self, env: &UserEnv) -> Result<Folders> {
        let home = env.require_home()?;
        // `%LOCALAPPDATA%` is set in every interactive session; the profile's
        // own `AppData\Local` is where it points when it is not.
        let local = env
            .absolute_var("LOCALAPPDATA")
            .unwrap_or_else(|| home.join("AppData").join("Local"));
        let data = local.join("Floti");
        Ok(Folders {
            logs: data.join("logs"),
            // A named pipe has no folder; this one is kept for symmetry and
            // holds nothing.
            runtime: data.join("run"),
            config: config_folder(home),
            data,
        })
    }
}
