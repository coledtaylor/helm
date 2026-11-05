//! `floti`: the one binary. `floti host` runs the daemon that starts at the
//! user's sign-in; `floti host --desktop <program> [--desktop-arg <arg>]...`
//! runs it for the desktop that started it, which it outlives, exiting by
//! itself once nothing runs and no client is attached. `floti bridge`
//! connects a client from its folder to the host on this computer and relays
//! the protocol over standard input and output; `floti bridge <client
//! folder> -- <program> [<arg>...]` reaches a host on another computer
//! instead, through a transport such as `ssh -o BatchMode=yes <target>`, run
//! with `floti connect` as its last argument. A client that has pinned no
//! host learns its key the same way, pins it once the host proves it, and
//! connects; nothing is approved on the host. `floti connect` is what that
//! runs on the host's computer: it copies bytes between its standard input
//! and output and the host's local socket, unchanged, and `floti connect
//! --host-key` prints the host's public key for a client that has pinned
//! none. `--floti <path>` names floti's full path on the other computer, for
//! a login whose `PATH` does not have it; the lines run there are then
//! `<path> connect` and the rest. `floti update-stop <client folder> --ask |
//! --stop` is what an installer runs before it replaces the binary: it says
//! what stopping the host would end, then stops it; without a client folder
//! it is run on the host's own computer, as the host itself, and `--ask`
//! prints how many sessions it runs. `floti end-old-host <client folder>` is
//! what Helm runs, from the floti it carries, when the user chooses Restart
//! host to update for this PC's host and that host speaks protocol 1.x: only
//! when the host refuses this floti's hello naming protocol 1.x, it ends that
//! host's process alone, as a crash would, leaving its session keeper
//! running for the next host to take back. `floti doctor` checks that each host
//! this device uses answers, this computer's through its socket and each on
//! another computer through its own ssh or command, and prints one line per
//! host: its floti version and round trip, or the last line ssh or the
//! command wrote and the line to try by hand; it starts, pins and changes
//! nothing. `floti doctor --record` is how the desktop tells it those hosts,
//! as JSON on standard input. `floti version` prints one line:
//! Floti's version, the protocol version, and this OS and CPU. `floti setup`
//! registers the host to start at this user's sign-in and starts it in the
//! signed-in session; on a Linux server it first turns lingering on, so the
//! host runs with nobody signed in, and `--linger` or `--no-linger` chooses
//! either way on any Linux computer. A host started by the OS's mechanism
//! exits with status 0 whenever it is stopped on purpose, so the systemd
//! unit's restart on failure starts again only a host that crashed or was
//! killed. In WSL, where systemd's user manager does not answer, setup
//! registers nothing and records that the host starts on connect, and
//! `floti connect` then starts the host when nothing answers. `floti bridge
//! ... --as-written -- wsl.exe -d <distro> --` appends the line unquoted, as
//! `wsl.exe` reads it. `floti keep-awake`, run inside a distro by the
//! Windows host's `wsl:keepAwake` hold, follows its own host's sessions and
//! exits once none runs or the host stops, which lets the distro go.
//! `floti keeper <data folder> <runtime folder>` is the
//! session keeper a host starts for itself, which holds its sessions so they
//! outlive it; it is not run by hand.

mod end_old_host;
mod update_stop;

use std::ffi::OsString;
use std::path::Path;
use std::process::ExitCode;

use floti_host::bridge::{
    BridgeExit, Transport, remote_floti_problem, run_bridge, run_bridge_through,
};
use floti_host::connect::{ConnectStep, run_connect};
use floti_host::doctor::{DoctorStep, run_doctor};
use floti_host::keep_awake::run_keep_awake;
use floti_host::version;
use floti_host::{ALREADY_RUNNING_EXIT, DesktopCommand, Error, HostOptions, log_line};

const USAGE: &str = "usage: floti host [--desktop <program> [--desktop-arg <arg>]...]\n       floti bridge <client folder>\n       floti bridge <client folder> [--floti <path>] [--as-written] -- <program> [<arg>...]\n       floti connect [--host-key]\n       floti keep-awake\n       floti doctor [--record]\n       floti version\n       floti setup [--linger | --no-linger]\n       floti update-stop [<client folder>] --ask | --stop\n       floti end-old-host <client folder>";

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
            Some((folder, transport)) => {
                ExitCode::from(run_bridge_through(Path::new(&folder), &transport).code())
            }
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
        ["keep-awake"] => ExitCode::from(run_keep_awake()),
        ["doctor"] => ExitCode::from(run_doctor(DoctorStep::Check).code()),
        ["doctor", "--record"] => ExitCode::from(run_doctor(DoctorStep::Record).code()),
        ["update-stop", ..] => match update_stop::parse(&args[1..]) {
            Some((asker, step)) => ExitCode::from(update_stop::run(&asker, step)),
            None => usage(),
        },
        ["end-old-host", ..] => match end_old_host::parse(&args[1..]) {
            Some(folder) => ExitCode::from(end_old_host::run(&folder)),
            None => usage(),
        },
        ["version"] => {
            println!("{}", version::version_line());
            ExitCode::SUCCESS
        }
        ["setup", flags @ ..] => match floti_host::setup::parse_linger(flags) {
            Some(linger) => ExitCode::from(floti_host::setup::run_setup(linger)),
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
/// client folder, then, optionally, `--floti <path>`, the full path of floti
/// on the host's computer, then, optionally, `--as-written` for a program
/// that reads the line from its own command line as written (`wsl.exe` on
/// this PC), then `--` and the program with its arguments, each kept as the
/// OS gave it.
fn bridge_through(args: &[OsString]) -> Option<(OsString, Transport)> {
    let (folder, mut rest) = args.split_first()?;
    let mut floti: Option<String> = None;
    if let [flag, path, more @ ..] = rest
        && flag == "--floti"
    {
        let path = path.to_str()?;
        if let Some(problem) = remote_floti_problem(path) {
            eprintln!("floti bridge: {problem}");
            return None;
        }
        floti = Some(path.to_owned());
        rest = more;
    }
    let mut as_written = false;
    if let [flag, more @ ..] = rest
        && flag == "--as-written"
    {
        as_written = true;
        rest = more;
    }
    let [separator, program, args @ ..] = rest else {
        return None;
    };
    (!folder.is_empty() && separator == "--" && !program.is_empty()).then(|| {
        (
            folder.clone(),
            Transport {
                program: program.clone(),
                args: args.to_vec(),
                floti,
                as_written,
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
