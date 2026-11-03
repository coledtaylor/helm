//! Notifications on macOS: `osascript`'s `display notification`. The script
//! is fixed and reads the title and body from its arguments, so neither is
//! ever part of the script it runs.

use std::process::{Command, Stdio};

use super::{Notice, ShowNotice};
use crate::{Error, Result};

/// Shows its first argument as the title and its second as the text.
const SCRIPT: [&str; 3] = [
    "on run argv",
    "display notification (item 2 of argv) with title (item 1 of argv)",
    "end run",
];

/// The macOS implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl ShowNotice for Native {
    fn show(&self, notice: &Notice) -> Result<()> {
        let mut command = Command::new("/usr/bin/osascript");
        for line in SCRIPT {
            command.arg("-e").arg(line);
        }
        let status = command
            .arg(&notice.title)
            .arg(&notice.body)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        match status {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(Error::io(
                "show a notification",
                std::io::Error::other(format!("osascript ended with {status}")),
            )),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Err(Error::unsupported("a notification without osascript"))
            }
            Err(err) => Err(Error::io("run osascript", err)),
        }
    }
}
