//! Starting the host at the user's sign-in: a Task Scheduler task "Floti
//! host" on Windows, the LaunchAgent `dev.floti.host` on macOS and the systemd
//! user unit `floti.service` on Linux. Never a system service, and never
//! started by SSH.
//!
//! The host generates the definition; registering it with the OS is the
//! installer's step, so generating one registers nothing. Each generator only
//! composes text, so all three are compiled on every OS and tested everywhere;
//! the lines below pick which one is `Native`.
//!
//! The same concern covers the host's place in that sign-in: it refuses to
//! start where no sign-in started it ([`launch_refusal`]: from SSH, or as root
//! or a Windows service account), and it stops on the OS's stop requests
//! ([`StopSignals`]: Ctrl+C, SIGTERM or the console events, and signing out).
//! Those read the OS, so each has one file per OS family, `signin_windows.rs`
//! and `signin_unix.rs`.

pub mod linux;
pub mod macos;
pub mod windows;

#[cfg(unix)]
mod signin_unix;
#[cfg(windows)]
mod signin_windows;

#[cfg(target_os = "linux")]
pub use linux::Native;
#[cfg(target_os = "macos")]
pub use macos::Native;
#[cfg(target_os = "windows")]
pub use windows::Native;

#[cfg(unix)]
use signin_unix as signin;
#[cfg(windows)]
use signin_windows as signin;

#[cfg(any(test, feature = "testkit"))]
pub use signin::{interrupt, stoppable, terminate};

#[cfg(test)]
mod tests;

use std::path::Path;

use crate::platform::folders::UserEnv;
use crate::{Error, Result};

/// Variables an SSH server sets in the sessions it starts.
const SSH_VARS: [&str; 3] = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"];

/// The account the host is running as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Account {
    /// An ordinary user.
    User,
    /// An account a host must never run as, by name: root, or a Windows
    /// service account such as SYSTEM.
    Privileged(&'static str),
    /// The OS would not say. The host starts, as it would for a user.
    Unknown,
}

/// The account this process runs as.
pub fn account() -> Account {
    signin::account()
}

/// The build number of the Windows the host runs on, for a client's
/// terminal renderer and its ConPTY quirks; `None` on any other OS, or when
/// Windows would not say.
pub fn windows_build() -> Option<u32> {
    signin::windows_build()
}

/// Why the host must not start here, as one sentence, or `None` when it may.
/// It starts at the user's sign-in as that user, so a start from an SSH
/// session, as root or as a Windows service account is refused before
/// anything is opened.
pub fn launch_refusal(env: &UserEnv, account: Account) -> Option<String> {
    if SSH_VARS.iter().any(|name| env.var(name).is_some()) {
        return Some(
            "The Floti host starts at your sign-in, not from an SSH session, so it was not started."
                .to_owned(),
        );
    }
    match account {
        Account::Privileged(name) => Some(format!(
            "The Floti host starts at your sign-in as you, not as {name}, so it was not started."
        )),
        Account::User | Account::Unknown => None,
    }
}

/// The OS's requests to stop the host, listened for from [`register`]
/// on. Registering replaces the default action, which would end the host
/// without recording its sessions.
///
/// [`register`]: StopSignals::register
pub struct StopSignals(signin::Signals);

impl StopSignals {
    /// Starts listening. Call it from inside a Tokio runtime.
    pub fn register() -> Result<Self> {
        signin::Signals::register().map(Self)
    }

    /// Waits for the next stop request, and says what it was.
    pub async fn recv(&mut self) -> &'static str {
        self.0.recv().await
    }
}

/// The OS mechanism a definition is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupKind {
    /// A Task Scheduler task with a logon trigger.
    LogonTask,
    /// A launchd agent in the user's `~/Library/LaunchAgents`.
    LaunchAgent,
    /// A systemd user unit.
    SystemdUserUnit,
}

/// A generated start-at-sign-in definition, ready for the installer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupDefinition {
    pub kind: StartupKind,
    /// What the OS knows it by: the task name, the launchd label or the unit
    /// name.
    pub name: String,
    /// The file name the definition is written as.
    pub file_name: String,
    /// The folder, relative to the user's home, the file belongs in:
    /// `Library/LaunchAgents` or `.config/systemd/user`. `None` for the logon
    /// task, which Task Scheduler stores itself once the file is imported.
    pub user_folder: Option<&'static str>,
    /// The definition itself: task XML, a property list or a unit file.
    pub contents: String,
}

impl StartupDefinition {
    /// The file's bytes in the encoding its OS reads: UTF-16LE with a byte
    /// order mark for the task XML, which declares UTF-16 as Task Scheduler
    /// exports it, and UTF-8 for the property list and the unit file.
    pub fn file_bytes(&self) -> Vec<u8> {
        match self.kind {
            StartupKind::LogonTask => {
                let mut bytes = Vec::with_capacity(2 + self.contents.len() * 2);
                bytes.extend_from_slice(&[0xFF, 0xFE]);
                for unit in self.contents.encode_utf16() {
                    bytes.extend_from_slice(&unit.to_le_bytes());
                }
                bytes
            }
            StartupKind::LaunchAgent | StartupKind::SystemdUserUnit => {
                self.contents.clone().into_bytes()
            }
        }
    }
}

/// The OS's way to start the host at sign-in.
pub trait StartAtSignIn {
    /// The definition that runs `binary host` at this user's sign-in.
    fn definition(&self, binary: &Path) -> Result<StartupDefinition>;
}

/// The binary's path as text, refused unless it is valid Unicode, has no
/// control characters (which no definition format can carry) and is absolute
/// by the target OS's rule, which `is_absolute` gives. The target's rule, not
/// the build's, so each generator behaves the same on every OS.
fn binary_text(binary: &Path, is_absolute: fn(&str) -> bool) -> Result<&str> {
    let text = binary.to_str().ok_or_else(|| {
        Error::Refused(format!(
            "The path to floti, {}, is not valid Unicode, so it cannot be written into a start-at-sign-in definition.",
            binary.display()
        ))
    })?;
    if text.chars().any(char::is_control) {
        return Err(Error::Refused(format!(
            "The path to floti, {text:?}, contains a control character, so it cannot be written into a start-at-sign-in definition."
        )));
    }
    if !is_absolute(text) {
        return Err(Error::Refused(format!(
            "The path to floti, {text}, is not absolute; a start-at-sign-in definition needs the full path."
        )));
    }
    Ok(text)
}

/// `text` escaped for XML character data and attribute values.
fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}
