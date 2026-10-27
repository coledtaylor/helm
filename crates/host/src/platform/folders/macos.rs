//! Floti's folders on macOS: data, logs and the socket under
//! `~/Library/Application Support/Floti`, the user's own files in
//! `~/.config/floti`.

use super::{FolderLayout, Folders, UserEnv, config_folder};
use crate::Result;

/// The macOS layout.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl FolderLayout for Native {
    fn resolve(&self, env: &UserEnv) -> Result<Folders> {
        let home = env.require_home()?;
        let data = home
            .join("Library")
            .join("Application Support")
            .join("Floti");
        Ok(Folders {
            logs: data.join("logs"),
            // Inside the user's own Library rather than `$TMPDIR`, which the
            // system cleans; the path stays well under a Unix socket's limit.
            runtime: data.join("run"),
            config: config_folder(home),
            data,
        })
    }
}
