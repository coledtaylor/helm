//! The plugin tools a client answers: `agentPlugin:*`. A client offers its
//! servers, the host sends it each call and each cancel, and it answers; none
//! of it needs a capability, because a call goes only to the connection that
//! offered the server.

use ciborium::Value;
use floti_protocol::channel::{from_payload, to_payload};
use floti_protocol::channels::agent_plugin::{
    AgentPluginAnswer, AgentPluginCallCancel, AgentPluginCaller, AgentPluginCalls,
    AgentPluginCancels, AgentPluginOffer, AgentPluginOutcome, AgentPluginServer,
    AgentPluginServers, AgentPluginTool, AgentPluginToolAnswer, AgentPluginToolCall,
};
use floti_protocol::message::{Request, Subscribe};
use floti_protocol::{
    CapabilitySet, Catalogue, ChannelKind, ClientChannels, EventChannel, Message, RequestChannel,
};
use serde_json::json;

#[test]
fn the_plugin_tool_channels_are_two_requests_and_two_events_needing_no_capability() {
    let catalogue = Catalogue::protocol();
    for (name, kind) in [
        (AgentPluginOffer::NAME, ChannelKind::Request),
        (AgentPluginAnswer::NAME, ChannelKind::Request),
        (
            AgentPluginCalls::NAME,
            ChannelKind::Event { snapshot: false },
        ),
        (
            AgentPluginCancels::NAME,
            ChannelKind::Event { snapshot: false },
        ),
    ] {
        let decl = catalogue
            .get(name)
            .unwrap_or_else(|| panic!("`{name}` is declared"));
        assert_eq!(decl.kind(), kind, "{name}");
        assert_eq!(decl.capability(), None, "{name}");
    }
    assert_eq!(
        [
            AgentPluginOffer::NAME,
            AgentPluginCalls::NAME,
            AgentPluginAnswer::NAME,
            AgentPluginCancels::NAME
        ],
        [
            "agentPlugin:offer",
            "agentPlugin:call",
            "agentPlugin:answer",
            "agentPlugin:cancel"
        ]
    );
}

#[test]
fn a_terminal_only_client_may_offer_hear_calls_and_answer() {
    let catalogue = Catalogue::protocol();
    let mut client = ClientChannels::new(&catalogue, CapabilitySet::from_names(["terminal"]));
    for (number, channel) in [(1, AgentPluginCalls::NAME), (2, AgentPluginCancels::NAME)] {
        client
            .subscribe(&Subscribe {
                subscription: number,
                channel: channel.into(),
            })
            .unwrap();
        let [Message::Event(event)] = &client.event(channel, 1, &Value::Null)[..] else {
            panic!("`{channel}` did not reach the client");
        };
        assert_eq!(event.subscription, number);
    }
    let answer = AgentPluginToolAnswer {
        call_id: 3,
        outcome: AgentPluginOutcome::Failed {
            message: "no".into(),
        },
    };
    let wire = Request {
        id: 1,
        channel: AgentPluginAnswer::NAME.into(),
        payload: to_payload(&answer).unwrap(),
    };
    assert!(client.check_request(&wire).is_ok());
}

#[test]
fn an_offer_carries_each_server_as_a_session_reads_it_in_camel_case() {
    let offer = AgentPluginServers {
        servers: vec![AgentPluginServer {
            name: "helm-plugin-notes".into(),
            plugin: "notes".into(),
            instructions: "These tools come from \"Notes\".".into(),
            tools: vec![AgentPluginTool {
                name: "find".into(),
                description: "Finds a note.".into(),
                input_schema: to_payload(&json!({ "type": "object", "properties": {} })).unwrap(),
                read_only: true,
            }],
        }],
    };
    let wire: serde_json::Value = from_payload(&to_payload(&offer).unwrap()).unwrap();
    assert_eq!(
        wire,
        json!({
            "servers": [{
                "name": "helm-plugin-notes",
                "plugin": "notes",
                "instructions": "These tools come from \"Notes\".",
                "tools": [{
                    "name": "find",
                    "description": "Finds a note.",
                    "inputSchema": { "type": "object", "properties": {} },
                    "readOnly": true,
                }],
            }],
        })
    );
    let back: AgentPluginServers = from_payload(&to_payload(&wire).unwrap()).unwrap();
    assert_eq!(back, offer);
}

#[test]
fn a_call_names_the_call_the_session_the_plugin_and_the_tool_and_an_answer_is_done_or_failed() {
    let call = AgentPluginToolCall {
        call_id: 7,
        session: 4,
        caller: Some(AgentPluginCaller {
            id: "k3v9q2".into(),
            label: "notes: triage".into(),
            folder: "C:\\work\\a repo".into(),
        }),
        plugin: "notes".into(),
        tool: "find".into(),
        arguments: to_payload(&json!({ "query": "x" })).unwrap(),
    };
    let wire: serde_json::Value = from_payload(&to_payload(&call).unwrap()).unwrap();
    assert_eq!(
        wire,
        json!({
            "callId": 7,
            "session": 4,
            "caller": { "id": "k3v9q2", "label": "notes: triage", "folder": "C:\\work\\a repo" },
            "plugin": "notes",
            "tool": "find",
            "arguments": { "query": "x" },
        })
    );
    let back: AgentPluginToolCall = from_payload(&to_payload(&wire).unwrap()).unwrap();
    assert_eq!(back, call);

    // A host with no running session to name sends null.
    let unnamed = AgentPluginToolCall {
        caller: None,
        ..call
    };
    let wire: serde_json::Value = from_payload(&to_payload(&unnamed).unwrap()).unwrap();
    assert_eq!(wire["caller"], serde_json::Value::Null);

    let done: serde_json::Value = from_payload(
        &to_payload(&AgentPluginToolAnswer {
            call_id: 7,
            outcome: AgentPluginOutcome::Done {
                value: to_payload(&json!({ "content": [] })).unwrap(),
            },
        })
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        done,
        json!({ "callId": 7, "outcome": { "status": "done", "value": { "content": [] } } })
    );
    let failed: serde_json::Value =
        from_payload(&to_payload(&AgentPluginOutcome::not_connected("Notes")).unwrap()).unwrap();
    assert_eq!(failed["status"], "failed");
    let message = failed["message"].as_str().unwrap();
    assert!(
        message.contains("Helm") && message.contains("Notes"),
        "{message}"
    );

    let cancel: serde_json::Value =
        from_payload(&to_payload(&AgentPluginCallCancel { call_id: 7 }).unwrap()).unwrap();
    assert_eq!(cancel, json!({ "callId": 7 }));
}
