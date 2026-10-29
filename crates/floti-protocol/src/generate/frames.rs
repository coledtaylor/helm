//! Frames encoded by [`encode_frame`], written beside the TypeScript so a
//! client in another language can pin its CBOR encoding to this crate's: it
//! decodes each frame, encodes it again and must get the same bytes.
//!
//! One frame per kind of traffic a client meets most: its `hello`, a
//! response, an event and stream data. The payloads cover what an encoder
//! can disagree on: integers of every width and sign, floats that fit in 16,
//! 32 and 64 bits, text beyond ASCII, null, booleans, nesting, and bytes that
//! are not UTF-8.

use ciborium::Value;
use serde_json::{Map, Value as Json};

use crate::bytes::Bytes;
use crate::frame::encode_frame;
use crate::message::{ClientInfo, ClientKind, Event, Hello, Message, Response, StreamData};
use crate::version::PROTOCOL_VERSION;

/// The messages, each under the name the file gives its frame.
pub fn frame_fixture_messages() -> Vec<(&'static str, Message)> {
    vec![
        (
            "hello",
            Message::Hello(Hello {
                protocol: PROTOCOL_VERSION,
                client: ClientInfo {
                    name: "Helm 2.4.0".to_owned(),
                    kind: ClientKind::Desktop,
                },
                capabilities: vec!["terminal".to_owned()],
            }),
        ),
        (
            "response",
            Message::Response(Response {
                id: 70_000,
                payload: Value::Map(vec![
                    (text("id"), Value::Integer(12.into())),
                    (text("name"), text("café → ✓ 日本")),
                    (text("cwd"), text("C:\\work\\my repos\\alpha")),
                    (text("exitCode"), Value::Integer((-1).into())),
                    (text("startedAt"), Value::Float(1.5)),
                    (text("ratio"), Value::Float(0.1)),
                    (text("wide"), Value::Float(65_504.5)),
                    (text("pid"), Value::Integer(4_294_967_296_u64.into())),
                    (text("large"), Value::Integer(300.into())),
                    (text("negative"), Value::Integer((-70_000).into())),
                    (text("live"), Value::Bool(true)),
                    (text("ended"), Value::Bool(false)),
                    (text("endedAt"), Value::Null),
                    (
                        text("tags"),
                        Value::Array(vec![text("a"), Value::Integer(24.into()), Value::Null]),
                    ),
                    (
                        text("nested"),
                        Value::Map(vec![(text("empty"), Value::Map(vec![]))]),
                    ),
                ]),
            }),
        ),
        (
            "event",
            Message::Event(Event {
                subscription: 3,
                seq: 255,
                payload: Value::Array(vec![Value::Map(vec![
                    (text("id"), Value::Integer(1.into())),
                    (text("state"), text("busy")),
                    (text("since"), Value::Float(1_767_225_600_000.25)),
                ])]),
            }),
        ),
        (
            "streamData",
            Message::StreamData(StreamData {
                stream: 24,
                data: Bytes(stream_bytes()),
            }),
        ),
    ]
}

/// Terminal output as it arrives: escape sequences, a UTF-8 sequence cut in
/// two, bytes that are not UTF-8 at all, and long enough to need a two-byte
/// length.
fn stream_bytes() -> Vec<u8> {
    let mut bytes = b"\x1b[38;2;255;100;0mcolour\x1b[0m \xe2\x9c".to_vec();
    bytes.extend([0x00, 0xff, 0xfe, 0x80]);
    bytes.extend((0..=255u8).cycle().take(300));
    bytes
}

fn text(value: &str) -> Value {
    Value::Text(value.to_owned())
}

/// The file: each frame as lowercase hex, by name.
pub fn frame_fixtures() -> String {
    let mut messages = frame_fixture_messages();
    // Sorted here, so the file reads the same whether or not serde_json keeps
    // insertion order in this build.
    messages.sort_by_key(|(name, _)| *name);
    let frames: Map<String, Json> = messages
        .into_iter()
        .map(|(name, message)| {
            let frame = encode_frame(&message).expect("a fixture frame encodes");
            (name.to_owned(), Json::String(hex(&frame)))
        })
        .collect();
    let mut file =
        serde_json::to_string_pretty(&Json::Object(frames)).expect("a map of strings serialises");
    file.push('\n');
    file
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut out, byte| {
        let _ = write!(out, "{byte:02x}");
        out
    })
}
