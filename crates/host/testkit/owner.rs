//! The test process that owns a fake program, so a fake whose test crashed
//! or was killed does not run on without it.
//!
//! A test's folder tree ([`TestDirs`](crate::testkit::TestDirs)) names the
//! test process in a [`OWNER_FILE`] at its root, and a fake started anywhere
//! under it finds that file from its record folder up and exits once the
//! process is gone. The owner is the test process, never the fake's parent: a
//! session that leaves its agent running when it is closed still leaves it
//! running for as long as the test does, so the test that says it must not
//! still fails.
//!
//! A file rather than a variable, because the host clears a session's
//! environment and a backend's arguments are the agent's own. The fakes in
//! `test/fake-agents` read the same file (`common.mjs`).
//!
//! The testkit and the fake programs (`fake_agent.rs`, `fake_gui.rs`) each
//! include this file, so it uses nothing but the standard library.

use std::path::Path;
use std::time::Duration;

/// The file at the root of a test's folder tree that holds the test
/// process's pid.
pub const OWNER_FILE: &str = "test-owner";

/// How often a fake asks whether its owner is still running.
pub const OWNER_POLL: Duration = Duration::from_millis(250);

/// The pid in the nearest [`OWNER_FILE`] at or above `folder`, or `None`
/// when there is none: a fake run outside any test's folder has no owner.
pub fn find_owner(folder: &Path) -> Option<u32> {
    folder.ancestors().find_map(|dir| {
        std::fs::read_to_string(dir.join(OWNER_FILE))
            .ok()?
            .trim()
            .parse()
            .ok()
            .filter(|pid| *pid > 0)
    })
}

/// Exits this process with status 0 once the owner [`find_owner`] finds from
/// `folder` has gone, as `is_running` tells, polling from a thread of its own.
/// Does nothing when there is no owner.
pub fn exit_when_owner_is_gone(folder: &Path, is_running: impl Fn(u32) -> bool + Send + 'static) {
    let Some(owner) = find_owner(folder) else {
        return;
    };
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(OWNER_POLL);
            if !is_running(owner) {
                std::process::exit(0);
            }
        }
    });
}
