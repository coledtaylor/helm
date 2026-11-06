//! A child's record on the wire: a client on this protocol minor lists the
//! sessions of a real host and finds a child naming its parent and its role,
//! a session with neither carrying none, and a client one minor behind
//! connects to the same host and reads every field its own version declared.
//!
//! The host is in this process over a socket of the test's own, its sessions
//! run the fake agent, and every folder is in a [`TestDirs`] tree the host has
//! stopped using by the time it goes.

use std::ffi::OsString;
use std::path::Path;
use std::sync::Arc;

use floti_host::agent::AgentBackend;
use floti_host::fake_agent;
use floti_host::server::HostConfig;
use floti_host::testkit::{PATIENCE, RunningHost, TestClient, TestDirs};
use floti_protocol::channel::{from_payload, to_payload};
use floti_protocol::channels::common::{SessionRecord, SessionStatus};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    SessionExit, SessionList, SessionStart, StartSessionRequest,
};
use floti_protocol::record::{records, records_dir};
use floti_protocol::{EventChannel, Payload, ProtocolVersion, RequestChannel};
use serde_json::Value;

const TERMINAL: &[&str] = &["terminal"];

fn start_request(folder: &Path) -> StartSessionRequest {
    StartSessionRequest {
        cwd: folder.to_string_lossy().into_owned(),
        project_path: None,
        name: None,
        cols: 80,
        rows: 24,
        ..StartSessionRequest::default()
    }
}

/// Starts a session in `folder` and says its id.
async fn start_in(client: &mut TestClient, folder: &Path) -> u64 {
    client
        .request::<SessionStart>(&start_request(folder))
        .await
        .expect("start a session")
        .id
}

/// Makes `child`'s row a child of `parent`'s, as a start by an agent tool
/// will write it, from a connection of the test's own to the host's store.
fn make_child(data: &Path, child: u64, parent: u64, role: &str) {
    let store = rusqlite::Connection::open(data.join("floti.db")).expect("open floti.db");
    store.busy_timeout(PATIENCE).expect("wait for the host");
    let changed = store
        .execute(
            "UPDATE sessions SET parent_session_id = ?2, child_name = ?3, role = ?3 WHERE id = ?1",
            rusqlite::params![child as i64, parent as i64, role],
        )
        .expect("link the child's row");
    assert_eq!(changed, 1, "the child's row is there");
}

/// Makes `child`'s row a command child of `parent`'s running `command`, as a
/// start by `floti agent run` will write it.
fn make_command_child(data: &Path, child: u64, parent: u64, name: &str, command: &str) {
    let store = rusqlite::Connection::open(data.join("floti.db")).expect("open floti.db");
    store.busy_timeout(PATIENCE).expect("wait for the host");
    let changed = store
        .execute(
            "UPDATE sessions SET parent_session_id = ?2, child_name = ?3, command = ?4 WHERE id = ?1",
            rusqlite::params![child as i64, parent as i64, name, command],
        )
        .expect("link the command child's row");
    assert_eq!(changed, 1, "the command child's row is there");
}

/// What the committed record of protocol 2.0 declares for `SessionRecord`.
fn record_of_2_0() -> Value {
    let text = records(&records_dir())
        .expect("read the records")
        .into_iter()
        .find_map(|(version, text)| (version == ProtocolVersion::new(2, 0)).then_some(text))
        .expect("there is a record of protocol 2.0");
    let record: Value = serde_json::from_str(&text).expect("the record is JSON");
    record["types"]["SessionRecord"].clone()
}

/// Whether `wire`, one session as a frame carries it, has every property
/// protocol 2.0 declared for a session, with a type 2.0 allowed: what a
/// client that knows only 2.0 needs to read it.
fn problems_for_a_2_0_reader(wire: &Value) -> Vec<String> {
    let declared = record_of_2_0();
    let mut problems = Vec::new();
    for (name, schema) in declared["properties"].as_object().unwrap() {
        let Some(found) = wire.get(name) else {
            if declared["required"]
                .as_array()
                .unwrap()
                .iter()
                .any(|required| required == name)
            {
                problems.push(format!("{name} is missing"));
            }
            continue;
        };
        let allowed: Vec<&str> = match &schema["type"] {
            Value::String(one) => vec![one.as_str()],
            Value::Array(many) => many.iter().filter_map(Value::as_str).collect(),
            _ => continue,
        };
        let kind = match found {
            Value::Null => "null",
            Value::Bool(_) => "boolean",
            Value::Number(_) => "integer",
            Value::String(_) => "string",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
        };
        if !allowed.contains(&kind) {
            problems.push(format!("{name} is {kind}, 2.0 allows {allowed:?}"));
        }
    }
    problems
}

#[tokio::test(flavor = "multi_thread")]
async fn s31_a_client_on_2_1_lists_a_child_with_its_parent_and_role_and_a_client_on_2_0_reads_the_same_list()
 {
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(HostConfig {
        run: Default::default(),
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: vec![Arc::new(agent.backend(["--fake-tick=100"])) as Arc<dyn AgentBackend>],
        inherited_env: std::env::vars_os()
            .filter(|(key, _)| key != "SHELL")
            .chain([(OsString::from("SHELL"), OsString::from("/bin/sh"))])
            .collect(),
    });

    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    assert_eq!(client.welcome.protocol.to_string(), "2.1");
    let folder = dirs.folder("project");
    let lead = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .expect("start the parent");
    let reviewer = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .expect("start the child");
    let alone = client
        .request::<SessionStart>(&start_request(&folder))
        .await
        .expect("start a session nobody's child");
    make_child(&dirs.data, reviewer.id, lead.id, "reviewer");

    let listed = client.request::<SessionList>(&()).await.unwrap();
    let record = |id: u64| -> &SessionRecord {
        listed
            .iter()
            .find(|record| record.id == id)
            .unwrap_or_else(|| panic!("session {id} is listed"))
    };
    let child = record(reviewer.id);
    assert_eq!(child.parent_id, Some(lead.id));
    assert_eq!(child.parent_name.as_deref(), Some(lead.name.as_str()));
    assert_eq!(child.role.as_deref(), Some("reviewer"));
    for session in [record(lead.id), record(alone.id)] {
        assert_eq!(
            (&session.parent_id, &session.parent_name, &session.role),
            (&None, &None, &None),
            "{} has no parent and no role",
            session.name
        );
    }

    // A client one minor behind connects, is told the version it speaks, and
    // reads every field it knows of every session in the same list.
    let mut old = TestClient::connect_at(&endpoint, ProtocolVersion::new(2, 0), TERMINAL).await;
    assert_eq!(old.welcome.protocol.to_string(), "2.0");
    let payload: Payload = old
        .request_on(
            SessionList::NAME,
            to_payload(&()).expect("encode the request"),
        )
        .await
        .expect("a 2.0 client lists sessions");
    let wire: Vec<Value> = from_payload(&payload).expect("the list is readable as plain values");
    assert_eq!(wire.len(), 3);
    for session in &wire {
        assert_eq!(
            problems_for_a_2_0_reader(session),
            Vec::<String>::new(),
            "{session}"
        );
    }

    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s23_a_client_on_2_1_lists_a_command_child_with_its_command_and_once_it_exited_its_exit_code_and_a_client_on_2_0_reads_the_same_list()
 {
    const EXITS: u64 = 4;
    let dirs = TestDirs::new();
    let agent = fake_agent!(&dirs);
    let endpoint = dirs.endpoint();
    let host = RunningHost::start(HostConfig {
        run: Default::default(),
        folders: dirs.folders(),
        endpoint: endpoint.clone(),
        backends: vec![Arc::new(agent.backend(["--fake-tick=100"])) as Arc<dyn AgentBackend>],
        inherited_env: std::env::vars_os()
            .filter(|(key, _)| key != "SHELL")
            .chain([(OsString::from("SHELL"), OsString::from("/bin/sh"))])
            .collect(),
    });

    let mut client = TestClient::connect(&endpoint, TERMINAL).await;
    client.subscribe_quietly(EXITS, SessionExit::NAME).await;
    let folder = dirs.folder("project");
    let lead = start_in(&mut client, &folder).await;
    let reviewer = start_in(&mut client, &folder).await;
    let tests = start_in(&mut client, &folder).await;
    let before = client.request::<SessionList>(&()).await.unwrap();
    eprintln!(
        "DEBUG before: {:?} ids {lead} {reviewer} {tests}",
        before.iter().map(|r| r.id).collect::<Vec<_>>()
    );
    make_child(&dirs.data, reviewer, lead, "reviewer");
    let mid = client.request::<SessionList>(&()).await.unwrap();
    eprintln!("DEBUG mid: {:?}", mid.iter().map(|r| r.id).collect::<Vec<_>>());
    make_command_child(&dirs.data, tests, lead, "worker", "pnpm test --filter core");
    let after = client.request::<SessionList>(&()).await.unwrap();
    eprintln!("DEBUG after: {:?}", after.iter().map(|r| r.id).collect::<Vec<_>>());

    while let Some(m) = client.next(std::time::Duration::from_millis(300)).await {
        eprintln!("DEBUG heard {m:?}");
    }
    {
        let store = rusqlite::Connection::open(dirs.data.join("floti.db")).unwrap();
        let row: (String, Option<i64>, Option<String>) = store.query_row("SELECT status, exit_code, ended_at FROM sessions WHERE id = ?1", [tests as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        eprintln!("DEBUG row {row:?}");
    }
    for n in 0..3 {
        let again = client.request::<SessionList>(&()).await.unwrap();
        eprintln!("DEBUG again {n}: {:?}", again.iter().map(|r| r.id).collect::<Vec<_>>());
    }
    // While the command runs it names its command and has no exit code; an
    // agent child and the parent name none.
    let listed = client.request::<SessionList>(&()).await.unwrap();
    let record = |listed: &[SessionRecord], id: u64| -> SessionRecord {
        listed
            .iter()
            .find(|record| record.id == id)
            .unwrap_or_else(|| {
                panic!(
                    "session {id} is listed; listed: {:?}",
                    listed.iter().map(|r| (r.id, &r.status)).collect::<Vec<_>>()
                )
            })
            .clone()
    };
    let running = record(&listed, tests);
    assert_eq!(running.command.as_deref(), Some("pnpm test --filter core"));
    assert_eq!(running.exit_code, None);
    assert_eq!(running.parent_id, Some(lead));
    assert_eq!(running.role, None);
    for session in [record(&listed, reviewer), record(&listed, lead)] {
        assert_eq!(session.command, None, "{} runs no command", session.name);
    }

    // Once it exits, the record carries its exit code beside its command, in
    // the exit the host sends and in the list.
    client.attach(1, tests).await;
    client.type_into(1, b"/exit 3\r").await;
    let exited: SessionRecord = client
        .event_on(
            EXITS,
            "the exit of the command child",
            |ended: &SessionRecord| ended.id == tests,
        )
        .await;
    assert_eq!(exited.exit_code, Some(3));
    assert_eq!(exited.command.as_deref(), Some("pnpm test --filter core"));

    let listed = client.request::<SessionList>(&()).await.unwrap();
    let ended = record(&listed, tests);
    assert_eq!(ended.status, SessionStatus::Exited);
    assert_eq!(ended.exit_code, Some(3));
    assert_eq!(ended.command.as_deref(), Some("pnpm test --filter core"));
    assert_eq!(record(&listed, reviewer).command, None);

    // A client one minor behind reads every field it knows of the same list,
    // the command child's record included.
    let mut old = TestClient::connect_at(&endpoint, ProtocolVersion::new(2, 0), TERMINAL).await;
    let payload: Payload = old
        .request_on(
            SessionList::NAME,
            to_payload(&()).expect("encode the request"),
        )
        .await
        .expect("a 2.0 client lists sessions");
    let wire: Vec<Value> = from_payload(&payload).expect("the list is readable as plain values");
    assert_eq!(wire.len(), 3);
    for session in &wire {
        assert_eq!(
            problems_for_a_2_0_reader(session),
            Vec::<String>::new(),
            "{session}"
        );
    }

    host.stop(HostStopReason::Stop).await;
}
