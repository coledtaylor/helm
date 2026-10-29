//! The Floti host: one process per user that owns the sessions on this
//! computer and serves them to clients.
//!
//! Clients connect on a local socket only this user can open, prove a paired
//! device key in a Noise handshake with the host key they pinned, and speak
//! `floti-protocol` inside that session. Sessions run in ptys, each screen kept off-screen so a
//! client that attaches late draws it as it is, and they outlive their
//! clients: closing every client ends nothing. They never outlive the host:
//! stopping it ends them, and so does killing it.
//!
//! The modules, one concern each:
//!
//! - [`agent`]: the `AgentBackend` trait every agent CLI is run through.
//! - [`agent_tools`]: the loopback listener that serves Floti's agent tools
//!   to the sessions it hosts, one bearer token per session.
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
//! - [`plugins`]: registered plugin folders; each one's background script in
//!   a deno_core isolate of its own; and the call layer every `floti.*`
//!   method goes through, with `floti.exec`, `floti.fetch`, settings and the
//!   sealed secret store behind it.
//! - [`server`]: the local socket's clients, the Noise session each one
//!   opens with, and the protocol they speak inside it.
//! - [`keys`]: the key pairs Floti keeps on disk, the host's and a
//!   client's, each in an owner-only file; never printed, logged or sent.
//! - [`devices`]: the device registry, which device keys are paired with
//!   this host and which were revoked.
//! - [`client`]: a client's side, for the clients that link this crate: its
//!   device key and pinned host key on disk, and a Noise session to a host.
//! - [`bridge`]: `floti bridge`, that client side for a program that does
//!   not link this crate, relaying the protocol over its standard input and
//!   output.

pub mod agent;
pub mod agent_tools;
pub mod bridge;
pub mod client;
pub mod config_console;
pub mod devices;
pub mod error;
pub mod history;
pub mod keys;
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

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use floti_protocol::channels::host::HostStopReason;

use platform::folders::UserEnv;
use platform::startup::{self, StopSignals};
use server::{Host, HostConfig};

/// How `floti host` was asked to run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct HostOptions {
    /// Stop as well when standard input reaches end of file: for a host
    /// started by a program that holds its standard input open, such as the
    /// desktop, so the host ends with that program however it ends.
    pub until_stdin_closes: bool,
}

/// Runs the host until it is stopped: by a client, or by Ctrl+C, SIGTERM,
/// signing out or the other stop requests the OS makes, each of which is a
/// plain stop.
///
/// With [`HostOptions::until_stdin_closes`], standard input reaching end of
/// file stops it too, unless a stop was asked for first, which stays what it
/// was. That stop ends every session's process tree and leaves their rows,
/// as a stop for an update does, for the next start to find lost and offer
/// back once: the program that started the host has gone, and whoever starts
/// it next decides what to reopen.
///
/// It refuses to start from an SSH session or as root or a Windows service
/// account before it opens anything, and refuses when another host already
/// has its data folder or socket.
pub fn run_host(options: HostOptions) -> Result<()> {
    let env = UserEnv::from_process();
    if let Some(refusal) = startup::launch_refusal(&env, startup::account()) {
        return Err(Error::Refused(refusal));
    }
    let config = HostConfig::from_env(&env)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|err| Error::io("start the host's runtime", err))?;
    let starter_gone = Arc::new(AtomicBool::new(false));
    let stopped = runtime.block_on(async {
        let mut signals = StopSignals::register()?;
        let host = Host::start(config)?;
        say(&format!("Floti host is listening at {}.", host.endpoint()));
        let stopper = host.stopper();
        if options.until_stdin_closes {
            let stdin_closed = stdin_closed();
            let stopper = stopper.clone();
            let gone = Arc::clone(&starter_gone);
            tokio::spawn(async move {
                if stdin_closed.await.is_ok() && stopper.stop(HostStopReason::Update) {
                    gone.store(true, Ordering::SeqCst);
                    say("Floti host is stopping: the program that started it has gone.");
                }
            });
        }
        tokio::spawn(async move {
            let what = signals.recv().await;
            say(&format!("Floti host is stopping: {what}."));
            stopper.stop(HostStopReason::Stop);
        });
        host.run_until_stopped().await
    });
    // The thread waiting on standard input is not the runtime's, so dropping
    // the runtime does not wait for it; it goes with the process.
    drop(runtime);
    let reason = stopped?;
    say(match reason {
        _ if starter_gone.load(Ordering::SeqCst) => {
            "Floti host stopped: the program that started it has gone, so its sessions are offered back at the next start."
        }
        HostStopReason::Stop => "Floti host stopped.",
        HostStopReason::Update => "Floti host stopped for an update.",
    });
    Ok(())
}

/// Resolves once standard input reaches end of file, or cannot be read,
/// which says the same: nothing holds it open. Read on a thread of its own,
/// and anything read is ignored.
fn stdin_closed() -> tokio::sync::oneshot::Receiver<()> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut stdin = std::io::stdin().lock();
        let mut buf = [0; 4096];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(_) => {}
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        let _ = tx.send(());
    });
    rx
}

/// A line on the console, where there is one. A host started at sign-in may
/// have nowhere to print, which is not a reason to fail.
fn say(line: &str) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}").and_then(|()| out.flush());
}
