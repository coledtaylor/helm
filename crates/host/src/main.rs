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
//! for a device about to pair. `--floti <path>` names floti's full path on
//! the other computer, for a login whose `PATH` does not have it; the lines
//! run there are then `<path> connect` and the rest. `floti update-stop
//! <client folder> --ask | --stop` is what an installer runs before it
//! replaces the binary: it says what stopping the host would end, then
//! stops it; without a client folder it is run on the host's own computer,
//! as the host itself, and `--ask` prints how many sessions it runs.
//! `floti version` prints one line: Floti's version, the protocol version,
//! and this OS and CPU. `floti setup` registers the host to start at this
//! user's sign-in and starts it in the signed-in session.
//! `floti devices` lists the devices paired with the host on this computer
//! and those waiting to pair, `floti devices approve <code>|- [--role
//! viewer|operator|admin]` pairs the one waiting under the code it shows
//! (`-` reads the code from standard input), and `floti devices revoke
//! <fingerprint>` revokes a device, closing its connections at once.
//! `floti bridge ... --pair <device name> --approve <role>` pairs in one
//! step: it runs `floti devices approve - --role <role>` through the same
//! transport, with its own code on that command's standard input.
//! `floti presence [--window <handle>] <reason>` asks this computer to
//! confirm its user is present, for the desktop to tell a host on another
//! computer before an admin action there.
//! `floti keeper <data folder> <runtime folder>` is the session keeper a
//! host starts for itself, which holds its sessions so they outlive it; it
//! is not run by hand.

mod devices_shell;
mod update_stop;

use std::ffi::OsString;
use std::path::Path;
use std::process::ExitCode;

use floti_host::bridge::{
    BridgeExit, Pair, Transport, remote_floti_problem, run_bridge, run_bridge_through,
};
use floti_host::connect::{ConnectStep, run_connect};
use floti_host::{ALREADY_RUNNING_EXIT, DesktopCommand, Error, HostOptions, log_line};
use floti_host::{presence, version};
use floti_protocol::channels::devices::DeviceRole;

const USAGE: &str = "usage: floti host [--desktop <program> [--desktop-arg <arg>]...]\n       floti bridge <client folder>\n       floti bridge <client folder> [--pair <device name> [--approve viewer|operator|admin]] [--floti <path>] -- <program> [<arg>...]\n       floti connect [--host-key]\n       floti version\n       floti setup\n       floti update-stop [<client folder>] --ask | --stop\n       floti devices\n       floti devices approve <code>|- [--role viewer|operator|admin]\n       floti devices revoke <fingerprint>\n       floti presence [--window <handle>] <reason>";

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
            Some((asker, step)) => ExitCode::from(update_stop::run(&asker, step)),
            None => usage(),
        },
        ["version"] => {
            println!("{}", version::version_line());
            ExitCode::SUCCESS
        }
        ["setup"] => ExitCode::from(floti_host::setup::run_setup()),
        ["presence", ..] => match presence::parse(&args[1..]) {
            Some(ask) => ExitCode::from(presence::run(&ask).code()),
            None => usage(),
        },
        ["devices", ..] => match devices_shell::parse(&args[1..]) {
            Some(step) => ExitCode::from(devices_shell::run(&step)),
            None => usage(),
        },
        ["--version"] | ["-V"] => {
            println!("floti {}", version::FLOTI_VERSION);
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
/// client folder, then, in any order, `--pair <device name>` (with
/// `--approve <role>` to pair in one step) and `--floti <path>`, the full
/// path of floti on the host's computer, then `--` and the program with its
/// arguments, each kept as the OS gave it.
fn bridge_through(args: &[OsString]) -> Option<(OsString, Option<Pair>, Transport)> {
    let (folder, mut rest) = args.split_first()?;
    let mut name: Option<String> = None;
    let mut approve: Option<DeviceRole> = None;
    let mut floti: Option<String> = None;
    loop {
        match rest {
            [flag, value, more @ ..] if flag == "--pair" && name.is_none() => {
                let value = value.to_str().filter(|name| !name.trim().is_empty())?;
                name = Some(value.to_owned());
                rest = more;
            }
            [flag, role, more @ ..] if flag == "--approve" && approve.is_none() => {
                approve = Some(match role.to_str()? {
                    "viewer" => DeviceRole::Viewer,
                    "operator" => DeviceRole::Operator,
                    "admin" => DeviceRole::Admin,
                    _ => return None,
                });
                rest = more;
            }
            [flag, path, more @ ..] if flag == "--floti" && floti.is_none() => {
                let path = path.to_str()?;
                if let Some(problem) = remote_floti_problem(path) {
                    eprintln!("floti bridge: {problem}");
                    return None;
                }
                floti = Some(path.to_owned());
                rest = more;
            }
            _ => break,
        }
    }
    // `--approve` approves a request to pair, so it comes with `--pair`.
    if approve.is_some() && name.is_none() {
        return None;
    }
    let pair = name.map(|name| Pair { name, approve });
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
                floti,
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
