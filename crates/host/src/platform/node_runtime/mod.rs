//! Where the Node runtime plugin services run on sits in the folder it ships
//! in: `node.exe` at the top on Windows, `bin/node` on macOS and Linux, the
//! layouts Node's own release archives have.
//!
//! The packaged app carries that folder as `node/` beside the `floti`
//! executable. [`runtime`] picks the Node a host runs services on:
//! `FLOTI_NODE` when it is set, else the one shipped beside the running
//! executable, else none, and a `node` service then fails saying so. A Node
//! found on `PATH` is never used: what runs a plugin's service is what the
//! app shipped, whatever the user has installed.
//!
//! Each OS's layout is plain path arithmetic, so all three are compiled and
//! tested on every OS; the build picks one as [`Native`].

pub mod linux;
pub mod macos;
pub mod windows;

#[cfg(target_os = "linux")]
pub use linux::Native;
#[cfg(target_os = "macos")]
pub use macos::Native;
#[cfg(target_os = "windows")]
pub use windows::Native;

use std::path::{Path, PathBuf};

use super::folders::UserEnv;

#[cfg(test)]
mod tests;

/// The variable that names the Node binary a host runs plugin services on,
/// in place of the one shipped beside it.
pub const NODE_VAR: &str = "FLOTI_NODE";

/// The folder the runtime ships in, beside the `floti` executable.
pub const SHIPPED_FOLDER: &str = "node";

/// The OS's layout of a Node release.
pub trait NodeLayout {
    /// Node's executable within `folder`, the top of a release as it ships.
    fn binary_in(&self, folder: &Path) -> PathBuf;
}

/// The Node a host whose executable is `exe` runs plugin services on, for
/// the user `env` describes: `FLOTI_NODE` when it names an absolute path,
/// else [`SHIPPED_FOLDER`] beside `exe` when its binary is there, else none.
pub fn runtime(env: &UserEnv, exe: Option<&Path>, layout: &dyn NodeLayout) -> Option<PathBuf> {
    if let Some(named) = env.absolute_var(NODE_VAR) {
        return Some(named);
    }
    let beside = exe?.parent()?.join(SHIPPED_FOLDER);
    Some(layout.binary_in(&beside)).filter(|binary| binary.is_file())
}
