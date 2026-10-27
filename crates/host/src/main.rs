//! `floti`: the one binary. `floti host` runs the daemon that starts at the
//! user's sign-in.

use std::process::ExitCode;

const USAGE: &str = "usage: floti host";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .as_slice()
    {
        ["host"] => match floti_host::run_host() {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("floti host: {err}");
                ExitCode::FAILURE
            }
        },
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
            ExitCode::from(2)
        }
    }
}
