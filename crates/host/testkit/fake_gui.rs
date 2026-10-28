//! `floti-fake-gui`: a program with no console, which is what a GUI app, or
//! a tool a CLI starts with its window hidden, is on Windows. It is built for
//! the `windows` subsystem, so it attaches to no console and gets none of a
//! console's events; macOS and Linux ignore the subsystem and run it as any
//! other program. The fake agent starts one for `--fake-gui-child`.
//!
//! It does nothing for `--fake-sleep=<ms>` milliseconds (ten minutes by
//! default), then exits 0.

#![windows_subsystem = "windows"]

use std::time::Duration;

const DEFAULT_MS: u64 = 600_000;

fn main() {
    let ms = std::env::args()
        .skip(1)
        .find_map(|arg| arg.strip_prefix("--fake-sleep=")?.parse().ok())
        .unwrap_or(DEFAULT_MS);
    std::thread::sleep(Duration::from_millis(ms));
}
