//! Floti's folders on Linux: data in `$XDG_DATA_HOME/floti`, logs in
//! `$XDG_STATE_HOME/floti` (default `~/.local/state/floti`), the socket in
//! `$XDG_RUNTIME_DIR/floti`, the user's own files in `~/.config/floti`.

use super::{FolderLayout, Folders, UserEnv, config_folder};
use crate::Result;

/// The Linux layout.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl FolderLayout for Native {
    fn resolve(&self, env: &UserEnv) -> Result<Folders> {
        let home = env.require_home()?;
        let data = env
            .absolute_var("XDG_DATA_HOME")
            .unwrap_or_else(|| home.join(".local").join("share"))
            .join("floti");
        let logs = env
            .absolute_var("XDG_STATE_HOME")
            .unwrap_or_else(|| home.join(".local").join("state"))
            .join("floti");
        // systemd sets `$XDG_RUNTIME_DIR` for every user session, lingering
        // ones included. Without it the socket goes in the data folder.
        let runtime = env
            .absolute_var("XDG_RUNTIME_DIR")
            .map(|dir| dir.join("floti"))
            .unwrap_or_else(|| data.join("run"));
        Ok(Folders {
            data,
            logs,
            config: config_folder(home),
            runtime,
        })
    }
}
