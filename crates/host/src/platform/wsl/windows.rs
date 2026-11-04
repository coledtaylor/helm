//! Windows has WSL: `FLOTI_WSL`, else `wsl.exe` in `%SystemRoot%\System32`.
//! A Windows process never runs inside a distro.

use std::path::PathBuf;

use super::{WSL_VAR, WslProgram, WslSide};
use crate::platform::folders::UserEnv;

#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl WslSide for Native {
    fn program(&self, env: &UserEnv) -> Option<WslProgram> {
        if let Some(named) = env.absolute_var(WSL_VAR) {
            return Some(WslProgram::plain(named));
        }
        let root = env
            .var_any_case("SystemRoot")
            .map(PathBuf::from)
            .filter(|root| root.is_absolute())
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        Some(WslProgram::plain(root.join("System32").join("wsl.exe")))
    }

    fn inside(&self, _env: &UserEnv) -> bool {
        false
    }
}
