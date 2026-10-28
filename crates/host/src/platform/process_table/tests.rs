use std::process::{Child, Command, Stdio};
use std::time::Duration;

use floti_protocol::Knowable;

use super::{Native, PortRow, ProcessRow, ProcessTable, snapshot};
use crate::platform::process_tree::{Ending, Native as NativeTree, ProcessTree};
use crate::session::tests::fake_agent_exe;
use crate::testkit::{FakeAgent, TestDirs};
use crate::{Error, Result};

/// The fake agent with a child listening on a port on 127.0.0.1: the
/// program, the child's pid and its port. Both end when this is dropped.
struct Listening {
    agent: Child,
    child: u32,
    port: u16,
    _dirs: TestDirs,
}

impl Listening {
    fn start() -> Self {
        let dirs = TestDirs::new();
        let log = FakeAgent::new(fake_agent_exe(), &dirs);
        let (var, folder) = log.log_env();
        let agent = Command::new(fake_agent_exe())
            .arg("--fake-listen=60000")
            .env(var, folder)
            // Held open, so the program runs until it is ended here.
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let child = log
            .wait_for_record(agent.id(), Duration::from_secs(10), |record| {
                !record.children.is_empty()
            })
            .children[0];
        let port = log
            .wait_for_record(child, Duration::from_secs(10), |record| {
                record.listening.is_some()
            })
            .listening
            .expect("the child's port");
        Self {
            agent,
            child,
            port,
            _dirs: dirs,
        }
    }
}

impl Drop for Listening {
    fn drop(&mut self) {
        let _ = NativeTree.end_tree(self.child, Ending::Forced);
        let _ = self.agent.kill();
        let _ = self.agent.wait();
        let _ = NativeTree.end_tree(self.child, Ending::Forced);
    }
}

/// S1, S2 and S10 on this OS: one read of the machine through its own calls
/// finds the program, its child with its full command line, and the port the
/// child listens on, in less than today's half second.
#[test]
fn one_read_finds_a_programs_child_its_command_line_and_its_port_in_under_half_a_second() {
    let listening = Listening::start();
    let pid = listening.agent.id();

    let seen = snapshot(&Native);

    assert!(
        seen.duration < Duration::from_millis(500),
        "one read took {:?}",
        seen.duration
    );
    let Knowable::Known(processes) = &seen.processes else {
        panic!("the process table was not read");
    };
    let Knowable::Known(ports) = &seen.ports else {
        panic!("the listening sockets were not read");
    };
    let program = processes
        .iter()
        .find(|row| row.pid == pid)
        .unwrap_or_else(|| panic!("the program {pid} is not listed"));
    let child = processes
        .iter()
        .find(|row| row.pid == listening.child)
        .unwrap_or_else(|| panic!("the child {} is not listed", listening.child));
    assert_eq!(child.parent_pid, pid, "{child:?}");
    assert!(
        format!("floti-fake-agent{}", std::env::consts::EXE_SUFFIX).starts_with(&child.name)
            && child.name.len() >= 15,
        "{child:?}"
    );
    assert_eq!(child.name, program.name);
    let line = child
        .command_line
        .as_deref()
        .expect("the child's command line");
    assert!(line.contains("floti-fake-agent"), "{line}");
    assert!(line.ends_with("--fake-serve=60000"), "{line}");
    assert!(
        program
            .command_line
            .as_deref()
            .is_some_and(|line| line.ends_with("--fake-listen=60000")),
        "{program:?}"
    );
    let held: Vec<&PortRow> = ports
        .iter()
        .filter(|row| row.pid == listening.child)
        .collect();
    assert_eq!(
        held,
        [&PortRow {
            pid: listening.child,
            port: listening.port,
            address: Some("127.0.0.1".into()),
        }]
    );
}

/// Several reads in a row each stay under the budget, not just the first.
#[test]
fn every_read_stays_under_half_a_second() {
    for _ in 0..5 {
        let seen = snapshot(&Native);
        assert!(seen.processes.is_known() && seen.ports.is_known());
        assert!(
            seen.duration < Duration::from_millis(500),
            "a read took {:?}",
            seen.duration
        );
    }
}

/// A table that answers each half as it was told.
struct Arranged {
    processes: fn() -> Result<Vec<ProcessRow>>,
    listening: fn() -> Result<Vec<PortRow>>,
}

impl ProcessTable for Arranged {
    fn processes(&self) -> Result<Vec<ProcessRow>> {
        (self.processes)()
    }

    fn listening(&self) -> Result<Vec<PortRow>> {
        (self.listening)()
    }
}

fn one_row() -> Result<Vec<ProcessRow>> {
    Ok(vec![ProcessRow {
        pid: 100,
        parent_pid: 1,
        name: "claude".into(),
        command_line: None,
    }])
}

/// An OS with no implementation answers Unsupported for both halves, and the
/// pass reports both as Unknown rather than failing.
#[test]
fn an_os_with_no_reader_reports_both_halves_unknown() {
    let seen = snapshot(&Arranged {
        processes: || Err(Error::unsupported("the process table")),
        listening: || Err(Error::unsupported("the listening sockets")),
    });
    assert_eq!(seen.processes, Knowable::Unknown);
    assert_eq!(seen.ports, Knowable::Unknown);
}

/// Each half fails on its own: a refused socket query keeps the process
/// table, and an unreadable process table keeps the sockets.
#[test]
fn each_half_is_unknown_on_its_own() {
    let seen = snapshot(&Arranged {
        processes: one_row,
        listening: || Err(Error::io("list", std::io::Error::other("refused"))),
    });
    assert_eq!(seen.processes, Knowable::Known(one_row().unwrap()));
    assert_eq!(seen.ports, Knowable::Unknown);

    let seen = snapshot(&Arranged {
        processes: || Err(Error::io("list", std::io::Error::other("refused"))),
        listening: || Ok(Vec::new()),
    });
    assert_eq!(seen.processes, Knowable::Unknown);
    assert_eq!(seen.ports, Knowable::Known(Vec::new()));
}
