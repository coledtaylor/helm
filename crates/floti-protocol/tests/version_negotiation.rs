//! The host accepts its own and the previous minor protocol version and
//! refuses any other with a message naming both versions.

use floti_protocol::message::{ClientInfo, ClientKind, Hello, Refused};
use floti_protocol::version::negotiate;
use floti_protocol::{
    FrameDecoder, HostIdentity, Message, ProtocolVersion, UpdateSide, encode_frame,
};
use serde::Deserialize;

fn host(minor: u16) -> HostIdentity {
    HostIdentity {
        protocol: ProtocolVersion::new(1, minor),
        host_version: "0.1.0".into(),
        backends: Vec::new(),
    }
}

fn hello(major: u16, minor: u16) -> Hello {
    Hello {
        protocol: ProtocolVersion::new(major, minor),
        client: ClientInfo {
            name: "test client".into(),
            kind: ClientKind::Tui,
        },
        capabilities: vec!["terminal".into()],
    }
}

fn answer(host: &HostIdentity, hello: &Hello) -> Message {
    host.answer(hello).0
}

fn refusal(message: Message) -> Refused {
    match message {
        Message::Refused(refused) => refused,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

#[test]
fn a_client_on_the_hosts_version_or_the_previous_minor_is_accepted_and_told_the_version_in_use() {
    let host = host(4);
    for client_minor in [4, 3] {
        match answer(&host, &hello(1, client_minor)) {
            Message::Welcome(welcome) => {
                assert_eq!(welcome.protocol, ProtocolVersion::new(1, client_minor))
            }
            other => panic!("1.{client_minor} should be accepted by 1.4, got {other:?}"),
        }
    }
}

#[test]
fn a_host_on_a_new_major_accepts_only_its_own_version() {
    assert_eq!(
        negotiate(ProtocolVersion::new(2, 0), ProtocolVersion::new(2, 0)),
        Ok(ProtocolVersion::new(2, 0))
    );
    assert!(negotiate(ProtocolVersion::new(2, 0), ProtocolVersion::new(1, 9)).is_err());
}

#[test]
fn an_older_minor_is_refused_naming_both_versions_and_the_client_as_the_side_to_update() {
    let refused = refusal(answer(&host(4), &hello(1, 2)));
    assert_eq!(refused.update, UpdateSide::Client);
    assert_eq!(
        (refused.host, refused.client),
        (ProtocolVersion::new(1, 4), ProtocolVersion::new(1, 2))
    );
    assert_eq!(
        refused.message,
        "This client speaks Floti protocol 1.2 and the host speaks 1.4. Update the client."
    );
}

#[test]
fn a_newer_minor_is_refused_naming_both_versions_and_the_host_as_the_side_to_update() {
    let refused = refusal(answer(&host(4), &hello(1, 5)));
    assert_eq!(refused.update, UpdateSide::Host);
    assert_eq!(
        refused.message,
        "This client speaks Floti protocol 1.5 and the host speaks 1.4. Update the host."
    );
}

#[test]
fn another_major_is_refused_naming_both_versions_and_which_side_to_update() {
    let older = refusal(answer(&host(0), &hello(0, 9)));
    assert_eq!(older.update, UpdateSide::Client);
    assert!(older.message.contains("0.9") && older.message.contains("1.0"));

    let newer = refusal(answer(&host(0), &hello(2, 0)));
    assert_eq!(newer.update, UpdateSide::Host);
    assert_eq!(
        newer.message,
        "This client speaks Floti protocol 2.0 and the host speaks 1.0. Update the host."
    );
}

/// What any client, of any version, reads from the frame it is refused with:
/// the message type and the sentence. Nothing else of the crate is used, so
/// this stands for a client that shares none of today's types.
#[derive(Deserialize)]
struct AnyClientReadsRefusal {
    #[serde(rename = "type")]
    kind: String,
    message: String,
}

#[test]
fn a_refusal_is_readable_by_a_client_that_knows_only_its_type_and_message() {
    let frame = encode_frame(&answer(&host(4), &hello(2, 7))).unwrap();
    let body = &frame[4..];
    let read: AnyClientReadsRefusal = ciborium::from_reader(body).unwrap();
    assert_eq!(read.kind, "refused");
    assert_eq!(
        read.message,
        "This client speaks Floti protocol 2.7 and the host speaks 1.4. Update the host."
    );
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// `hello` and `refused` are frozen across majors. These bytes are their
// encoding; a change here breaks every client that cannot read the new one.
const FROZEN_HELLO: &str = "a464747970656568656c6c6f6870726f746f636f6ca2656d616a6f7201656d696e6f720066636c69656e74a2646e616d656b7465737420636c69656e74646b696e64637475696c6361706162696c697469657381687465726d696e616c";
const FROZEN_REFUSED: &str = "a56474797065677265667573656464686f7374a2656d616a6f7201656d696e6f720466636c69656e74a2656d616a6f7201656d696e6f72026675706461746566636c69656e74676d65737361676578515468697320636c69656e7420737065616b7320466c6f74692070726f746f636f6c20312e3220616e642074686520686f737420737065616b7320312e342e205570646174652074686520636c69656e742e";

#[test]
fn hello_and_refused_encode_to_their_frozen_bytes() {
    let hello_frame = encode_frame(&Message::Hello(hello(1, 0))).unwrap();
    let refused_frame = encode_frame(&answer(&host(4), &hello(1, 2))).unwrap();
    assert_eq!(
        hex(&hello_frame[4..]),
        FROZEN_HELLO,
        "the hello encoding changed"
    );
    assert_eq!(
        hex(&refused_frame[4..]),
        FROZEN_REFUSED,
        "the refused encoding changed"
    );

    let mut decoder = FrameDecoder::new();
    decoder.push(&hello_frame);
    assert_eq!(
        decoder.next_message().unwrap(),
        Some(Message::Hello(hello(1, 0)))
    );
}
