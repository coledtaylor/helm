//! `floti`: the one binary. `floti host` runs the daemon that starts at the
//! user's sign-in; `floti host --desktop <program> [--desktop-arg <arg>]...`
//! runs it for the desktop that started it, which it outlives, exiting by
//! itself once nothing runs and no client is attached. `floti bridge`
//! connects a client from its folder to the host on this computer and relays
//! the protocol over standard input and output; `floti bridge <client
//! folder> [--pair <device name>] -- <program> [<arg>...]` reaches a host on
//! another computer instead, through a transport such as `ssh -o
//! BatchMode=yes <target>`, run with `floti connect` as its last argument,
//! and pairs first when given `--pair` and the client has pinned no host.
//! `floti connect` is what that runs on the host's computer: it copies bytes
//! between its standard input and output and the host's local socket,
//! unchanged, and `floti connect --host-key` prints the host's public key
//! for a device about to pair. `floti update-stop <client
//! folder> --ask | --stop` is what an installer runs before it replaces the
//! binary: it says what stopping the host would end, then stops it.
//! `floti devices` lists the devices paired with the host on this computer
//! and those waiting to pair, `floti devices approve <code>|- [--role
//! viewer|operator|admin]` pairs the one waiting under the code it shows
//! (`-` reads the code from standard input), and `floti devices revoke
//! <fingerprint>` revokes a device, closing its connections at once.
//! `floti bridge ... --pair <device name> --approve <role>` pairs in one
//! step: it runs `floti devices approve - --role <role>` through the same
//! transport, with its own code on that command's standard input.
//! `floti keeper <data folder> <runtime folder>` is the session keeper a
//! host starts for itself, which holds its sessions so they outlive it; it
//! is not run by hand.

mod devices_shell;
mod update_stop;

use std::ffi::OsString;
use std::path::Path;
use std::process::ExitCode;

use floti_host::bridge::{BridgeExit, Pair, Transport, run_bridge, run_bridge_through};
use floti_host::connect::{ConnectStep, run_connect};
use floti_host::{ALREADY_RUNNING_EXIT, DesktopCommand, Error, HostOptions, log_line};
use floti_protocol::channels::devices::DeviceRole;

const USAGE: &str = "usage: floti host [--desktop <program> [--desktop-arg <arg>]...]\n       floti bridge <client folder>\n       floti bridge <client folder> [--pair <device name> [--approve viewer|operator|admin]] -- <program> [<arg>...]\n       floti connect [--host-key]\n       floti update-stop <client folder> --ask | --stop\n       floti devices\n       floti devices approve <code>|- [--role viewer|operator|admin]\n       floti devices revoke <fingerprint>";

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.first().is_some_and(|first| first == "keeper") {
        return match &args[1..] {
            [data, runtime] if !data.is_empty() && !runtime.is_empty() => {
                keeper(Path::new(data), Path::new(runtime))
            }
            _ => usage(),
        };
    }
    if args.first().is_some_and(|first| first == "bridge") && args.len() > 2 {
        return match bridge_through(&args[1..]) {
            Some((folder, pair, transport)) => ExitCode::from(
                run_bridge_through(Path::new(&folder), pair.as_ref(), &transport).code(),
            ),
            None => usage(),
        };
    }
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
        ["connect"] => ExitCode::from(run_connect(ConnectStep::Relay).code()),
        ["connect", "--host-key"] => ExitCode::from(run_connect(ConnectStep::HostKey).code()),
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

/// What follows `bridge` when it reaches a host through a transport: the
/// client folder, then `--pair <device name>` (and, to pair in one step,
/// `--approve <role>`) or nothing, then `--` and the program with its
/// arguments, each kept as the OS gave it.
fn bridge_through(args: &[OsString]) -> Option<(OsString, Option<Pair>, Transport)> {
    let (folder, rest) = args.split_first()?;
    let (pair, rest) = match rest {
        [flag, name, rest @ ..] if flag == "--pair" => {
            let name = name.to_str().filter(|name| !name.trim().is_empty())?;
            let (approve, rest) = match rest {
                [flag, role, rest @ ..] if flag == "--approve" => {
                    let role = match role.to_str()? {
                        "viewer" => DeviceRole::Viewer,
                        "operator" => DeviceRole::Operator,
                        "admin" => DeviceRole::Admin,
                        _ => return None,
                    };
                    (Some(role), rest)
                }
                _ => (None, rest),
            };
            (
                Some(Pair {
                    name: name.to_owned(),
                    approve,
                }),
                rest,
            )
        }
        _ => (None, rest),
    };
    let [separator, program, args @ ..] = rest else {
        return None;
    };
    (!folder.is_empty() && separator == "--" && !program.is_empty()).then(|| {
        (
            folder.clone(),
            pair,
            Transport {
                program: program.clone(),
                args: args.to_vec(),
            },
        )
    })
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

fn keeper(data: &Path, runtime: &Path) -> ExitCode {
    match floti_host::keeper::run_keeper(data, runtime) {
        Ok(()) => ExitCode::SUCCESS,
        Err((status, err)) => {
            log_line!("floti keeper: {err}");
            ExitCode::from(status)
        }
    }
}

fn host(options: HostOptions) -> ExitCode {
    match floti_host::run_host(options) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err @ Error::AlreadyRunning(_)) => {
            log_line!("floti host: {err}");
            ExitCode::from(ALREADY_RUNNING_EXIT)
        }
        Err(err) => {
            log_line!("floti host: {err}");
            ExitCode::FAILURE
        }
    }
}
