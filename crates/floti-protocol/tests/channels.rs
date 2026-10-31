//! Typed channels: an ill-typed or unknown request costs one error reply, and
//! a subscription to state starts with a snapshot and resyncs after a gap.
//! The channels here are test-only stubs.

use floti_protocol::channel::Routed;
use floti_protocol::channel::{decode_request, from_payload, to_payload};
use floti_protocol::message::{ErrorCode, ErrorReply, Request, Subscribe};
use floti_protocol::{
    CapabilitySet, Catalogue, ChannelKind, Delivery, EventChannel, EventCursor, FrameDecoder,
    Message, Payload, RequestChannel, Router, Topic, encode_frame,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
struct RenameRequest {
    id: u32,
    label: Option<String>,
}

struct Rename;
impl RequestChannel for Rename {
    const NAME: &'static str = "test:rename";
    type Request = RenameRequest;
    type Response = String;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
struct Counter {
    count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
struct Increment {
    by: u32,
}

struct CounterChanged;
impl EventChannel for CounterChanged {
    const NAME: &'static str = "test:counter";
    const SNAPSHOT: bool = true;
    type Event = Increment;
    type Snapshot = Counter;
}

fn catalogue() -> Catalogue {
    let mut catalogue = Catalogue::new();
    catalogue.request::<Rename>().event::<CounterChanged>();
    catalogue
}

fn payload<T: Serialize>(value: &T) -> Payload {
    to_payload(value).unwrap()
}

fn frames(messages: &[Message]) -> Vec<u8> {
    messages
        .iter()
        .flat_map(|message| encode_frame(message).unwrap())
        .collect()
}

#[test]
fn a_request_that_does_not_fit_its_channel_or_names_no_channel_gets_an_error_naming_the_channel_and_the_connection_carries_on()
 {
    let catalogue = catalogue();
    let mut router = Router::new(&catalogue, CapabilitySet::empty());
    router.handle::<Rename>(|request| Ok(format!("renamed {} to {:?}", request.id, request.label)));

    let ill_typed = Request {
        id: 1,
        channel: "test:rename".into(),
        payload: payload(&"not a rename"),
    };
    let missing_field = Request {
        id: 2,
        channel: "test:rename".into(),
        payload: payload(&serde_json::json!({ "label": "x" })),
    };
    let unknown = Request {
        id: 3,
        channel: "session:teleport".into(),
        payload: Payload::Null,
    };
    let event_channel = Request {
        id: 4,
        channel: "test:counter".into(),
        payload: Payload::Null,
    };
    let good = Request {
        id: 5,
        channel: "test:rename".into(),
        payload: payload(&RenameRequest {
            id: 9,
            label: Some("api".into()),
        }),
    };

    // The client's frames arrive on one connection, one after another.
    let mut host = FrameDecoder::new();
    host.push(&frames(
        &[ill_typed, missing_field, unknown, event_channel, good].map(Message::Request),
    ));
    let replies: Vec<Message> = host
        .drain()
        .unwrap()
        .into_iter()
        .map(|message| match message {
            Message::Request(request) => router.dispatch(&request),
            other => panic!("unexpected {other:?}"),
        })
        .collect();

    let error = |index: usize| match &replies[index] {
        Message::Error(error) => error.clone(),
        other => panic!("reply {index} should be an error, got {other:?}"),
    };
    for (index, id) in [(0, 1), (1, 2)] {
        let ErrorReply {
            id: replied_to,
            channel,
            code,
            message,
        } = error(index);
        assert_eq!(
            (replied_to, channel.as_str(), code),
            (id, "test:rename", ErrorCode::BadPayload)
        );
        assert!(message.contains("`test:rename`"), "{message}");
    }
    let unknown = error(2);
    assert_eq!(
        (unknown.id, unknown.channel.as_str(), unknown.code),
        (3, "session:teleport", ErrorCode::UnknownChannel)
    );
    assert!(
        unknown.message.contains("`session:teleport`"),
        "{}",
        unknown.message
    );
    let wrong_kind = error(3);
    assert_eq!(
        (wrong_kind.id, wrong_kind.code),
        (4, ErrorCode::NotARequest)
    );

    let Message::Response(response) = &replies[4] else {
        panic!("the request after the bad ones is answered")
    };
    assert_eq!(response.id, 5);
    assert_eq!(
        from_payload::<String>(&response.payload).unwrap(),
        "renamed 9 to Some(\"api\")"
    );

    // The replies frame and decode like any other message.
    let mut client = FrameDecoder::new();
    client.push(&frames(&replies));
    assert_eq!(client.drain().unwrap(), replies);
}

/// The message a routed request comes to, once its work is done. The
/// handlers here are done when they are first polled.
fn settled(routed: Routed) -> Message {
    match routed {
        Routed::Now(message) => message,
        Routed::Later(mut answer) => {
            let mut context = std::task::Context::from_waker(std::task::Waker::noop());
            match answer.as_mut().poll(&mut context) {
                std::task::Poll::Ready(message) => message,
                std::task::Poll::Pending => panic!("the answer was not ready"),
            }
        }
    }
}

#[test]
fn a_request_answered_later_is_routed_as_a_future_of_its_response_or_its_sentence_and_refused_at_once_when_it_does_not_fit()
 {
    let catalogue = catalogue();
    let mut router = Router::new(&catalogue, CapabilitySet::empty());
    router.handle_later::<Rename>(|request| {
        if request.id == 0 {
            return Err("there is no session 0".to_owned());
        }
        Ok(Box::pin(async move {
            match request.label {
                Some(label) => Ok(format!("renamed {} to {label}", request.id)),
                None => Err(format!("session {} needs a label", request.id)),
            }
        }))
    });
    let rename = |id: u64, session: u32, label: Option<&str>| Request {
        id,
        channel: "test:rename".into(),
        payload: payload(&RenameRequest {
            id: session,
            label: label.map(str::to_owned),
        }),
    };

    let routed = router.route(&rename(1, 9, Some("api")));
    assert!(matches!(routed, Routed::Later(_)), "answered later");
    let Message::Response(response) = settled(routed) else {
        panic!("expected a response")
    };
    assert_eq!(response.id, 1);
    assert_eq!(
        from_payload::<String>(&response.payload).unwrap(),
        "renamed 9 to api"
    );

    let Message::Error(failed) = settled(router.route(&rename(2, 9, None))) else {
        panic!("expected an error")
    };
    assert_eq!(
        (
            failed.id,
            failed.channel.as_str(),
            failed.code,
            failed.message.as_str()
        ),
        (
            2,
            "test:rename",
            ErrorCode::Failed,
            "session 9 needs a label"
        )
    );

    let refused = router.route(&rename(3, 0, Some("api")));
    let Routed::Now(Message::Error(refused)) = refused else {
        panic!("a refusal is answered at once")
    };
    assert_eq!(
        (refused.id, refused.message.as_str()),
        (3, "there is no session 0")
    );

    let ill_typed = Request {
        id: 4,
        channel: "test:rename".into(),
        payload: payload(&"not a rename"),
    };
    let Routed::Now(Message::Error(ill_typed)) = router.route(&ill_typed) else {
        panic!("a request that does not fit is refused at once")
    };
    assert_eq!(ill_typed.code, ErrorCode::BadPayload);

    // Dispatching one says it has to be routed.
    let Message::Error(dispatched) = router.dispatch(&rename(5, 9, Some("api"))) else {
        panic!("expected an error")
    };
    assert!(dispatched.message.contains("route it"), "{dispatched:?}");
}

#[test]
fn a_declared_channel_the_host_does_not_serve_answers_unavailable() {
    let catalogue = catalogue();
    let mut router = Router::new(&catalogue, CapabilitySet::empty());
    let request = Request {
        id: 8,
        channel: "test:rename".into(),
        payload: payload(&RenameRequest { id: 1, label: None }),
    };
    let Message::Error(error) = router.dispatch(&request) else {
        panic!("expected an error")
    };
    assert_eq!(
        (error.id, error.channel.as_str(), error.code),
        (8, "test:rename", ErrorCode::Unavailable)
    );
}

#[test]
fn a_request_is_decoded_as_its_channels_type() {
    let request = Request {
        id: 1,
        channel: "test:rename".into(),
        payload: payload(&RenameRequest { id: 3, label: None }),
    };
    assert_eq!(
        decode_request::<Rename>(&request).unwrap(),
        RenameRequest { id: 3, label: None }
    );
    let wrong = Request {
        id: 2,
        channel: "test:rename".into(),
        payload: payload(&[1, 2, 3]),
    };
    let error = decode_request::<Rename>(&wrong).unwrap_err();
    assert_eq!(
        (error.id, error.channel.as_str(), error.code),
        (2, "test:rename", ErrorCode::BadPayload)
    );
}

#[test]
fn the_catalogue_knows_each_channels_kind() {
    let catalogue = catalogue();
    assert_eq!(
        catalogue.get("test:rename").unwrap().kind(),
        ChannelKind::Request
    );
    assert_eq!(
        catalogue.get("test:counter").unwrap().kind(),
        ChannelKind::Event { snapshot: true }
    );
    assert!(catalogue.get("test:nothing").is_none());
}

#[test]
#[should_panic(expected = "declared twice")]
fn a_channel_declared_twice_is_a_programming_error() {
    let mut catalogue = Catalogue::new();
    catalogue.request::<Rename>().request::<Rename>();
}

/// A client's view of one subscription: the state it holds and its cursor.
struct Client {
    subscription: u64,
    cursor: EventCursor,
    state: Option<Counter>,
    resubscribe: Option<Subscribe>,
}

impl Client {
    fn receive(&mut self, message: &Message) {
        match message {
            Message::Snapshot(snapshot) => {
                assert_eq!(snapshot.subscription, self.subscription);
                self.cursor.on_snapshot(snapshot);
                self.state = Some(snapshot.state.deserialized().unwrap());
            }
            Message::Event(event) => match self.cursor.on_event(event) {
                Delivery::Apply => {
                    let increment: Increment = event.payload.deserialized().unwrap();
                    self.state.as_mut().unwrap().count += increment.by;
                }
                Delivery::Stale => {}
                Delivery::Gap { .. } => {
                    self.subscription += 1;
                    self.cursor = EventCursor::new();
                    self.resubscribe = Some(Subscribe {
                        subscription: self.subscription,
                        channel: CounterChanged::NAME.into(),
                    });
                }
            },
            other => panic!("unexpected {other:?}"),
        }
    }
}

fn over_the_wire(messages: Vec<Message>) -> Vec<Message> {
    let mut decoder = FrameDecoder::new();
    decoder.push(&frames(&messages));
    decoder.drain().unwrap()
}

#[test]
fn a_subscription_to_state_starts_with_a_snapshot_then_numbered_events_and_resyncs_after_a_gap() {
    let mut topic = Topic::<CounterChanged>::new(Counter { count: 10 });
    let mut client = Client {
        subscription: 1,
        cursor: EventCursor::new(),
        state: None,
        resubscribe: None,
    };

    let first = over_the_wire(vec![topic.subscribe(1).unwrap()]);
    assert!(matches!(first.as_slice(), [Message::Snapshot(snapshot)] if snapshot.seq == 0));
    client.receive(&first[0]);
    assert_eq!(client.state, Some(Counter { count: 10 }));

    let apply = |state: &mut Counter, event: &Increment| state.count += event.by;
    let one = topic.publish(Increment { by: 1 }, apply).unwrap();
    let two = topic.publish(Increment { by: 2 }, apply).unwrap();
    let _lost = topic.publish(Increment { by: 3 }, apply).unwrap();
    let four = topic.publish(Increment { by: 4 }, apply).unwrap();

    for message in over_the_wire([one, two].concat()) {
        client.receive(&message);
    }
    assert_eq!(
        client.state,
        Some(Counter { count: 13 }),
        "events 1 and 2 applied in order"
    );
    assert!(client.resubscribe.is_none());

    // Event 3 never arrives. Event 4 shows the gap.
    for message in over_the_wire(four) {
        client.receive(&message);
    }
    assert_eq!(
        client.state,
        Some(Counter { count: 13 }),
        "nothing applied across the gap"
    );
    let resubscribe = client
        .resubscribe
        .take()
        .expect("the client resubscribes after a gap");

    topic.unsubscribe(1);
    let fresh = over_the_wire(vec![topic.subscribe(resubscribe.subscription).unwrap()]);
    assert!(matches!(fresh.as_slice(), [Message::Snapshot(snapshot)] if snapshot.seq == 4));
    client.receive(&fresh[0]);
    assert_eq!(
        client.state,
        Some(Counter { count: 20 }),
        "the fresh snapshot includes the missed event"
    );

    let five = topic.publish(Increment { by: 5 }, apply).unwrap();
    assert_eq!(five.len(), 1, "only the live subscription gets it");
    for message in over_the_wire(five) {
        client.receive(&message);
    }
    assert_eq!(client.state, Some(Counter { count: 25 }));
    assert_eq!(topic.state(), &Counter { count: 25 });
}

#[test]
fn an_event_already_covered_is_dropped_and_a_channel_without_state_counts_from_one() {
    let mut cursor = EventCursor::from_start();
    let event = |seq| floti_protocol::message::Event {
        subscription: 1,
        seq,
        payload: Payload::Null,
    };
    assert_eq!(cursor.on_event(&event(1)), Delivery::Apply);
    assert_eq!(cursor.on_event(&event(1)), Delivery::Stale);
    assert_eq!(
        cursor.on_event(&event(3)),
        Delivery::Gap {
            expected: 2,
            received: 3
        }
    );
}
