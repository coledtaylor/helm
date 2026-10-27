//! A client receives only what its declared capabilities cover. Over the
//! whole catalogue, a client that declared only terminal is sent no plugin
//! page, Files or agent browser traffic, and a request on such a channel is
//! refused with an error naming the capability.

use ciborium::Value;
use floti_protocol::channel::to_payload;
use floti_protocol::channels::agent_browser::{
    AgentBrowserAnswer, AgentBrowserCalls, AgentBrowserOutcome, AgentBrowserToolAnswer,
    AgentBrowserToolCall, browser_client,
};
use floti_protocol::message::{
    ErrorCode, Request, StreamClose, StreamOpen, Subscribe, SubscriptionError,
};
use floti_protocol::{
    Capability, CapabilitySet, Catalogue, ChannelKind, ClientChannels, EventChannel, Message,
    RequestChannel, Router,
};

fn terminal_only() -> CapabilitySet {
    CapabilitySet::from_names(["terminal"])
}

fn everything() -> CapabilitySet {
    Capability::ALL.into_iter().collect()
}

/// The capabilities a terminal-only client lacks.
const NOT_TERMINAL: [Capability; 3] = [
    Capability::PluginPages,
    Capability::Files,
    Capability::Browser,
];

fn subscribe(subscription: u64, channel: &str) -> Subscribe {
    Subscribe {
        subscription,
        channel: channel.into(),
    }
}

fn request(id: u64, channel: &str, payload: Value) -> Request {
    Request {
        id,
        channel: channel.into(),
        payload,
    }
}

fn names_the_capability(message: &str, capability: Capability) -> bool {
    message.contains(&format!("`{}` capability", capability.name()))
}

#[test]
fn a_terminal_only_client_is_refused_every_channel_needing_plugin_pages_files_or_browser() {
    let catalogue = Catalogue::protocol();
    let mut client = ClientChannels::new(&catalogue, terminal_only());
    let mut router = Router::new(&catalogue, terminal_only());

    let mut refused = Vec::new();
    for (number, decl) in (1u64..).zip(catalogue.channels()) {
        let Some(needed) = decl.capability().filter(|c| NOT_TERMINAL.contains(c)) else {
            continue;
        };
        refused.push(decl.name());
        assert!(!client.may_receive(decl.name()));
        match decl.kind() {
            ChannelKind::Request => {
                // Refused before its payload is looked at, so any payload
                // will do: the error is about the capability.
                let wire = request(number, decl.name(), Value::Null);
                let reply = client.check_request(&wire).unwrap_err();
                assert_eq!(
                    (reply.id, reply.channel.as_str(), reply.code),
                    (number, decl.name(), ErrorCode::MissingCapability)
                );
                assert!(
                    names_the_capability(&reply.message, needed),
                    "{}",
                    reply.message
                );
                let Message::Error(routed) = router.dispatch(&wire) else {
                    panic!("`{}` was answered for a terminal-only client", decl.name())
                };
                assert_eq!(routed, reply);
            }
            ChannelKind::Event { .. } => {
                let SubscriptionError {
                    subscription,
                    code,
                    message,
                    ..
                } = client
                    .subscribe(&subscribe(number, decl.name()))
                    .unwrap_err();
                assert_eq!((subscription, code), (number, ErrorCode::MissingCapability));
                assert!(names_the_capability(&message, needed), "{message}");
                assert!(client.subscriptions_to(decl.name()).is_empty());
                assert!(
                    client.event(decl.name(), 1, &Value::Null).is_empty(),
                    "an event on `{}` reached a terminal-only client",
                    decl.name()
                );
            }
            ChannelKind::Stream => {
                let open = StreamOpen {
                    stream: number,
                    channel: decl.name().into(),
                    params: Value::Null,
                };
                let StreamClose { stream, reason } = client.open_stream(&open).unwrap_err();
                assert_eq!(stream, number);
                assert!(names_the_capability(&reason.unwrap(), needed));
            }
        }
    }

    // Plugin page events, Files events and agent browser tool calls are all
    // among them, so the loop above was not vacuous.
    for name in [
        "plugins:ui",
        "plugins:deliver",
        "plugins:call",
        "files:changed",
        "files:read",
        "content:document",
        "agentBrowser:call",
        "agentBrowser:answer",
    ] {
        assert!(refused.contains(&name), "`{name}` was not refused");
    }
}

#[test]
fn plugin_page_files_and_browser_events_reach_only_the_clients_that_declared_them() {
    let catalogue = Catalogue::protocol();
    let mut terminal = ClientChannels::new(&catalogue, terminal_only());
    let mut desktop = ClientChannels::new(&catalogue, everything());

    let host_events = [
        "plugins:ui",
        "plugins:deliver",
        "files:changed",
        AgentBrowserCalls::NAME,
    ];
    for (number, channel) in (1u64..).zip(host_events) {
        let _ = terminal.subscribe(&subscribe(number, channel));
        desktop.subscribe(&subscribe(number, channel)).unwrap();
    }
    // What a terminal client draws still reaches it.
    terminal.subscribe(&subscribe(10, "session:exit")).unwrap();
    let session_stream = StreamOpen {
        stream: 3,
        channel: "session:data".into(),
        params: Value::Map(vec![(Value::Text("id".into()), Value::Integer(1.into()))]),
    };
    terminal.open_stream(&session_stream).unwrap();

    for (number, channel) in (1u64..).zip(host_events) {
        assert!(terminal.event(channel, 1, &Value::Null).is_empty());
        let [Message::Event(event)] = &desktop.event(channel, 1, &Value::Null)[..] else {
            panic!("`{channel}` did not reach the client that declared it")
        };
        assert_eq!(event.subscription, number);
    }
    assert_eq!(terminal.event("session:exit", 1, &Value::Null).len(), 1);
}

#[test]
fn a_browser_tool_call_goes_to_a_client_with_a_browser_and_says_so_when_none_is_attached() {
    let catalogue = Catalogue::protocol();
    let mut terminal = ClientChannels::new(&catalogue, terminal_only());
    let _ = terminal.subscribe(&subscribe(1, AgentBrowserCalls::NAME));

    // Only a terminal client attached: the tool answers that there is no
    // browser.
    let Err(answer) = browser_client([("tui", &terminal)]) else {
        panic!("a call went to a client without a browser")
    };
    assert_eq!(answer, AgentBrowserOutcome::no_browser_client());
    let AgentBrowserOutcome::Failed { message } = &answer else {
        panic!()
    };
    assert!(message.contains("No client with a browser is attached"));

    // A client that declared browser but is not listening is not attached
    // for this purpose either.
    let mut desktop = ClientChannels::new(&catalogue, everything());
    assert!(browser_client([("tui", &terminal), ("desktop", &desktop)]).is_err());

    desktop
        .subscribe(&subscribe(5, AgentBrowserCalls::NAME))
        .unwrap();
    let (chosen, client) = browser_client([("tui", &terminal), ("desktop", &desktop)]).unwrap();
    assert_eq!(chosen, "desktop");
    let call = AgentBrowserToolCall {
        call_id: 9,
        session: 4,
        tool: "browser_navigate".into(),
        arguments: Value::Map(vec![(
            Value::Text("url".into()),
            Value::Text("https://example.com".into()),
        )]),
    };
    let delivered = client.event(AgentBrowserCalls::NAME, 1, &to_payload(&call).unwrap());
    assert_eq!(delivered.len(), 1);

    // The answer is a browser request: the desktop may send it, the
    // terminal client may not.
    let answer = AgentBrowserToolAnswer {
        call_id: 9,
        outcome: AgentBrowserOutcome::Done {
            value: Value::Text("navigated".into()),
        },
    };
    let wire = request(2, AgentBrowserAnswer::NAME, to_payload(&answer).unwrap());
    assert!(desktop.check_request(&wire).is_ok());
    let refused = terminal.check_request(&wire).unwrap_err();
    assert_eq!(refused.code, ErrorCode::MissingCapability);
    assert!(names_the_capability(&refused.message, Capability::Browser));
}

#[test]
fn the_agent_browser_relay_needs_the_browser_capability_both_ways() {
    let catalogue = Catalogue::protocol();
    let call = catalogue.get(AgentBrowserCalls::NAME).unwrap();
    let answer = catalogue.get(AgentBrowserAnswer::NAME).unwrap();
    assert_eq!(call.kind(), ChannelKind::Event { snapshot: false });
    assert_eq!(answer.kind(), ChannelKind::Request);
    assert_eq!(call.capability(), Some(Capability::Browser));
    assert_eq!(answer.capability(), Some(Capability::Browser));
}

#[test]
fn a_refused_subscription_is_not_held_and_a_wrong_kind_is_named() {
    let catalogue = Catalogue::protocol();
    let mut client = ClientChannels::new(&catalogue, terminal_only());
    client.subscribe(&subscribe(1, "session:exit")).unwrap();
    // Reusing the number for a channel it may not have drops the old one.
    assert!(client.subscribe(&subscribe(1, "files:changed")).is_err());
    assert!(client.subscriptions_to("session:exit").is_empty());

    let wrong = client.subscribe(&subscribe(2, "app:info")).unwrap_err();
    assert_eq!(wrong.code, ErrorCode::NotAnEvent);
    let unknown = client
        .subscribe(&subscribe(3, "session:teleport"))
        .unwrap_err();
    assert_eq!(unknown.code, ErrorCode::UnknownChannel);
    assert!(unknown.message.contains("session:teleport"));
}
