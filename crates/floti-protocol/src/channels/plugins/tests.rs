//! Every plugin and plugin-secret channel from `shared/ipc.ts` is declared
//! with typed payloads, plugin page deliveries and UI requests are events,
//! and each payload survives a trip through a CBOR frame.

use std::fmt::Debug;

use ciborium::Value;
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::*;
use crate::backend::BackendId;
use crate::capability::{Capability, CapabilitySet};
use crate::channel::{ChannelKind, EventChannel, RequestChannel, from_payload, to_payload};
use crate::channels::common::SessionStatus;
use crate::frame::{FrameDecoder, encode_frame};
use crate::message::{ErrorCode, Event, Message, Request, Response, Snapshot};

const EVENT: ChannelKind = ChannelKind::Event { snapshot: false };
const STATE: ChannelKind = ChannelKind::Event { snapshot: true };
const REQUEST: ChannelKind = ChannelKind::Request;
const PAGES: Option<Capability> = Some(Capability::PluginPages);

/// Every ipc.ts host channel in this domain, and `plugins:file`, which only
/// a client's own protocol handler asks, as the protocol declares them.
const DECLARED: &[(&str, ChannelKind, Option<Capability>)] = &[
    ("plugins:file", REQUEST, PAGES),
    ("plugins:list", REQUEST, None),
    ("plugins:add", REQUEST, None),
    ("plugins:remove", REQUEST, None),
    ("plugins:setEnabled", REQUEST, None),
    ("plugins:setTools", REQUEST, None),
    ("plugins:reload", REQUEST, None),
    ("plugins:setSetting", REQUEST, None),
    ("plugins:call", REQUEST, PAGES),
    ("plugins:session", REQUEST, None),
    ("plugins:command", REQUEST, None),
    ("plugins:metrics", REQUEST, None),
    ("plugins:log", REQUEST, None),
    ("plugins:ownSecrets", REQUEST, None),
    ("plugins:cancel", REQUEST, PAGES),
    ("plugins:answer", REQUEST, PAGES),
    ("plugins:changed", STATE, None),
    ("plugins:ui", EVENT, PAGES),
    ("plugins:deliver", EVENT, PAGES),
    ("secrets:list", REQUEST, None),
    ("secrets:save", REQUEST, None),
    ("secrets:remove", REQUEST, None),
    ("secrets:changed", STATE, None),
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

fn arrives_intact<T>(value: &T, wrap: impl FnOnce(Payload) -> Message) -> Payload
where
    T: Serialize + DeserializeOwned + PartialEq + Debug,
{
    let payload = match over_the_wire(wrap(to_payload(value).unwrap())) {
        Message::Request(Request { payload, .. })
        | Message::Response(Response { payload, .. })
        | Message::Event(Event { payload, .. })
        | Message::Snapshot(Snapshot { state: payload, .. }) => payload,
        other => panic!("unexpected {other:?}"),
    };
    let decoded: T = from_payload(&payload).unwrap();
    assert_eq!(&decoded, value);
    payload
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

/// An event on `C` survives the wire; returns its encoded payload.
fn event<C: EventChannel>(value: C::Event) -> Payload
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
    })
}

/// The text-keyed field `key` of a CBOR map.
fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value
        .as_map()
        .unwrap_or_else(|| panic!("{value:?} is not a map"))
        .iter()
        .find(|(k, _)| k.as_text() == Some(key))
        .map(|(_, v)| v)
        .unwrap_or_else(|| panic!("{value:?} has no `{key}`"))
}

fn text(value: &str) -> Value {
    Value::Text(value.into())
}

fn record() -> SessionRecord {
    SessionRecord {
        id: 31,
        name: "factory: triage".into(),
        label: None,
        cwd: "C:\\work\\a repo".into(),
        branch: Some("main".into()),
        project_path: Some("C:\\work\\a repo".into()),
        profile_id: None,
        argv: vec!["--session-id".into(), "7c1e".into()],
        conversation_id: Some("7c1e".into()),
        backend: BackendId::claude_code(),
        status: SessionStatus::Running,
        started_at: "2026-10-27T10:00:00Z".into(),
        ended_at: None,
        duration_ms: None,
        exit_code: None,
    }
}

fn plugin() -> PluginInfo {
    PluginInfo {
        path: "C:\\plugins\\factory plugin".into(),
        id: Some("factory".into()),
        name: "Factory".into(),
        version: Some("1.2.0".into()),
        description: Some("Runs and their logs.".into()),
        enabled: true,
        error: None,
        warnings: vec!["`icon` is not square.".into()],
        revision: 9,
        icon: Some("data:image/svg+xml;base64,PHN2Zz4=".into()),
        rail: Some(PluginRail {
            title: "Factory".into(),
            panel: "runs".into(),
        }),
        panels: BTreeMap::from([(
            "runs".into(),
            PluginPanelInfo {
                title: "Runs".into(),
                url: "floti-plugin://factory/dist/runs.html".into(),
                actions: vec![PluginPanelAction {
                    id: "refresh".into(),
                    title: "Refresh".into(),
                    icon: PluginPanelActionIcon::Refresh,
                }],
            },
        )]),
        tabs: BTreeMap::from([(
            "run".into(),
            PluginTabInfo {
                title: "Run".into(),
                url: "floti-plugin://factory/dist/run.html".into(),
            },
        )]),
        page_strip: true,
        background: Some(PluginBackgroundInfo {
            url: "floti-plugin://factory/dist/background.html".into(),
            state: PluginBackgroundState::Crashed,
            error: Some("ReferenceError: x is not defined".into()),
        }),
        commands: vec![
            PluginCommandInfo {
                id: "open-run".into(),
                title: "Open run".into(),
                tab: Some("run".into()),
            },
            PluginCommandInfo {
                id: "sync".into(),
                title: "Sync".into(),
                tab: None,
            },
        ],
        settings: vec![
            PluginSettingSpec::Text {
                key: "server".into(),
                label: "Server".into(),
                description: None,
                default: Some("https://factory.example".into()),
                placeholder: Some("https://".into()),
            },
            PluginSettingSpec::Number {
                key: "limit".into(),
                label: "Limit".into(),
                description: Some("Runs per page.".into()),
                default: Some(50.0),
                min: Some(1.0),
                max: None,
            },
            PluginSettingSpec::Toggle {
                key: "follow".into(),
                label: "Follow".into(),
                description: None,
                default: Some(true),
            },
            PluginSettingSpec::Select {
                key: "view".into(),
                label: "View".into(),
                description: None,
                options: vec![PluginSelectOption {
                    value: "list".into(),
                    label: "List".into(),
                }],
                default: None,
            },
            PluginSettingSpec::Secret {
                key: "token".into(),
                label: "Token".into(),
                description: None,
                secret: "factory-token".into(),
            },
        ],
        setting_values: BTreeMap::from([
            (
                "server".into(),
                PluginSettingValue::Text("https://f".into()),
            ),
            ("limit".into(), PluginSettingValue::Number(25.0)),
            ("follow".into(), PluginSettingValue::Toggle(false)),
            ("view".into(), PluginSettingValue::Unset),
        ]),
        network: vec!["https://factory.example".into()],
        secrets: vec![
            PluginSecretInfo {
                key: "factory-token".into(),
                state: PluginSecretState::NotAllowed,
            },
            PluginSecretInfo {
                key: "other".into(),
                state: PluginSecretState::Ready,
            },
        ],
        exec: vec![PluginExecInfo {
            name: "factory".into(),
            command: "factory".into(),
            args: vec!["--json".into()],
        }],
        service: Some(PluginServiceInfo {
            kind: PluginServiceKind::Node,
            command: "dist/service.js".into(),
            start: PluginServiceStart::Demand,
            state: PluginServiceState::Running,
            pid: Some(4120),
            port: Some(51_822),
            restarts: 1,
            error: None,
        }),
        runs_programs: true,
        agent: Some(PluginAgentInfo {
            enabled: true,
            server: "floti-plugin-factory".into(),
            instructions: None,
            tools: vec![
                PluginToolInfo {
                    name: "runs".into(),
                    description: "Lists runs.".into(),
                    input_schema: Value::Map(vec![
                        (text("type"), text("object")),
                        (text("properties"), Value::Map(vec![])),
                    ]),
                    read_only: true,
                },
                PluginToolInfo {
                    name: "rerun".into(),
                    description: "Runs one again.".into(),
                    input_schema: Value::Map(vec![(text("type"), text("object"))]),
                    read_only: false,
                },
            ],
        }),
        starts_sessions: true,
        sees_sessions: false,
        status: Some(PluginStatusItem {
            text: "3 failing".into(),
            tone: Some(PluginStatusTone::Danger),
            tooltip: None,
        }),
        badge: Some(3),
    }
}

/// A folder whose manifest could not be read: every surface empty.
fn broken_plugin() -> PluginInfo {
    PluginInfo {
        path: "C:\\plugins\\broken".into(),
        id: None,
        name: "broken".into(),
        version: None,
        description: None,
        enabled: false,
        error: Some("There is no floti-plugin.json in this folder.".into()),
        warnings: vec![],
        revision: 1,
        icon: None,
        rail: None,
        panels: BTreeMap::new(),
        tabs: BTreeMap::new(),
        page_strip: false,
        background: None,
        commands: vec![],
        settings: vec![],
        setting_values: BTreeMap::new(),
        network: vec![],
        secrets: vec![],
        exec: vec![],
        service: None,
        runs_programs: false,
        agent: None,
        starts_sessions: false,
        sees_sessions: false,
        status: None,
        badge: None,
    }
}

fn plugins() -> Vec<PluginInfo> {
    vec![plugin(), broken_plugin()]
}

fn secrets() -> SecretsState {
    SecretsState {
        available: true,
        secrets: vec![SecretInfo {
            key: "factory-token".into(),
            hosts: vec!["https://factory.example".into()],
            plugins: vec!["factory".into()],
            updated_at: "2026-10-27T09:00:00Z".into(),
        }],
    }
}

fn path(path: &str) -> PluginPathRequest {
    PluginPathRequest { path: path.into() }
}

#[test]
fn every_plugin_and_secret_channel_in_ipc_ts_is_declared_with_its_kind_and_capability() {
    let catalogue = domain();
    let declared: Vec<_> = catalogue
        .channels()
        .map(|decl| (decl.name(), decl.kind(), decl.capability()))
        .collect();
    let mut expected = DECLARED.to_vec();
    expected.sort_by_key(|(name, ..)| *name);
    assert_eq!(declared, expected);
}

#[test]
fn host_internal_and_client_only_plugin_channels_are_not_declared() {
    use crate::channels::boundary::{Placement, placement};

    let protocol = crate::channel::Catalogue::protocol();
    let host_internal = [
        "plugins:tool",
        "plugins:toolCancel",
        "plugins:toolResult",
        "plugins:backgroundState",
    ];
    for name in host_internal {
        assert!(
            matches!(placement(&protocol, name), Some(Placement::HostInternal(_))),
            "{name} stays between a background page and what runs it"
        );
    }
    assert!(matches!(
        placement(&protocol, "plugins:theme"),
        Some(Placement::ClientOnly(_))
    ));
    let declared: Vec<_> = DECLARED.iter().map(|(name, ..)| *name).collect();
    for name in host_internal.into_iter().chain(["plugins:theme"]) {
        assert!(
            protocol.get(name).is_none(),
            "{name} must not cross the protocol"
        );
        assert!(!declared.contains(&name));
    }
}

#[test]
fn plugin_page_deliveries_and_ui_requests_are_events_only_a_plugin_pages_client_receives() {
    let catalogue = domain();
    let terminal_only = CapabilitySet::from_names(["terminal"]);
    let pages = CapabilitySet::from_names(["terminal", "pluginPages"]);
    for name in [
        "plugins:ui",
        "plugins:deliver",
        "plugins:call",
        "plugins:cancel",
        "plugins:answer",
        "plugins:file",
    ] {
        let decl = catalogue.get(name).unwrap();
        assert!(!decl.covered_by(&terminal_only), "{name}");
        assert!(decl.covered_by(&pages), "{name}");
    }
    for name in ["plugins:ui", "plugins:deliver"] {
        assert_eq!(catalogue.get(name).unwrap().kind(), EVENT, "{name}");
    }
    // Settings > Plugins works for any client.
    for name in ["plugins:list", "plugins:changed", "secrets:save"] {
        assert!(catalogue.get(name).unwrap().covered_by(&terminal_only));
    }
}

#[test]
fn plugin_management_requests_round_trip() {
    exchange::<PluginsList>((), plugins());
    exchange::<PluginsAdd>(
        PluginAddRequest {
            path: "C:\\plugins\\factory plugin".into(),
        },
        PluginAddResult {
            path: "C:\\plugins\\factory plugin".into(),
            error: None,
            plugins: plugins(),
        },
    );
    exchange::<PluginsAdd>(
        PluginAddRequest {
            path: "C:\\empty".into(),
        },
        PluginAddResult {
            path: "C:\\empty".into(),
            error: Some("There is no plugin manifest in C:\\empty.".into()),
            plugins: vec![],
        },
    );
    exchange::<PluginsRemove>(
        PluginRemoveRequest {
            path: "C:\\plugins\\broken".into(),
            delete_secrets: vec!["factory-token".into()],
        },
        vec![plugin()],
    );
    exchange::<PluginsSetEnabled>(
        PluginSwitchRequest {
            path: "C:\\plugins\\broken".into(),
            enabled: false,
        },
        plugins(),
    );
    exchange::<PluginsSetTools>(
        PluginSwitchRequest {
            path: "C:\\plugins\\factory plugin".into(),
            enabled: true,
        },
        plugins(),
    );
    exchange::<PluginsReload>(path("C:\\plugins\\factory plugin"), plugins());
    exchange::<PluginsMetrics>(
        (),
        vec![
            PluginMetrics {
                path: "C:\\plugins\\factory plugin".into(),
                plugin: "factory".into(),
                memory_kb: Some(84_000),
                cpu_percent: Some(1.5),
                processes: 3,
            },
            PluginMetrics {
                path: "C:\\plugins\\broken".into(),
                plugin: "broken".into(),
                memory_kb: None,
                cpu_percent: None,
                processes: 0,
            },
        ],
    );
    exchange::<PluginsLog>(
        path("C:\\plugins\\factory plugin"),
        vec![
            PluginLogLine {
                at: "2026-10-27T10:00:00Z".into(),
                stream: PluginLogStream::Out,
                text: "listening".into(),
            },
            PluginLogLine {
                at: "2026-10-27T10:00:01Z".into(),
                stream: PluginLogStream::Err,
                text: "warn".into(),
            },
            PluginLogLine {
                at: "2026-10-27T10:00:02Z".into(),
                stream: PluginLogStream::Host,
                text: "restarted after a crash".into(),
            },
        ],
    );
    exchange::<PluginsOwnSecrets>(
        path("C:\\plugins\\factory plugin"),
        vec!["factory-token".into()],
    );
    exchange::<PluginsCommand>(
        PluginCommandRequest {
            plugin: "factory".into(),
            id: "sync".into(),
        },
        (),
    );
}

#[test]
fn a_plugin_setting_is_a_string_number_boolean_or_null_on_the_wire() {
    for (value, wire) in [
        (
            PluginSettingValue::Text("https://f".into()),
            text("https://f"),
        ),
        (PluginSettingValue::Toggle(true), Value::Bool(true)),
        (PluginSettingValue::Unset, Value::Null),
    ] {
        exchange::<PluginsSetSetting>(
            PluginSetSettingRequest {
                plugin: "factory".into(),
                key: "server".into(),
                value: value.clone(),
            },
            plugins(),
        );
        assert_eq!(to_payload(&value).unwrap(), wire);
    }
    let number = to_payload(&PluginSettingValue::Number(25.0)).unwrap();
    assert!(number.is_float() || number.is_integer(), "{number:?}");
    // A client may send a whole number as an integer.
    let from_integer: PluginSettingValue = from_payload(&Value::Integer(25.into())).unwrap();
    assert_eq!(from_integer, PluginSettingValue::Number(25.0));
}

#[test]
fn a_bridge_call_carries_any_arguments_and_answers_with_a_value_or_a_coded_failure() {
    let fetch = Value::Map(vec![
        (text("url"), text("https://factory.example/runs")),
        (text("body"), Value::Bytes(vec![0, 159, 255])),
    ]);
    let call = PluginCallRequest {
        plugin: "factory".into(),
        surface: PluginSurfaceKind::Panel,
        method: "fetch".into(),
        args: vec![fetch, Value::Null],
        call_id: "c-14".into(),
    };
    let ok = PluginCallOutcome::ok(Value::Array(vec![Value::Integer(1.into()), text("two")]));
    exchange::<PluginsCall>(call.clone(), ok.clone());
    let wire = to_payload(&ok).unwrap();
    assert_eq!(field(&wire, "ok"), &Value::Bool(true));

    let failed = PluginCallOutcome::failed(PluginErrorCode::NotDeclared, "Not in the manifest.");
    exchange::<PluginsCall>(call, failed.clone());
    let wire = to_payload(&failed).unwrap();
    assert_eq!(field(&wire, "ok"), &Value::Bool(false));
    assert_eq!(field(&wire, "code"), &text("not-declared"));

    for (code, name) in [
        (PluginErrorCode::Secret, "secret"),
        (PluginErrorCode::NotFound, "not-found"),
        (PluginErrorCode::NotAllowed, "not-allowed"),
        (PluginErrorCode::Busy, "busy"),
    ] {
        assert_eq!(to_payload(&code).unwrap(), text(name));
    }

    // `ok: false` with a value is neither shape.
    let mixed = Value::Map(vec![
        (text("ok"), Value::Bool(false)),
        (text("value"), Value::Null),
    ]);
    assert!(from_payload::<PluginCallOutcome>(&mixed).is_err());
}

#[test]
fn a_call_without_the_shape_of_its_channel_is_refused_naming_the_channel() {
    let catalogue = domain();
    let wire = Request {
        id: 3,
        channel: "plugins:call".into(),
        payload: Value::Map(vec![(text("plugin"), text("factory"))]),
    };
    let reply = catalogue.check_request(&wire).unwrap_err();
    assert_eq!(reply.id, 3);
    assert_eq!(reply.channel, "plugins:call");
    assert_eq!(reply.code, ErrorCode::BadPayload);
}

#[test]
fn page_answers_and_cancels_round_trip() {
    exchange::<PluginsCancel>(
        PluginCancelRequest {
            call_id: "c-14".into(),
        },
        (),
    );
    exchange::<PluginsAnswer>(
        PluginAnswerRequest {
            request_id: "r-2".into(),
        },
        (),
    );
    let start = PluginSessionAnswer {
        request_id: "r-3".into(),
        start: true,
        cols: 120,
        rows: 40,
    };
    exchange::<PluginsSession>(start, Some(record()));
    exchange::<PluginsSession>(
        PluginSessionAnswer {
            request_id: "r-4".into(),
            start: false,
            cols: 80,
            rows: 24,
        },
        None,
    );
    let wire = to_payload(&Option::<SessionRecord>::None).unwrap();
    assert_eq!(wire, Value::Null);
    let wire = to_payload(&PluginAnswerRequest {
        request_id: "r-2".into(),
    })
    .unwrap();
    assert_eq!(field(&wire, "requestId"), &text("r-2"));
}

#[test]
fn every_kind_of_ui_request_arrives_as_an_event_tagged_by_kind() {
    let requests = [
        (
            PluginUiRequest::OpenTab {
                plugin: "factory".into(),
                tab: "run".into(),
                params: PluginParams(BTreeMap::from([
                    ("id".into(), PluginParamValue::Text("r-88".into())),
                    ("attempt".into(), PluginParamValue::Number(2.0)),
                    ("follow".into(), PluginParamValue::Flag(true)),
                ])),
                title: Some("Run 88".into()),
                preview: true,
            },
            "openTab",
        ),
        (
            PluginUiRequest::Secret {
                request_id: "r-2".into(),
                plugin: "factory".into(),
                key: "factory-token".into(),
                hosts: vec!["https://factory.example".into()],
            },
            "secret",
        ),
        (
            PluginUiRequest::Session {
                request_id: "r-3".into(),
                plugin: "factory".into(),
                cwd: "C:\\work\\a repo".into(),
                prompt: "Triage run 88.".into(),
                name: "factory: triage".into(),
            },
            "session",
        ),
        (
            PluginUiRequest::SessionWithdrawn {
                request_id: "r-3".into(),
            },
            "sessionWithdrawn",
        ),
        (
            PluginUiRequest::Link {
                plugin: "factory".into(),
                url: "https://factory.example/runs/88".into(),
            },
            "link",
        ),
    ];
    for (request, kind) in requests {
        let wire = event::<PluginsUi>(request);
        assert_eq!(field(&wire, "kind"), &text(kind));
        if kind != "openTab" && kind != "link" {
            field(&wire, "requestId");
        }
    }
}

#[test]
fn every_kind_of_page_delivery_arrives_as_an_event_with_typed_data() {
    let deliveries = [
        (
            PluginDelivery::Settings {
                plugin: "factory".into(),
                data: BTreeMap::from([
                    ("limit".into(), PluginSettingValue::Number(10.0)),
                    ("view".into(), PluginSettingValue::Unset),
                ]),
                to: PluginDeliveryTarget::All,
            },
            "settings",
        ),
        (
            PluginDelivery::Secrets {
                plugin: "factory".into(),
                data: BTreeMap::from([
                    ("factory-token".into(), PluginPageSecretState::Ready),
                    ("other".into(), PluginPageSecretState::Missing),
                ]),
                to: PluginDeliveryTarget::All,
            },
            "secrets",
        ),
        (
            PluginDelivery::Command {
                plugin: "factory".into(),
                data: PluginCommandEvent { id: "sync".into() },
                to: PluginDeliveryTarget::Background,
            },
            "command",
        ),
        (
            PluginDelivery::Sessions {
                plugin: "factory".into(),
                data: vec![
                    PluginSession {
                        id: "s-1".into(),
                        name: "factory: triage".into(),
                        cwd: "C:\\work\\a repo".into(),
                        state: PluginSessionState::Running,
                        activity: Some(PluginSessionActivity::Waiting),
                        activity_since: Some(1_761_560_000_000),
                        started_at: 1_761_550_000_000,
                        ended_at: None,
                    },
                    PluginSession {
                        id: "s-2".into(),
                        name: "api".into(),
                        cwd: "C:\\work\\api".into(),
                        state: PluginSessionState::Ended,
                        activity: None,
                        activity_since: None,
                        started_at: 1_761_540_000_000,
                        ended_at: Some(1_761_545_000_000),
                    },
                ],
                to: PluginDeliveryTarget::All,
            },
            "sessions",
        ),
        (
            PluginDelivery::Channel {
                plugin: "factory".into(),
                data: PluginChannelMessage {
                    name: "factory-runs".into(),
                    message: Value::Map(vec![
                        (text("type"), text("changed")),
                        (text("ids"), Value::Array(vec![Value::Integer(3.into())])),
                    ]),
                    token: "c-7".into(),
                },
                to: PluginDeliveryTarget::All,
            },
            "channel",
        ),
    ];
    for (delivery, name) in deliveries {
        let wire = event::<PluginsDeliver>(delivery);
        assert_eq!(field(&wire, "event"), &text(name));
        field(&wire, "plugin");
        field(&wire, "data");
        field(&wire, "to");
    }
}

fn page_file(status: u16, content_type: &str, body: Vec<u8>) -> PluginFile {
    PluginFile {
        status,
        content_type: content_type.into(),
        version: Some("1.2.0".into()),
        revision: 9,
        total_bytes: body.len() as u64,
        body: Bytes(body),
    }
}

#[test]
fn a_page_file_is_read_a_piece_at_a_time_with_its_status_type_version_and_revision() {
    let request = PluginFileRequest {
        plugin: "factory".into(),
        path: "panel/my page.html".into(),
        offset: 4,
    };
    exchange::<PluginsFile>(
        request.clone(),
        page_file(200, "text/html; charset=utf-8", b"<p>".to_vec()),
    );
    exchange::<PluginsFile>(
        request.clone(),
        page_file(403, "text/plain; charset=utf-8", b"Forbidden".to_vec()),
    );
    exchange::<PluginsFile>(
        request,
        PluginFile {
            status: 404,
            content_type: "text/plain; charset=utf-8".into(),
            version: None,
            revision: 0,
            total_bytes: 9,
            body: Bytes(b"Not found".to_vec()),
        },
    );

    let png = page_file(200, "image/png", vec![0x89, b'P', b'N', b'G', 0, 0xFF]);
    let wire = to_payload(&png).unwrap();
    let field = |name: &str| {
        wire.as_map()
            .unwrap()
            .iter()
            .find(|(k, _)| k.as_text() == Some(name))
            .map(|(_, v)| v.clone())
    };
    assert_eq!(
        field("body"),
        Some(Value::Bytes(png.body.0.clone())),
        "the body is a CBOR byte string"
    );
    assert_eq!(field("contentType"), Some(text("image/png")));
    assert_eq!(field("version"), Some(text("1.2.0")));
    assert_eq!(field("revision"), Some(Value::Integer(9.into())));
    assert_eq!(field("totalBytes"), Some(Value::Integer(6.into())));

    // A request that leaves the offset out starts at the first byte.
    let bare = Value::Map(vec![
        (text("plugin"), text("factory")),
        (text("path"), text("index.html")),
    ]);
    let request: PluginFileRequest = from_payload(&bare).unwrap();
    assert_eq!(request.offset, 0);
}

#[test]
fn a_full_page_file_piece_and_its_framing_fit_in_one_frame() {
    let piece = page_file(
        200,
        "application/javascript",
        vec![0xFF; PLUGIN_FILE_PIECE_LEN as usize],
    );
    let frame = encode_frame(&Message::Response(Response {
        id: u64::MAX,
        payload: to_payload(&piece).unwrap(),
    }))
    .expect("a full piece is one frame");
    assert!(frame.len() <= crate::frame::MAX_FRAME_LEN as usize + 4);
    assert!(PLUGIN_FILE_PIECE_LEN * 2 < u64::from(crate::frame::MAX_FRAME_LEN));
}

#[test]
fn page_files_are_asked_by_a_client_and_never_named_in_ipc_ts() {
    use crate::channels::boundary::{Placement, placement};

    let protocol = crate::channel::Catalogue::protocol();
    assert!(matches!(
        placement(&protocol, "plugins:file"),
        Some(Placement::Declared("plugins:file"))
    ));
    let ipc = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/desktop/src/shared/ipc.ts"),
    )
    .expect("shared/ipc.ts is readable");
    assert!(ipc.contains("'plugins:list'"), "ipc.ts quotes its channels");
    assert!(
        !ipc.contains("'plugins:file'"),
        "only the desktop's main process asks for page files"
    );
}

#[test]
fn a_channel_post_carries_its_name_message_and_posting_token() {
    let wire = event::<PluginsDeliver>(PluginDelivery::Channel {
        plugin: "factory".into(),
        data: PluginChannelMessage {
            name: "factory-runs".into(),
            message: text("refresh"),
            token: "c-7".into(),
        },
        to: PluginDeliveryTarget::All,
    });
    assert_eq!(field(&wire, "to"), &text("all"));
    let data = field(&wire, "data");
    assert_eq!(field(data, "name"), &text("factory-runs"));
    assert_eq!(field(data, "message"), &text("refresh"));
    assert_eq!(field(data, "token"), &text("c-7"));

    // A post goes to the host as a call of the bridge's own method.
    exchange::<PluginsCall>(
        PluginCallRequest {
            plugin: "factory".into(),
            surface: PluginSurfaceKind::Tab,
            method: PLUGIN_CHANNEL_POST.into(),
            args: vec![text("factory-runs"), text("refresh"), text("c-7")],
            call_id: "9".into(),
        },
        PluginCallOutcome::ok(Value::Null),
    );
}

#[test]
fn a_plugin_tool_carries_its_input_schema_and_read_only_mark() {
    let wire = to_payload(&plugin()).unwrap();
    let tools = field(field(&wire, "agent"), "tools").as_array().unwrap();
    assert_eq!(field(&tools[0], "readOnly"), &Value::Bool(true));
    assert_eq!(
        field(field(&tools[0], "inputSchema"), "type"),
        &text("object")
    );
    assert_eq!(field(&tools[1], "readOnly"), &Value::Bool(false));
}

#[test]
fn the_plugin_list_is_state_with_a_snapshot() {
    state::<PluginsChanged>(plugins());
    state::<PluginsChanged>(vec![]);
}

#[test]
fn optional_manifest_fields_are_left_out_rather_than_sent_as_null() {
    let wire = to_payload(&PluginSettingSpec::Toggle {
        key: "follow".into(),
        label: "Follow".into(),
        description: None,
        default: None,
    })
    .unwrap();
    let keys: Vec<_> = wire
        .as_map()
        .unwrap()
        .iter()
        .map(|(k, _)| k.as_text().unwrap().to_owned())
        .collect();
    assert_eq!(keys, ["type", "key", "label"]);
    // And a manifest that leaves them out decodes.
    let decoded: PluginStatusItem =
        from_payload(&Value::Map(vec![(text("text"), text("ok"))])).unwrap();
    assert_eq!(decoded.tone, None);
}

#[test]
fn secrets_requests_round_trip_and_their_list_is_state_with_a_snapshot() {
    exchange::<SecretsList>((), secrets());
    exchange::<SecretsSave>(
        SecretInput {
            key: "factory-token".into(),
            value: Some("s3cret".into()),
            hosts: vec!["https://factory.example".into()],
            plugins: vec!["factory".into()],
        },
        secrets(),
    );
    exchange::<SecretsSave>(
        SecretInput {
            key: "factory-token".into(),
            value: None,
            hosts: vec![],
            plugins: vec!["factory".into()],
        },
        secrets(),
    );
    exchange::<SecretsRemove>(
        SecretRemoveRequest {
            key: "factory-token".into(),
        },
        SecretsState {
            available: false,
            secrets: vec![],
        },
    );
    state::<SecretsChanged>(secrets());
}

#[test]
fn the_generated_typescript_keeps_the_ipc_ts_shapes() {
    let ts = crate::generate::typescript(&domain());
    for expected in [
        "{ ok: true, value: unknown, } | { ok: false, code: PluginErrorCode, message: string, }",
        "\"not-declared\"",
        "\"kind\": \"openTab\"",
        "requestId: string",
        "\"event\": \"sessions\"",
        "\"event\": \"channel\"",
        "inputSchema: unknown",
        "readOnly: boolean",
        "boolean | number | string | null",
        "description?: string",
        "args: unknown[]",
        "offset: number",
        "totalBytes: number",
        "version: string | null",
    ] {
        assert!(ts.contains(expected), "missing `{expected}` in:\n{ts}");
    }
    assert!(!ts.contains("bigint"), "{ts}");
}
