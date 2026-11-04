//! WSL, from both sides: the `wsl.exe` a Windows host starts a distro with,
//! and whether this process runs inside a distro.
//!
//! On Windows the host keeps a distro awake while the host inside it has
//! sessions (`wsl:keepAwake`), by holding one `wsl.exe -d <distro> --
//! <floti> keep-awake` open. That is needed because of how WSL treats an
//! idle distro, checked on the development PC against the installed WSL,
//! 3.0.3.0 (`wsl.exe --version`, 2026-11-03): WSL stops a distro shortly
//! after the last Windows process attached to it through `wsl.exe` exits,
//! and a process running inside the distro (the host, its keeper, its
//! sessions) does not keep it running. That was read from WSL's own
//! behaviour as documented for that version, not checked against a running
//! distro: no test starts one.
//!
//! macOS and Linux have no WSL: their [`WslSide::program`] is `None`, and an
//! ask to keep a distro awake there is answered with [`NO_WSL_LINE`]. Linux
//! is where a host can run inside a distro ([`WslSide::inside`]), which
//! changes how `floti setup` and `floti connect` start it there.
//!
//! The `wsl.exe` to run is `FLOTI_WSL` when it names an absolute path, as
//! `FLOTI_NODE` names Node, else `wsl.exe` in Windows' System32. A test
//! passes its own [`WslProgram`], the fake in `test/fake-ssh/wsl.mjs` run by
//! Node, in the host's run, so the holding logic, which compiles on every
//! OS, is tested on every OS.
//!
//! Each OS's answer is plain path and variable arithmetic, so all three are
//! compiled and tested on every OS; the build picks one as [`Native`].

pub mod linux;
pub mod macos;
pub mod windows;

#[cfg(target_os = "linux")]
pub use linux::Native;
#[cfg(target_os = "macos")]
pub use macos::Native;
#[cfg(target_os = "windows")]
pub use windows::Native;

use std::ffi::OsString;

use super::folders::UserEnv;
use super::launcher::{Native as NativeLauncher, ProgramLauncher};

#[cfg(test)]
mod tests;

/// The variable that names the `wsl.exe` a host starts distros with, in
/// place of System32's.
pub const WSL_VAR: &str = "FLOTI_WSL";

/// The variable that makes `wsl.exe` write UTF-8 rather than UTF-16LE. Every
/// `wsl.exe` floti starts gets it; one started on another PC through ssh
/// does not, so what it writes is read as UTF-16LE when it is.
pub const UTF8_VAR: &str = "WSL_UTF8";

/// What a host with no WSL answers an ask to keep a distro awake.
pub const NO_WSL_LINE: &str = "There is no WSL on this computer.";

/// The variable WSL sets in every process it starts inside a distro.
pub const DISTRO_NAME_VAR: &str = "WSL_DISTRO_NAME";

/// The file WSL's interop registers inside every distro.
pub const INTEROP_FILE: &str = "/proc/sys/fs/binfmt_misc/WSLInterop";

/// The `wsl.exe` to run: a program, any arguments that go before the
/// distro's, and variables it runs with besides this process's own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslProgram {
    pub program: OsString,
    /// Before `-d <distro>`: empty for `wsl.exe` itself, the fake's script
    /// for a test that runs it with Node.
    pub args: Vec<OsString>,
    /// Set on every run besides [`UTF8_VAR`]: empty in production.
    pub env: Vec<(OsString, OsString)>,
}

impl WslProgram {
    /// `program` run as it is.
    pub fn plain(program: impl Into<OsString>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            env: Vec::new(),
        }
    }

    /// `<wsl> -d <distro> -- <line>`, with `line` handed to the distro's
    /// shell as written ([`ProgramLauncher::append_as_written`]), with
    /// [`UTF8_VAR`] set, opening no window.
    pub fn in_distro(&self, distro: &str, line: &str) -> std::process::Command {
        let mut command = std::process::Command::new(&self.program);
        command
            .args(&self.args)
            .args(["-d", distro, "--"])
            .env(UTF8_VAR, "1")
            .envs(self.env.iter().map(|(name, value)| (name, value)));
        NativeLauncher.append_as_written(&mut command, line);
        NativeLauncher.windowless(&mut command);
        command
    }
}

/// What differs about WSL by OS.
pub trait WslSide {
    /// The `wsl.exe` this computer starts distros with, for the user `env`
    /// describes, or `None` where there is no WSL.
    fn program(&self, env: &UserEnv) -> Option<WslProgram>;

    /// Whether this process runs inside a WSL distro.
    fn inside(&self, env: &UserEnv) -> bool;
}

/// Why `name` cannot be a WSL distro's name, or `None` when it can: WSL
/// allows letters, digits, `.`, `_` and `-`, and nothing else.
pub fn distro_name_problem(name: &str) -> Option<String> {
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
    if name.is_empty() || !name.chars().all(allowed) {
        return Some(format!(
            "{name:?} is not a WSL distro name: one is letters, digits, '.', '_' and '-'."
        ));
    }
    None
}
