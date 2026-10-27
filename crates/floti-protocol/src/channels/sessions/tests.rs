//! Every session, plain-terminal, profile, history, archive and usage channel
//! from `shared/ipc.ts` is declared with typed payloads, and each payload
//! survives a trip through a CBOR frame.

use std::fmt::Debug;

use ciborium::Value;
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::*;
use crate::bytes::Bytes;
use crate::capability::Capability;
use crate::channel::{
    Catalogue, ChannelKind, EventChannel, RequestChannel, StreamChannel, from_payload, to_payload,
};
use crate::channels::common::SessionStatus;
use crate::frame::{FrameDecoder, encode_frame};
use crate::message::{Event, Message, Request, Response, Snapshot, StreamData, StreamOpen};

const EVENT: ChannelKind = ChannelKind::Event { snapshot: false };
const STATE: ChannelKind = ChannelKind::Event { snapshot: true };
const REQUEST: ChannelKind = ChannelKind::Request;
const STREAM: ChannelKind = ChannelKind::Stream;

/// Every ipc.ts host channel in this domain, as the protocol declares it.
/// The ipc.ts input channels are the other direction of a stream, in
/// [`CARRIED_ON_STREAMS`].
const DECLARED: &[(&str, ChannelKind, Option<Capability>)] = &[
    ("session:start", REQUEST, None),
    ("session:launch", REQUEST, None),
    ("session:restorable", REQUEST, None),
    ("session:restore", REQUEST, None),
    ("session:close", REQUEST, None),
    ("session:list", REQUEST, None),
    ("session:rename", REQUEST, None),
    ("session:resize", REQUEST, Some(Capability::Terminal)),
    ("session:focus", REQUEST, None),
    ("sessions:watch", REQUEST, None),
    ("session:confirmed", REQUEST, None),
    ("session:activity", STATE, None),
    ("sessions:overview", STATE, None),
    ("sessions:resources", STATE, None),
    ("session:exit", EVENT, None),
    ("session:activate", EVENT, None),
    ("session:confirm", EVENT, None),
    ("session:data", STREAM, Some(Capability::Terminal)),
    ("pterm:open", REQUEST, Some(Capability::Terminal)),
    ("pterm:close", REQUEST, Some(Capability::Terminal)),
    ("pterm:shells", REQUEST, None),
    ("pterm:resize", REQUEST, Some(Capability::Terminal)),
    ("pterm:exit", EVENT, Some(Capability::Terminal)),
    ("pterm:data", STREAM, Some(Capability::Terminal)),
    ("profile:list", REQUEST, None),
    ("profile:save", REQUEST, None),
    ("profile:delete", REQUEST, None),
    ("profile:pin", REQUEST, None),
    ("profile:export", REQUEST, None),
    ("profile:import", REQUEST, None),
    ("profile:launch", REQUEST, None),
    ("profiles:changed", STATE, None),
    ("history:summary", REQUEST, None),
    ("history:sessions", REQUEST, None),
    ("history:prompts", REQUEST, None),
    ("history:projects", REQUEST, None),
    ("history:refresh", REQUEST, None),
    ("history:rename", REQUEST, None),
    ("history:resume", REQUEST, None),
    ("history:changed", STATE, None),
    ("archive:conversation", REQUEST, None),
    ("archive:stats", REQUEST, None),
    ("archive:changed", STATE, None),
    ("usage:read", REQUEST, None),
    ("usage:changed", STATE, None),
];

fn domain() -> Catalogue {
    let mut catalogue = Catalogue::new();
    declare(&mut catalogue);
    catalogue
}

/// Frames `message`, decodes it as a client would, and returns what arrived.
fn over_the_wire(message: Message) -> Message {
    let mut decoder = FrameDecoder::new();
    decoder.push(&encode_frame(&message).unwrap());
    let arrived = decoder.next_message().unwrap().unwrap();
    assert!(decoder.next_message().unwrap().is_none());
    arrived
}

fn arrives_intact<T>(value: &T, wrap: impl FnOnce(crate::message::Payload) -> Message) -> T
where
    T: Serialize + DeserializeOwned + PartialEq + Debug,
{
    let payload = match over_the_wire(wrap(to_payload(value).unwrap())) {
        Message::Request(Request { payload, .. })
        | Message::Response(Response { payload, .. })
        | Message::Event(Event { payload, .. })
        | Message::StreamOpen(StreamOpen {
            params: payload, ..
        })
        | Message::Snapshot(Snapshot { state: payload, .. }) => payload,
        other => panic!("unexpected {other:?}"),
    };
    let decoded: T = from_payload(&payload).unwrap();
    assert_eq!(&decoded, value);
    decoded
}

/// A request and its response on channel `C` both survive the wire, and the
/// catalogue accepts the request as `C`'s.
fn exchange<C: RequestChannel>(request: C::Request, response: C::Response)
where
    C::Request: PartialEq + Debug,
    C::Response: PartialEq + Debug,
{
    let catalogue = domain();
    let wire = Request {
        id: 7,
        channel: C::NAME.into(),
        payload: to_payload(&request).unwrap(),
    };
    let decl = catalogue
        .check_request(&wire)
        .unwrap_or_else(|reply| panic!("{} refused its own request: {reply:?}", C::NAME));
    assert_eq!(decl.name(), C::NAME);

    arrives_intact(&request, |payload| {
        Message::Request(Request {
            id: 7,
            channel: C::NAME.into(),
            payload,
        })
    });
    arrives_intact(&response, |payload| {
        Message::Response(Response { id: 7, payload })
    });
}

/// A state channel's snapshot and event both survive the wire.
fn state<C: EventChannel>(value: C::Snapshot)
where
    C::Snapshot: PartialEq + Debug,
{
    assert!(C::SNAPSHOT, "{} should carry state", C::NAME);
    arrives_intact(&value, |state| {
        Message::Snapshot(Snapshot {
            subscription: 1,
            seq: 0,
            state,
        })
    });
    arrives_intact(&value, |payload| {
        Message::Event(Event {
            subscription: 1,
            seq: 1,
            payload,
        })
    });
}

fn event<C: EventChannel>(value: C::Event)
where
    C::Event: PartialEq + Debug,
{
    assert!(!C::SNAPSHOT, "{} should not carry state", C::NAME);
    arrives_intact(&value, |payload| {
        Message::Event(Event {
            subscription: 1,
            seq: 1,
            payload,
        })
    });
}

fn stream<C: StreamChannel>(open: C::Open)
where
    C::Open: PartialEq + Debug,
{
    arrives_intact(&open, |params| {
        Message::StreamOpen(StreamOpen {
            stream: 3,
            channel: C::NAME.into(),
            params,
        })
    });
}

fn record(id: u64) -> SessionRecord {
    SessionRecord {
        id,
        name: "helm-3".into(),
        label: Some("PR review".into()),
        cwd: "C:\\work\\a repo".into(),
        branch: Some("main".into()),
        project_path: Some("C:\\work\\a repo".into()),
        profile_id: Some(4),
        argv: vec!["--session-id".into(), "0b9c".into()],
        conversation_id: Some("0b9c".into()),
        backend: BackendId::claude_code(),
        status: SessionStatus::Exited,
        started_at: "2026-10-27T10:00:00Z".into(),
        ended_at: Some("2026-10-27T11:00:00Z".into()),
        duration_ms: Some(3_600_000),
        exit_code: Some(-1),
    }
}

fn launched() -> LaunchedSession {
    LaunchedSession {
        session: record(12),
        overlays: vec!["dev".into(), "api".into()],
        composed_instructions: true,
        warnings: vec!["The overlay folder C:\\gone is not there.".into()],
        not_taken: vec![crate::HarnessPart::Workflows],
    }
}

fn profile() -> Profile {
    Profile {
        id: 4,
        name: "API work".into(),
        root: "C:\\work\\api".into(),
        overlays: vec!["C:\\work\\web".into()],
        access: vec!["C:\\work\\shared".into()],
        model: Some("opus".into()),
        effort: Some(EffortLevel::Xhigh),
        permission_mode: Some(PermissionMode::AcceptEdits),
        agent: None,
        mcp: vec!["github".into()],
        opening_prompt: Some("Read the plan.".into()),
        pinned_order: Some(0),
        created_at: "2026-10-01T09:00:00Z".into(),
        updated_at: "2026-10-02T09:00:00Z".into(),
    }
}

fn history_session() -> HistorySession {
    HistorySession {
        session_id: "0b9c".into(),
        backend: BackendId::claude_code(),
        project: "C:\\work\\api".into(),
        project_name: "api".into(),
        prompt_count: 14,
        first_at: 1_761_550_000_000,
        last_at: 1_761_560_000_000,
        first_prompt: "/review".into(),
        title: "Review the auth change".into(),
        title_fallback: false,
        label: None,
        transcript_file: Some("C:\\Users\\me\\.claude\\projects\\api\\0b9c.jsonl".into()),
        transcript_bytes: Some(5_000_000_000),
        project_exists: true,
        archive: Some(ArchiveSessionState::Evicted),
        archived_messages: Some(0),
        matched: Some("auth".into()),
    }
}

fn history_summary() -> HistorySummary {
    HistorySummary {
        sessions: 1011,
        prompts: 9000,
        projects: 40,
        resumable: 105,
        latest_at: Some(1_761_560_000_000),
        history_file: "C:\\Users\\me\\.claude\\history.jsonl".into(),
        indexed_bytes: 12_345_678,
        error: None,
    }
}

fn archive_stats() -> ArchiveStats {
    ArchiveStats {
        sessions: 300,
        evicted_sessions: 2,
        messages: 120_000,
        raw_bytes: 900_000_000,
        stored_bytes: 200_000_000,
        max_bytes: 1 << 30,
        oldest_at: None,
        newest_at: Some(1_761_560_000_000),
    }
}

fn window(dollars: f64) -> UsageWindowCost {
    UsageWindowCost {
        tokens: UsageTokens {
            input: 10,
            output: 20,
            cache_write: 30,
            cache_read: 40_000_000_000,
        },
        dollars,
        messages: 12,
    }
}

fn usage() -> UsageSnapshot {
    UsageSnapshot {
        backend: BackendId::claude_code(),
        file: "C:\\Users\\me\\.claude.json".into(),
        fetched_at_ms: Some(1_761_560_000_000),
        limits: vec![UsageLimit {
            kind: "weekly_scoped".into(),
            group: UsageGroup::Weekly,
            percent: 41.5,
            severity: UsageSeverity::Warning,
            resets_at_ms: None,
            scope: Some("Opus".into()),
            is_active: true,
        }],
        problem: None,
        spend: Some(UsageSpend {
            session: window(1.25),
            today: window(3.5),
            week: window(20.0),
            priced_at: "2026-08-10".into(),
            unpriced_models: vec![],
            index_ms: 3.25,
        }),
    }
}

#[test]
fn every_session_terminal_profile_history_archive_and_usage_channel_from_ipc_ts_is_declared_with_its_kind()
 {
    let protocol = Catalogue::protocol();
    for &(name, kind, capability) in DECLARED {
        let decl = protocol
            .get(name)
            .unwrap_or_else(|| panic!("`{name}` is not declared"));
        assert_eq!(decl.kind(), kind, "`{name}` has the wrong kind");
        assert_eq!(
            decl.capability(),
            capability,
            "`{name}` needs the wrong capability"
        );
    }
    // Nothing else in this domain, so the list above is the whole of it.
    assert_eq!(domain().len(), DECLARED.len());
    for (input, stream) in CARRIED_ON_STREAMS {
        assert!(
            protocol.get(input).is_none(),
            "`{input}` travels on `{stream}`"
        );
        assert_eq!(protocol.get(stream).map(|decl| decl.kind()), Some(STREAM));
    }
}

#[test]
fn a_sessions_and_a_plain_terminals_input_and_output_travel_as_byte_streams() {
    stream::<SessionTerminal>(SessionStreamOpen { id: 12 });
    stream::<PtermTerminal>(PtermStreamOpen { id: 3 });

    // Output with invalid UTF-8 and a split escape sequence, then a keystroke
    // back, both on stream 3.
    let output: Vec<u8> = b"\x1b[31mred\xff\xfe\x1b[".to_vec();
    for data in [output, b"\r".to_vec()] {
        let arrived = over_the_wire(Message::StreamData(StreamData {
            stream: 3,
            data: Bytes(data.clone()),
        }));
        let Message::StreamData(arrived) = arrived else {
            panic!("expected stream data");
        };
        assert_eq!(arrived.data.as_slice(), data.as_slice());

        let frame = encode_frame(&Message::StreamData(StreamData {
            stream: 3,
            data: Bytes(data.clone()),
        }))
        .unwrap();
        let value: Value = ciborium::from_reader(&frame[4..]).unwrap();
        let field = value
            .as_map()
            .unwrap()
            .iter()
            .find(|(key, _)| key.as_text() == Some("data"))
            .map(|(_, value)| value.clone());
        assert_eq!(field, Some(Value::Bytes(data)));
    }
}

#[test]
fn session_requests_and_answers_round_trip_over_cbor() {
    exchange::<SessionStart>(
        StartSessionRequest {
            cwd: "C:\\work\\a repo".into(),
            project_path: None,
            name: Some("api".into()),
            backend: Some(BackendId::claude_code()),
            cols: 120,
            rows: 40,
        },
        record(12),
    );
    exchange::<SessionLaunch>(
        LaunchSessionRequest {
            cwd: "C:\\work\\api".into(),
            project_path: Some("C:\\work\\api".into()),
            name: None,
            profile_id: Some(4),
            permission_mode: Some(PermissionMode::Plan),
            resume: Some("0b9c".into()),
            backend: None,
            cols: 80,
            rows: 24,
        },
        launched(),
    );
    exchange::<SessionRestorable>(
        (),
        Some(RestoreOffer {
            sessions: vec![RestorableSession {
                id: 9,
                name: "dev 2".into(),
                cwd: "C:\\work\\api".into(),
                branch: None,
                profile: Some("API work".into()),
                profile_gone: false,
                last_at: Some(1_761_560_000_000),
                blocked: Some("Its folder is gone.".into()),
            }],
            elsewhere: 1,
        }),
    );
    exchange::<SessionRestorable>((), None);
    exchange::<SessionRestore>(
        RestoreSessionsRequest {
            sessions: vec![SessionToRestore {
                id: 9,
                cols: 100,
                rows: 30,
            }],
        },
        RestoreSessionsResult {
            restored: vec![RestoredSession {
                from: 9,
                launched: launched(),
            }],
            failed: vec![UnrestoredSession {
                id: 10,
                name: "web".into(),
                reason: "Its conversation is running elsewhere.".into(),
            }],
        },
    );
    exchange::<SessionClose>(
        CloseSessionRequest {
            id: 12,
            force: true,
        },
        CloseSessionResult { closed: false },
    );
    exchange::<SessionList>((), vec![record(1), record(2)]);
    exchange::<SessionRename>(
        RenameSessionRequest {
            id: 12,
            label: None,
        },
        record(12),
    );
    exchange::<SessionResize>(
        SessionResizeRequest {
            id: 12,
            cols: 200,
            rows: 60,
        },
        (),
    );
    exchange::<SessionFocus>(SessionFocusRequest { ids: vec![1, 2] }, ());
    exchange::<SessionsWatch>(SessionsWatchRequest { watching: true }, ());
    exchange::<SessionConfirmed>(
        SessionConfirmAnswer {
            id: 5,
            agreed: true,
        },
        (),
    );
}

#[test]
fn session_events_and_state_round_trip_over_cbor() {
    state::<SessionActivityChanged>(vec![SessionActivityState {
        id: 12,
        activity: Some(SessionActivity::Waiting),
        waiting_for: Some("permission prompt".into()),
        conversation_id: Some("0b9c".into()),
    }]);
    state::<SessionsOverviewChanged>(SessionsOverview {
        sessions: vec![
            LiveSession {
                host_session_id: Some(12),
                backend: BackendId::claude_code(),
                pid: 23496,
                registered: true,
                cwd: Some("C:\\work\\api".into()),
                name: Some("api".into()),
                activity: Some(SessionActivity::Busy),
                waiting_for: None,
                status_since_ms: Some(1_761_560_000_000),
                version: Some("2.1.238".into()),
                entrypoint: Some("cli".into()),
                started_at_ms: Some(1_761_550_000_000),
                conversation_id: Some("0b9c".into()),
            },
            LiveSession {
                host_session_id: None,
                backend: BackendId::new("tomorrows-agent"),
                pid: 4068,
                registered: false,
                cwd: None,
                name: None,
                activity: None,
                waiting_for: None,
                status_since_ms: None,
                version: None,
                entrypoint: None,
                started_at_ms: None,
                conversation_id: None,
            },
        ],
        read_at_ms: 1_761_560_000_000,
    });
    state::<SessionResourcesChanged>(vec![
        SessionResources {
            id: 12,
            root_pid: 23496,
            processes: Some(vec![SessionProcess {
                pid: 4068,
                parent_pid: 23496,
                name: "node.exe".into(),
                command_line: None,
                depth: 1,
                ports: Some(vec![]),
            }]),
            root_seen: true,
            ports: Some(vec![SessionPort {
                port: 5173,
                pid: 4068,
                process: "node.exe".into(),
                addresses: vec!["127.0.0.1".into(), "::1".into()],
            }]),
            opaque: 4,
            at_ms: 1_761_560_000_000,
        },
        SessionResources {
            id: 13,
            root_pid: 1,
            processes: None,
            root_seen: false,
            ports: None,
            opaque: 0,
            at_ms: 1_761_560_000_000,
        },
    ]);
    event::<SessionExit>(record(12));
    event::<SessionActivate>(SessionActivation { id: 12 });
    event::<SessionConfirm>(SessionConfirmRequest {
        id: 5,
        kind: SessionConfirmKind::CloseSession,
        message: "This session is still running.".into(),
        detail: "Closing it ends the conversation.".into(),
        confirm_label: "End session".into(),
        session_names: vec!["PR review".into()],
    });
}

#[test]
fn plain_terminal_channels_round_trip_over_cbor() {
    exchange::<PtermOpen>(
        PtermOpenRequest {
            path: "C:\\work\\a repo".into(),
            cols: 80,
            rows: 24,
            shell: Some("C:\\Program Files\\PowerShell\\7\\pwsh.exe".into()),
            separate: true,
        },
        PtermOpened {
            id: 3,
            shell: "C:\\Windows\\System32\\cmd.exe".into(),
            requested: Some("C:\\Program Files\\PowerShell\\7\\pwsh.exe".into()),
            problem: Some("PowerShell 7 is not installed.".into()),
        },
    );
    exchange::<PtermClose>(PtermCloseRequest { id: 3 }, ());
    exchange::<PtermShells>(
        (),
        vec![DetectedShell {
            path: "/bin/zsh".into(),
            name: "zsh".into(),
            label: "Z shell".into(),
            args: vec!["-l".into()],
        }],
    );
    exchange::<PtermResize>(
        PtermResizeRequest {
            id: 3,
            cols: 132,
            rows: 50,
        },
        (),
    );
    event::<PtermExit>(PtermExited {
        id: 3,
        exit_code: 130,
    });
}

#[test]
fn profile_channels_round_trip_over_cbor_and_the_dialogs_stay_in_the_client() {
    exchange::<ProfileList>((), vec![profile()]);
    exchange::<ProfileSave>(
        SaveProfileRequest {
            id: None,
            draft: ProfileDraft {
                name: "API work".into(),
                root: "C:\\work\\api".into(),
                overlays: vec![],
                access: vec![],
                model: None,
                effort: Some(EffortLevel::Low),
                permission_mode: None,
                agent: Some("reviewer".into()),
                mcp: vec![],
                opening_prompt: None,
                pinned_order: None,
            },
        },
        SaveProfileResult {
            profile: None,
            problems: vec!["The root folder does not exist.".into()],
        },
    );
    exchange::<ProfileDelete>(ProfileRef { id: 4 }, ProfileDeleted { deleted: true });
    exchange::<ProfilePin>(PinProfilesRequest { ids: vec![4, 2] }, vec![profile()]);

    // Export hands back the document for the client's save dialog; import
    // takes the document the client's open dialog read.
    let document = ProfileDocument {
        file_name: "API work.yaml".into(),
        yaml: "name: API work\nroot: C:\\work\\api\n".into(),
    };
    exchange::<ProfileExport>(ProfileRef { id: 4 }, document.clone());
    exchange::<ProfileImport>(
        document,
        ImportProfileResult {
            profile: Some(profile()),
            error: None,
            renamed_to: Some("API work (2)".into()),
        },
    );
    exchange::<ProfileLaunch>(
        LaunchProfileRequest {
            profile_id: 4,
            cols: 80,
            rows: 24,
        },
        LaunchedProfile {
            session: record(12),
            profile: profile(),
            overlays: vec!["web".into()],
            composed_instructions: false,
            warnings: vec![],
        },
    );
    state::<ProfilesChanged>(vec![profile()]);
}

#[test]
fn history_and_archive_channels_round_trip_over_cbor() {
    exchange::<ReadHistorySummary>((), history_summary());
    exchange::<HistorySessions>(
        HistoryQuery {
            search: Some("auth".into()),
            scope: Some(HistorySearchScope::Messages),
            project: Some("C:\\work\\api".into()),
            resumable_only: Some(true),
            limit: Some(50),
        },
        HistoryPage {
            sessions: vec![history_session()],
            total: 1,
            took_ms: 0.75,
        },
    );
    exchange::<HistoryPrompts>(
        HistorySessionRef {
            session_id: "0b9c".into(),
        },
        vec![HistoryPrompt {
            session_id: "0b9c".into(),
            seq: 88,
            text: "Review the auth change".into(),
            at: 1_761_550_000_000,
        }],
    );
    exchange::<HistoryProjects>(
        (),
        vec![HistoryProject {
            project: "C:\\work\\api".into(),
            name: "api".into(),
            sessions: 30,
            prompts: 400,
            last_at: 1_761_560_000_000,
            resumable: 5,
            exists: true,
        }],
    );
    exchange::<HistoryRefresh>(
        (),
        HistorySummary {
            error: Some("The history file could not be read.".into()),
            ..history_summary()
        },
    );
    exchange::<HistoryRename>(
        RenameHistorySessionRequest {
            session_id: "0b9c".into(),
            name: Some("Auth review".into()),
        },
        Some(history_session()),
    );
    exchange::<HistoryRename>(
        RenameHistorySessionRequest {
            session_id: "gone".into(),
            name: None,
        },
        None,
    );
    exchange::<HistoryResume>(
        ResumeSessionRequest {
            session_id: "0b9c".into(),
            cols: 80,
            rows: 24,
        },
        ResumedSession {
            session: record(12),
            history: history_session(),
        },
    );
    state::<HistoryChanged>(history_summary());

    exchange::<ArchiveConversation>(
        HistorySessionRef {
            session_id: "0b9c".into(),
        },
        Some(ArchivedConversation {
            session_id: "0b9c".into(),
            source_file: "C:\\Users\\me\\.claude\\projects\\api\\0b9c.jsonl".into(),
            state: ArchiveSessionState::Archived,
            first_at: Some(1_761_550_000_000),
            last_at: None,
            message_count: 2,
            raw_bytes: 2048,
            stored_bytes: 900,
            captured_at: "2026-10-27T10:00:00Z".into(),
            evicted_at: None,
            messages: vec![
                ArchiveMessage {
                    uuid: "m1".into(),
                    role: ArchiveRole::User,
                    at: 1_761_550_000_000,
                    text: "Review the auth change".into(),
                },
                ArchiveMessage {
                    uuid: "m2".into(),
                    role: ArchiveRole::Assistant,
                    at: 1_761_550_001_000,
                    text: "Done.".into(),
                },
            ],
        }),
    );
    exchange::<ArchiveConversation>(
        HistorySessionRef {
            session_id: "never".into(),
        },
        None,
    );
    exchange::<ReadArchiveStats>((), archive_stats());
    state::<ArchiveChanged>(archive_stats());
}

#[test]
fn usage_channels_round_trip_over_cbor_and_each_reading_names_its_backend() {
    let unread = UsageSnapshot {
        backend: BackendId::new("tomorrows-agent"),
        file: "/home/me/.agent/usage.json".into(),
        fetched_at_ms: None,
        limits: vec![],
        problem: Some(UsageProblem {
            kind: UsageProblemKind::RolledOver,
            detail: "Every window in the reading has reset.".into(),
        }),
        spend: None,
    };
    exchange::<ReadUsage>((), vec![usage(), unread.clone()]);
    state::<UsageChanged>(vec![usage()]);

    let payload = to_payload(&unread).unwrap();
    let map = payload.as_map().unwrap();
    let text = |name: &str| {
        map.iter()
            .find(|(key, _)| key.as_text() == Some(name))
            .and_then(|(_, value)| value.as_text().map(str::to_owned))
    };
    assert_eq!(text("backend").as_deref(), Some("tomorrows-agent"));
    let problem = to_payload(&unread.problem).unwrap();
    let kind = problem
        .as_map()
        .unwrap()
        .iter()
        .find(|(key, _)| key.as_text() == Some("kind"))
        .and_then(|(_, value)| value.as_text().map(str::to_owned));
    assert_eq!(kind.as_deref(), Some("rolled-over"));
}

#[test]
fn optional_request_fields_may_be_left_out() {
    let catalogue = domain();
    let request = |channel: &str, payload: serde_json::Value| Request {
        id: 1,
        channel: channel.into(),
        payload: to_payload(&payload).unwrap(),
    };
    for (channel, payload) in [
        (
            "session:start",
            serde_json::json!({ "cwd": "C:\\a", "cols": 80, "rows": 24 }),
        ),
        ("session:close", serde_json::json!({ "id": 1 })),
        (
            "pterm:open",
            serde_json::json!({ "path": "C:\\a", "cols": 80, "rows": 24 }),
        ),
        ("history:sessions", serde_json::json!({})),
    ] {
        catalogue
            .check_request(&request(channel, payload))
            .unwrap_or_else(|reply| panic!("{channel}: {reply:?}"));
    }

    let start: StartSessionRequest = from_payload(
        &request(
            "session:start",
            serde_json::json!({ "cwd": "C:\\a", "cols": 80, "rows": 24 }),
        )
        .payload,
    )
    .unwrap();
    assert_eq!(start.backend, None);
    let query: HistoryQuery = from_payload(&to_payload(&serde_json::json!({})).unwrap()).unwrap();
    assert_eq!(query, HistoryQuery::default());
}

#[test]
fn the_typescript_and_json_schema_for_these_channels_name_every_payload_with_no_bigint() {
    let catalogue = domain();
    let typescript = crate::generate::typescript(&catalogue);
    assert!(!typescript.contains("bigint"), "u64 must render as number");
    for name in [
        "StartSessionRequest",
        "LaunchedSession",
        "RestoreOffer",
        "SessionsOverview",
        "SessionResources",
        "SessionConfirmRequest",
        "PtermOpened",
        "DetectedShell",
        "Profile",
        "ProfileDocument",
        "HistoryPage",
        "ArchivedConversation",
        "UsageSnapshot",
    ] {
        assert!(
            typescript.contains(&format!("export type {name} ")),
            "the TypeScript does not declare {name}"
        );
    }
    for &(name, _, _) in DECLARED {
        assert!(
            typescript.contains(&format!("\"{name}\"")),
            "{name} missing"
        );
    }
    assert!(
        typescript.contains("match: string | null"),
        "HistorySession's matched prompt is `match` on the wire"
    );

    let schema = crate::generate::json_schema(&catalogue);
    for name in ["UsageSnapshot", "HistorySession", "SessionResources"] {
        assert!(
            schema.contains(&format!("\"{name}\"")),
            "schema lacks {name}"
        );
    }
}
