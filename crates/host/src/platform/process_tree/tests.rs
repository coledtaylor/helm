use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

use floti_protocol::Knowable;

use super::{Ending, Native, ProcessTree, descendants, tree_under};
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

/// Every OS ties what this process starts to its life, and asking again
/// gives the same answer.
#[test]
fn what_this_process_starts_ends_with_it_on_every_os() {
    assert_eq!(Native.end_tree_with_this_process(), Knowable::Known(true));
    assert_eq!(Native.end_tree_with_this_process(), Knowable::Known(true));
}

/// The tree under a process is its children and theirs, found by parent,
/// and never a process the walk is told is not really a child.
#[test]
fn the_tree_under_a_process_is_its_children_theirs_and_no_others() {
    let table = [
        (1, 0),
        (10, 1),
        (11, 1),
        (20, 10),
        (30, 20),
        (40, 99),
        // A row naming itself as its parent ends no walk.
        (50, 50),
    ];
    let mut tree = tree_under(&table, 1, |_, _| true);
    tree.sort_unstable();
    assert_eq!(tree, [10, 11, 20, 30]);

    // 20 names 10 as its parent only because 10's pid was handed on.
    let mut tree = tree_under(&table, 1, |parent, pid| (parent, pid) != (10, 20));
    tree.sort_unstable();
    assert_eq!(tree, [10, 11]);

    assert_eq!(tree_under(&table, 40, |_, _| true), Vec::<u32>::new());
}

/// A program this process started, and the child that one started, are
/// both found under this process.
#[test]
fn the_descendants_of_this_process_include_its_childs_child() {
    let mut agent = Command::new(fake_agent_exe())
        .arg("--fake-child=60000")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let agent_pid = agent.id();
    let mut line = String::new();
    BufReader::new(agent.stdout.take().expect("the agent's output"))
        .read_line(&mut line)
        .expect("read the agent's child");
    let grandchild: Option<u32> = line
        .trim()
        .strip_prefix("child: ")
        .and_then(|pid| pid.parse().ok());

    let found = descendants(std::process::id());
    // Its stdin closes and it exits; its child is ended here.
    drop(agent.stdin.take());
    agent.wait().unwrap();
    if let Some(pid) = grandchild {
        Native.end_tree(pid, Ending::Forced).unwrap();
    }

    let grandchild = grandchild.unwrap_or_else(|| panic!("no child reported: {line:?}"));
    let Knowable::Known(found) = found else {
        panic!("the OS would not list this process's descendants");
    };
    assert!(found.contains(&agent_pid), "{agent_pid} not in {found:?}");
    assert!(found.contains(&grandchild), "{grandchild} not in {found:?}");
    assert!(!found.contains(&std::process::id()), "{found:?}");
}
