//! What a session's row keeps of its Remote Control name and of the starts it
//! has been allowed beyond the setting.

use std::sync::Mutex;

use floti_protocol::BackendId;

use super::*;
use crate::testkit::TestDirs;

struct World {
    store: Mutex<Store>,
    /// Last: fields drop in order, and the folder goes only once the store is closed.
    dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let store = Mutex::new(Store::open(&dirs.data).unwrap());
        Self { store, dirs }
    }

    fn start(&self, name: &str, remote_control_name: Option<&str>) -> SessionId {
        let row = NewSessionRow {
            name: name.to_owned(),
            cwd: self.dirs.folder("work"),
            argv: vec![],
            conversation_id: None,
            backend: BackendId::claude_code(),
            origin: SessionOrigin {
                remote_control_name: remote_control_name.map(str::to_owned),
                ..SessionOrigin::default()
            },
        };
        self.store.started(&row).unwrap()
    }
}

#[test]
fn a_session_row_keeps_the_name_it_runs_with_remote_control_under() {
    let world = World::new();
    let named = world.start("api-refactor", Some("api-refactor"));
    let plain = world.start("scratch", None);
    let store = world.store.lock().unwrap();

    assert_eq!(
        remote_control_name(&store, named).unwrap().as_deref(),
        Some("api-refactor")
    );
    assert_eq!(remote_control_name(&store, plain).unwrap(), None);
    assert_eq!(remote_control_name(&store, SessionId(9_999)).unwrap(), None);
}

#[test]
fn allowing_a_parent_more_starts_adds_to_that_parent_alone() {
    let world = World::new();
    let first = world.start("lead", None);
    let second = world.start("other", None);
    let store = world.store.lock().unwrap();

    assert_eq!(extra_starts(&store, first).unwrap(), 0);
    assert_eq!(allow_starts(&store, first, 16).unwrap(), Some(16));
    assert_eq!(allow_starts(&store, first, 16).unwrap(), Some(32));
    assert_eq!(extra_starts(&store, first).unwrap(), 32);
    assert_eq!(extra_starts(&store, second).unwrap(), 0);

    // A row that is not there has nothing to allow.
    assert_eq!(allow_starts(&store, SessionId(9_999), 16).unwrap(), None);
    assert_eq!(extra_starts(&store, SessionId(9_999)).unwrap(), 0);
}
