//! The notification area on Linux: not drawn yet, so a host there shows no
//! icon and runs as it would have; [`Native::start`] says so.

use super::{Answer, NotificationArea, Question, TrayIcon, TrayItem};
use crate::{DesktopCommand, Error, Result};

/// The Linux implementation, which has none yet.
#[derive(Debug)]
pub struct Native(());

impl Native {
    /// Always [`Error::Unsupported`]: there is no icon to start.
    pub fn start(_picked: impl Fn(TrayItem) + Send + 'static) -> Result<Self> {
        Err(unsupported())
    }
}

impl NotificationArea for Native {
    fn show(&self, _icon: &TrayIcon) -> Result<()> {
        Err(unsupported())
    }

    fn hide(&self) -> Result<()> {
        Ok(())
    }

    fn confirm(&self, _question: &Question, answer: Answer) {
        answer(false);
    }

    fn open(&self, _desktop: &DesktopCommand) -> Result<()> {
        Err(unsupported())
    }
}

fn unsupported() -> Error {
    Error::unsupported("the notification area")
}
