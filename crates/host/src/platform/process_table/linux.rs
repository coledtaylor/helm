//! The process table and listening sockets on Linux, read from `/proc`.
//!
//! Each process is `/proc/<pid>/stat` (its name, which can hold spaces and
//! parentheses, between the first `(` and the last `)`) and
//! `/proc/<pid>/cmdline` (NUL-separated, and empty for a kernel thread). The
//! listening sockets are the LISTEN rows (state `0A`) of `/proc/net/tcp` and
//! `/proc/net/tcp6`, each matched to the processes holding it through the
//! socket inodes their `/proc/<pid>/fd` links name. A process of another
//! user's whose descriptors cannot be read holds no socket this can see, as
//! with `ss` run by the same user.

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::Path;

use super::{PortRow, ProcessRow, ProcessTable};
use crate::{Error, Result};

/// Where the kernel shows its processes.
const PROC: &str = "/proc";

/// The state column's LISTEN.
const LISTEN: &str = "0A";

/// The Linux implementation.
#[derive(Debug, Clone, Copy, Default)]
pub struct Native;

impl ProcessTable for Native {
    fn processes(&self) -> Result<Vec<ProcessRow>> {
        read_processes(Path::new(PROC)).map_err(|err| Error::io("list the processes", err))
    }

    fn listening(&self) -> Result<Vec<PortRow>> {
        read_listening(Path::new(PROC)).map_err(|err| Error::io("list the listening sockets", err))
    }
}

/// The pids `proc` lists.
fn pids(proc: &Path) -> io::Result<Vec<u32>> {
    Ok(std::fs::read_dir(proc)?
        .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
        .collect())
}

/// Every process in a folder shaped like `/proc`, leaving out any that ended
/// between the listing and the read.
fn read_processes(proc: &Path) -> io::Result<Vec<ProcessRow>> {
    let mut rows = Vec::new();
    for pid in pids(proc)? {
        let folder = proc.join(pid.to_string());
        let Ok(stat) = std::fs::read_to_string(folder.join("stat")) else {
            continue;
        };
        let Some((pid, parent_pid, name)) = parse_stat(&stat) else {
            continue;
        };
        let command_line = std::fs::read(folder.join("cmdline"))
            .ok()
            .and_then(|bytes| parse_cmdline(&bytes));
        rows.push(ProcessRow {
            pid,
            parent_pid,
            name,
            command_line,
        });
    }
    Ok(rows)
}

/// The pid, parent pid and name in a `stat` line.
fn parse_stat(line: &str) -> Option<(u32, u32, String)> {
    let open = line.find('(')?;
    let close = line.rfind(')')?;
    if close < open {
        return None;
    }
    let pid = line[..open].trim().parse().ok()?;
    let name = line[open + 1..close].to_owned();
    let mut rest = line[close + 1..].split_whitespace();
    let _state = rest.next()?;
    let parent_pid = rest.next()?.parse().ok()?;
    Some((pid, parent_pid, name))
}

/// A NUL-separated command line, joined with spaces; `None` for a kernel
/// thread, which has none.
fn parse_cmdline(bytes: &[u8]) -> Option<String> {
    let end = bytes.iter().rposition(|byte| *byte != 0)? + 1;
    let joined: Vec<u8> = bytes[..end]
        .iter()
        .map(|byte| if *byte == 0 { b' ' } else { *byte })
        .collect();
    Some(String::from_utf8_lossy(&joined).into_owned())
}

/// A listening socket: its port and address.
type Listener = (u16, IpAddr);

/// Every listening TCP socket in a folder shaped like `/proc`, once per
/// process holding it.
fn read_listening(proc: &Path) -> io::Result<Vec<PortRow>> {
    let mut sockets: HashMap<u64, Listener> = HashMap::new();
    parse_net_tcp(
        &std::fs::read_to_string(proc.join("net").join("tcp"))?,
        &mut sockets,
    );
    // A kernel without IPv6 has no tcp6, which is no IPv6 listener.
    match std::fs::read_to_string(proc.join("net").join("tcp6")) {
        Ok(text) => parse_net_tcp(&text, &mut sockets),
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(err),
    }
    let mut rows = Vec::new();
    if sockets.is_empty() {
        return Ok(rows);
    }
    for pid in pids(proc)? {
        let Ok(fds) = std::fs::read_dir(proc.join(pid.to_string()).join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let Ok(target) = std::fs::read_link(fd.path()) else {
                continue;
            };
            let Some(inode) = socket_inode(&target.to_string_lossy()) else {
                continue;
            };
            if let Some((port, address)) = sockets.get(&inode) {
                rows.push(PortRow {
                    pid,
                    port: *port,
                    address: Some(address.to_string()),
                });
            }
        }
    }
    Ok(rows)
}

/// The inode in a descriptor's link, `socket:[<inode>]`.
fn socket_inode(target: &str) -> Option<u64> {
    target
        .strip_prefix("socket:[")?
        .strip_suffix(']')?
        .parse()
        .ok()
}

/// The LISTEN rows of a `/proc/net/tcp` or `tcp6` table, by inode.
fn parse_net_tcp(text: &str, into: &mut HashMap<u64, Listener>) {
    for line in text.lines().skip(1) {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let (Some(local), Some(state), Some(inode)) = (fields.get(1), fields.get(3), fields.get(9))
        else {
            continue;
        };
        if *state != LISTEN {
            continue;
        }
        let (Some(listener), Ok(inode)) = (parse_local(local), inode.parse::<u64>()) else {
            continue;
        };
        into.insert(inode, listener);
    }
}

/// `<address>:<port>` in hex, the address as the kernel prints it: each 32
/// bits of the network-order address as one number in this machine's order.
fn parse_local(local: &str) -> Option<Listener> {
    let (address, port) = local.split_once(':')?;
    let port = u16::from_str_radix(port, 16).ok()?;
    let word = |at: usize| -> Option<[u8; 4]> {
        Some(
            u32::from_str_radix(address.get(at..at + 8)?, 16)
                .ok()?
                .to_ne_bytes(),
        )
    };
    let address = match address.len() {
        8 => IpAddr::V4(Ipv4Addr::from(word(0)?)),
        32 => {
            let mut bytes = [0u8; 16];
            for (i, chunk) in bytes.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                *chunk = word(i * 8)?;
            }
            IpAddr::V6(Ipv6Addr::from(bytes))
        }
        _ => return None,
    };
    Some((port, address))
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::symlink;

    use super::*;
    use crate::testkit::TestDirs;

    const STAT_PLAIN: &str = "733 (node) S 702 733 702 0 -1 4194560";
    const STAT_ODD: &str = "901 (tmux: server (1)) S 1 901 901 0 -1 4194624";

    #[test]
    fn a_stat_line_is_read_including_a_name_with_spaces_and_parentheses() {
        assert_eq!(parse_stat(STAT_PLAIN), Some((733, 702, "node".to_owned())));
        assert_eq!(
            parse_stat(STAT_ODD),
            Some((901, 1, "tmux: server (1)".to_owned()))
        );
        assert_eq!(parse_stat("garbage"), None);
    }

    #[test]
    fn a_nul_separated_command_line_is_joined_and_a_kernel_thread_has_none() {
        assert_eq!(
            parse_cmdline(b"node\0/srv/app server.mjs\0--port\x005173\0").as_deref(),
            Some("node /srv/app server.mjs --port 5173")
        );
        assert_eq!(parse_cmdline(b""), None);
    }

    #[test]
    fn a_local_address_reads_as_the_kernel_prints_it_with_a_wildcard_as_every_address() {
        let loopback = u32::from_ne_bytes([127, 0, 0, 1]);
        assert_eq!(
            parse_local(&format!("{loopback:08X}:1435")),
            Some((5173, "127.0.0.1".parse().unwrap()))
        );
        assert_eq!(
            parse_local("00000000:1F90"),
            Some((8080, "0.0.0.0".parse().unwrap()))
        );
        let one = u32::from_ne_bytes([0, 0, 0, 1]);
        assert_eq!(
            parse_local(&format!("000000000000000000000000{one:08X}:1435")),
            Some((5173, "::1".parse().unwrap()))
        );
        assert_eq!(
            parse_local("00000000000000000000000000000000:1F90"),
            Some((8080, "::".parse().unwrap()))
        );
        assert_eq!(parse_local("nonsense"), None);
    }

    /// A folder shaped like `/proc`: two processes of a session, a kernel
    /// thread, an entry that is not a pid, and one that vanished between the
    /// listing and the read.
    struct FakeProc {
        root: std::path::PathBuf,
        _dirs: TestDirs,
    }

    impl FakeProc {
        fn new() -> Self {
            let dirs = TestDirs::new();
            let root = dirs.folder("proc");
            let add = |pid: u32, stat: &str, cmdline: Option<&[u8]>| {
                let folder = root.join(pid.to_string());
                std::fs::create_dir_all(folder.join("fd")).unwrap();
                std::fs::write(folder.join("stat"), stat).unwrap();
                if let Some(cmdline) = cmdline {
                    std::fs::write(folder.join("cmdline"), cmdline).unwrap();
                }
            };
            add(
                702,
                "702 (claude) S 701 702 701 0 -1 0",
                Some(b"claude\0--name\0my session\0"),
            );
            add(733, STAT_PLAIN, Some(b"node\0server.mjs\0"));
            add(2, "2 (kthreadd) S 0 0 0 0 -1 0", Some(b""));
            std::fs::create_dir_all(root.join("self")).unwrap();
            std::fs::create_dir_all(root.join("999")).unwrap();
            // 733 holds the listener on 5173 on both families; 702 holds a
            // socket that is not listening.
            symlink("socket:[1001]", root.join("733/fd/3")).unwrap();
            symlink("socket:[1002]", root.join("733/fd/4")).unwrap();
            symlink("socket:[1003]", root.join("702/fd/5")).unwrap();
            symlink("/dev/null", root.join("702/fd/0")).unwrap();
            let net = root.join("net");
            std::fs::create_dir_all(&net).unwrap();
            let header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
            let loopback = u32::from_ne_bytes([127, 0, 0, 1]);
            std::fs::write(
                net.join("tcp"),
                format!(
                    "{header}   0: {loopback:08X}:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1001 1 0 100 0 0 10 0\n   1: {loopback:08X}:9C40 {loopback:08X}:1435 01 00000000:00000000 00:00000000 00000000  1000        0 1003 1 0 100 0 0 10 0\n   2: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4242 1 0 100 0 0 10 0\n"
                ),
            )
            .unwrap();
            let one = u32::from_ne_bytes([0, 0, 0, 1]);
            std::fs::write(
                net.join("tcp6"),
                format!(
                    "{header}   0: 000000000000000000000000{one:08X}:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1002 1 0 100 0 0 10 0\n"
                ),
            )
            .unwrap();
            Self { root, _dirs: dirs }
        }
    }

    #[test]
    fn the_table_is_listed_leaving_out_what_vanished_between_the_listing_and_the_read() {
        let proc = FakeProc::new();
        let mut rows = read_processes(&proc.root).unwrap();
        rows.sort_by_key(|row| row.pid);
        assert_eq!(
            rows,
            [
                ProcessRow {
                    pid: 2,
                    parent_pid: 0,
                    name: "kthreadd".into(),
                    command_line: None,
                },
                ProcessRow {
                    pid: 702,
                    parent_pid: 701,
                    name: "claude".into(),
                    command_line: Some("claude --name my session".into()),
                },
                ProcessRow {
                    pid: 733,
                    parent_pid: 702,
                    name: "node".into(),
                    command_line: Some("node server.mjs".into()),
                },
            ]
        );
    }

    #[test]
    fn the_listeners_are_matched_to_the_processes_holding_them_and_one_nobody_here_holds_is_left_out()
     {
        let proc = FakeProc::new();
        let mut rows = read_listening(&proc.root).unwrap();
        rows.sort_by(|a, b| a.address.cmp(&b.address));
        assert_eq!(
            rows,
            [
                PortRow {
                    pid: 733,
                    port: 5173,
                    address: Some("127.0.0.1".into()),
                },
                PortRow {
                    pid: 733,
                    port: 5173,
                    address: Some("::1".into()),
                },
            ]
        );
    }

    #[test]
    fn each_half_fails_on_its_own() {
        let proc = FakeProc::new();
        // No socket tables: the sockets cannot be listed, the processes can.
        std::fs::remove_dir_all(proc.root.join("net")).unwrap();
        assert!(read_listening(&proc.root).is_err());
        assert_eq!(read_processes(&proc.root).unwrap().len(), 3);
        // No process table at all.
        assert!(read_processes(&proc.root.join("missing")).is_err());
    }
}
