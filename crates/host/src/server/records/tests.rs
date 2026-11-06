//! A session's row read back as the protocol's record: a child names its
//! parent and its role, a session with neither says none.

use std::sync::Mutex;

use floti_protocol::BackendId;
use rusqlite::params;

use super::*;
use crate::session::{NewSessionRow, ParentLink, SessionOrigin};
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

    fn start(&self, name: &str, parent: Option<ParentLink>) -> SessionId {
        let row = NewSessionRow {
            name: name.to_owned(),
            cwd: self.dirs.folder("work"),
            argv: vec!["--name".to_owned(), name.to_owned()],
            conversation_id: Some(format!("conversation-of-{name}")),
            backend: BackendId::claude_code(),
            origin: SessionOrigin {
                parent,
                ..SessionOrigin::default()
            },
        };
        self.store.started(&row).unwrap()
    }

    fn record(&self, id: SessionId) -> SessionRecord {
        read_record(&self.store.lock().unwrap(), id).unwrap()
    }

    fn execute(&self, sql: &str, id: SessionId) {
        self.store
            .lock()
            .unwrap()
            .connection()
            .execute(sql, params![id.0])
            .unwrap();
    }
}

fn link(parent: SessionId, name: &str) -> ParentLink {
    ParentLink {
        session: parent,
        conversation_id: Some("conversation-of-lead".to_owned()),
        name: name.to_owned(),
        role: Some("reviewer".to_owned()),
        outlive: false,
        can_start: false,
    }
}

#[test]
fn a_childs_record_names_its_parent_by_row_and_name_and_carries_its_role() {
    let world = World::new();
    let parent = world.start("lead", None);
    let child = world.start("lead-reviewer", Some(link(parent, "reviewer")));

    let child = world.record(child);
    assert_eq!(child.parent_id, Some(parent.0 as u64));
    assert_eq!(child.parent_name.as_deref(), Some("lead"));
    assert_eq!(child.role.as_deref(), Some("reviewer"));
}

#[test]
fn a_session_started_by_a_person_carries_no_parent_and_no_role() {
    let world = World::new();
    let alone = world.record(world.start("alone", None));
    assert_eq!(alone.parent_id, None);
    assert_eq!(alone.parent_name, None);
    assert_eq!(alone.role, None);
}

#[test]
fn a_parents_label_is_the_name_its_child_shows_and_clearing_it_shows_the_name_again() {
    let world = World::new();
    let parent = world.start("lead", None);
    let child = world.start("lead-reviewer", Some(link(parent, "reviewer")));

    set_label(&world.store.lock().unwrap(), parent, Some("PR review")).unwrap();
    assert_eq!(
        world.record(child).parent_name.as_deref(),
        Some("PR review")
    );

    set_label(&world.store.lock().unwrap(), parent, Some("")).unwrap();
    assert_eq!(world.record(child).parent_name.as_deref(), Some("lead"));
}

#[test]
fn a_child_keeps_naming_its_parent_after_the_parent_ended_and_what_the_row_keeps_for_the_link() {
    let world = World::new();
    let parent = world.start("lead", None);
    let mut kept = link(parent, "reviewer");
    kept.outlive = true;
    kept.can_start = true;
    let child = world.start("lead-reviewer", Some(kept));

    world
        .store
        .finished(
            parent,
            &SessionExit {
                code: 0,
                signal: None,
            },
        )
        .unwrap();
    let record = world.record(child);
    assert_eq!(record.parent_id, Some(parent.0 as u64));
    assert_eq!(record.parent_name.as_deref(), Some("lead"));

    let (name, conversation, outlive, can_start): (String, String, bool, bool) = world
        .store
        .lock()
        .unwrap()
        .connection()
        .query_row(
            "SELECT child_name, parent_conversation_id, outlive, can_start \
             FROM sessions WHERE id = ?1",
            [child.0],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(name, "reviewer");
    assert_eq!(conversation, "conversation-of-lead");
    assert!(outlive && can_start);
}

#[test]
fn a_session_without_a_link_keeps_the_defaults_for_outlive_and_can_start() {
    let world = World::new();
    let alone = world.start("alone", None);
    let (outlive, can_start, child_name): (bool, bool, Option<String>) = world
        .store
        .lock()
        .unwrap()
        .connection()
        .query_row(
            "SELECT outlive, can_start, child_name FROM sessions WHERE id = ?1",
            [alone.0],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert!(!outlive && !can_start);
    assert_eq!(child_name, None);
}

#[test]
fn deleting_a_parents_row_leaves_its_child_with_no_parent_and_keeps_the_conversation_to_find_it_by()
{
    let world = World::new();
    let parent = world.start("lead", None);
    let child = world.start("lead-reviewer", Some(link(parent, "reviewer")));

    world.execute("DELETE FROM sessions WHERE id = ?1", parent);

    let record = world.record(child);
    assert_eq!(record.parent_id, None);
    assert_eq!(record.parent_name, None);
    assert_eq!(record.role.as_deref(), Some("reviewer"));
    let conversation: Option<String> = world
        .store
        .lock()
        .unwrap()
        .connection()
        .query_row(
            "SELECT parent_conversation_id FROM sessions WHERE id = ?1",
            [child.0],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(conversation.as_deref(), Some("conversation-of-lead"));
}
