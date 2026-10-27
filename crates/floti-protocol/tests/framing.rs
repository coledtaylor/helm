//! Frames are length-prefixed CBOR on one stream, and terminal bytes travel
//! as binary.

use floti_protocol::backend::{BackendDescriptor, BackendFeature, BackendId};
use floti_protocol::message::{
    ClientInfo, ClientKind, ErrorCode, ErrorReply, Event, Hello, Request, Response, Snapshot,
    StreamClose, StreamCredit, StreamData, StreamOpen, Subscribe, SubscriptionError, Unsubscribe,
    Welcome,
};
use floti_protocol::{
    Bytes, Capability, FrameDecoder, Message, Payload, ProtocolVersion, encode_frame,
};

fn terminal_output() -> Vec<u8> {
    // Every byte value, then sequences that are not UTF-8: a lone
    // continuation byte, a truncated two-byte sequence, an overlong encoding
    // and the bytes UTF-8 never uses.
    let mut bytes: Vec<u8> = (0..=255).collect();
    bytes.extend_from_slice(&[
        0x80, 0xc3, 0x28, 0xc0, 0xaf, 0xfe, 0xff, 0x1b, b'[', b'3', b'1', b'm',
    ]);
    bytes
}

fn every_kind_of_message() -> Vec<Message> {
    vec![
        Message::Hello(Hello {
            protocol: ProtocolVersion::new(1, 0),
            client: ClientInfo {
                name: "desktop".into(),
                kind: ClientKind::Desktop,
            },
            capabilities: vec!["terminal".into(), "files".into()],
        }),
        Message::Welcome(Welcome {
            protocol: ProtocolVersion::new(1, 0),
            host_version: "0.1.0".into(),
            capabilities: vec![Capability::Terminal],
            backends: vec![BackendDescriptor::new(
                BackendId::claude_code(),
                "Claude Code",
                BackendFeature::ALL,
            )],
        }),
        Message::Request(Request {
            id: 1,
            channel: "session:list".into(),
            payload: Payload::Null,
        }),
        Message::Response(Response {
            id: 1,
            payload: Payload::Array(vec![Payload::Text("a".into())]),
        }),
        Message::Error(ErrorReply {
            id: 2,
            channel: "x".into(),
            code: ErrorCode::UnknownChannel,
            message: "no".into(),
        }),
        Message::Subscribe(Subscribe {
            subscription: 7,
            channel: "settings:changed".into(),
        }),
        Message::Snapshot(Snapshot {
            subscription: 7,
            seq: 0,
            state: Payload::Bool(true),
        }),
        Message::Event(Event {
            subscription: 7,
            seq: 1,
            payload: Payload::Integer(42.into()),
        }),
        Message::Unsubscribe(Unsubscribe { subscription: 7 }),
        Message::SubscriptionError(SubscriptionError {
            subscription: 8,
            channel: "files:changed".into(),
            code: ErrorCode::MissingCapability,
            message: "needs files".into(),
        }),
        Message::StreamOpen(StreamOpen {
            stream: 3,
            channel: "session:data".into(),
            params: Payload::Integer(9.into()),
        }),
        Message::StreamData(StreamData {
            stream: 3,
            data: Bytes(terminal_output()),
        }),
        Message::StreamCredit(StreamCredit {
            stream: 3,
            bytes: 65_536,
        }),
        Message::StreamClose(StreamClose {
            stream: 3,
            reason: None,
        }),
    ]
}

fn wire(messages: &[Message]) -> Vec<u8> {
    messages
        .iter()
        .flat_map(|message| encode_frame(message).unwrap())
        .collect()
}

fn decode_in_pieces(pieces: &[&[u8]]) -> Vec<Message> {
    let mut decoder = FrameDecoder::new();
    let mut out = Vec::new();
    for piece in pieces {
        decoder.push(piece);
        out.extend(decoder.drain().unwrap());
    }
    decoder.finish().unwrap();
    out
}

#[test]
fn a_frame_is_a_big_endian_length_followed_by_exactly_one_cbor_value() {
    for message in every_kind_of_message() {
        let frame = encode_frame(&message).unwrap();
        let len = u32::from_be_bytes(frame[..4].try_into().unwrap()) as usize;
        assert_eq!(len, frame.len() - 4, "the prefix is the body's length");

        let mut body = &frame[4..];
        let value: Payload = ciborium::from_reader(&mut body).unwrap();
        assert!(body.is_empty(), "nothing follows the one CBOR value");
        assert!(value.is_map());
    }
}

#[test]
fn messages_split_at_every_point_decode_to_the_same_messages_in_order() {
    let messages = every_kind_of_message();
    let bytes = wire(&messages);
    for split in 0..=bytes.len() {
        let (left, right) = bytes.split_at(split);
        assert_eq!(
            decode_in_pieces(&[left, right]),
            messages,
            "split at byte {split}"
        );
    }
}

#[test]
fn messages_fed_one_byte_at_a_time_or_in_uneven_pieces_decode_in_order() {
    let messages = every_kind_of_message();
    let bytes = wire(&messages);

    let single_bytes: Vec<&[u8]> = bytes.chunks(1).collect();
    assert_eq!(decode_in_pieces(&single_bytes), messages);

    // Uneven, deterministic piece sizes, so every frame boundary falls at a
    // different offset inside a piece.
    let mut pieces = Vec::new();
    let mut rest = bytes.as_slice();
    let mut seed: u32 = 0x2545_f491;
    while !rest.is_empty() {
        seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        let size = (seed >> 16) as usize % 97 + 1;
        let (piece, tail) = rest.split_at(size.min(rest.len()));
        pieces.push(piece);
        rest = tail;
    }
    assert_eq!(decode_in_pieces(&pieces), messages);
}

#[test]
fn terminal_output_with_invalid_utf8_arrives_byte_for_byte_as_a_cbor_byte_string() {
    let output = terminal_output();
    let message = Message::StreamData(StreamData {
        stream: 1,
        data: Bytes(output.clone()),
    });
    let frame = encode_frame(&message).unwrap();

    let decoded = decode_in_pieces(&[&frame]);
    let [Message::StreamData(data)] = decoded.as_slice() else {
        panic!("expected one streamData, got {decoded:?}")
    };
    assert_eq!(data.data.as_slice(), output.as_slice(), "byte for byte");

    let value: Payload = ciborium::from_reader(&frame[4..]).unwrap();
    let data_field = value
        .as_map()
        .unwrap()
        .iter()
        .find(|(key, _)| key.as_text() == Some("data"))
        .map(|(_, value)| value)
        .unwrap();
    match data_field {
        Payload::Bytes(bytes) => assert_eq!(bytes, &output),
        other => panic!("terminal output must be a CBOR byte string, not {other:?}"),
    }

    // A byte string's header is major type 2 (0x40..=0x5b), and the raw
    // bytes follow it unchanged: no base64, no array of numbers.
    let at = frame
        .windows(output.len())
        .position(|window| window == output)
        .expect("the raw bytes are in the frame");
    let header_len = 3; // 0x59 and a 2-byte length, for 268 bytes
    assert_eq!(frame[at - header_len], 0x59);
    assert_eq!(
        u16::from_be_bytes([frame[at - 2], frame[at - 1]]) as usize,
        output.len()
    );
}
