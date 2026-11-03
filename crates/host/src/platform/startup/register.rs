//! Registering a start-at-sign-in definition with the OS's per-user
//! mechanism, and starting the host through it, for `floti setup`.
//!
//! - The logon task: Task Scheduler imports the task XML under its name,
//!   replacing a task of that name (`schtasks /Create /XML ... /F`), and runs
//!   it (`schtasks /Run`) when this user has a desktop session on the
//!   computer. With nobody signed in it starts at the next sign-in.
//! - The LaunchAgent: the property list goes in `~/Library/LaunchAgents`,
//!   replacing the one there. When this user's GUI domain (`gui/<uid>`)
//!   exists, launchd is given it (`launchctl bootstrap`, after `bootout` when
//!   a different definition was loaded) and asked to start it
//!   (`launchctl kickstart`, which leaves a running host running). With no
//!   GUI domain launchd loads it at the next sign-in.
//! - The systemd user unit: the unit file goes in `~/.config/systemd/user`,
//!   replacing the one there, and the user's own service manager reloads,
//!   enables and starts it (`systemctl --user`). Keeping it running with
//!   nobody signed in (lingering) is not set here.
//!
//! Every step is one OS command run through a [`SignInSystem`], never a
//! shell, and nothing asks for admin rights or touches a system folder or a
//! system service. The host is started by the mechanism, in the user's
//! signed-in session, never as a child of the process that registered it,
//! so a setup run over ssh never leaves a host under ssh. Each entry has
//! one fixed name, so running setup again replaces it and never adds a
//! second.
//!
//! All three are compiled on every OS and tested everywhere with a fake
//! system, like the generators.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

use super::{StartupDefinition, StartupKind};

/// One OS command: a program, found on `PATH`, and its arguments, run
/// without a shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsCommand {
    pub program: String,
    pub args: Vec<OsString>,
}

impl OsCommand {
    fn new(program: &str, args: &[&str]) -> Self {
        Self {
            program: program.to_owned(),
            args: args.iter().map(OsString::from).collect(),
        }
    }

    fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// The command line, for a failure to name.
    pub fn described(&self) -> String {
        self.args
            .iter()
            .fold(self.program.clone(), |mut line, arg| {
                line.push(' ');
                line.push_str(&arg.to_string_lossy());
                line
            })
    }
}

/// How an OS command ended.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Ran {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

impl Ran {
    /// The last line it wrote, standard error first, unedited.
    fn last_line(&self) -> Option<&str> {
        [&self.stderr, &self.stdout].into_iter().find_map(|text| {
            text.lines()
                .map(str::trim_end)
                .rfind(|line| !line.trim().is_empty())
        })
    }
}

/// What registering asks of the OS. [`NativeSystem`] runs the real commands;
/// a test gives a fake that records them.
pub trait SignInSystem {
    /// Runs `command` to its end and says how it ended.
    fn run(&self, command: &OsCommand) -> io::Result<Ran>;

    /// Whether this user has a desktop session on this computer now, at the
    /// console or over remote desktop, connected or not: where a logon task
    /// runs when it is started. Asked only for the logon task.
    fn desktop_session(&self) -> io::Result<bool>;
}

/// The real OS: commands run windowless with no standard input.
#[derive(Debug, Clone, Copy, Default)]
pub struct NativeSystem;

impl SignInSystem for NativeSystem {
    fn run(&self, command: &OsCommand) -> io::Result<Ran> {
        use crate::platform::launcher::{Native as NativeLauncher, ProgramLauncher};
        let mut process = std::process::Command::new(&command.program);
        process
            .args(&command.args)
            .stdin(std::process::Stdio::null());
        NativeLauncher.windowless(&mut process);
        let output = process.output()?;
        Ok(Ran {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }

    fn desktop_session(&self) -> io::Result<bool> {
        super::signin::desktop_session()
    }
}

/// Where registering left the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Started {
    /// Registered, and started in the user's signed-in session.
    Running,
    /// Registered; nobody is signed in, so it starts at the next sign-in.
    AtNextSignIn,
}

/// The folder the logon task's XML is kept in, under the data folder: Task
/// Scheduler keeps its own copy once it is imported.
pub const TASK_FILE_FOLDER: &str = "startup";

/// Where `definition`'s file is written: under `home` for the LaunchAgent
/// and the unit, under `data` for the logon task's XML.
pub fn definition_file(definition: &StartupDefinition, home: &Path, data: &Path) -> PathBuf {
    match definition.user_folder {
        Some(folder) => folder
            .split('/')
            .fold(home.to_path_buf(), |path, part| path.join(part))
            .join(&definition.file_name),
        None => data.join(TASK_FILE_FOLDER).join(&definition.file_name),
    }
}

/// Writes `definition` where its OS reads it, replacing what was there,
/// registers it with the OS's per-user mechanism, and starts the host
/// through that mechanism when the user is signed in. `Err` is the one line
/// to say: the last line the failing command wrote, unedited, or why the
/// file could not be written.
pub fn register_and_start(
    system: &dyn SignInSystem,
    definition: &StartupDefinition,
    home: &Path,
    data: &Path,
) -> Result<Started, String> {
    let file = definition_file(definition, home, data);
    let previous = std::fs::read(&file).ok();
    let bytes = definition.file_bytes();
    write_file(&file, &bytes)?;
    let changed = previous.as_deref() != Some(bytes.as_slice());
    match definition.kind {
        StartupKind::LogonTask => logon_task(system, definition, &file),
        StartupKind::LaunchAgent => launch_agent(system, definition, &file, changed),
        StartupKind::SystemdUserUnit => user_unit(system, definition),
    }
}

fn logon_task(
    system: &dyn SignInSystem,
    definition: &StartupDefinition,
    file: &Path,
) -> Result<Started, String> {
    let name = definition.name.as_str();
    must(
        system,
        &OsCommand::new("schtasks", &["/Create", "/TN", name, "/XML"])
            .arg(file)
            .arg("/F"),
    )?;
    let signed_in = system
        .desktop_session()
        .map_err(|err| format!("could not tell whether you are signed in here: {err}"))?;
    if !signed_in {
        return Ok(Started::AtNextSignIn);
    }
    must(system, &OsCommand::new("schtasks", &["/Run", "/TN", name]))?;
    Ok(Started::Running)
}

fn launch_agent(
    system: &dyn SignInSystem,
    definition: &StartupDefinition,
    file: &Path,
    changed: bool,
) -> Result<Started, String> {
    let uid = must(system, &OsCommand::new("id", &["-u"]))?;
    let uid = uid.stdout.trim();
    if uid.is_empty() || !uid.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("`id -u` answered {uid:?}, which is not a user id"));
    }
    let domain = format!("gui/{uid}");
    let service = format!("{domain}/{}", definition.name);
    // No GUI domain: nobody is signed in at the screen, and launchd loads the
    // agent from the folder at the next sign-in.
    if !ran(system, &OsCommand::new("launchctl", &["print", &domain]))?.success {
        return Ok(Started::AtNextSignIn);
    }
    let loaded = ran(system, &OsCommand::new("launchctl", &["print", &service]))?.success;
    if loaded && changed {
        // launchd keeps the definition it loaded; a changed one is loaded
        // afresh. Unchanged, the agent is left as it is, a running host too.
        must(system, &OsCommand::new("launchctl", &["bootout", &service]))?;
    }
    if !loaded || changed {
        must(
            system,
            &OsCommand::new("launchctl", &["bootstrap", &domain]).arg(file),
        )?;
    }
    must(
        system,
        &OsCommand::new("launchctl", &["kickstart", &service]),
    )?;
    Ok(Started::Running)
}

fn user_unit(system: &dyn SignInSystem, definition: &StartupDefinition) -> Result<Started, String> {
    let unit = definition.name.as_str();
    must(
        system,
        &OsCommand::new("systemctl", &["--user", "daemon-reload"]),
    )?;
    must(
        system,
        &OsCommand::new("systemctl", &["--user", "enable", unit]),
    )?;
    // `start` leaves a running host running; a stopped one starts.
    must(
        system,
        &OsCommand::new("systemctl", &["--user", "start", unit]),
    )?;
    Ok(Started::Running)
}

fn write_file(file: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(folder) = file.parent() {
        std::fs::create_dir_all(folder)
            .map_err(|err| format!("could not make {}: {err}", folder.display()))?;
    }
    std::fs::write(file, bytes).map_err(|err| format!("could not write {}: {err}", file.display()))
}

/// Runs `command`; only not being able to run it at all is a failure.
fn ran(system: &dyn SignInSystem, command: &OsCommand) -> Result<Ran, String> {
    system
        .run(command)
        .map_err(|err| format!("could not run {}: {err}", command.program))
}

/// Runs `command`, which must succeed.
fn must(system: &dyn SignInSystem, command: &OsCommand) -> Result<Ran, String> {
    let ran = ran(system, command)?;
    if ran.success {
        return Ok(ran);
    }
    Err(ran.last_line().map(str::to_owned).unwrap_or_else(|| {
        format!(
            "{} failed and wrote nothing on standard error",
            command.described()
        )
    }))
}
