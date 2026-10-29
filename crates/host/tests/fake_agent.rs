//! The fake agent CLI does what the host's tests rely on: it records its
//! arguments and folder, echoes what it reads, prints the bytes it is given,
//! exits with the code it is given and starts a child of its own, on its
//! console or with none.

use std::io::Write;
use std::process::{Command, Stdio};

use floti_host::fake_agent;
use floti_host::platform::process_tree::{Ending, Native as NativeTree, ProcessTree};
use floti_host::testkit::{PATIENCE, TestDirs};
use floti_protocol::Knowable;

fn command(agent: &floti_host::testkit::FakeAgent, cwd: &std::path::Path) -> Command {
    let (name, value) = agent.log_env();
    let mut command = Command::new(agent.exe());
    command
        .current_dir(cwd)
        .env(name, value)
        .env("TERM", "xterm-256color")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

#[test]
fn records_argv_and_cwd_echoes_input_prints_bytes_and_exits_with_the_code_given() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let folder = dirs.folder("a project");

    let mut child = command(&agent, &folder)
        .args(["--fake-print=1b5b316d6869", "--resume", "two words"])
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"hello\n/print 21\n/exit 7\n")
        .unwrap();
    let output = child.wait_with_output().unwrap();

    assert_eq!(output.status.code(), Some(7));
    assert_eq!(output.stdout, b"\x1b[1mhiecho: hello\r\n!");

    let record = agent.record(child_pid(&agent)).unwrap();
    assert_eq!(
        record.argv,
        ["--fake-print=1b5b316d6869", "--resume", "two words"]
    );
    assert_eq!(
        std::fs::canonicalize(&record.cwd).unwrap(),
        std::fs::canonicalize(&folder).unwrap()
    );
    assert_eq!(record.input, ["hello", "/print 21", "/exit 7"]);
    assert_eq!(
        record.env.get("TERM").map(String::as_str),
        Some("xterm-256color")
    );
    assert!(
        record
            .env_names
            .iter()
            .any(|name| name == "FLOTI_FAKE_AGENT_LOG")
    );
}

#[test]
fn exits_at_once_with_the_code_given() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let status = command(&agent, dirs.root())
        .arg("--fake-exit=3")
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(3));
}

#[test]
fn starts_a_child_of_its_own() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let status = command(&agent, dirs.root())
        .args(["--fake-child=1000", "--fake-exit=0"])
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(0));

    let parent = agent
        .records()
        .into_iter()
        .find(|record| record.argv.contains(&"--fake-child=1000".to_owned()))
        .expect("the agent recorded its run");
    assert_eq!(parent.children.len(), 1);
    let child = agent.wait_for_record(parent.children[0], PATIENCE, |_| true);
    assert_eq!(child.argv, ["--fake-sleep=1000"]);
}

#[test]
fn starts_a_program_with_no_console_as_a_child_of_its_own() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let status = command(&agent, dirs.root())
        .args(["--fake-gui-child", "--fake-exit=0"])
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(0));

    let records = agent.records();
    assert_eq!(
        records.len(),
        1,
        "only the agent records itself: {records:?}"
    );
    assert_eq!(records[0].children.len(), 1);
    let child = records[0].children[0];
    let running = NativeTree.is_alive(child);
    NativeTree.end_tree(child, Ending::Forced).unwrap();
    assert_eq!(running, Knowable::Known(true), "the child lives on");
}

#[test]
fn exits_with_its_child_once_the_test_process_that_owns_it_is_gone() {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    // A stand-in for the test process, made the owner of everything in
    // `dirs`, and ended below as a crash would end a test.
    let mut owner = Command::new(agent.exe())
        .arg("--fake-sleep=600000")
        .current_dir(dirs.folder("owner"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    dirs.own(owner.id());

    // Owned by this test process, for the barrier below.
    let others = TestDirs::new();
    let other_agent = fake_agent!(&others);
    let mut other = command(&other_agent, others.root()).spawn().unwrap();

    // Its input stays open, so nothing but its owner going can end it.
    let mut fake = command(&agent, dirs.root())
        .arg("--fake-child")
        .spawn()
        .unwrap();
    let record = agent.wait_for_record(fake.id(), PATIENCE, |record| {
        !record.children.is_empty()
    });
    let child = record.children[0];
    agent.wait_for_record(child, PATIENCE, |_| true);
    assert_eq!(NativeTree.is_alive(child), Knowable::Known(true));
    other_agent.wait_for_record(other.id(), PATIENCE, |_| true);

    owner.kill().unwrap();
    owner.wait().unwrap();

    let status = wait_for_exit(&mut fake);
    assert_eq!(status.code(), Some(0));
    let deadline = std::time::Instant::now() + PATIENCE;
    while NativeTree.is_alive(child) != Knowable::Known(false) {
        assert!(
            std::time::Instant::now() < deadline,
            "the fake's child {child} did not exit within {PATIENCE:?} of its owner"
        );
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    // The barrier: by now the other fake, polling as often, has had as long
    // to end, and its owner, this test process, still runs.
    assert!(
        other.try_wait().unwrap().is_none(),
        "a fake whose owner still runs ended"
    );
    drop(other.stdin.take());
    assert_eq!(wait_for_exit(&mut other).code(), Some(0));
    drop(fake);
}

/// Waits up to the patience for `child` to exit.
fn wait_for_exit(child: &mut std::process::Child) -> std::process::ExitStatus {
    let deadline = std::time::Instant::now() + PATIENCE;
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("the fake {} did not exit within {PATIENCE:?}", child.id());
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// The pid of the only run recorded so far.
fn child_pid(agent: &floti_host::testkit::FakeAgent) -> u32 {
    let records = agent.records();
    assert_eq!(records.len(), 1, "{records:?}");
    records[0].pid
}
