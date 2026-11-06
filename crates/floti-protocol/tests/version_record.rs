//! Each protocol version's record: the current version's matches the
//! protocol, a change without a bump fails naming what changed, the one
//! command writes the bumped version's record beside the earlier ones, and a
//! minor only adds.

use std::path::{Path, PathBuf};

use floti_protocol::generate::REGENERATE_COMMAND;
use floti_protocol::record::{
    Change, Difference, Part, Written, check_record, minor_rule_breaks, record, record_file_name,
    records_dir, write_record,
};
use floti_protocol::{Catalogue, EventChannel, PROTOCOL_VERSION, ProtocolVersion, RequestChannel};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The real check: the record committed for this version is the protocol.
#[test]
fn the_record_committed_for_the_current_protocol_version_matches_the_protocol() {
    if let Err(why) = check_record(&records_dir(), PROTOCOL_VERSION, &Catalogue::protocol()) {
        panic!("{why}");
    }
}

#[test]
fn the_committed_records_read_in_order_only_add_within_a_major() {
    let breaks = minor_rule_breaks(&records_dir()).unwrap();
    assert!(breaks.is_empty(), "{}", breaks.join("\n"));
}

#[test]
fn the_record_holds_the_handshake_and_no_client_only_or_host_internal_entry() {
    let text = record(PROTOCOL_VERSION, &Catalogue::protocol());
    let record: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(record["version"], PROTOCOL_VERSION.to_string());
    let types = record["types"].as_object().unwrap();
    for handshake in [
        "Hello",
        "Welcome",
        "Refused",
        "RestartAsk",
        "Restart",
        "RestartState",
    ] {
        assert!(
            types.contains_key(handshake),
            "the record lacks {handshake}"
        );
    }
    let channels = record["channels"].as_object().unwrap();
    assert!(channels.contains_key("session:list"));
    use floti_protocol::channels::boundary::{CLIENT_ONLY, HOST_INTERNAL};
    for entry in CLIENT_ONLY.iter().chain(HOST_INTERNAL) {
        let family = entry.channels.trim_end_matches('*');
        assert!(
            !channels
                .keys()
                .any(|name| if entry.channels.ends_with('*') {
                    name.starts_with(family)
                } else {
                    name == entry.channels
                }),
            "{} is in the record",
            entry.channels
        );
    }
    assert!(!text.contains("\"description\": \"The client's first message"));
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
struct StubState {
    names: Vec<String>,
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
    type Event = StubState;
    type Snapshot = StubState;
}

/// The protocol with two channels and a type added.
fn with_stub() -> Catalogue {
    let mut catalogue = Catalogue::protocol();
    catalogue.request::<StubRequest>().event::<StubEvent>();
    catalogue
}

/// `with_stub`, with `stub:changed` carrying another type: a change of shape.
#[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
struct OtherState {
    count: u32,
}

struct StubEventChanged;
impl EventChannel for StubEventChanged {
    const NAME: &'static str = "stub:changed";
    const SNAPSHOT: bool = false;
    type Event = OtherState;
    type Snapshot = ();
}

fn with_stub_changed() -> Catalogue {
    let mut catalogue = Catalogue::protocol();
    catalogue
        .request::<StubRequest>()
        .event::<StubEventChanged>();
    catalogue
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
            "floti-protocol-record-{label}-{}-{nanos}",
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

fn difference(part: Part, name: &str, change: Change) -> String {
    Difference {
        part,
        name: name.to_owned(),
        change,
    }
    .to_string()
}

const V2_0: ProtocolVersion = ProtocolVersion::new(2, 0);
const V2_1: ProtocolVersion = ProtocolVersion::new(2, 1);

#[test]
fn s3_a_channel_or_type_added_removed_or_changed_without_a_bump_fails_naming_each_and_the_rule() {
    let dir = TempDir::new("s3");
    assert!(matches!(
        write_record(dir.path(), V2_0, &with_stub()).unwrap(),
        Written::Wrote(_)
    ));

    // Added: a third channel and its type, and nobody bumped.
    let mut added = with_stub();
    #[derive(Debug, Serialize, Deserialize, JsonSchema, TS)]
    struct ThirdAnswer {
        ok: bool,
    }
    struct Third;
    impl RequestChannel for Third {
        const NAME: &'static str = "stub:third";
        type Request = ();
        type Response = ThirdAnswer;
    }
    added.request::<Third>();
    let why = check_record(dir.path(), V2_0, &added).unwrap_err();
    assert!(
        why.contains(&difference(Part::Channel, "stub:third", Change::Added)),
        "{why}"
    );
    assert!(
        why.contains(&difference(Part::Type, "ThirdAnswer", Change::Added)),
        "{why}"
    );

    // Removed: both stub channels and their type.
    let why = check_record(dir.path(), V2_0, &Catalogue::protocol()).unwrap_err();
    for removed in [
        difference(Part::Channel, "stub:changed", Change::Removed),
        difference(Part::Channel, "stub:list", Change::Removed),
        difference(Part::Type, "StubState", Change::Removed),
    ] {
        assert!(why.contains(&removed), "{why}");
    }

    // Changed: `stub:changed` carries another type and no snapshot.
    let why = check_record(dir.path(), V2_0, &with_stub_changed()).unwrap_err();
    assert!(
        why.contains(&difference(Part::Channel, "stub:changed", Change::Changed)),
        "{why}"
    );
    assert!(
        why.contains(&difference(Part::Type, "OtherState", Change::Added)),
        "{why}"
    );
    assert!(
        !why.contains("stub:list"),
        "an unchanged channel is not named: {why}"
    );

    // Each says to bump by the rule and run the one command.
    assert!(why.contains("Bump PROTOCOL_VERSION"), "{why}");
    assert!(why.contains("a minor for an addition only"), "{why}");
    assert!(
        why.contains("a major for any removal or change of shape"),
        "{why}"
    );
    assert!(
        why.contains(&format!("run `{REGENERATE_COMMAND}`")),
        "{why}"
    );
}

#[test]
fn s4_the_one_command_leaves_a_differing_record_and_writes_the_bumped_versions_beside_it() {
    let dir = TempDir::new("s4");
    write_record(dir.path(), V2_0, &Catalogue::protocol()).unwrap();
    let path = dir.path().join(record_file_name(V2_0));
    let recorded = std::fs::read_to_string(&path).unwrap();
    assert_eq!(
        write_record(dir.path(), V2_0, &Catalogue::protocol()).unwrap(),
        Written::Current
    );

    // Without a bump it changes nothing, and names the same differences the
    // test does.
    let Written::Differs(why) = write_record(dir.path(), V2_0, &with_stub()).unwrap() else {
        panic!("a differing record was not refused");
    };
    assert_eq!(std::fs::read_to_string(&path).unwrap(), recorded);
    assert_eq!(
        why,
        check_record(dir.path(), V2_0, &with_stub()).unwrap_err()
    );
    assert!(
        why.contains(&difference(Part::Channel, "stub:list", Change::Added)),
        "{why}"
    );

    // Bumped, it writes the new version's record beside the earlier one, and
    // every check passes.
    assert_eq!(
        write_record(dir.path(), V2_1, &with_stub()).unwrap(),
        Written::Wrote(dir.path().join("2.1.json"))
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), recorded);
    check_record(dir.path(), V2_1, &with_stub()).unwrap();
    assert_eq!(minor_rule_breaks(dir.path()).unwrap(), Vec::<String>::new());
}

#[test]
fn s5_a_minor_whose_record_removes_or_changes_anything_of_the_previous_minor_fails_saying_it_takes_a_major()
 {
    let removed = TempDir::new("s5-removed");
    write_record(removed.path(), V2_0, &with_stub()).unwrap();
    write_record(removed.path(), V2_1, &Catalogue::protocol()).unwrap();
    let breaks = minor_rule_breaks(removed.path()).unwrap();
    assert_eq!(
        breaks,
        [
            "Floti protocol 2.1 is a minor after 2.0, and in it channel `stub:changed` removed: that change takes a major.",
            "Floti protocol 2.1 is a minor after 2.0, and in it channel `stub:list` removed: that change takes a major.",
            "Floti protocol 2.1 is a minor after 2.0, and in it type `StubState` removed: that change takes a major.",
        ]
    );

    let changed = TempDir::new("s5-changed");
    write_record(changed.path(), V2_0, &with_stub()).unwrap();
    write_record(changed.path(), V2_1, &with_stub_changed()).unwrap();
    let breaks = minor_rule_breaks(changed.path()).unwrap();
    assert!(
        breaks
            .iter()
            .any(|line| line.contains("channel `stub:changed` changed: that change takes a major")),
        "{breaks:?}"
    );

    // A major may remove; and records are read in version order, not by name.
    let major = TempDir::new("s5-major");
    write_record(major.path(), V2_0, &with_stub()).unwrap();
    write_record(
        major.path(),
        ProtocolVersion::new(3, 0),
        &Catalogue::protocol(),
    )
    .unwrap();
    write_record(major.path(), ProtocolVersion::new(2, 10), &with_stub()).unwrap();
    assert_eq!(
        minor_rule_breaks(major.path()).unwrap(),
        Vec::<String>::new()
    );
    write_record(
        major.path(),
        ProtocolVersion::new(2, 9),
        &Catalogue::protocol(),
    )
    .unwrap();
    let breaks = minor_rule_breaks(major.path()).unwrap();
    assert!(
        breaks
            .iter()
            .all(|line| line.starts_with("Floti protocol 2.9 is a minor after 2.0")),
        "{breaks:?}"
    );
    assert!(!breaks.is_empty());
}
