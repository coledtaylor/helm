//! What each protocol version contains, committed beside the crate as
//! `crates/floti-protocol/versions/<major>.<minor>.json`.
//!
//! A version's record holds every host channel (its kind, its capability and
//! the types it carries) and every type's JSON Schema, the handshake's
//! messages included. It is the shape only: descriptions are left out, so a
//! doc comment changes no record, and so are the client-only and
//! host-internal lists, which never cross the protocol.
//!
//! `cargo run -p floti-protocol --bin generate` writes the current version's
//! record when there is none. When there is one and the protocol differs
//! from it, it leaves it as it is and names each channel and type added,
//! removed or changed, and the crate's tests fail with the same names, until
//! [`PROTOCOL_VERSION`](crate::PROTOCOL_VERSION) is bumped by the rule in
//! [`crate::version`] and the same command writes the new version's record
//! beside the earlier ones, which stay. Records are read in version order,
//! and a minor whose record removes or changes anything the previous minor's
//! held fails the tests: that change takes a major.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::channel::Catalogue;
use crate::generate::{REGENERATE_COMMAND, pretty, schema_parts};
use crate::version::ProtocolVersion;

/// The records' folder, relative to the repository root.
pub const RECORDS_DIR: &str = "crates/floti-protocol/versions";

/// Where the version rule is written down, which every refusal names.
const RULE: &str = "Bump PROTOCOL_VERSION in crates/floti-protocol/src/version.rs by its rule (a minor for an addition only, such as a channel or an optional field; a major for any removal or change of shape, the handshake included)";

/// The records' folder in this checkout.
pub fn records_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("versions")
}

/// The name of `version`'s record in [`RECORDS_DIR`].
pub fn record_file_name(version: ProtocolVersion) -> String {
    format!("{}.{}.json", version.major, version.minor)
}

/// The record of `catalogue` as protocol `version`.
pub fn record(version: ProtocolVersion, catalogue: &Catalogue) -> String {
    let parts = schema_parts(catalogue);
    let channels: Map<String, Value> = parts
        .channels
        .into_iter()
        .map(|mut channel| {
            let name = channel
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if let Value::Object(entry) = &mut channel {
                entry.remove("name");
            }
            (name, shape_only(channel))
        })
        .collect();
    let types: Map<String, Value> = parts
        .defs
        .into_iter()
        .map(|(name, schema)| (name, shape_only(schema)))
        .collect();
    pretty(json!({
        "description": format!(
            "What Floti protocol {version} contains: every host channel and every type, the handshake's included. Written by `{REGENERATE_COMMAND}`; never edited."
        ),
        "version": version.to_string(),
        "message": parts.message,
        "channels": channels,
        "types": types,
    }))
}

/// Which part of the protocol a difference is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Part {
    Channel,
    Type,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Change {
    Added,
    Removed,
    Changed,
}

/// One channel or type that differs between two records.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Difference {
    pub part: Part,
    pub name: String,
    pub change: Change,
}

impl fmt::Display for Difference {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let part = match self.part {
            Part::Channel => "channel",
            Part::Type => "type",
        };
        let change = match self.change {
            Change::Added => "added",
            Change::Removed => "removed",
            Change::Changed => "changed",
        };
        write!(f, "{part} `{}` {change}", self.name)
    }
}

/// Every channel and type added, removed or changed from `earlier` to
/// `later`, two records' text, channels first, each by name.
pub fn differences(earlier: &str, later: &str) -> Result<Vec<Difference>, String> {
    let earlier = parse(earlier)?;
    let later = parse(later)?;
    let mut found = Vec::new();
    for (part, key) in [(Part::Channel, "channels"), (Part::Type, "types")] {
        let (before, after) = (section(&earlier, key), section(&later, key));
        let names: BTreeSet<&String> = before.keys().chain(after.keys()).collect();
        for name in names {
            let change = match (before.get(name), after.get(name)) {
                (None, Some(_)) => Change::Added,
                (Some(_), None) => Change::Removed,
                (Some(old), Some(new)) if old != new => Change::Changed,
                _ => continue,
            };
            found.push(Difference {
                part,
                name: name.clone(),
                change,
            });
        }
    }
    Ok(found)
}

/// Whether `catalogue` is what `version`'s record in `dir` holds; otherwise
/// the sentences that name each difference and say what to do.
pub fn check_record(
    dir: &Path,
    version: ProtocolVersion,
    catalogue: &Catalogue,
) -> Result<(), String> {
    let path = dir.join(record_file_name(version));
    let Ok(recorded) = std::fs::read_to_string(&path) else {
        return Err(format!(
            "{RECORDS_DIR}/{} is missing: there is no record of Floti protocol {version}. Run `{REGENERATE_COMMAND}`.",
            record_file_name(version)
        ));
    };
    let current = record(version, catalogue);
    let found = differences(&recorded, &current)?;
    if found.is_empty() {
        return Ok(());
    }
    Err(differs(version, &found))
}

fn differs(version: ProtocolVersion, found: &[Difference]) -> String {
    let mut text = format!(
        "The protocol differs from the record of Floti protocol {version}, {RECORDS_DIR}/{}:\n",
        record_file_name(version)
    );
    for difference in found {
        text.push_str(&format!("  {difference}\n"));
    }
    text.push_str(&format!("{RULE}, then run `{REGENERATE_COMMAND}`."));
    text
}

/// What [`write_record`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Written {
    /// There was no record of the version, and now there is.
    Wrote(PathBuf),
    /// The record there already holds what the protocol is.
    Current,
    /// The record there differs and was left as it is: the sentences naming
    /// each difference and the rule.
    Differs(String),
}

/// Writes `version`'s record of `catalogue` into `dir` when there is none.
/// An existing record is never changed: one that differs is left, and the
/// answer names what differs.
pub fn write_record(
    dir: &Path,
    version: ProtocolVersion,
    catalogue: &Catalogue,
) -> std::io::Result<Written> {
    let path = dir.join(record_file_name(version));
    match std::fs::read_to_string(&path) {
        Ok(recorded) => {
            let found = differences(&recorded, &record(version, catalogue))
                .map_err(std::io::Error::other)?;
            Ok(if found.is_empty() {
                Written::Current
            } else {
                Written::Differs(differs(version, &found))
            })
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(dir)?;
            std::fs::write(&path, record(version, catalogue))?;
            Ok(Written::Wrote(path))
        }
        Err(err) => Err(err),
    }
}

/// Every record in `dir`, in version order.
pub fn records(dir: &Path) -> Result<Vec<(ProtocolVersion, String)>, String> {
    let entries = std::fs::read_dir(dir).map_err(|err| format!("{}: {err}", dir.display()))?;
    let mut found = BTreeMap::new();
    for entry in entries {
        let path = entry.map_err(|err| err.to_string())?.path();
        let Some(version) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".json"))
            .and_then(parse_version)
        else {
            continue;
        };
        let text =
            std::fs::read_to_string(&path).map_err(|err| format!("{}: {err}", path.display()))?;
        found.insert(version, text);
    }
    Ok(found.into_iter().collect())
}

fn parse_version(text: &str) -> Option<ProtocolVersion> {
    let (major, minor) = text.split_once('.')?;
    Some(ProtocolVersion::new(
        major.parse().ok()?,
        minor.parse().ok()?,
    ))
}

/// Each place a minor's record in `dir` removes or changes something the
/// previous minor of its major held, read in version order: the rule allows
/// a minor only to add.
pub fn minor_rule_breaks(dir: &Path) -> Result<Vec<String>, String> {
    let records = records(dir)?;
    let mut breaks = Vec::new();
    for pair in records.windows(2) {
        let ((earlier, before), (later, after)) = (&pair[0], &pair[1]);
        if earlier.major != later.major {
            continue;
        }
        let (old, new) = (parse(before)?, parse(after)?);
        for difference in differences(before, after)? {
            let key = match difference.part {
                Part::Channel => "channels",
                Part::Type => "types",
            };
            let only_adds = match difference.change {
                Change::Added => true,
                Change::Removed => false,
                Change::Changed => extends(
                    &section(&old, key)[&difference.name],
                    &section(&new, key)[&difference.name],
                ),
            };
            if !only_adds {
                breaks.push(format!(
                    "Floti protocol {later} is a minor after {earlier}, and in it {difference}: that change takes a major."
                ));
            }
        }
    }
    Ok(breaks)
}

fn parse(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|err| format!("a record that is not JSON: {err}"))
}

fn section<'a>(record: &'a Value, key: &str) -> &'a Map<String, Value> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    record
        .get(key)
        .and_then(Value::as_object)
        .unwrap_or_else(|| EMPTY.get_or_init(Map::new))
}

/// Whether `new` only adds to `old`: every property kept in the same shape,
/// none newly required, every alternative and value kept, and nothing else
/// changed.
fn extends(old: &Value, new: &Value) -> bool {
    if old == new {
        return true;
    }
    let (Value::Object(old), Value::Object(new)) = (old, new) else {
        return false;
    };
    let keys: BTreeSet<&String> = old.keys().chain(new.keys()).collect();
    keys.into_iter().all(|key| {
        let (before, after) = (old.get(key), new.get(key));
        match key.as_str() {
            "properties" => {
                let empty = Map::new();
                let before = before.and_then(Value::as_object).unwrap_or(&empty);
                let after = after.and_then(Value::as_object).unwrap_or(&empty);
                let required: BTreeSet<&str> = new
                    .get("required")
                    .and_then(Value::as_array)
                    .map(|names| names.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                before
                    .iter()
                    .all(|(name, schema)| after.get(name).is_some_and(|kept| extends(schema, kept)))
                    && after
                        .keys()
                        .filter(|name| !before.contains_key(*name))
                        .all(|added| !required.contains(added.as_str()))
            }
            "oneOf" | "anyOf" | "enum" => {
                let empty = Vec::new();
                let before = before.and_then(Value::as_array).unwrap_or(&empty);
                let after = after.and_then(Value::as_array).unwrap_or(&empty);
                before
                    .iter()
                    .all(|kept| after.iter().any(|choice| extends(kept, choice)))
            }
            _ => before == after,
        }
    })
}

/// A schema without its descriptions, which say what it means and not what
/// shape it has. Property names are kept whatever they are called.
fn shape_only(schema: Value) -> Value {
    match schema {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(key, _)| key != "description")
                .map(|(key, value)| {
                    let value = match (key.as_str(), value) {
                        ("properties", Value::Object(properties)) => Value::Object(
                            properties
                                .into_iter()
                                .map(|(name, property)| (name, shape_only(property)))
                                .collect(),
                        ),
                        (_, value) => shape_only(value),
                    };
                    (key, value)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(shape_only).collect()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_optional_property_or_a_new_alternative_only_adds_and_anything_else_changes_shape() {
        let old =
            json!({"type": "object", "properties": {"a": {"type": "string"}}, "required": ["a"]});
        let optional = json!({"type": "object", "properties": {"a": {"type": "string"}, "b": {"type": "string"}}, "required": ["a"]});
        let required = json!({"type": "object", "properties": {"a": {"type": "string"}, "b": {"type": "string"}}, "required": ["a", "b"]});
        let retyped =
            json!({"type": "object", "properties": {"a": {"type": "integer"}}, "required": ["a"]});
        let dropped = json!({"type": "object", "properties": {}, "required": []});
        assert!(extends(&old, &optional));
        assert!(!extends(&old, &required));
        assert!(!extends(&old, &retyped));
        assert!(!extends(&old, &dropped));

        let choices = json!({"oneOf": [{"const": "a"}, {"const": "b"}]});
        assert!(extends(
            &choices,
            &json!({"oneOf": [{"const": "a"}, {"const": "b"}, {"const": "c"}]})
        ));
        assert!(!extends(&choices, &json!({"oneOf": [{"const": "a"}]})));
        assert!(extends(
            &json!({"enum": ["a"]}),
            &json!({"enum": ["a", "b"]})
        ));
        assert!(!extends(
            &json!({"enum": ["a", "b"]}),
            &json!({"enum": ["a"]})
        ));
    }

    #[test]
    fn descriptions_are_left_out_and_a_property_called_description_is_kept() {
        let schema = json!({
            "description": "what it means",
            "type": "object",
            "properties": {"description": {"type": "string", "description": "a field"}},
        });
        assert_eq!(
            shape_only(schema),
            json!({"type": "object", "properties": {"description": {"type": "string"}}})
        );
    }
}
