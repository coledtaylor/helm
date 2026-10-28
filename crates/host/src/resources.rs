//! What a hosted session is holding, shaped from one read of the machine.
//!
//! The host started the session's program, so the tree under it is the
//! host's own process tree: this asks the OS for the children of a process
//! the host started, a question any parent may ask about its own children,
//! and reads nothing out of the session.
//!
//! A pass is a sample, not a census: a short-lived process a pass ran
//! between was not seen. `at_ms` is carried so a surface can say when it
//! looked.
//!
//! Three outcomes are kept apart rather than merged:
//!
//!   - The table could not be read at all: `processes` and `ports` are null.
//!   - It was read and the session's own process was not in it: `root_seen`
//!     is false and `processes` empty. A session whose program exited between
//!     the pass being asked for and it running.
//!   - It was read and the program has started nothing: `root_seen` is true
//!     and `processes` holds one row, the program.
//!
//! "Could not look" and "nothing there" are different claims, and each half
//! (processes, ports) is Unknown on its own.

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};

use floti_protocol::Knowable;
use floti_protocol::channels::sessions::{SessionPort, SessionProcess, SessionResources};

use crate::platform::process_table::{PortRow, ProcessRow, ProcessSnapshot};

/// What session `id`, whose program is `root_pid`, is holding in `snapshot`.
///
/// `root_pid` is the terminal's pid, the one the host holds without reading
/// anything, rather than any pid the agent registered under: through a shim
/// (`cmd.exe` running `claude.cmd`) the agent is a child of it, and rooting
/// here covers both.
pub fn session_resources(id: u64, root_pid: u32, snapshot: &ProcessSnapshot) -> SessionResources {
    let Knowable::Known(rows) = &snapshot.processes else {
        return SessionResources {
            id,
            root_pid,
            processes: None,
            root_seen: false,
            ports: None,
            opaque: 0,
            at_ms: snapshot.at_ms,
        };
    };

    let mut by_pid: HashMap<u32, &ProcessRow> = HashMap::new();
    let mut by_parent: HashMap<u32, Vec<&ProcessRow>> = HashMap::new();
    for row in rows {
        // A pid of 0 is no process this can hold.
        if row.pid == 0 {
            continue;
        }
        by_pid.insert(row.pid, row);
        by_parent.entry(row.parent_pid).or_default().push(row);
    }

    let root_seen = by_pid.contains_key(&root_pid);
    let order = if root_seen {
        tree_of(root_pid, &by_parent)
    } else {
        Vec::new()
    };
    let in_tree: HashSet<u32> = order.iter().copied().collect();

    let ports = match &snapshot.ports {
        Knowable::Known(rows) => Some(ports_of(&in_tree, rows, |pid| {
            by_pid
                .get(&pid)
                .map_or_else(|| pid.to_string(), |row| row.name.clone())
        })),
        Knowable::Unknown => None,
    };

    // Ports per process, so the tree carries them where they are held. Null
    // all the way down when the socket query itself failed: an empty list
    // there would claim the process listens on nothing.
    let mut held: HashMap<u32, Vec<u16>> = HashMap::new();
    for port in ports.iter().flatten() {
        held.entry(port.pid).or_default().push(port.port);
    }

    let mut depth: HashMap<u32, u32> = HashMap::from([(root_pid, 0)]);
    let mut processes = Vec::with_capacity(order.len());
    let mut opaque = 0u32;
    for pid in &order {
        let Some(row) = by_pid.get(pid) else {
            continue;
        };
        let own = depth.get(pid).copied().unwrap_or(0);
        for child in by_parent.get(pid).into_iter().flatten() {
            if in_tree.contains(&child.pid) && !depth.contains_key(&child.pid) {
                depth.insert(child.pid, own + 1);
            }
        }
        if row.command_line.is_none() {
            opaque += 1;
        }
        processes.push(SessionProcess {
            pid: row.pid,
            parent_pid: row.parent_pid,
            name: row.name.clone(),
            command_line: row.command_line.clone(),
            depth: own,
            ports: ports.as_ref().map(|_| {
                let mut own_ports = held.get(pid).cloned().unwrap_or_default();
                own_ports.sort_unstable();
                own_ports
            }),
        });
    }

    SessionResources {
        id,
        root_pid,
        processes: Some(processes),
        root_seen,
        ports,
        opaque,
        at_ms: snapshot.at_ms,
    }
}

/// The pids in `root`'s tree, root first and then breadth-first.
///
/// A process table is a set of edges read at slightly different instants, so
/// it can hold a cycle, and `seen` bounds the walk whatever the edges say. A
/// pid of 0 is never followed: on Windows it is the parent of anything whose
/// real parent has exited, which would make a reparented process's tree the
/// whole machine.
fn tree_of(root: u32, by_parent: &HashMap<u32, Vec<&ProcessRow>>) -> Vec<u32> {
    let mut order = vec![root];
    let mut seen = HashSet::from([root]);
    let mut at = 0;
    while let Some(&pid) = order.get(at) {
        at += 1;
        if pid == 0 {
            continue;
        }
        for child in by_parent.get(&pid).into_iter().flatten() {
            if seen.insert(child.pid) {
                order.push(child.pid);
            }
        }
    }
    order
}

/// The ports held by `pids`, one row per pid and port.
///
/// Deduplicated on (pid, port) rather than on the whole row, because a
/// server routinely binds one port once per address family, and two rows
/// reading 5173 would look like two servers. The addresses are kept as a
/// sorted list instead, so "loopback only" and "every interface" stay
/// distinguishable.
fn ports_of(
    pids: &HashSet<u32>,
    rows: &[PortRow],
    name_of: impl Fn(u32) -> String,
) -> Vec<SessionPort> {
    let mut by_key: HashMap<(u32, u16), SessionPort> = HashMap::new();
    for row in rows {
        if !pids.contains(&row.pid) || row.port == 0 {
            continue;
        }
        let found = by_key
            .entry((row.pid, row.port))
            .or_insert_with(|| SessionPort {
                port: row.port,
                pid: row.pid,
                process: name_of(row.pid),
                addresses: Vec::new(),
            });
        if let Some(address) = row.address.as_deref().filter(|address| !address.is_empty())
            && !found.addresses.iter().any(|known| known == address)
        {
            found.addresses.push(address.to_owned());
        }
    }
    let mut ports: Vec<SessionPort> = by_key.into_values().collect();
    for port in &mut ports {
        port.addresses.sort();
    }
    ports.sort_by_key(|port| (port.port, port.pid));
    ports
}
