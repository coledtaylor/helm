//! A session names its agent backend, and what Floti shows for it is declared
//! per backend.

use floti_protocol::backend::feature_table;
use floti_protocol::channels::common::{SessionRecord, SessionStatus};
use floti_protocol::message::Response;
use floti_protocol::message::Welcome;
use floti_protocol::{
    BackendDescriptor, BackendFeature, BackendId, Capability, FrameDecoder, Knowable, Message,
    PROTOCOL_VERSION, Payload, Support, encode_frame,
};

fn session(backend: BackendId) -> SessionRecord {
    SessionRecord {
        id: 12,
        name: "helm-3".into(),
        label: None,
        cwd: "C:\\work\\a repo".into(),
        branch: Some("main".into()),
        project_path: None,
        profile_id: Some(4),
        argv: vec!["--session-id".into(), "0b9c".into()],
        conversation_id: Some("0b9c".into()),
        backend,
        status: SessionStatus::Running,
        started_at: "2026-10-27T10:00:00Z".into(),
        ended_at: None,
        duration_ms: None,
        exit_code: None,
    }
}

fn welcome() -> Welcome {
    Welcome {
        protocol: PROTOCOL_VERSION,
        host_version: "0.1.0".into(),
        capabilities: vec![Capability::Terminal],
        backends: vec![
            BackendDescriptor::new(BackendId::claude_code(), "Claude Code", BackendFeature::ALL),
            BackendDescriptor::new(BackendId::new("any-cli"), "Any CLI", [BackendFeature::Run]),
        ],
    }
}

/// Sends `message` through a frame and back, as a client receives it.
fn over_the_wire(message: Message) -> Message {
    let mut decoder = FrameDecoder::new();
    decoder.push(&encode_frame(&message).unwrap());
    decoder.next_message().unwrap().unwrap()
}

#[test]
fn a_session_record_names_its_backend_and_claude_code_is_claude_code() {
    assert_eq!(BackendId::claude_code().as_str(), "claude-code");

    let record = session(BackendId::claude_code());
    let payload = floti_protocol::channel::to_payload(&record).unwrap();
    let backend_field = payload
        .as_map()
        .unwrap()
        .iter()
        .find(|(key, _)| key.as_text() == Some("backend"))
        .map(|(_, value)| value.clone());
    assert_eq!(backend_field, Some(Payload::Text("claude-code".into())));

    let received = over_the_wire(Message::Response(Response { id: 1, payload }));
    let Message::Response(response) = received else {
        panic!("expected a response")
    };
    let decoded: SessionRecord = response.payload.deserialized().unwrap();
    assert_eq!(decoded, record);
    assert_eq!(decoded.backend, BackendId::claude_code());
}

#[test]
fn the_welcome_lists_each_backend_with_the_features_it_declares() {
    let Message::Welcome(received) = over_the_wire(Message::Welcome(welcome())) else {
        panic!("expected a welcome")
    };
    assert_eq!(received, welcome());

    let claude = received.backend(&BackendId::claude_code()).unwrap();
    assert_eq!(claude.features, BackendFeature::ALL);

    let names: Vec<String> = BackendFeature::ALL
        .iter()
        .map(|feature| {
            floti_protocol::channel::to_payload(feature)
                .unwrap()
                .into_text()
                .unwrap()
        })
        .collect();
    assert_eq!(
        names,
        [
            "run",
            "status",
            "agentTools",
            "resume",
            "history",
            "usage",
            "config",
            "signInCheck"
        ]
    );
}

#[test]
fn a_feature_the_sessions_backend_does_not_declare_shows_as_unknown_never_omitted() {
    let welcome = welcome();
    let table = welcome.feature_table(&BackendId::new("any-cli"));
    assert_eq!(
        table.len(),
        BackendFeature::ALL.len(),
        "every feature is listed"
    );
    for (feature, support) in table {
        let expected = if feature == BackendFeature::Run {
            Support::Declared
        } else {
            Support::Unknown
        };
        assert_eq!(support, expected, "{feature:?}");
    }

    let any_cli = welcome.backend(&BackendId::new("any-cli")).unwrap();
    assert_eq!(
        any_cli.answer(BackendFeature::History, || vec!["a conversation"]),
        Knowable::Unknown
    );
    assert_eq!(
        any_cli.answer(BackendFeature::Run, Vec::<String>::new),
        Knowable::Known(Vec::new()),
        "known and empty is an answer"
    );
}

#[test]
fn unknown_and_known_empty_travel_as_different_values() {
    let unknown = floti_protocol::channel::to_payload(&Knowable::<Vec<String>>::Unknown).unwrap();
    let empty =
        floti_protocol::channel::to_payload(&Knowable::Known(Vec::<String>::new())).unwrap();
    assert_ne!(unknown, empty);
    assert_eq!(
        unknown.deserialized::<Knowable<Vec<String>>>().unwrap(),
        Knowable::Unknown
    );
    assert_eq!(
        empty.deserialized::<Knowable<Vec<String>>>().unwrap(),
        Knowable::Known(Vec::new())
    );
}

#[test]
fn a_session_on_a_backend_this_client_has_never_heard_of_decodes_and_shows_only_what_it_declares() {
    let future = BackendId::new("tomorrows-agent");
    let mut welcome = welcome();
    // A newer host describes it with a feature this client does not know.
    let descriptor = Payload::Map(vec![
        (
            Payload::Text("id".into()),
            Payload::Text("tomorrows-agent".into()),
        ),
        (
            Payload::Text("name".into()),
            Payload::Text("Tomorrow's agent".into()),
        ),
        (
            Payload::Text("features".into()),
            Payload::Array(vec![
                Payload::Text("status".into()),
                Payload::Text("telepathy".into()),
            ]),
        ),
    ]);
    welcome.backends.push(descriptor.deserialized().unwrap());

    let record = session(future.clone());
    let Message::Response(response) = over_the_wire(Message::Response(Response {
        id: 2,
        payload: floti_protocol::channel::to_payload(&record).unwrap(),
    })) else {
        panic!("expected a response")
    };
    let decoded: SessionRecord = response.payload.deserialized().unwrap();
    assert_eq!(decoded.backend, future);

    let shown: Vec<BackendFeature> = welcome
        .feature_table(&decoded.backend)
        .into_iter()
        .filter(|(_, support)| *support == Support::Declared)
        .map(|(feature, _)| feature)
        .collect();
    assert_eq!(shown, [BackendFeature::Status]);

    // A backend the host did not describe at all declares nothing.
    assert!(
        feature_table(welcome.backend(&BackendId::new("never-described")))
            .iter()
            .all(|(_, support)| *support == Support::Unknown)
    );
}
