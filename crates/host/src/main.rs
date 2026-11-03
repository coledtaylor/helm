//! `floti`: the one binary. `floti host` runs the daemon that starts at the
//! user's sign-in; `floti host --desktop <program> [--desktop-arg <arg>]...`
//! runs it for the desktop that started it, which it outlives, exiting by
//! itself once nothing runs and no client is attached. `floti bridge`
//! connects a client from its folder to the host on this computer and relays
//! the protocol over standard input and output. `floti update-stop <client
//! folder> --ask | --stop` is what an installer runs before it replaces the
//! binary: it says what stopping the host would end, then stops it.
//! `floti devices` lists the devices paired with the host on this computer
//! and those waiting to pair, and `floti devices approve <code> [--role
//! viewer|operator|admin]` pairs the one waiting under the code it shows.

mod devices_shell;
mod update_stop;

use std::ffi::OsString;
use std::path::Path;
use std::process::ExitCode;

use floti_host::bridge::{BridgeExit, run_bridge};
use floti_host::{ALREADY_RUNNING_EXIT, DesktopCommand, Error, HostOptions};

const USAGE: &str = "usage: floti host [--desktop <program> [--desktop-arg <arg>]...]\n       floti bridge <client folder>\n       floti update-stop <client folder> --ask | --stop\n       floti devices\n       floti devices approve <code> [--role viewer|operator|admin]";

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.first().is_some_and(|first| first == "host") {
        return match host_options(&args[1..]) {
            Some(options) => host(options),
            None => usage(),
        };
    }
    let args: Vec<String> = args
        .into_iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["bridge", folder] if !folder.is_empty() => {
            ExitCode::from(run_bridge(Path::new(folder)).code())
        }
        ["update-stop", ..] => match update_stop::parse(&args[1..]) {
            Some((folder, step)) => ExitCode::from(update_stop::run(&folder, step)),
            None => usage(),
        },
        ["devices", ..] => match devices_shell::parse(&args[1..]) {
            Some(step) => ExitCode::from(devices_shell::run(&step)),
            None => usage(),
        },
        ["--version"] | ["-V"] => {
            println!("floti {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        ["--help"] | ["-h"] => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        _ => usage(),
    }
}

fn usage() -> ExitCode {
    eprintln!("{USAGE}");
    ExitCode::from(BridgeExit::Usage.code())
}

/// What follows `host`: nothing, or `--desktop <program>` and any number of
/// `--desktop-arg <arg>`, each a path or argument kept as the OS gave it.
fn host_options(args: &[OsString]) -> Option<HostOptions> {
    let mut args = args.iter();
    let mut desktop: Option<DesktopCommand> = None;
    while let Some(flag) = args.next() {
        let value = args.next().filter(|value| !value.is_empty())?.clone();
        if flag == "--desktop" && desktop.is_none() {
            desktop = Some(DesktopCommand {
                program: value,
                args: Vec::new(),
            });
        } else if flag == "--desktop-arg" {
            desktop.as_mut()?.args.push(value);
        } else {
            return None;
        }
    }
    Some(HostOptions { desktop })
}

fn host(options: HostOptions) -> ExitCode {
    match floti_host::run_host(options) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err @ Error::AlreadyRunning(_)) => {
            eprintln!("floti host: {err}");
            ExitCode::from(ALREADY_RUNNING_EXIT)
        }
        Err(err) => {
            eprintln!("floti host: {err}");
            ExitCode::FAILURE
        }
    }
}
