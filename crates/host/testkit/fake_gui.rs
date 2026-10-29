//! `floti-fake-gui`: a program with no console, which is what a GUI app, or
//! a tool a CLI starts with its window hidden, is on Windows. It is built for
//! the `windows` subsystem, so it attaches to no console and gets none of a
//! console's events; macOS and Linux ignore the subsystem and run it as any
//! other program. The fake agent starts one for `--fake-gui-child`.
//!
//! It does nothing for `--fake-sleep=<ms>` milliseconds (ten minutes by
//! default), then exits 0, or exits 0 sooner once the test process that owns
//! it is gone, as the fake agent does (`owner.rs`).

#![windows_subsystem = "windows"]

mod owner;

use std::path::PathBuf;
use std::time::Duration;

use floti_host::platform::process_tree::{Native, ProcessTree};
use floti_protocol::Knowable;

const DEFAULT_MS: u64 = 600_000;

/// The fake agent's record folder, which it hands on to its children.
const LOG_VAR: &str = "FLOTI_FAKE_AGENT_LOG";

fn main() {
    let watched = std::env::var_os(LOG_VAR)
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok());
    if let Some(folder) = watched {
        owner::exit_when_owner_is_gone(&folder, |pid| {
            Native.is_alive(pid) != Knowable::Known(false)
        });
    }
    let ms = std::env::args()
        .skip(1)
        .find_map(|arg| arg.strip_prefix("--fake-sleep=")?.parse().ok())
        .unwrap_or(DEFAULT_MS);
    std::thread::sleep(Duration::from_millis(ms));
}
