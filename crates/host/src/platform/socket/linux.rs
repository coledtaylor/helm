//! The local socket on Linux: a `0600` Unix socket in `$XDG_RUNTIME_DIR/floti`,
//! a `0700` folder owned by this user. The socket itself is the Unix one
//! shared with macOS; the folders concern puts the runtime folder there.

pub use super::unix::{Listener, Native};

/// Every TCP socket listening and every UDP socket bound in process `pid`,
/// one line each. It matches the socket inodes among the process's open
/// files against `/proc/<pid>/net/{tcp,tcp6,udp,udp6}`, read in the process's
/// own network namespace.
#[cfg(any(test, feature = "testkit"))]
pub fn network_listeners(pid: u32) -> std::io::Result<Vec<String>> {
    use std::collections::BTreeSet;
    use std::fs;

    /// The TCP state LISTEN in /proc/net/tcp.
    const TCP_LISTEN: &str = "0A";

    let proc = format!("/proc/{pid}");
    let mut inodes = BTreeSet::new();
    for entry in fs::read_dir(format!("{proc}/fd"))? {
        // A descriptor closed while this reads is no longer the process's.
        let Ok(target) = fs::read_link(entry?.path()) else {
            continue;
        };
        if let Some(inode) = target
            .to_str()
            .and_then(|t| t.strip_prefix("socket:["))
            .and_then(|t| t.strip_suffix(']'))
        {
            inodes.insert(inode.to_owned());
        }
    }

    let mut found = Vec::new();
    for table in ["tcp", "tcp6", "udp", "udp6"] {
        let text = match fs::read_to_string(format!("{proc}/net/{table}")) {
            Ok(text) => text,
            // A kernel without IPv6 has no tcp6 or udp6 table.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        for line in text.lines().skip(1) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let (Some(local), Some(state), Some(inode)) =
                (fields.get(1), fields.get(3), fields.get(9))
            else {
                continue;
            };
            let listening = table.starts_with("udp") || *state == TCP_LISTEN;
            if listening && inodes.contains(*inode) {
                found.push(format!("{table} {local}"));
            }
        }
    }
    Ok(found)
}
