//! Starting at sign-in on Windows: the Task Scheduler task "Floti host",
//! triggered at this user's logon only and run as this user, with least
//! privilege and an interactive token, so it runs in the user's own desktop
//! session. No boot trigger, no stored password, no service account and no
//! highest run level.

use std::path::Path;

use super::{StartAtSignIn, StartupDefinition, StartupKind, binary_text, xml_escape};
use crate::{Error, Result};

/// The task's name in Task Scheduler (design I11).
pub const TASK_NAME: &str = "Floti host";

/// The Windows implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl StartAtSignIn for Native {
    fn definition(&self, binary: &Path) -> Result<StartupDefinition> {
        logon_task(binary, &current_user()?)
    }
}

/// The user this process runs as, as `DOMAIN\name`, which is how Task
/// Scheduler names the account in a logon trigger and a principal.
fn current_user() -> Result<String> {
    let var = |name: &str| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    let name = var("USERNAME").ok_or_else(|| {
        Error::Refused(
            "USERNAME is not set, so the logon task cannot name the user it starts for.".to_owned(),
        )
    })?;
    Ok(match var("USERDOMAIN") {
        Some(domain) => format!("{domain}\\{name}"),
        None => name,
    })
}

/// The logon task that runs `binary host` when `user` signs in, as `user`.
///
/// Refuses a relative path, a path with a quote (Windows allows none in a file
/// name) and a system account: a machine account (`name$`), `SYSTEM`,
/// `LOCAL SERVICE` or `NETWORK SERVICE`.
pub fn logon_task(binary: &Path, user: &str) -> Result<StartupDefinition> {
    let path = binary_text(binary, is_windows_absolute)?;
    if path.contains('"') {
        return Err(Error::Refused(format!(
            "The path to floti, {path}, contains a quote, which a Windows path cannot."
        )));
    }
    let user = user.trim();
    if is_system_account(user) {
        return Err(Error::Refused(format!(
            "The Floti host starts at a person's sign-in, never as the {user} account."
        )));
    }

    let user = xml_escape(user);
    let command = xml_escape(path);
    let name = xml_escape(TASK_NAME);
    let contents = format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts the Floti host when you sign in.</Description>
    <URI>\{name}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"{command}"</Command>
      <Arguments>host</Arguments>
    </Exec>
  </Actions>
</Task>
"#
    );

    Ok(StartupDefinition {
        kind: StartupKind::LogonTask,
        name: TASK_NAME.to_owned(),
        file_name: format!("{TASK_NAME}.xml"),
        user_folder: None,
        contents,
    })
}

/// A drive path (`C:\` or `C:/`) or a UNC path (`\\server\share`).
fn is_windows_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    drive || path.starts_with(r"\\")
}

/// An account that is not a person: the machine account `SYSTEM` runs as
/// (`DOMAIN\NAME$`) or one of the built-in service accounts.
fn is_system_account(user: &str) -> bool {
    let account = user.rsplit('\\').next().unwrap_or(user);
    account.is_empty()
        || account.ends_with('$')
        || ["SYSTEM", "LOCAL SERVICE", "NETWORK SERVICE", "LOCALSYSTEM"]
            .iter()
            .any(|builtin| account.eq_ignore_ascii_case(builtin))
}
