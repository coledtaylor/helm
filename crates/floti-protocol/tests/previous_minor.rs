//! A client one minor behind still reads what a host on this minor sends, and
//! the host still reads what that client sends: protocol 2.1 only adds
//! optional fields, so a 2.0 frame is a 2.1 frame with the new fields left
//! out, and a 2.1 frame is a 2.0 frame with fields the older reader ignores.

use std::collections::BTreeSet;

use floti_protocol::channel::{from_payload, to_payload};
use floti_protocol::channels::common::{ChildReport, PermissionMode, SessionRecord, SessionStatus};
use floti_protocol::channels::sessions::{
    EffortLevel, Profile, ProfileDraft, SessionConfirmKind, SessionConfirmRequest,
    SessionStreamOpen,
};
use floti_protocol::channels::workspace::{
    DEFAULT_AGENT_CHILDREN_PER_PARENT, DEFAULT_AGENT_COMMANDS_PER_PARENT, DEFAULT_AGENT_DEPTH,
    DEFAULT_AGENT_HEAVY_PER_HOST, DEFAULT_AGENT_SESSIONS_PER_HOST, DEFAULT_AGENT_STARTS_PER_PARENT,
    DEFAULT_SESSION_AGENTS, HostSettings, HostSettingsPatch,
};
use floti_protocol::record::{self, records, records_dir};
use floti_protocol::version::negotiate;
use floti_protocol::{BackendId, Catalogue, PROTOCOL_VERSION, ProtocolVersion};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const V2_0: ProtocolVersion = ProtocolVersion::new(2, 0);

// ---------------------------------------------------------------------------
// What a 2.0 client has: each type as 2.0 declared it, without the fields 2.1
// added, and without `deny_unknown_fields`, as no client reads strictly.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionRecordV20 {
    id: u64,
    name: String,
    label: Option<String>,
    cwd: String,
    branch: Option<String>,
    project_path: Option<String>,
    profile_id: Option<u64>,
    argv: Vec<String>,
    conversation_id: Option<String>,
    backend: BackendId,
    status: SessionStatus,
    started_at: String,
    ended_at: Option<String>,
    duration_ms: Option<u64>,
    exit_code: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostSettingsV20 {
    scan_roots: Vec<String>,
    pinned_projects: Vec<String>,
    first_run_completed_at: Option<String>,
    backend_paths: std::collections::BTreeMap<BackendId, String>,
    terminal_shell: Option<String>,
    transcript_archive_max_bytes: u64,
    browser_mcp: bool,
    browser_mcp_local_only: bool,
    session_mcp: bool,
    restore_without_asking: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileV20 {
    id: u64,
    name: String,
    root: String,
    overlays: Vec<String>,
    access: Vec<String>,
    model: Option<String>,
    effort: Option<EffortLevel>,
    permission_mode: Option<PermissionMode>,
    agent: Option<String>,
    mcp: Vec<String>,
    opening_prompt: Option<String>,
    pinned_order: Option<u32>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileDraftV20 {
    name: String,
    root: String,
    overlays: Vec<String>,
    access: Vec<String>,
    model: Option<String>,
    effort: Option<EffortLevel>,
    permission_mode: Option<PermissionMode>,
    agent: Option<String>,
    mcp: Vec<String>,
    opening_prompt: Option<String>,
    pinned_order: Option<u32>,
}

/// The question a 2.0 host asks before it ends a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionConfirmRequestV20 {
    id: u64,
    kind: SessionConfirmKind,
    message: String,
    detail: String,
    confirm_label: String,
    session_names: Vec<String>,
}

/// The stream a 2.0 client opens on a session's terminal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStreamOpenV20 {
    id: u64,
}

fn session_v20() -> SessionRecordV20 {
    SessionRecordV20 {
        id: 12,
        name: "helm-3".into(),
        label: Some("PR review".into()),
        cwd: "C:\\work\\a repo".into(),
        branch: Some("main".into()),
        project_path: Some("C:\\work\\a repo".into()),
        profile_id: Some(4),
        argv: vec!["--session-id".into(), "0b9c".into()],
        conversation_id: Some("0b9c".into()),
        backend: BackendId::claude_code(),
        status: SessionStatus::Running,
        started_at: "2026-10-27T10:00:00Z".into(),
        ended_at: None,
        duration_ms: None,
        exit_code: None,
    }
}

fn settings_v20() -> HostSettingsV20 {
    HostSettingsV20 {
        scan_roots: vec!["C:\\work".into()],
        pinned_projects: vec![],
        first_run_completed_at: None,
        backend_paths: Default::default(),
        terminal_shell: None,
        transcript_archive_max_bytes: 512 * 1024 * 1024,
        browser_mcp: true,
        browser_mcp_local_only: false,
        session_mcp: true,
        restore_without_asking: false,
    }
}

fn profile_v20() -> ProfileV20 {
    ProfileV20 {
        id: 4,
        name: "API work".into(),
        root: "C:\\work\\api".into(),
        overlays: vec![],
        access: vec![],
        model: None,
        effort: Some(EffortLevel::High),
        permission_mode: Some(PermissionMode::AcceptEdits),
        agent: None,
        mcp: vec![],
        opening_prompt: None,
        pinned_order: Some(0),
        created_at: "2026-10-01T09:00:00Z".into(),
        updated_at: "2026-10-02T09:00:00Z".into(),
    }
}

fn draft_v20() -> ProfileDraftV20 {
    ProfileDraftV20 {
        name: "API work".into(),
        root: "C:\\work\\api".into(),
        overlays: vec![],
        access: vec![],
        model: None,
        effort: None,
        permission_mode: None,
        agent: None,
        mcp: vec![],
        opening_prompt: Some("Read the plan.".into()),
        pinned_order: None,
    }
}

// ---------------------------------------------------------------------------
// The 2.1 record of a session
// ---------------------------------------------------------------------------

fn child_of(parent: &SessionRecord) -> SessionRecord {
    SessionRecord {
        id: parent.id + 1,
        name: "reviewer".into(),
        parent_id: Some(parent.id),
        parent_name: Some(parent.label.clone().unwrap_or_else(|| parent.name.clone())),
        role: Some("reviewer".into()),
        ..parent.clone()
    }
}

fn session_v21() -> SessionRecord {
    from_payload(&to_payload(&session_v20()).unwrap()).expect("a 2.0 record is a 2.1 record")
}

#[test]
fn s31_a_client_on_2_1_reads_a_childs_parent_and_role_and_a_session_with_neither_carries_none() {
    let parent = session_v21();
    let child = child_of(&parent);

    let read_child: SessionRecord = from_payload(&to_payload(&child).unwrap()).unwrap();
    assert_eq!(read_child.parent_id, Some(parent.id));
    assert_eq!(read_child.parent_name.as_deref(), Some("PR review"));
    assert_eq!(read_child.role.as_deref(), Some("reviewer"));

    let read_parent: SessionRecord = from_payload(&to_payload(&parent).unwrap()).unwrap();
    assert_eq!(read_parent.parent_id, None);
    assert_eq!(read_parent.parent_name, None);
    assert_eq!(read_parent.role, None);

    // On the wire a session with neither says null, never a made-up value.
    let wire = serde_json::to_value(&parent).unwrap();
    for field in ["parentId", "parentName", "role"] {
        assert_eq!(wire[field], Value::Null, "{field}");
    }
}

#[test]
fn s31_a_2_0_client_reads_every_field_it_knows_of_a_2_1_childs_record() {
    let child = child_of(&session_v21());
    let read: SessionRecordV20 = from_payload(&to_payload(&child).unwrap())
        .expect("a 2.0 client reads a 2.1 record of a child");
    let mut known = session_v20();
    known.id = child.id;
    known.name = child.name.clone();
    assert_eq!(read, known);
}

#[test]
fn s31_a_2_0_record_read_by_a_2_1_client_has_no_parent_and_no_role() {
    let read = session_v21();
    assert_eq!(
        (read.parent_id, read.parent_name, read.role),
        (None, None, None)
    );
    assert_eq!(read.name, "helm-3");
    assert_eq!(read.profile_id, Some(4));
}

/// A command child that has exited: it names its command, not a role, and its
/// exit code is the record's.
fn command_child(parent: &SessionRecord, code: i32) -> SessionRecord {
    SessionRecord {
        name: "tests".into(),
        role: None,
        command: Some("pnpm test --filter core".into()),
        status: SessionStatus::Exited,
        ended_at: Some("2026-10-03T14:52:00Z".into()),
        exit_code: Some(code),
        ..child_of(parent)
    }
}

#[test]
fn s23_a_client_on_2_1_reads_a_command_childs_command_and_exit_code_and_an_agent_child_carries_no_command()
 {
    let parent = session_v21();

    let read: SessionRecord =
        from_payload(&to_payload(&command_child(&parent, 3)).unwrap()).unwrap();
    assert_eq!(read.command.as_deref(), Some("pnpm test --filter core"));
    assert_eq!(read.exit_code, Some(3));
    assert_eq!(read.role, None);
    assert_eq!(read.parent_id, Some(parent.id));

    // A command child still running has no exit code to carry yet.
    let running = SessionRecord {
        status: SessionStatus::Running,
        ended_at: None,
        exit_code: None,
        ..command_child(&parent, 0)
    };
    let read: SessionRecord = from_payload(&to_payload(&running).unwrap()).unwrap();
    assert_eq!(read.command.as_deref(), Some("pnpm test --filter core"));
    assert_eq!(read.exit_code, None);

    // An agent child, and a session nobody started, carry none: null on the
    // wire, never a made-up value.
    for session in [child_of(&parent), parent.clone()] {
        let read: SessionRecord = from_payload(&to_payload(&session).unwrap()).unwrap();
        assert_eq!(read.command, None);
        assert_eq!(
            serde_json::to_value(&session).unwrap()["command"],
            Value::Null
        );
    }
}

#[test]
fn s23_a_2_0_client_reads_every_field_it_knows_of_a_command_childs_record() {
    let child = command_child(&session_v21(), 0);
    let read: SessionRecordV20 = from_payload(&to_payload(&child).unwrap())
        .expect("a 2.0 client reads a 2.1 record of a command child");
    assert_eq!(read.id, child.id);
    assert_eq!(read.name, "tests");
    assert_eq!(read.status, SessionStatus::Exited);
    assert_eq!(read.exit_code, Some(0));
    assert_eq!(read.ended_at.as_deref(), Some("2026-10-03T14:52:00Z"));
}

#[test]
fn s23_a_record_from_a_host_before_2_1_reads_as_no_command() {
    let read: SessionRecord = from_payload(&to_payload(&session_v20()).unwrap()).unwrap();
    assert_eq!(read.command, None);
}

fn stopped_child(parent: &SessionRecord) -> SessionRecord {
    SessionRecord {
        status: SessionStatus::Exited,
        ended_at: Some("2026-10-03T14:52:00Z".into()),
        stopped: true,
        ..child_of(parent)
    }
}

#[test]
fn a_2_1_record_says_stopped_only_for_a_session_the_host_ended_and_omits_it_otherwise() {
    let parent = session_v21();
    let stopped = stopped_child(&parent);

    let read: SessionRecord = from_payload(&to_payload(&stopped).unwrap()).unwrap();
    assert!(read.stopped);
    assert_eq!(
        serde_json::to_value(&stopped).unwrap()["stopped"],
        Value::Bool(true)
    );

    // A session that exited by itself carries nothing, so its record is the
    // record a 2.0 host sends.
    let wire = serde_json::to_value(child_of(&parent)).unwrap();
    assert!(wire.get("stopped").is_none(), "{wire}");
    assert!(!parent.stopped);
}

#[test]
fn a_record_from_a_host_before_2_1_reads_as_not_stopped() {
    let wire = to_payload(&session_v20()).unwrap();
    let read: SessionRecord = from_payload(&wire).unwrap();
    assert!(!read.stopped);

    let read: SessionRecord = serde_json::from_value(json!({
        "id": 9, "name": "a", "label": null, "cwd": "C:\\work", "branch": null,
        "projectPath": null, "profileId": null, "argv": [], "conversationId": null,
        "backend": "claude-code", "status": "exited", "startedAt": "2026-10-03T14:00:00Z",
        "endedAt": "2026-10-03T14:52:00Z", "durationMs": 1, "exitCode": 0
    }))
    .unwrap();
    assert!(!read.stopped);
}

#[test]
fn a_2_0_client_reads_every_field_it_knows_of_a_stopped_childs_record() {
    let stopped = stopped_child(&session_v21());
    let read: SessionRecordV20 = from_payload(&to_payload(&stopped).unwrap())
        .expect("a 2.0 client reads a 2.1 record that says stopped");
    assert_eq!(read.id, stopped.id);
    assert_eq!(read.status, SessionStatus::Exited);
    assert_eq!(read.ended_at.as_deref(), Some("2026-10-03T14:52:00Z"));
}

#[test]
fn a_childs_last_report_is_on_its_record_only_while_it_has_one() {
    let parent = session_v21();
    let reported = SessionRecord {
        last_report: Some(ChildReport {
            state: "done".into(),
            text: "Fixed both bugs in ledger.rs.".into(),
            at: "2026-11-06T10:00:00Z".into(),
        }),
        ..child_of(&parent)
    };

    let read: SessionRecord = from_payload(&to_payload(&reported).unwrap()).unwrap();
    assert_eq!(read.last_report, reported.last_report);
    assert_eq!(
        serde_json::to_value(&reported).unwrap()["lastReport"],
        json!({ "state": "done", "text": "Fixed both bugs in ledger.rs.", "at": "2026-11-06T10:00:00Z" })
    );

    // With none, the field is absent: the record is the record of a host
    // before it, and one from such a host reads as none.
    assert!(
        serde_json::to_value(child_of(&parent))
            .unwrap()
            .get("lastReport")
            .is_none()
    );
    let old: SessionRecord = from_payload(&to_payload(&session_v20()).unwrap()).unwrap();
    assert_eq!(old.last_report, None);

    // A 2.0 client reads everything it knows of a record that carries one.
    let v20: SessionRecordV20 = from_payload(&to_payload(&reported).unwrap())
        .expect("a 2.0 client reads a record that carries a last report");
    assert_eq!(v20.id, reported.id);
}

#[test]
fn a_child_started_to_outlive_its_parent_and_its_mode_are_on_its_record_only_when_there_are_some() {
    let parent = session_v21();
    let child = SessionRecord {
        outlive: true,
        permission_mode: Some(PermissionMode::Plan),
        ..child_of(&parent)
    };

    let read: SessionRecord = from_payload(&to_payload(&child).unwrap()).unwrap();
    assert!(read.outlive);
    assert_eq!(read.permission_mode, Some(PermissionMode::Plan));
    let wire = serde_json::to_value(&child).unwrap();
    assert_eq!(wire["outlive"], Value::Bool(true));
    assert_eq!(wire["permissionMode"], "plan");

    // Without them the record is the record of a host before 2.1.
    let plain = serde_json::to_value(child_of(&parent)).unwrap();
    assert!(plain.get("outlive").is_none(), "{plain}");
    assert!(plain.get("permissionMode").is_none(), "{plain}");
    let old: SessionRecord = from_payload(&to_payload(&session_v20()).unwrap()).unwrap();
    assert!(!old.outlive);
    assert_eq!(old.permission_mode, None);

    // A 2.0 client reads everything it knows of a record that carries them.
    let v20: SessionRecordV20 = from_payload(&to_payload(&child).unwrap())
        .expect("a 2.0 client reads a record that carries outlive and a mode");
    assert_eq!(v20.id, child.id);
}

#[test]
fn a_close_question_names_the_sessions_that_end_and_that_outlive_and_a_2_0_client_still_reads_it() {
    let v20 = SessionConfirmRequestV20 {
        id: 5,
        kind: SessionConfirmKind::CloseSession,
        message: "lead is still running.".into(),
        detail: "Closing it ends it and 2 more.".into(),
        confirm_label: "End 3 sessions".into(),
        session_names: vec!["lead".into(), "worker".into()],
    };
    // A question from a host before 2.1 names no ids.
    let read: SessionConfirmRequest = from_payload(&to_payload(&v20).unwrap()).unwrap();
    assert!(read.ending_ids.is_empty() && read.outliving_ids.is_empty());

    let asked = SessionConfirmRequest {
        ending_ids: vec![13, 14],
        outliving_ids: vec![15],
        ..read
    };
    let heard: SessionConfirmRequest = from_payload(&to_payload(&asked).unwrap()).unwrap();
    assert_eq!(heard, asked);
    let old: SessionConfirmRequestV20 = from_payload(&to_payload(&asked).unwrap())
        .expect("a 2.0 client reads a question that names ids");
    assert_eq!(old, v20);

    // A question that names none says nothing of them.
    let wire = serde_json::to_value(SessionConfirmRequest {
        ending_ids: vec![],
        outliving_ids: vec![],
        ..asked
    })
    .unwrap();
    assert!(wire.get("endingIds").is_none() && wire.get("outlivingIds").is_none());
}

#[test]
fn a_stream_opened_by_a_2_0_client_is_not_a_watch_and_a_watch_is_only_said_when_it_is_one() {
    let from_v20: SessionStreamOpen =
        from_payload(&to_payload(&SessionStreamOpenV20 { id: 12 }).unwrap()).unwrap();
    assert_eq!(
        from_v20,
        SessionStreamOpen {
            id: 12,
            watch: false
        }
    );
    assert!(
        serde_json::to_value(&from_v20)
            .unwrap()
            .get("watch")
            .is_none()
    );

    let watching = SessionStreamOpen {
        id: 12,
        watch: true,
    };
    assert_eq!(
        serde_json::to_value(&watching).unwrap()["watch"],
        Value::Bool(true)
    );
    // A host before 2.1 reads it as the open it knows: the id it names.
    let read: SessionStreamOpenV20 = from_payload(&to_payload(&watching).unwrap()).unwrap();
    assert_eq!(read, SessionStreamOpenV20 { id: 12 });
}

#[test]
fn a_profile_from_before_2_1_runs_without_remote_control_and_a_2_0_client_reads_one_that_has_it() {
    let profile: Profile = from_payload(&to_payload(&profile_v20()).unwrap()).unwrap();
    assert_eq!(profile.remote_control, None);
    let draft: ProfileDraft = from_payload(&to_payload(&draft_v20()).unwrap()).unwrap();
    assert_eq!(draft.remote_control, None);

    let on = Profile {
        remote_control: Some(true),
        ..profile
    };
    let read: ProfileV20 = from_payload(&to_payload(&on).unwrap()).unwrap();
    assert_eq!(read, profile_v20());
    let kept: Profile = from_payload(&to_payload(&on).unwrap()).unwrap();
    assert_eq!(kept.remote_control, Some(true));
}

#[test]
fn the_standing_notice_channels_are_in_2_1_and_not_in_2_0_and_every_2_0_channel_stays() {
    let v20 = record_of(V2_0);
    let v21: Value =
        serde_json::from_str(&record::record(PROTOCOL_VERSION, &Catalogue::protocol())).unwrap();
    let channels = |record: &Value| -> BTreeSet<String> {
        record["channels"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect()
    };
    let (before, after) = (channels(&v20), channels(&v21));
    assert!(before.is_subset(&after), "a channel left 2.1");
    for added in [
        "notices:changed",
        "notices:dismiss",
        "notices:allowMore",
        "session:size",
    ] {
        assert!(!before.contains(added), "{added} was in 2.0");
        assert!(after.contains(added), "{added} is not in 2.1");
    }
    assert_eq!(v21["channels"]["notices:changed"]["kind"], "event");
    assert!(!v21["channels"]["notices:changed"]["snapshot"].is_null());
}

#[test]
fn s31_a_2_1_host_negotiates_the_version_a_2_0_client_speaks() {
    assert_eq!(PROTOCOL_VERSION, ProtocolVersion::new(2, 1));
    assert_eq!(negotiate(PROTOCOL_VERSION, V2_0), Ok(V2_0));
    assert_eq!(
        negotiate(PROTOCOL_VERSION, PROTOCOL_VERSION),
        Ok(PROTOCOL_VERSION)
    );
}

// ---------------------------------------------------------------------------
// The settings and the profile
// ---------------------------------------------------------------------------

#[test]
fn settings_from_a_host_before_2_1_read_as_the_defaults() {
    let read: HostSettings = from_payload(&to_payload(&settings_v20()).unwrap()).unwrap();
    assert_eq!(read.session_agents, DEFAULT_SESSION_AGENTS);
    assert_eq!(
        read.agent_children_per_parent,
        DEFAULT_AGENT_CHILDREN_PER_PARENT
    );
    assert_eq!(
        read.agent_sessions_per_host,
        DEFAULT_AGENT_SESSIONS_PER_HOST
    );
    assert_eq!(read.agent_depth, DEFAULT_AGENT_DEPTH);
    assert_eq!(
        read.agent_starts_per_parent,
        DEFAULT_AGENT_STARTS_PER_PARENT
    );
    assert_eq!(read.agent_heavy_per_host, DEFAULT_AGENT_HEAVY_PER_HOST);
    assert_eq!(
        (DEFAULT_SESSION_AGENTS, DEFAULT_AGENT_CHILDREN_PER_PARENT),
        (true, 4)
    );
    assert_eq!(
        (
            DEFAULT_AGENT_SESSIONS_PER_HOST,
            DEFAULT_AGENT_DEPTH,
            DEFAULT_AGENT_STARTS_PER_PARENT,
            DEFAULT_AGENT_HEAVY_PER_HOST
        ),
        (8, 2, 16, 1)
    );
    assert_eq!(
        read.agent_commands_per_parent,
        DEFAULT_AGENT_COMMANDS_PER_PARENT
    );
    assert_eq!(DEFAULT_AGENT_COMMANDS_PER_PARENT, 4);
    assert_eq!(read.scan_roots, vec!["C:\\work".to_owned()]);
}

#[test]
fn a_2_0_clients_settings_patch_changes_none_of_the_agents_settings() {
    let patch: HostSettingsPatch = from_payload(
        &to_payload(&json!({ "sessionMcp": false, "scanRoots": ["C:\\work"] })).unwrap(),
    )
    .unwrap();
    assert_eq!(patch.session_mcp, Some(false));
    assert_eq!(
        (
            patch.session_agents,
            patch.agent_children_per_parent,
            patch.agent_sessions_per_host,
            patch.agent_depth,
            patch.agent_starts_per_parent,
            patch.agent_commands_per_parent,
            patch.agent_heavy_per_host
        ),
        (None, None, None, None, None, None, None)
    );
    // A patch that sets none of them does not say them either.
    let said = serde_json::to_value(&patch).unwrap();
    for key in [
        "sessionAgents",
        "agentChildrenPerParent",
        "agentSessionsPerHost",
        "agentDepth",
        "agentStartsPerParent",
        "agentCommandsPerParent",
        "agentHeavyPerHost",
    ] {
        assert!(said.get(key).is_none(), "{key} in {said}");
    }
}

#[test]
fn a_profile_from_before_2_1_follows_the_hosts_setting() {
    let profile: Profile = from_payload(&to_payload(&profile_v20()).unwrap()).unwrap();
    assert_eq!(profile.session_agents, None);
    let draft: ProfileDraft = from_payload(&to_payload(&draft_v20()).unwrap()).unwrap();
    assert_eq!(draft.session_agents, None);
}

#[test]
fn a_2_0_client_reads_a_2_1_profile_that_turns_the_agents_tools_off() {
    let off: Profile = Profile {
        session_agents: Some(false),
        ..from_payload(&to_payload(&profile_v20()).unwrap()).unwrap()
    };
    let read: ProfileV20 = from_payload(&to_payload(&off).unwrap()).unwrap();
    assert_eq!(read, profile_v20());
}

#[test]
fn a_2_0_client_reads_the_2_1_hosts_settings() {
    let host: HostSettings = from_payload(&to_payload(&settings_v20()).unwrap()).unwrap();
    let read: HostSettingsV20 = from_payload(&to_payload(&host).unwrap()).unwrap();
    assert_eq!(read, settings_v20());
}

// ---------------------------------------------------------------------------
// The records of the two versions
// ---------------------------------------------------------------------------

fn properties_of(record: &Value, name: &str) -> BTreeSet<String> {
    record["types"][name]["properties"]
        .as_object()
        .unwrap_or_else(|| panic!("{name} has no properties in the record"))
        .keys()
        .cloned()
        .collect()
}

fn required_of(record: &Value, name: &str) -> BTreeSet<String> {
    record["types"][name]["required"]
        .as_array()
        .map(|names| {
            names
                .iter()
                .filter_map(|name| name.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn record_of(version: ProtocolVersion) -> Value {
    let text = records(&records_dir())
        .unwrap()
        .into_iter()
        .find_map(|(found, text)| (found == version).then_some(text))
        .unwrap_or_else(|| panic!("there is no record of {version}"));
    serde_json::from_str(&text).unwrap()
}

fn names(list: &[&str]) -> BTreeSet<String> {
    list.iter().map(|name| (*name).to_owned()).collect()
}

#[test]
fn the_2_0_clients_types_above_are_the_types_the_2_0_record_holds() {
    let v20 = record_of(V2_0);
    for (name, sample) in [
        (
            "SessionRecord",
            serde_json::to_value(session_v20()).unwrap(),
        ),
        (
            "HostSettings",
            serde_json::to_value(settings_v20()).unwrap(),
        ),
        ("Profile", serde_json::to_value(profile_v20()).unwrap()),
        ("ProfileDraft", serde_json::to_value(draft_v20()).unwrap()),
    ] {
        let fields: BTreeSet<String> = sample.as_object().unwrap().keys().cloned().collect();
        assert_eq!(fields, properties_of(&v20, name), "{name}");
    }
}

#[test]
fn protocol_2_1_adds_only_optional_fields_and_these_are_all_of_them() {
    let v20 = record_of(V2_0);
    let v21: Value =
        serde_json::from_str(&record::record(PROTOCOL_VERSION, &Catalogue::protocol())).unwrap();
    assert_eq!(v21["version"], "2.1");
    let added = [
        (
            "SessionRecord",
            vec![
                "command",
                "lastReport",
                "outlive",
                "parentId",
                "parentName",
                "permissionMode",
                "role",
                "stopped",
            ],
        ),
        ("SessionConfirmRequest", vec!["endingIds", "outlivingIds"]),
        ("SessionStreamOpen", vec!["watch"]),
        (
            "HostSettings",
            vec![
                "sessionAgents",
                "agentChildrenPerParent",
                "agentSessionsPerHost",
                "agentDepth",
                "agentStartsPerParent",
                "agentCommandsPerParent",
                "agentHeavyPerHost",
            ],
        ),
        (
            "HostSettingsPatch",
            vec![
                "sessionAgents",
                "agentChildrenPerParent",
                "agentSessionsPerHost",
                "agentDepth",
                "agentStartsPerParent",
                "agentCommandsPerParent",
                "agentHeavyPerHost",
            ],
        ),
        ("Profile", vec!["remoteControl", "sessionAgents"]),
        ("ProfileDraft", vec!["remoteControl", "sessionAgents"]),
    ];
    for (name, new) in added {
        let before = properties_of(&v20, name);
        let after = properties_of(&v21, name);
        let gained: BTreeSet<String> = after.difference(&before).cloned().collect();
        assert_eq!(gained, names(&new), "{name} gained");
        assert!(before.is_subset(&after), "{name} lost a field");
        assert_eq!(
            required_of(&v21, name),
            required_of(&v20, name),
            "{name} requires what it did, so a 2.0 frame is still a whole 2.1 frame"
        );
    }
}
