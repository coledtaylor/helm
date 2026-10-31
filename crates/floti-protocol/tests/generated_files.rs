//! JSON Schema and TypeScript are generated from the crate, and a test fails
//! when the generated files are out of date.

use std::path::{Path, PathBuf};

use floti_protocol::generate::{
    GENERATED_DIR, REGENERATE_COMMAND, SCHEMA_FILE, TSCONFIG_FILE, TYPESCRIPT_FILE,
    frame_fixture_messages, frame_fixtures, generated_dir, json_schema, stale_files, typescript,
    write_generated,
};
use floti_protocol::{
    Bytes, Capability, Catalogue, EventChannel, FrameDecoder, RequestChannel, StreamChannel,
    encode_frame,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The real check: the files in this checkout match the crate.
#[test]
fn the_generated_files_in_this_checkout_are_current() {
    let stale = stale_files(&generated_dir(), &Catalogue::protocol());
    assert!(stale.is_empty(), "{}", stale.join("\n"));
}

/// A test-only catalogue with one channel of each kind.
#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
struct StubOpen {
    session_id: u32,
    preview: Bytes,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
struct StubState {
    names: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
enum StubChange {
    Added { name: String },
    Removed { name: String },
}

struct StubRequest;
impl RequestChannel for StubRequest {
    const NAME: &'static str = "stub:list";
    type Request = ();
    type Response = Vec<StubState>;
}

struct StubEvent;
impl EventChannel for StubEvent {
    const NAME: &'static str = "stub:changed";
    const SNAPSHOT: bool = true;
    type Event = StubChange;
    type Snapshot = StubState;
}

struct StubStream;
impl StreamChannel for StubStream {
    const NAME: &'static str = "stub:data";
    const CAPABILITY: Option<Capability> = Some(Capability::Terminal);
    type Open = StubOpen;
}

fn stub_catalogue() -> Catalogue {
    let mut catalogue = Catalogue::protocol();
    catalogue
        .request::<StubRequest>()
        .event::<StubEvent>()
        .stream::<StubStream>();
    catalogue
}

#[test]
fn the_typescript_declares_every_channel_message_and_payload_type() {
    let ts = typescript(&stub_catalogue());
    for declared in [
        "export type Message = ",
        "export type Hello = ",
        "export type Welcome = ",
        "export type Refused = ",
        "export type StreamData = ",
        "export type SessionRecord = ",
        "export type PermissionMode = ",
        "export type BackendId = string;",
        "export type StubState = ",
        "export type StubChange = ",
        "export type StubOpen = ",
        "\"stub:list\": { request: null; response: Array<StubState>; capability: null };",
        "\"stub:changed\": { event: StubChange; snapshot: StubState; capability: null };",
        "\"stub:data\": { open: StubOpen; capability: \"terminal\" };",
        "{ name: \"stub:data\", kind: \"stream\", capability: \"terminal\" },",
        "export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;",
    ] {
        assert!(ts.contains(declared), "missing `{declared}` in:\n{ts}");
    }
    assert!(ts.contains("data: Uint8Array"), "bytes are Uint8Array");
    assert!(
        ts.contains("preview: Uint8Array"),
        "bytes are Uint8Array in payloads too"
    );
    assert!(
        !ts.contains("bigint"),
        "every number fits a JavaScript number"
    );
}

#[test]
fn the_typescript_lists_every_client_only_and_host_internal_entry_with_its_reason() {
    use floti_protocol::channels::boundary::{CLIENT_ONLY, HOST_INTERNAL};
    let ts = typescript(&Catalogue::protocol());
    let section = |name: &str| -> String {
        let start = ts
            .find(&format!("export const {name}: readonly OutsideEntry[] = ["))
            .unwrap_or_else(|| panic!("no {name} in the TypeScript"));
        let end = start + ts[start..].find("];").expect("the list ends");
        ts[start..end].to_owned()
    };
    for (name, list) in [
        ("CLIENT_ONLY", CLIENT_ONLY),
        ("HOST_INTERNAL", HOST_INTERNAL),
    ] {
        let section = section(name);
        for entry in list {
            let line = format!(
                "{{ channels: {:?}, reason: {:?} }},",
                entry.channels, entry.reason
            );
            assert!(section.contains(&line), "{name} is missing `{line}`");
        }
        assert_eq!(section.matches("{ channels:").count(), list.len(), "{name}");
    }
    // The coverage check is `Outside::covers`: a `family:*` entry covers its
    // family by prefix, any other entry only its own name.
    assert!(ts.contains(
        "return entry.channels.endsWith(\"*\") ? name.startsWith(entry.channels.slice(0, -1)) : name === entry.channels;"
    ));
}

#[test]
fn the_json_schema_defines_every_message_and_payload_type_and_lists_the_channels() {
    let schema: serde_json::Value = serde_json::from_str(&json_schema(&stub_catalogue())).unwrap();
    let defs = schema["$defs"].as_object().unwrap();
    for name in [
        "Message",
        "Hello",
        "Welcome",
        "Refused",
        "StreamData",
        "Bytes",
        "SessionRecord",
        "PermissionMode",
        "StubState",
        "StubChange",
        "StubOpen",
    ] {
        assert!(defs.contains_key(name), "$defs lacks {name}");
    }
    assert_eq!(schema["$ref"], "#/$defs/Message");
    assert_eq!(schema["x-protocolVersion"], "1.0");

    let channels = schema["x-channels"].as_array().unwrap();
    let data = channels
        .iter()
        .find(|channel| channel["name"] == "stub:data")
        .unwrap();
    assert_eq!(data["kind"], "stream");
    assert_eq!(data["capability"], "terminal");
    assert_eq!(data["open"]["$ref"], "#/$defs/StubOpen");
    let changed = channels
        .iter()
        .find(|channel| channel["name"] == "stub:changed")
        .unwrap();
    assert_eq!(changed["snapshot"]["$ref"], "#/$defs/StubState");
}

/// A fresh folder under the system temp directory, removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "floti-protocol-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn a_protocol_change_without_regenerating_fails_naming_the_stale_file_and_the_command() {
    let dir = TempDir::new("stale");
    write_generated(dir.path(), &Catalogue::protocol()).unwrap();
    assert!(stale_files(dir.path(), &Catalogue::protocol()).is_empty());

    // The crate changed: a channel was added, and nobody regenerated.
    let stale = stale_files(dir.path(), &stub_catalogue());
    assert_eq!(
        stale,
        [
            format!("{GENERATED_DIR}/{SCHEMA_FILE} is out of date. Run `{REGENERATE_COMMAND}`."),
            format!(
                "{GENERATED_DIR}/{TYPESCRIPT_FILE} is out of date. Run `{REGENERATE_COMMAND}`."
            ),
        ]
    );
    assert_eq!(
        REGENERATE_COMMAND,
        "cargo run -p floti-protocol --bin generate"
    );

    // After regenerating, it passes.
    write_generated(dir.path(), &stub_catalogue()).unwrap();
    assert!(stale_files(dir.path(), &stub_catalogue()).is_empty());
}

#[test]
fn a_missing_generated_file_is_reported_as_out_of_date() {
    let dir = TempDir::new("missing");
    write_generated(dir.path(), &Catalogue::protocol()).unwrap();
    std::fs::remove_file(dir.path().join(TSCONFIG_FILE)).unwrap();
    assert_eq!(
        stale_files(dir.path(), &Catalogue::protocol()),
        [format!(
            "{GENERATED_DIR}/{TSCONFIG_FILE} is out of date. Run `{REGENERATE_COMMAND}`."
        )]
    );
}

#[test]
fn the_frame_fixtures_are_frames_of_a_hello_a_response_an_event_and_stream_data_that_decode_to_their_messages()
 {
    let file: serde_json::Value = serde_json::from_str(&frame_fixtures()).unwrap();
    let frames = file.as_object().unwrap();
    let messages = frame_fixture_messages();
    assert_eq!(
        frames.keys().map(String::as_str).collect::<Vec<_>>(),
        ["event", "hello", "response", "streamData"]
    );
    for (name, message) in messages {
        let hex = frames[name].as_str().unwrap();
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap())
            .collect();
        assert_eq!(bytes, encode_frame(&message).unwrap(), "{name}");
        let mut decoder = FrameDecoder::new();
        decoder.push(&bytes);
        assert_eq!(decoder.drain().unwrap(), [message], "{name}");
        decoder.finish().unwrap();
    }
}

#[test]
fn a_windows_checkout_with_crlf_line_endings_is_still_current() {
    let dir = TempDir::new("crlf");
    let written = write_generated(dir.path(), &Catalogue::protocol()).unwrap();
    for path in written {
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, text.replace('\n', "\r\n")).unwrap();
    }
    assert!(stale_files(dir.path(), &Catalogue::protocol()).is_empty());
}
