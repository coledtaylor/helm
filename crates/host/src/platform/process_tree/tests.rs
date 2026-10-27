use std::process::{Command, Stdio};

use floti_protocol::Knowable;

use super::{Ending, Native, ProcessTree};
use crate::session::tests::fake_agent_exe;

#[test]
fn the_host_itself_is_alive() {
    assert_eq!(Native.is_alive(std::process::id()), Knowable::Known(true));
}

#[test]
fn a_process_that_has_exited_is_not_alive() {
    let mut child = Command::new(fake_agent_exe())
        .arg("--fake-exit=0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();
    child.wait().unwrap();
    assert_eq!(Native.is_alive(pid), Knowable::Known(false));
}

/// A pid of 0 is a process that never started; ending it signals nothing,
/// least of all the host's own group.
#[test]
fn ending_no_process_does_nothing() {
    Native.end_tree(0, Ending::Forced).unwrap();
    Native.end_tree(0, Ending::Polite).unwrap();
    assert_eq!(Native.is_alive(std::process::id()), Knowable::Known(true));
}
