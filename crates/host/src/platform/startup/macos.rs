//! Starting at sign-in on macOS: the LaunchAgent `dev.floti.host`, a property
//! list for the user's `~/Library/LaunchAgents`, so launchd loads it in the
//! user's own GUI session at sign-in. Never a LaunchDaemon: it names no user
//! or group to run as and is never placed in a system folder.

use std::path::Path;

use super::{StartAtSignIn, StartupDefinition, StartupKind, binary_text, xml_escape};
use crate::Result;

/// The launchd label (design I11).
pub const LABEL: &str = "dev.floti.host";

/// Where the property list goes, relative to the user's home.
pub const USER_FOLDER: &str = "Library/LaunchAgents";

/// The macOS implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl StartAtSignIn for Native {
    fn definition(&self, binary: &Path) -> Result<StartupDefinition> {
        launch_agent(binary)
    }
}

/// The LaunchAgent that runs `binary host` when it is loaded, which launchd
/// does at sign-in. The path is one element of `ProgramArguments`, so spaces
/// in it need no quoting. `LimitLoadToSessionType` `Aqua` keeps it to the
/// graphical sign-in, so an SSH sign-in never loads it.
pub fn launch_agent(binary: &Path) -> Result<StartupDefinition> {
    let path = xml_escape(binary_text(binary, |path| path.starts_with('/'))?);
    let label = xml_escape(LABEL);
    let contents = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{path}</string>
		<string>host</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>LimitLoadToSessionType</key>
	<string>Aqua</string>
	<key>ProcessType</key>
	<string>Interactive</string>
</dict>
</plist>
"#
    );

    Ok(StartupDefinition {
        kind: StartupKind::LaunchAgent,
        name: LABEL.to_owned(),
        file_name: format!("{LABEL}.plist"),
        user_folder: Some(USER_FOLDER),
        contents,
    })
}
