//! macOS has no WSL, and never runs inside a distro.

use super::{WslProgram, WslSide};
use crate::platform::folders::UserEnv;

#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl WslSide for Native {
    fn program(&self, _env: &UserEnv) -> Option<WslProgram> {
        None
    }

    fn inside(&self, _env: &UserEnv) -> bool {
        false
    }
}
