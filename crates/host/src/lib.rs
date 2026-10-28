//! The Floti host: one process per user that owns the sessions on this
//! computer and serves them to clients.
//!
//! Clients connect on a local socket only this user can open and speak
//! `floti-protocol`. Sessions run in ptys, each screen kept off-screen so a
//! client that attaches late draws it as it is, and they outlive their
//! clients: closing every client ends nothing. They never outlive the host:
//! stopping it ends them, and so does killing it.
//!
//! The modules, one concern each:
//!
//! - [`agent`]: the `AgentBackend` trait every agent CLI is run through.
//! - [`config_console`]: an agent's config files, read through its backend and
//!   changed only through one snapshot-first writer; served to clients as
//!   `config:*`.
//! - [`platform`]: what differs by OS, behind one trait per concern. Nothing
//!   outside its per-OS files is conditional on the OS.
//! - [`store`]: `floti.db`, which only the host opens.
//! - [`history`]: the history index and the transcript archive in it.
//! - [`resources`]: what each hosted session is holding (its process tree
//!   and listening ports), shaped from one read of the machine.
//! - [`usage`]: each backend's latest usage reading.
//! - [`workspace`]: the user's folders as the host serves them: settings,
//!   setup, discovery, profiles, templates and the Files view.
//! - [`session`]: sessions in ptys and the screens kept for them.
//! - [`plugins`]: registered plugin folders, the isolate plugin scripts run
//!   in, and the call layer every `floti.*` method goes through.
//! - [`server`]: the local socket's clients and the protocol they speak.

pub mod agent;
pub mod config_console;
pub mod error;
pub mod history;
pub mod platform;
pub mod plugins;
pub mod resources;
pub mod server;
pub mod session;
pub mod store;
pub mod usage;
pub mod workspace;

#[cfg(any(test, feature = "testkit"))]
pub mod testkit;

pub use error::{Error, Result};

use floti_protocol::channels::host::HostStopReason;

use platform::folders::UserEnv;
use platform::startup::{self, StopSignals};
use server::{Host, HostConfig};

/// Runs the host until it is stopped: by a client, or by Ctrl+C, SIGTERM,
/// signing out or the other stop requests the OS makes, each of which is a
/// plain stop.
///
/// It refuses to start from an SSH session or as root or a Windows service
/// account before it opens anything, and refuses when another host already
/// has its data folder or socket.
pub fn run_host() -> Result<()> {
    let env = UserEnv::from_process();
    if let Some(refusal) = startup::launch_refusal(&env, startup::account()) {
        return Err(Error::Refused(refusal));
    }
    let config = HostConfig::from_env(&env)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|err| Error::io("start the host's runtime", err))?;
    runtime.block_on(async {
        let mut signals = StopSignals::register()?;
        let host = Host::start(config)?;
        say(&format!("Floti host is listening at {}.", host.endpoint()));
        let stopper = host.stopper();
        tokio::spawn(async move {
            let what = signals.recv().await;
            say(&format!("Floti host is stopping: {what}."));
            stopper.stop(HostStopReason::Stop);
        });
        let reason = host.run_until_stopped().await?;
        say(match reason {
            HostStopReason::Stop => "Floti host stopped.",
            HostStopReason::Update => "Floti host stopped for an update.",
        });
        Ok(())
    })
}

/// A line on the console, where there is one. A host started at sign-in may
/// have nowhere to print, which is not a reason to fail.
fn say(line: &str) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}").and_then(|()| out.flush());
}
