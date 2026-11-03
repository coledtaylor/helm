//! The Floti host: one process per user that owns the sessions on this
//! computer and serves them to clients.
//!
//! Clients connect on a local socket only this user can open, prove a paired
//! device key in a Noise handshake with the host key they pinned, and speak
//! `floti-protocol` inside that session. Sessions run in ptys, each screen kept off-screen so a
//! client that attaches late draws it as it is, and they outlive their
//! clients: closing every client ends nothing. They outlive the host too:
//! their ptys and process trees are the session keeper's ([`keeper`]), a
//! second process the host starts, so a host that crashes, panics or is
//! killed takes none with it and the next host takes them back. Only a
//! deliberate stop ends them, and the keeper with them. The host owns their
//! lifetime: a client quitting ends the sessions it started only when it
//! asks to, a client crashing ends nothing, and a host a desktop started
//! exits by itself once nothing runs and nobody is attached.
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
//! - [`host_log`]: `host.log`, where `floti host` points its standard error,
//!   rotated so it stays bounded.
//! - [`resources`]: what each hosted session is holding (its process tree
//!   and listening ports), shaped from one read of the machine.
//! - [`usage`]: each backend's latest usage reading.
//! - [`workspace`]: the user's folders as the host serves them: settings,
//!   setup, discovery, profiles, templates and the Files view.
//! - [`session`]: sessions in ptys and the screens kept for them.
//! - [`keeper`]: `floti keeper`, the session keeper that holds every
//!   session's and plain terminal's pty and process tree, and the host's
//!   connection to it.
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
//!   output, to the host on this computer or, through a transport such as
//!   the user's own `ssh`, to one on another.
//! - [`connect`]: `floti connect`, what a transport runs on the host's
//!   computer: it copies bytes between its standard input and output and the
//!   host's local socket, unchanged.

/// Writes a line to standard error, as `eprintln!` does, then rotates the
/// host's log when that line took it past its limit ([`host_log`]). In
/// `floti host` standard error is the log; in a test process it is the test's
/// own. Every line the host writes about itself goes through here.
#[macro_export]
macro_rules! log_line {
    ($($arg:tt)*) => {{
        ::std::eprintln!($($arg)*);
        $crate::host_log::wrote();
    }};
}

pub mod agent;
pub mod agent_tools;
pub mod bridge;
pub mod carry;
pub mod client;
pub mod config_console;
pub mod connect;
pub mod devices;
pub mod error;
pub mod history;
pub mod host_log;
pub mod keeper;
pub mod keys;
pub mod platform;
pub mod plugins;
pub mod presence;
pub mod resources;
pub mod server;
pub mod session;
pub mod setup;
pub mod store;
pub mod usage;
pub mod version;
pub mod workspace;

#[cfg(any(test, feature = "testkit"))]
pub mod testkit;

pub use error::{Error, Result};

use std::ffi::OsString;
use std::sync::Arc;

use floti_protocol::channels::host::HostStopReason;
use jiff::Timestamp;
use tokio::sync::{mpsc, watch};

use host_log::HostLog;
use platform::folders::{Folders, UserEnv};
use platform::standard_error;
use platform::startup::{self, StopSignals};
use platform::tray::{self, NotificationArea};
use server::idle::{FIRST_CLIENT_WAIT, until_idle};
use server::{Host, HostConfig, Occupancy, Stopper};

/// The exit status of a `floti host` that would not start because another
/// host has its data folder or socket: one that is still ending its sessions
/// holds them until it has, so the program that started it may try again.
pub const ALREADY_RUNNING_EXIT: u8 = 3;

/// How `floti host` was asked to run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostOptions {
    /// The desktop that started this host, as the command that opens it
    /// again: `floti host --desktop <program> [--desktop-arg <arg>]...`.
    /// Such a host outlives that desktop and exits by itself once it runs
    /// nothing and no client is attached ([`server::idle`]). `None` is a host
    /// started on its own, which runs until it is stopped.
    pub desktop: Option<DesktopCommand>,
}

/// The program that started a host, and the arguments that open it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DesktopCommand {
    pub program: OsString,
    pub args: Vec<OsString>,
}

/// Runs the host until it is stopped: by a client, or by Ctrl+C, SIGTERM,
/// signing out or the other stop requests the OS makes, each of which is a
/// plain stop.
///
/// A host a desktop started ([`HostOptions::desktop`]) also stops by itself,
/// as a plain stop, once it runs no session or plain terminal and no client
/// is attached. Nothing else about the desktop ends it: a desktop that quits
/// on purpose says first what becomes of its sessions (`host:quit`), and one
/// that crashes or is killed ends nothing, so its next start finds its
/// sessions still running. While it runs something with no client attached,
/// it shows in the notification area, with its session count, Open (that
/// desktop again) and Stop host ([`platform::tray`]).
///
/// It refuses to start from an SSH session or as root or a Windows service
/// account before it opens anything, and refuses when another host already
/// has its data folder or socket ([`Error::AlreadyRunning`]). Whatever stops
/// it before it listens, it says why on the console ([`not_started`]).
///
/// Past the refusals, the first thing it opens is its log ([`host_log`]):
/// its standard error goes there from then on, a panic's message and a
/// failed allocation's last line included, after a line naming its version,
/// process and start.
pub fn run_host(options: HostOptions) -> Result<()> {
    let env = UserEnv::from_process();
    if let Some(refusal) = startup::launch_refusal(&env, startup::account()) {
        return not_started(Err(Error::Refused(refusal)));
    }
    let mut config = not_started(HostConfig::from_env(&env))?;
    config.run.desktop = options.desktop.is_some();
    let started = Timestamp::now();
    let log = open_log(&config.folders);
    host_log::note_panics();
    log_line!("{}", host_log::start_line(started));
    #[cfg(any(test, feature = "testkit"))]
    host_log::crash_if_asked(&config.folders.data);
    let runtime = not_started(
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|err| Error::io("start the host's runtime", err)),
    )?;
    let reason = runtime.block_on(async {
        let mut signals = not_started(StopSignals::register())?;
        let host = not_started(Host::start(config))?;
        if let Some(log) = log {
            own_log(log, started);
        }
        say(&format!("Floti host is listening at {}.", host.endpoint()));
        let stopper = host.stopper();
        let mut area = None;
        if let Some(desktop) = options.desktop {
            area = notification_area(desktop, host.occupancy(), stopper.clone());
            let occupancy = host.occupancy();
            let stopper = stopper.clone();
            tokio::spawn(async move {
                until_idle(occupancy, FIRST_CLIENT_WAIT).await;
                if stopper.stop(HostStopReason::Stop) {
                    say("Floti host is stopping: nothing is running and no client is attached.");
                }
            });
        }
        tokio::spawn(async move {
            let what = signals.recv().await;
            say(&format!("Floti host is stopping: {what}."));
            stopper.stop(HostStopReason::Stop);
        });
        let stopped = host.run_until_stopped().await;
        if let Some(area) = area
            && let Err(err) = area.hide()
        {
            log_line!("floti host: the notification area: {err}");
        }
        stopped
    });
    drop(runtime);
    let reason = reason?;
    say(match reason {
        HostStopReason::Stop => "Floti host stopped.",
        HostStopReason::Update => "Floti host stopped for an update.",
    });
    Ok(())
}

/// Opens the host's log in its logs folder and points standard error at it,
/// before anything else the host opens, so that whatever it writes from here
/// to its end is kept. A host that cannot open it says so where standard
/// error still goes, and runs on without one.
fn open_log(folders: &Folders) -> Option<&'static HostLog> {
    match host_log::install(
        &folders.logs,
        host_log::log_limit(&folders.data),
        standard_error::Native,
    ) {
        Ok(log) => Some(log),
        Err(err) => {
            log_line!("floti host: it keeps no log file: {err}");
            None
        }
    }
}

/// Once the host holds its data folder, no other host writes its log: one
/// past its limit is rotated now, and the new file opens with the start line
/// again.
fn own_log(log: &HostLog, started: Timestamp) {
    match log.own() {
        Ok(true) => log_line!("{}", host_log::start_line(started)),
        Ok(false) => {}
        Err(err) => log_line!("floti host: the log was not rotated: {err}"),
    }
}

/// Shows a host a desktop started in the notification area, as
/// [`tray::run`] decides, for as long as the host runs. `None` where the OS
/// has no notification area Floti draws in, or it could not be reached: the
/// host runs on as it would have.
fn notification_area(
    desktop: DesktopCommand,
    occupancy: watch::Receiver<Occupancy>,
    stopper: Stopper,
) -> Option<Arc<tray::Native>> {
    let (picked, picks) = mpsc::unbounded_channel();
    let area = match tray::Native::start(move |item| {
        let _ = picked.send(item);
    }) {
        Ok(area) => Arc::new(area),
        Err(Error::Unsupported { .. }) => return None,
        Err(err) => {
            log_line!("floti host: it shows no icon in the notification area: {err}");
            return None;
        }
    };
    tokio::spawn(tray::run(
        Arc::clone(&area),
        desktop,
        occupancy,
        picks,
        move || {
            if stopper.stop(HostStopReason::Stop) {
                say("Floti host is stopping: it was stopped from the notification area.");
            }
        },
    ));
    Some(area)
}

/// Says why the host did not start, on the console beside the line it
/// prints once it listens, where the desktop that started it reads it and
/// shows it. Standard error says it too, but nobody need be reading that.
fn not_started<T>(result: Result<T>) -> Result<T> {
    if let Err(err) = &result {
        say(&format!("Floti host did not start: {err}"));
    }
    result
}

/// A line on the console, where there is one. A host started at sign-in may
/// have nowhere to print, and the desktop that started one stops reading once
/// it is listening and may have gone since; neither is a reason to fail.
fn say(line: &str) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}").and_then(|()| out.flush());
}
