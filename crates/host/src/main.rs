//! `floti`: the one binary. `floti host` runs the daemon that starts at the
//! user's sign-in; `floti host --until-stdin-closes` runs it for a program
//! that started it, ending with that program. `floti bridge` connects a
//! client from its folder to the host on this computer and relays the
//! protocol over standard input and output.

use std::path::Path;
use std::process::ExitCode;

use floti_host::HostOptions;
use floti_host::bridge::{BridgeExit, run_bridge};

const USAGE: &str = "usage: floti host [--until-stdin-closes]\n       floti bridge <client folder>";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["host"] => host(HostOptions::default()),
        ["host", "--until-stdin-closes"] => host(HostOptions {
            until_stdin_closes: true,
        }),
        ["bridge", folder] if !folder.is_empty() => {
            ExitCode::from(run_bridge(Path::new(folder)).code())
        }
        ["--version"] | ["-V"] => {
            println!("floti {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        ["--help"] | ["-h"] => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(BridgeExit::Usage.code())
        }
    }
}

fn host(options: HostOptions) -> ExitCode {
    match floti_host::run_host(options) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("floti host: {err}");
            ExitCode::FAILURE
        }
    }
}
