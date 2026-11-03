//! Starting at sign-in on Linux: the systemd user unit `floti.service`,
//! wanted by `default.target` of the user's own service manager. It names no
//! `User=` and no system target, so it is never a system service. On a
//! server `floti setup` turns lingering on for the user, so the user's
//! service manager starts it at boot and keeps it running with nobody signed
//! in; on a computer that boots to a desktop it starts at sign-in, in the
//! desktop session ([`register`](super::register)).

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
/// `KillMode=process` sends the stop signal to the host alone and kills
/// nothing else in the unit, at a stop or when the host dies. At a stop the
/// host ends each session's process tree and the session keeper itself, and
/// records them. When the host dies without a stop, the session keeper,
/// which shares the unit's control group, keeps the sessions running, and
/// `Restart=on-failure` starts the host again, which takes them back from the
/// keeper: on a server nobody signs in to start it. Every deliberate end of
/// the host (a stop from a client or the OS's stop signal, a stop for an
/// update) exits with status 0, so only a crash or a kill restarts it.
pub fn user_unit(binary: &Path) -> Result<StartupDefinition> {
    let exec = quote_exec_word(binary_text(binary, |path| path.starts_with('/'))?);
    let contents = format!(
        "[Unit]
Description=Floti host

[Service]
Type=simple
ExecStart={exec} host
KillMode=process
Restart=on-failure
RestartSec=1

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
