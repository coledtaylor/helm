//! The JSON Schema and TypeScript that clients build against.
//!
//! `cargo run -p floti-protocol --bin generate` writes them into
//! `crates/floti-protocol/generated/`, and a test regenerates them in memory
//! and fails when the files on disk differ, so a protocol change cannot ship
//! without them. Line endings are compared normalised, because a Windows
//! checkout may have rewritten them.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use schemars::SchemaGenerator;
use serde_json::{Map, Value, json};
use ts_rs::{TS, TypeVisitor};

use crate::capability::Capability;
use crate::channel::{Catalogue, ChannelKind, Shape, TypeInfo};
use crate::flow::DEFAULT_INITIAL_CREDIT;
use crate::frame::MAX_FRAME_LEN;
use crate::message::Message;
use crate::version::PROTOCOL_VERSION;

/// The command that writes the generated files.
pub const REGENERATE_COMMAND: &str = "cargo run -p floti-protocol --bin generate";

/// The generated files' folder, relative to the repository root.
pub const GENERATED_DIR: &str = "crates/floti-protocol/generated";

pub const SCHEMA_FILE: &str = "floti-protocol.schema.json";
pub const TYPESCRIPT_FILE: &str = "floti-protocol.generated.ts";
pub const TSCONFIG_FILE: &str = "tsconfig.json";

/// One file the generator writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedFile {
    /// Its name inside [`GENERATED_DIR`].
    pub name: &'static str,
    pub contents: String,
}

/// Every generated file for `catalogue`.
pub fn generated_files(catalogue: &Catalogue) -> Vec<GeneratedFile> {
    vec![
        GeneratedFile {
            name: SCHEMA_FILE,
            contents: json_schema(catalogue),
        },
        GeneratedFile {
            name: TYPESCRIPT_FILE,
            contents: typescript(catalogue),
        },
        GeneratedFile {
            name: TSCONFIG_FILE,
            contents: tsconfig(),
        },
    ]
}

/// The folder the generated files live in, in this checkout.
pub fn generated_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("generated")
}

/// Writes every generated file into `dir`.
pub fn write_generated(dir: &Path, catalogue: &Catalogue) -> std::io::Result<Vec<PathBuf>> {
    std::fs::create_dir_all(dir)?;
    generated_files(catalogue)
        .into_iter()
        .map(|file| {
            let path = dir.join(file.name);
            std::fs::write(&path, file.contents)?;
            Ok(path)
        })
        .collect()
}

/// The files in `dir` that differ from what the generator would write now,
/// each with the sentence that says so and how to fix it.
pub fn stale_files(dir: &Path, catalogue: &Catalogue) -> Vec<String> {
    generated_files(catalogue)
        .into_iter()
        .filter_map(|file| {
            let on_disk = std::fs::read_to_string(dir.join(file.name)).ok();
            let current = on_disk.is_some_and(|text| normalise(&text) == normalise(&file.contents));
            (!current).then(|| {
                format!(
                    "{GENERATED_DIR}/{} is out of date. Run `{REGENERATE_COMMAND}`.",
                    file.name
                )
            })
        })
        .collect()
}

fn normalise(text: &str) -> String {
    text.replace("\r\n", "\n")
}

const HEADER: &str = "Generated from the floti-protocol crate by `cargo run -p floti-protocol --bin generate`. Do not edit.";

/// TypeScript declarations for every message, payload and channel.
pub fn typescript(catalogue: &Catalogue) -> String {
    let mut collector = TsCollector::default();
    TsCollector::root::<Message>(&mut collector);
    for_each_type(catalogue, |info| (info.collect_ts)(&mut collector));

    let mut out = String::new();
    let _ = writeln!(out, "// {HEADER}\n");
    let _ = writeln!(
        out,
        "/** The protocol version these declarations describe. */\nexport const PROTOCOL_VERSION = {{ major: {}, minor: {} }} as const;\n",
        PROTOCOL_VERSION.major, PROTOCOL_VERSION.minor
    );
    let _ = writeln!(
        out,
        "/** The largest frame body, in bytes. */\nexport const MAX_FRAME_LEN = {MAX_FRAME_LEN};\n"
    );
    let _ = writeln!(
        out,
        "/** Credit each direction of a new stream starts with, in bytes. */\nexport const DEFAULT_INITIAL_CREDIT = {DEFAULT_INITIAL_CREDIT};\n"
    );
    for decl in collector.decls.values() {
        out.push_str(decl);
        out.push_str("\n\n");
    }

    let mut requests = String::new();
    let mut events = String::new();
    let mut streams = String::new();
    let mut list = String::new();
    for decl in catalogue.channels() {
        let name = decl.name();
        let capability = ts_capability(decl.capability());
        match decl.shape {
            Shape::Request { request, response } => {
                let _ = writeln!(
                    requests,
                    "  {name:?}: {{ request: {}; response: {}; capability: {capability} }};",
                    (request.ts_name)(),
                    (response.ts_name)()
                );
            }
            Shape::Event { event, snapshot } => {
                let snapshot = snapshot.map_or_else(|| "null".to_owned(), |info| (info.ts_name)());
                let _ = writeln!(
                    events,
                    "  {name:?}: {{ event: {}; snapshot: {snapshot}; capability: {capability} }};",
                    (event.ts_name)()
                );
            }
            Shape::Stream { open } => {
                let _ = writeln!(
                    streams,
                    "  {name:?}: {{ open: {}; capability: {capability} }};",
                    (open.ts_name)()
                );
            }
        }
        let _ = writeln!(
            list,
            "  {{ name: {name:?}, kind: {:?}, capability: {capability} }},",
            kind_name(decl.kind())
        );
    }
    let _ = writeln!(
        out,
        "/** Every request channel: what it takes, what it answers and the capability it needs. */\nexport interface RequestChannels {{\n{requests}}}\n"
    );
    let _ = writeln!(
        out,
        "/** Every event channel: its events, its snapshot (null when it carries no state) and the capability it needs. */\nexport interface EventChannels {{\n{events}}}\n"
    );
    let _ = writeln!(
        out,
        "/** Every stream channel: what opening it names and the capability it needs. Its data is bytes. */\nexport interface StreamChannels {{\n{streams}}}\n"
    );
    let _ = writeln!(
        out,
        "/** Every channel, by name. */\nexport const CHANNELS = [\n{list}] as const;"
    );
    out
}

/// A JSON Schema with every message and payload type under `$defs`, and the
/// channel table under `x-channels`.
pub fn json_schema(catalogue: &Catalogue) -> String {
    let mut generator = SchemaGenerator::default();
    let message = generator.subschema_for::<Message>();
    let mut channels = Vec::new();
    for decl in catalogue.channels() {
        let mut entry = Map::new();
        entry.insert("name".into(), json!(decl.name()));
        entry.insert("kind".into(), json!(kind_name(decl.kind())));
        entry.insert(
            "capability".into(),
            json!(decl.capability().map(Capability::name)),
        );
        let mut schema = |key: &str, info: TypeInfo| {
            entry.insert(key.into(), (info.schema)(&mut generator).to_value());
        };
        match decl.shape {
            Shape::Request { request, response } => {
                schema("request", request);
                schema("response", response);
            }
            Shape::Event { event, snapshot } => {
                schema("event", event);
                match snapshot {
                    Some(info) => schema("snapshot", info),
                    None => {
                        entry.insert("snapshot".into(), Value::Null);
                    }
                }
            }
            Shape::Stream { open } => schema("open", open),
        }
        channels.push(Value::Object(entry));
    }
    for info in &catalogue.payloads {
        (info.schema)(&mut generator);
    }
    let defs: BTreeMap<String, Value> = generator.take_definitions(true).into_iter().collect();

    let document = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Floti protocol",
        "description": format!("{HEADER} Each frame is a 4-byte big-endian length and one CBOR value that is a Message."),
        "x-protocolVersion": PROTOCOL_VERSION.to_string(),
        "x-maxFrameLen": MAX_FRAME_LEN,
        "x-defaultInitialCredit": DEFAULT_INITIAL_CREDIT,
        "$ref": message.to_value().get("$ref").cloned().unwrap_or(Value::Null),
        "x-channels": channels,
        "$defs": defs,
    });
    let mut text = serde_json::to_string_pretty(&document).expect("a JSON value always serialises");
    text.push('\n');
    text
}

fn tsconfig() -> String {
    "{\n  \"extends\": \"../../../tsconfig.base.json\",\n  \"compilerOptions\": {\n    \"noEmit\": true,\n    \"types\": []\n  },\n  \"include\": [\"*.generated.ts\"]\n}\n".to_owned()
}

fn for_each_type(catalogue: &Catalogue, mut visit: impl FnMut(TypeInfo)) {
    for decl in catalogue.channels() {
        match decl.shape {
            Shape::Request { request, response } => {
                visit(request);
                visit(response);
            }
            Shape::Event { event, snapshot } => {
                visit(event);
                snapshot.into_iter().for_each(&mut visit);
            }
            Shape::Stream { open } => visit(open),
        }
    }
    catalogue.payloads.iter().copied().for_each(visit);
}

fn kind_name(kind: ChannelKind) -> &'static str {
    match kind {
        ChannelKind::Request => "request",
        ChannelKind::Event { .. } => "event",
        ChannelKind::Stream => "stream",
    }
}

fn ts_capability(capability: Option<Capability>) -> String {
    capability.map_or_else(
        || "null".to_owned(),
        |capability| format!("{:?}", capability.name()),
    )
}

/// Gathers each declarable type once, with every type it depends on.
#[derive(Default)]
pub(crate) struct TsCollector {
    /// Declarations by type name, so the output is sorted and stable.
    decls: BTreeMap<String, String>,
}

impl TsCollector {
    /// Collects `T`, or what it is built from when `T` itself has no
    /// declaration (`Vec<SessionRecord>`, `Option<Profile>`).
    pub(crate) fn root<T: TS + 'static>(&mut self) {
        T::visit_generics(self);
        T::visit_dependencies(self);
        self.visit::<T>();
    }
}

impl TypeVisitor for TsCollector {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        if T::output_path().is_none() {
            return;
        }
        let ident = T::ident();
        if self.decls.contains_key(&ident) {
            return;
        }
        let mut decl = T::docs().unwrap_or_default();
        decl.push_str("export ");
        decl.push_str(&T::decl());
        self.decls.insert(ident, decl);
        T::visit_dependencies(self);
        T::visit_generics(self);
    }
}
