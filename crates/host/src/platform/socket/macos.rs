//! The local socket on macOS: a `0600` Unix socket in a `0700` folder owned
//! by this user. The socket itself is the Unix one shared with Linux; the
//! folders concern decides where the runtime folder is.

pub use super::unix::{Listener, Native};

/// Every TCP socket listening and every UDP socket bound in process `pid`,
/// one line each, from `lsof`, which is part of macOS.
#[cfg(any(test, feature = "testkit"))]
pub fn network_listeners(pid: u32) -> std::io::Result<Vec<String>> {
    let output = std::process::Command::new("lsof")
        .args(["-nP", "-a", "-p", &pid.to_string(), "-i"])
        .output()?;
    // lsof exits 1 with nothing on stdout when the process has no network
    // files, which is the answer, not a failure.
    if !output.status.success() && !output.stdout.is_empty() {
        return Err(std::io::Error::other(format!(
            "lsof failed: {}",
            output.status
        )));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text
        .lines()
        .skip(1)
        .filter(|line| {
            // COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
            let node = line.split_whitespace().nth(7);
            node == Some("UDP") || (node == Some("TCP") && line.ends_with("(LISTEN)"))
        })
        .map(str::to_owned)
        .collect())
}
