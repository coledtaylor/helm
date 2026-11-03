//! `floti setup`: run from the floti in the user's own folder, on the
//! computer that is to be a host, usually through ssh by the desktop that
//! installed it there.
//!
//! It makes the data folder and the host's key when they are absent, writes
//! the start-at-sign-in definition for this floti (the logon task "Floti
//! host", the LaunchAgent `dev.floti.host` or the user unit `floti.service`),
//! registers it with the OS's per-user mechanism, replacing its own entry
//! when there is one, and starts the host through that mechanism in the
//! user's signed-in session ([`register`]). It never starts the host as its
//! own child, so a setup run over ssh leaves no host under ssh, which
//! [`launch_refusal`](crate::platform::startup::launch_refusal) refuses
//! anyway. With nobody signed in, it starts nothing.
//!
//! On Linux it first turns lingering on for a server, a computer that does
//! not boot to a desktop, so the user's service manager runs the unit from
//! boot with nobody signed in; a computer that boots to a desktop keeps
//! lingering as it is. `floti setup --linger` turns it on either way and
//! `--no-linger` leaves it as it is ([`Linger`]); the desktop's install
//! passes neither. It is turned on with the user's own `loginctl`, never
//! sudo, and a refusal fails setup before anything is registered.
//!
//! It ends with one line on standard output and an exit status for each
//! outcome:
//!
//! - [`RUNNING_LINE`], status 0: the host is running and answers on its
//!   socket.
//! - [`KEEPS_RUNNING_LINE`], status 0: the same, on a computer where it
//!   keeps running with nobody signed in (the Linux unit with lingering on).
//! - [`AT_NEXT_SIGN_IN_LINE`], status [`AT_NEXT_SIGN_IN_EXIT`]: registered,
//!   and nobody is signed in, so the host starts at the next sign-in.
//! - A failure: one line on standard error starting `floti setup: `, with
//!   the last line the failing OS command wrote, unedited, and status 1. A
//!   refused lingering also names the fix: an administrator there runs
//!   `sudo loginctl enable-linger <user>`.
//!
//! Checking the agent CLIs and offering the desktop app are not part of it.
//!
//! [`register`]: crate::platform::startup::register

use std::io::Write;
use std::path::Path;
use std::time::{Duration, Instant};

use floti_protocol::message::ClientKind;
use floti_protocol::noise::KeyPair;

use crate::client;
use crate::host_log::LOG_FILE;
use crate::keys::load_or_create_key_pair;
use crate::platform::folders::{self, Folders, UserEnv};
pub use crate::platform::startup::register::Linger;
use crate::platform::startup::register::{NativeSystem, SignInSystem, Started, register_and_start};
use crate::platform::startup::{self, Account, StartAtSignIn, StartupDefinition};
use crate::server::{HOST_KEY_FILE, local_endpoint};

/// What `floti setup` prints once the host is running.
pub const RUNNING_LINE: &str = "The Floti host is running, and starts at each sign-in.";

/// What `floti setup` prints once the host is running where it keeps running
/// with nobody signed in.
pub const KEEPS_RUNNING_LINE: &str =
    "The Floti host is running, and keeps running with nobody signed in.";

/// What `floti setup` prints when nobody is signed in to start it in.
pub const AT_NEXT_SIGN_IN_LINE: &str = "The Floti host starts at the next sign-in.";

/// The exit status when the host was registered but nobody is signed in.
pub const AT_NEXT_SIGN_IN_EXIT: u8 = 10;

/// How long setup waits for the host it started to answer.
pub const ANSWER_DEADLINE: Duration = Duration::from_secs(60);

/// How often it looks.
const LOOK_AGAIN: Duration = Duration::from_millis(100);

/// The name the host's log sees setup's one connection as.
const CLIENT_NAME: &str = "floti setup";

/// How setup ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SetupOutcome {
    /// The host is registered, started, and answers.
    Running,
    /// The host is registered, started, and answers, and keeps running with
    /// nobody signed in.
    KeepsRunning,
    /// The host is registered and starts at the next sign-in.
    AtNextSignIn,
    /// Why it failed, as one line.
    Failed(String),
}

impl SetupOutcome {
    /// The process's exit status.
    pub fn code(&self) -> u8 {
        match self {
            Self::Running | Self::KeepsRunning => 0,
            Self::AtNextSignIn => AT_NEXT_SIGN_IN_EXIT,
            Self::Failed(_) => 1,
        }
    }

    /// The one line on standard output, or `None` for a failure, which goes
    /// to standard error.
    pub fn printed(&self) -> Option<&'static str> {
        match self {
            Self::Running => Some(RUNNING_LINE),
            Self::KeepsRunning => Some(KEEPS_RUNNING_LINE),
            Self::AtNextSignIn => Some(AT_NEXT_SIGN_IN_LINE),
            Self::Failed(_) => None,
        }
    }
}

/// What follows `setup` on the command line: nothing, `--linger` or
/// `--no-linger`. `None` for anything else.
pub fn parse_linger(args: &[&str]) -> Option<Linger> {
    match args {
        [] => Some(Linger::ByComputer),
        ["--linger"] => Some(Linger::On),
        ["--no-linger"] => Some(Linger::AsItIs),
        _ => None,
    }
}

/// Runs `floti setup` for the floti this process is, settling lingering as
/// `linger` says, says how it ended, and answers its exit status.
pub fn run_setup(linger: Linger) -> u8 {
    let outcome = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime.block_on(native_setup(linger)),
        Err(err) => SetupOutcome::Failed(format!("could not start: {err}")),
    };
    match &outcome {
        SetupOutcome::Failed(why) => {
            let line = why.replace(['\r', '\n'], " ");
            let mut err = std::io::stderr().lock();
            let _ = writeln!(err, "floti setup: {line}").and_then(|()| err.flush());
        }
        done => {
            let mut out = std::io::stdout().lock();
            let line = done.printed().unwrap_or_default();
            let _ = writeln!(out, "{line}").and_then(|()| out.flush());
        }
    }
    outcome.code()
}

async fn native_setup(linger: Linger) -> SetupOutcome {
    if let Account::Privileged(name) = startup::account() {
        return SetupOutcome::Failed(format!(
            "The Floti host starts at your sign-in as you, not as {name}; run floti setup as yourself."
        ));
    }
    let binary = match std::env::current_exe() {
        Ok(binary) => binary,
        Err(err) => {
            return SetupOutcome::Failed(format!("could not tell where this floti is: {err}"));
        }
    };
    let definition = match startup::Native.definition(&binary) {
        Ok(definition) => definition,
        Err(err) => return SetupOutcome::Failed(err.to_string()),
    };
    setup(
        &UserEnv::from_process(),
        &NativeSystem,
        &definition,
        linger,
        ANSWER_DEADLINE,
    )
    .await
}

/// Sets up the host for the user `env` describes, registering `definition`
/// through `system` with lingering settled as `linger` says, and, once it is
/// started, waits up to `answer_within` for it to answer.
pub async fn setup(
    env: &UserEnv,
    system: &dyn SignInSystem,
    definition: &StartupDefinition,
    linger: Linger,
    answer_within: Duration,
) -> SetupOutcome {
    let folders = match folders::resolve(env) {
        Ok(folders) => folders,
        Err(err) => return SetupOutcome::Failed(err.to_string()),
    };
    let home = match env.require_home() {
        Ok(home) => home.to_path_buf(),
        Err(err) => return SetupOutcome::Failed(err.to_string()),
    };
    let key = match data_folder_and_key(&folders.data) {
        Ok(key) => key,
        Err(why) => return SetupOutcome::Failed(why),
    };
    match register_and_start(system, definition, &home, &folders.data, linger) {
        Ok(Started::AtNextSignIn) => SetupOutcome::AtNextSignIn,
        Ok(started @ (Started::Running | Started::KeepsRunning)) => {
            if !answers(&folders, &key, answer_within).await {
                SetupOutcome::Failed(format!(
                    "the host was started but did not answer within {answer_within:?}; its log is {}",
                    folders.logs.join(LOG_FILE).display()
                ))
            } else if started == Started::KeepsRunning {
                SetupOutcome::KeepsRunning
            } else {
                SetupOutcome::Running
            }
        }
        Err(why) => SetupOutcome::Failed(why),
    }
}

/// Makes the data folder and the host's key when they are absent, and
/// answers the key, which the host proves when it answers.
fn data_folder_and_key(data: &Path) -> Result<KeyPair, String> {
    std::fs::create_dir_all(data)
        .map_err(|err| format!("could not make {}: {err}", data.display()))?;
    load_or_create_key_pair(&data.join(HOST_KEY_FILE)).map_err(|err| err.to_string())
}

/// Whether the host on `folders` answers within `within`: it takes a
/// connection proving its own `key`, as `floti devices` makes, and welcomes
/// it.
async fn answers(folders: &Folders, key: &KeyPair, within: Duration) -> bool {
    let endpoint = local_endpoint(folders);
    let deadline = Instant::now() + within;
    loop {
        if let Ok(mut connection) = client::connect(&endpoint, key, &key.public()).await {
            let welcomed = connection.say_hello(CLIENT_NAME, ClientKind::Other).await;
            connection.close().await;
            if welcomed.is_ok() {
                return true;
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(LOOK_AGAIN).await;
    }
}
