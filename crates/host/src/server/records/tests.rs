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
        command: None,
        outlive: false,
        can_start: false,
        heavy: false,
        worktree: false,
    }
}

#[test]
fn a_childs_record_says_whether_it_outlives_its_parent_and_the_mode_it_was_launched_in() {
    let world = World::new();
    let parent = world.start("lead", None);
    let keeps_going = ParentLink {
        outlive: true,
        ..link(parent, "builder")
    };
    let child = world.start("lead-builder", Some(keeps_going));
    let ends_with_it = world.start("lead-reviewer", Some(link(parent, "reviewer")));
    world.execute(
        &format!(
            "UPDATE sessions SET permission_mode = '{}' WHERE id = ?1",
            permission_mode_name(PermissionMode::Plan)
        ),
        child,
    );

    let child = world.record(child);
    assert!(child.outlive);
    assert_eq!(child.permission_mode, Some(PermissionMode::Plan));

    // A child that ends with its parent, and a session launched with no mode,
    // say neither.
    let ends_with_it = world.record(ends_with_it);
    assert!(!ends_with_it.outlive);
    assert_eq!(ends_with_it.permission_mode, None);
    assert_eq!(world.record(parent).permission_mode, None);
}

#[test]
fn a_profile_row_keeps_remote_control_only_when_it_is_on() {
    let world = World::new();
    let store = world.store.lock().unwrap();
    let insert = |name: &str, remote_control: Option<bool>| {
        store
            .connection()
            .execute(
                "INSERT INTO profiles (name, root, remote_control) VALUES (?1, 'C:\\work', ?2)",
                params![name, remote_control],
            )
            .unwrap();
        store.connection().last_insert_rowid()
    };
    let on = insert("on", Some(true));
    let off = insert("off", Some(false));
    let unset = insert("unset", None);

    let read = |id: i64| {
        read_profile(&store, u64::try_from(id).unwrap())
            .unwrap()
            .unwrap()
            .remote_control
    };
    assert_eq!(read(on), Some(true));
    assert_eq!(read(off), None);
    assert_eq!(read(unset), None);
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
fn a_command_childs_record_carries_its_command_and_once_it_exited_its_exit_code() {
    let world = World::new();
    let parent = world.start("lead", None);
    let mut running = link(parent, "tests");
    running.role = None;
    running.command = Some("pnpm test --filter core".to_owned());
    let child = world.start("lead-tests", Some(running));

    let record = world.record(child);
    assert_eq!(record.command.as_deref(), Some("pnpm test --filter core"));
    assert_eq!(record.role, None);
    assert_eq!(record.exit_code, None, "still running: no code yet");

    world
        .store
        .finished(
            child,
            &SessionExit {
                code: 3,
                signal: None,
            },
        )
        .unwrap();
    let record = world.record(child);
    assert_eq!(record.command.as_deref(), Some("pnpm test --filter core"));
    assert_eq!(record.exit_code, Some(3));
    assert_eq!(record.status, SessionStatus::Exited);
}

#[test]
fn a_command_that_exited_above_i32_is_listed_and_told_as_the_signed_code_powershell_says() {
    // Windows reports 0xC0000005 as a u32; the ledger keeps it as given in an
    // i64 column, and a row an earlier build wrote reads the same value.
    let world = World::new();
    let parent = world.start("lead", None);
    let mut running = link(parent, "tests");
    running.role = None;
    running.command = Some("pnpm test".to_owned());
    let child = world.start("lead-tests", Some(running));
    world.store.finished(child, &exit(0xC000_0005)).unwrap();
    let column: i64 = world
        .store
        .lock()
        .unwrap()
        .connection()
        .query_row(
            "SELECT exit_code FROM sessions WHERE id = ?1",
            [child.0],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        column, 3_221_225_477,
        "the row holds the code as the OS gave it"
    );

    let record = world.record(child);
    assert_eq!(record.exit_code, Some(-1_073_741_819));
    // A 2.0 reader reads the same number: the field is a signed 32-bit one.
    let json = serde_json::to_value(&record).unwrap();
    assert_eq!(json["exitCode"], -1_073_741_819);

    let largest = world.start("lead-all", None);
    world.store.finished(largest, &exit(u32::MAX)).unwrap();
    assert_eq!(world.record(largest).exit_code, Some(-1));
}

#[test]
fn an_agent_childs_record_and_a_session_started_by_a_person_carry_no_command() {
    let world = World::new();
    let parent = world.start("lead", None);
    let child = world.start("lead-reviewer", Some(link(parent, "reviewer")));
    assert_eq!(world.record(child).command, None);
    assert_eq!(world.record(parent).command, None);

    // A blank column reads as none, as a blank role does.
    world.execute("UPDATE sessions SET command = '  ' WHERE id = ?1", child);
    assert_eq!(world.record(child).command, None);
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

fn exit(code: u32) -> SessionExit {
    SessionExit { code, signal: None }
}

#[test]
fn a_session_the_host_ends_reads_stopped_before_its_program_exits_and_one_that_exits_by_itself_does_not()
 {
    let world = World::new();
    let stopped = world.start("stopped", None);
    let alone = world.start("alone", None);
    assert!(!world.record(stopped).stopped);

    // Marked while it still runs, so the exit that follows is the host's doing.
    world.store.ending(stopped);
    let marked = world.record(stopped);
    assert_eq!(marked.status, SessionStatus::Running);
    assert!(marked.stopped);

    world.store.finished(stopped, &exit(143)).unwrap();
    world.store.finished(alone, &exit(0)).unwrap();
    assert!(world.record(stopped).stopped);
    assert_eq!(world.record(stopped).status, SessionStatus::Exited);
    assert!(!world.record(alone).stopped);
    assert_eq!(world.record(alone).exit_code, Some(0));
}

#[test]
fn ending_a_session_that_already_ended_marks_nothing() {
    let world = World::new();
    let done = world.start("done", None);
    world.store.finished(done, &exit(0)).unwrap();
    world.store.ending(done);
    assert!(!world.record(done).stopped);
}

#[test]
fn a_deliberate_stop_records_each_row_exited_and_stopped_and_leaves_an_ended_row_alone() {
    let world = World::new();
    let running = world.start("running", None);
    let done = world.start("done", None);
    world.store.finished(done, &exit(0)).unwrap();

    record_stopped(&world.store.lock().unwrap(), &[running, done]).unwrap();
    let record = world.record(running);
    assert_eq!(record.status, SessionStatus::Exited);
    assert!(record.stopped);
    assert!(!world.record(done).stopped);
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
