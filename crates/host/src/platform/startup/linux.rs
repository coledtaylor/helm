//! Starting at sign-in on Linux: the systemd user unit `floti.service`,
//! wanted by `default.target` of the user's own service manager. It names no
//! `User=` and no system target, so it is never a system service; a server
//! with lingering on starts it without a sign-in.

use std::path::Path;

use super::{StartAtSignIn, StartupDefinition, StartupKind, binary_text};
use crate::Result;

/// The unit's name (design I11).
pub const UNIT_NAME: &str = "floti.service";

/// Where the unit file goes, relative to the user's home.
pub const USER_FOLDER: &str = ".config/systemd/user";

/// The Linux implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl StartAtSignIn for Native {
    fn definition(&self, binary: &Path) -> Result<StartupDefinition> {
        user_unit(binary)
    }
}

/// The user unit that runs `binary host` when the user's service manager
/// reaches `default.target`.
///
/// `KillMode=mixed` sends the stop signal to the host alone, so the host ends
/// each session's process tree and records it itself before systemd kills
/// whatever is left.
pub fn user_unit(binary: &Path) -> Result<StartupDefinition> {
    let exec = quote_exec_word(binary_text(binary, |path| path.starts_with('/'))?);
    let contents = format!(
        "[Unit]
Description=Floti host

[Service]
Type=simple
ExecStart={exec} host
KillMode=mixed

[Install]
WantedBy=default.target
"
    );

    Ok(StartupDefinition {
        kind: StartupKind::SystemdUserUnit,
        name: UNIT_NAME.to_owned(),
        file_name: UNIT_NAME.to_owned(),
        user_folder: Some(USER_FOLDER),
        contents,
    })
}

/// One `ExecStart=` word in double quotes, escaped as systemd reads it:
/// `\` and `"` with a backslash, `%` (a specifier) as `%%` and `$` (a
/// variable) as `$$`.
fn quote_exec_word(word: &str) -> String {
    let mut out = String::with_capacity(word.len() + 2);
    out.push('"');
    for c in word.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '%' => out.push_str("%%"),
            '$' => out.push_str("$$"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
