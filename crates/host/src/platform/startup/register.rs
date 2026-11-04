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
//!   enables and starts it (`systemctl --user`). First, on a server, lingering
//!   is turned on for the user ([`Linger`]), so the user's service manager,
//!   and the host with it, runs from boot with nobody signed in. A server is
//!   a computer whose default target (`systemctl get-default`) is not
//!   `graphical.target`, or one where that cannot be told; a computer that
//!   boots to a desktop keeps lingering as it is, so its host runs in the
//!   desktop session with the desktop's environment (design A3).
//!   `floti setup --linger` and `--no-linger` choose either way. Lingering is
//!   turned on with the user's own `loginctl enable-linger`, never through
//!   sudo or as root, and only once `loginctl show-user` says it is off; it
//!   is never turned off. When loginctl refuses, nothing is written,
//!   registered or started.
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

    /// Whether this process runs inside a WSL distro, where systemd may not
    /// be running at all. Asked only for the user unit.
    fn inside_wsl(&self) -> bool {
        false
    }
}

/// Whether the user's systemd service manager answers here: `systemctl
/// --user show-environment` succeeds. In a WSL distro that runs no systemd
/// it fails, and no unit would ever be started.
pub fn user_manager_answers(system: &dyn SignInSystem) -> bool {
    system
        .run(&OsCommand::new(
            "systemctl",
            &["--user", "show-environment"],
        ))
        .is_ok_and(|ran| ran.success)
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

    fn inside_wsl(&self) -> bool {
        use crate::platform::folders::UserEnv;
        use crate::platform::wsl::{Native as NativeWsl, WslSide};
        NativeWsl.inside(&UserEnv::from_process())
    }
}

/// Where registering left the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Started {
    /// Registered, and started in the user's signed-in session.
    Running,
    /// Registered and started by a service manager that keeps running with
    /// nobody signed in: the systemd user unit with lingering on.
    KeepsRunning,
    /// Registered; nobody is signed in, so it starts at the next sign-in.
    AtNextSignIn,
}

/// Whether setup turns lingering on for the systemd user unit, so the host
/// runs with nobody signed in. Only the user unit asks; the logon task and
/// the LaunchAgent have no such thing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Linger {
    /// On for a server, as it is on a computer that boots to a desktop: what
    /// setup does with no flag, and what the desktop's install runs.
    #[default]
    ByComputer,
    /// On, whatever the computer boots to (`floti setup --linger`).
    On,
    /// As it is, never asked about or changed (`floti setup --no-linger`).
    AsItIs,
}

/// The default target of a computer that boots to a desktop.
pub const DESKTOP_TARGET: &str = "graphical.target";

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
/// through that mechanism when the user is signed in. For the user unit,
/// lingering is settled first, as `linger` says, so a refusal leaves the
/// unit there as it was. `Err` is the one line to say: the last line the
/// failing command wrote, unedited, or why the file could not be written.
pub fn register_and_start(
    system: &dyn SignInSystem,
    definition: &StartupDefinition,
    home: &Path,
    data: &Path,
    linger: Linger,
) -> Result<Started, String> {
    let lingering = match definition.kind {
        StartupKind::SystemdUserUnit => settle_lingering(system, linger)?,
        StartupKind::LogonTask | StartupKind::LaunchAgent => false,
    };
    let file = definition_file(definition, home, data);
    let previous = std::fs::read(&file).ok();
    let bytes = definition.file_bytes();
    write_file(&file, &bytes)?;
    let changed = previous.as_deref() != Some(bytes.as_slice());
    match definition.kind {
        StartupKind::LogonTask => logon_task(system, definition, &file),
        StartupKind::LaunchAgent => launch_agent(system, definition, &file, changed),
        StartupKind::SystemdUserUnit => user_unit(system, definition, lingering),
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
    let uid = user_id(system)?;
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

/// This user's numeric id, from `id -u`.
fn user_id(system: &dyn SignInSystem) -> Result<String, String> {
    let uid = must(system, &OsCommand::new("id", &["-u"]))?;
    let uid = uid.stdout.trim();
    if uid.is_empty() || !uid.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("`id -u` answered {uid:?}, which is not a user id"));
    }
    Ok(uid.to_owned())
}

/// Settles lingering for the user unit as `linger` says, and answers whether
/// it is on: whether the user's service manager, and the host it starts,
/// keeps running with nobody signed in.
///
/// Turning it on is the user's own `loginctl enable-linger`, which names no
/// user and so acts on the caller, after `loginctl show-user <uid>` says it
/// is off. On a computer whose loginctl refuses (its policy lets only an
/// administrator turn lingering on) it fails with loginctl's last line,
/// unedited, and the line that administrator runs.
fn settle_lingering(system: &dyn SignInSystem, linger: Linger) -> Result<bool, String> {
    let wanted = match linger {
        Linger::On => true,
        Linger::AsItIs => false,
        Linger::ByComputer => !boots_to_desktop(system),
    };
    if !wanted {
        return Ok(false);
    }
    let uid = user_id(system)?;
    let shown = system.run(&OsCommand::new(
        "loginctl",
        &["show-user", &uid, "--property=Linger", "--value"],
    ));
    // `show-user` fails for a user with no session and lingering off, and
    // where loginctl cannot be run the enable below says why: either way
    // lingering is not known to be on.
    if shown.is_ok_and(|shown| shown.success && shown.stdout.trim() == "yes") {
        return Ok(true);
    }
    let said = match system.run(&OsCommand::new("loginctl", &["enable-linger"])) {
        Ok(enabled) if enabled.success => return Ok(true),
        Ok(enabled) => enabled.last_line().map(str::to_owned).unwrap_or_else(|| {
            "loginctl enable-linger failed and wrote nothing on standard error".to_owned()
        }),
        Err(err) => format!("could not run loginctl: {err}"),
    };
    let user = system
        .run(&OsCommand::new("id", &["-un"]))
        .ok()
        .filter(|named| named.success)
        .map(|named| named.stdout.trim().to_owned())
        .filter(|name| !name.is_empty() && !name.contains(char::is_whitespace))
        .unwrap_or(uid);
    Err(linger_refused_line(&said, &user))
}

/// The one line setup fails with when lingering could not be turned on for
/// `user`: what loginctl said, unedited, then the fix. The fix says "there"
/// rather than "here": the line is mostly read on another computer, in the
/// desktop's add-a-host dialog, which shows it unedited.
pub fn linger_refused_line(said: &str, user: &str) -> String {
    format!(
        "could not turn on lingering, which keeps the host running with nobody signed in: {said}. Ask an administrator there to run sudo loginctl enable-linger {user}, then run floti setup again."
    )
}

/// Whether this computer boots to a desktop: its default target is
/// [`DESKTOP_TARGET`]. Where that cannot be told it is taken for a server.
fn boots_to_desktop(system: &dyn SignInSystem) -> bool {
    system
        .run(&OsCommand::new("systemctl", &["get-default"]))
        .is_ok_and(|target| target.success && target.stdout.trim() == DESKTOP_TARGET)
}

fn user_unit(
    system: &dyn SignInSystem,
    definition: &StartupDefinition,
    lingering: bool,
) -> Result<Started, String> {
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
    Ok(if lingering {
        Started::KeepsRunning
    } else {
        Started::Running
    })
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
