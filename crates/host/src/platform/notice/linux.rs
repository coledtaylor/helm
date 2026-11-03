//! Notifications on Linux: `notify-send`, in a desktop session. The title
//! carries the device's name because a notification's summary is plain text
//! by the desktop notifications specification, where its body may be read as
//! markup; the body is the host's own text.

use std::process::{Command, Stdio};

use super::{Notice, ShowNotice};
use crate::{Error, Result};

/// The Linux implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl ShowNotice for Native {
    fn show(&self, notice: &Notice) -> Result<()> {
        let session = ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"]
            .iter()
            .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()));
        if !session {
            return Err(Error::unsupported(
                "a notification on a computer with no desktop session",
            ));
        }
        let status = Command::new("notify-send")
            .args(["--app-name=Floti", "--"])
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
                std::io::Error::other(format!("notify-send ended with {status}")),
            )),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Err(Error::unsupported("a notification without notify-send"))
            }
            Err(err) => Err(Error::io("run notify-send", err)),
        }
    }
}
