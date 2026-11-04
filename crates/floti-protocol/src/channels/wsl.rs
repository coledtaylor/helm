//! WSL distros on the host's computer: `wsl:keepAwake`, which keeps one
//! running while a host inside it has sessions.
//!
//! WSL stops a distro shortly after the last Windows process attached to it
//! through `wsl.exe` exits, and a process inside the distro does not keep it
//! running, so a host in a distro would lose its sessions when the last
//! window closed. The desktop's main process asks the Windows host on the
//! distro's PC to hold the distro whenever it sees a running session there,
//! and again after either connection comes back. It is sent only by main,
//! like `host:quit`, so it is not in `shared/ipc.ts`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::channel::Catalogue;

pub fn declare(catalogue: &mut Catalogue) {
    catalogue.request::<WslKeepAwake>();
}

request_channel! {
    /// Keeps `distro`, a WSL distro on the host's computer, running while
    /// the host inside it runs a session: the host holds one
    /// `wsl.exe -d <distro> -- <floti> keep-awake` open, which ends once no
    /// session runs there or that host stops. An ask for a distro already
    /// held starts nothing. Answered once the hold is started, or with the
    /// reason it cannot be: a host not on Windows has no WSL.
    WslKeepAwake = "wsl:keepAwake", WslKeepAwakeRequest => ()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WslKeepAwakeRequest {
    /// The distro's name, as `wsl.exe --list` gives it.
    pub distro: String,
    /// floti's full path inside the distro, for a login whose `PATH` does
    /// not have it; absent for `floti` on that `PATH`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub floti: Option<String>,
}
