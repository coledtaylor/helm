//! Linux has no WSL of its own to start distros with, and is what runs
//! inside one: a process is in a distro when WSL set `WSL_DISTRO_NAME` for
//! it or registered its interop file.

use std::path::Path;

use super::{DISTRO_NAME_VAR, INTEROP_FILE, WslProgram, WslSide};
use crate::platform::folders::UserEnv;

#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl WslSide for Native {
    fn program(&self, _env: &UserEnv) -> Option<WslProgram> {
        None
    }

    fn inside(&self, env: &UserEnv) -> bool {
        inside_with(env, Path::new(INTEROP_FILE))
    }
}

/// Whether `env` is a process's inside a distro, with `interop` as the
/// interop file to look for.
pub fn inside_with(env: &UserEnv, interop: &Path) -> bool {
    env.var(DISTRO_NAME_VAR)
        .is_some_and(|name| !name.is_empty())
        || interop.exists()
}
