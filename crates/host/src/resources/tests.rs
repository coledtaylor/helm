//! Today's shaping cases, with the same inputs and expectations: a machine
//! arranged by hand, because the cases that matter are the ones a real
//! machine will not produce on demand (a command line the user may not read,
//! a cycle in the table, a socket query that failed while the process query
//! did not).

use std::time::Duration;

use floti_protocol::Knowable;
use floti_protocol::channels::sessions::SessionPort;

use super::session_resources;
use crate::platform::process_table::{PortRow, ProcessRow, ProcessSnapshot};

fn proc(pid: u32, parent_pid: u32, name: &str, command_line: Option<&str>) -> ProcessRow {
    ProcessRow {
        pid,
        parent_pid,
        name: name.to_owned(),
        command_line: command_line.map(str::to_owned),
    }
}

fn port(pid: u32, port: u16, address: &str) -> PortRow {
    PortRow {
        pid,
        port,
        address: Some(address.to_owned()),
    }
}

fn snap(processes: Vec<ProcessRow>, ports: Option<Vec<PortRow>>) -> ProcessSnapshot {
    ProcessSnapshot {
        processes: Knowable::Known(processes),
        ports: ports.map_or(Knowable::Unknown, Knowable::Known),
        at_ms: 1_000,
        duration: Duration::from_millis(7),
    }
}

fn pids(resources: &floti_protocol::channels::sessions::SessionResources) -> Vec<u32> {
    resources
        .processes
        .iter()
        .flatten()
        .map(|process| process.pid)
        .collect()
}

#[test]
fn s11_walks_the_tree_under_the_terminals_pid_breadth_first_with_depths() {
    let result = session_resources(
        3,
        100,
        &snap(
            vec![
                proc(1, 0, "System", None),
                proc(
                    100,
                    42,
                    "claude.exe",
                    Some(r#"claude --add-dir "C:\Program Files\x""#),
                ),
                proc(200, 100, "bash.exe", Some(r#"bash -c "npm run dev""#)),
                proc(300, 200, "node.exe", Some("node vite")),
                proc(400, 100, "docker.exe", Some("docker compose up")),
                // Somebody else's process, one pid away from the tree.
                proc(500, 42, "chrome.exe", Some("chrome")),
            ],
            Some(Vec::new()),
        ),
    );

    assert!(result.root_seen);
    assert_eq!(pids(&result), [100, 200, 400, 300]);
    let depths: Vec<u32> = result
        .processes
        .iter()
        .flatten()
        .map(|process| process.depth)
        .collect();
    assert_eq!(depths, [0, 1, 1, 2]);
    assert!(!pids(&result).contains(&500));
    assert_eq!(result.id, 3);
    assert_eq!(result.root_pid, 100);
    assert_eq!(result.at_ms, 1_000);
}

#[test]
fn s3_a_table_that_could_not_be_read_is_unknown_never_an_empty_tree() {
    let result = session_resources(1, 100, &ProcessSnapshot::unknown(2_000));
    assert_eq!(result.processes, None);
    assert_eq!(result.ports, None);
    assert!(!result.root_seen);
    assert_eq!(result.at_ms, 2_000);
}

#[test]
fn s4_a_session_that_has_exited_is_told_from_one_with_no_children() {
    // The pass ran and the program was not in it.
    let gone = session_resources(
        1,
        100,
        &snap(vec![proc(1, 0, "System", None)], Some(Vec::new())),
    );
    assert_eq!(gone.processes, Some(Vec::new()));
    assert!(!gone.root_seen);

    // The pass ran and the program is there, holding nothing.
    let quiet = session_resources(
        1,
        100,
        &snap(
            vec![proc(100, 42, "claude.exe", Some("claude"))],
            Some(Vec::new()),
        ),
    );
    assert!(quiet.root_seen);
    assert_eq!(pids(&quiet), [100]);
    assert_eq!(quiet.ports, Some(Vec::new()));
    assert_eq!(quiet.processes.unwrap()[0].ports, Some(Vec::new()));
}

#[test]
fn s5_counts_the_command_lines_the_os_would_not_give_up() {
    let result = session_resources(
        1,
        100,
        &snap(
            vec![
                proc(100, 42, "claude.exe", Some("claude")),
                proc(200, 100, "svchost.exe", None),
                proc(300, 100, "audiodg.exe", None),
            ],
            Some(Vec::new()),
        ),
    );
    assert_eq!(result.opaque, 2);
    let lines: Vec<Option<String>> = result
        .processes
        .unwrap()
        .into_iter()
        .map(|process| process.command_line)
        .collect();
    assert_eq!(lines, [Some("claude".to_owned()), None, None]);
}

#[test]
fn s11_never_follows_pid_0_the_parent_of_every_reparented_process() {
    // 900's real parent has exited, so Windows reports 0. Following that
    // edge would make this session's tree the whole machine.
    let result = session_resources(
        1,
        100,
        &snap(
            vec![
                proc(0, 0, "System Idle Process", None),
                proc(100, 0, "claude.exe", Some("claude")),
                proc(900, 0, "somebody-elses.exe", Some("not mine")),
            ],
            Some(Vec::new()),
        ),
    );
    assert_eq!(pids(&result), [100]);
}

#[test]
fn s11_ends_on_a_process_table_that_holds_a_cycle() {
    let result = session_resources(
        1,
        100,
        &snap(
            vec![
                proc(100, 200, "a.exe", Some("a")),
                proc(200, 100, "b.exe", Some("b")),
            ],
            Some(Vec::new()),
        ),
    );
    assert_eq!(pids(&result), [100, 200]);
}

#[test]
fn s11_attributes_only_ports_held_inside_the_tree() {
    let result = session_resources(
        1,
        100,
        &snap(
            vec![
                proc(100, 42, "claude.exe", Some("claude")),
                proc(200, 100, "node.exe", Some("vite")),
            ],
            Some(vec![
                port(200, 5173, "127.0.0.1"),
                // Somebody else's dev server on the same port, one pid outside.
                port(999, 5173, "0.0.0.0"),
                port(200, 24678, "::1"),
            ]),
        ),
    );
    let ports = result.ports.unwrap();
    let held: Vec<(u16, u32)> = ports.iter().map(|port| (port.port, port.pid)).collect();
    assert_eq!(held, [(5173, 200), (24678, 200)]);
    assert_eq!(ports[0].process, "node.exe");
}

#[test]
fn s11_collapses_one_port_bound_twice_into_one_row_keeping_both_addresses() {
    let result = session_resources(
        1,
        100,
        &snap(
            vec![
                proc(100, 42, "claude.exe", Some("claude")),
                proc(200, 100, "node.exe", Some("server")),
            ],
            Some(vec![
                port(200, 3000, "::"),
                port(200, 3000, "0.0.0.0"),
                port(200, 3000, "0.0.0.0"),
            ]),
        ),
    );
    assert_eq!(
        result.ports,
        Some(vec![SessionPort {
            port: 3000,
            pid: 200,
            process: "node.exe".into(),
            addresses: vec!["0.0.0.0".into(), "::".into()],
        }])
    );
}

#[test]
fn s11_puts_the_ports_on_the_process_holding_them() {
    let result = session_resources(
        1,
        100,
        &snap(
            vec![
                proc(100, 42, "claude.exe", Some("claude")),
                proc(200, 100, "node.exe", Some("vite")),
            ],
            Some(vec![port(200, 5173, "127.0.0.1")]),
        ),
    );
    let processes = result.processes.unwrap();
    assert_eq!(processes[0].pid, 100);
    assert_eq!(processes[0].ports, Some(Vec::new()));
    assert_eq!(processes[1].pid, 200);
    assert_eq!(processes[1].ports, Some(vec![5173]));
}

#[test]
fn s3_leaves_every_process_ports_unknown_when_the_socket_query_itself_failed() {
    // Not empty, which would claim nothing in this tree is listening: the
    // merge of "could not look" and "nothing there" the shape prevents.
    let result = session_resources(
        1,
        100,
        &snap(
            vec![
                proc(100, 42, "claude.exe", Some("claude")),
                proc(200, 100, "node.exe", Some("vite")),
            ],
            None,
        ),
    );
    let processes = result.processes.unwrap();
    assert_eq!(processes.len(), 2);
    assert_eq!(result.ports, None);
    assert!(processes.iter().all(|process| process.ports.is_none()));
}

#[test]
fn s11_ignores_rows_with_an_impossible_pid_rather_than_failing_the_pass() {
    // A pid of 0 is no process; a port of 0 is no listener.
    let result = session_resources(
        1,
        100,
        &snap(
            vec![
                proc(100, 42, "claude.exe", Some("claude")),
                proc(0, 100, "broken.exe", None),
                proc(0, 100, "broken.exe", None),
                proc(200, 100, "node.exe", Some("real")),
            ],
            Some(vec![port(200, 0, "127.0.0.1")]),
        ),
    );
    assert_eq!(pids(&result), [100, 200]);
    assert_eq!(result.opaque, 0);
    assert_eq!(result.ports, Some(Vec::new()));
}
