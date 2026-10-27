//! JSON that keeps its keys in the order the file has them.
//!
//! The console rewrites files people keep by hand (`settings.local.json` for
//! an approval) and predicts files the agent's CLI rewrites (`.mcp.json`,
//! `~/.claude.json`). Both have to come out the way today's app writes them,
//! `JSON.stringify(doc, null, 2)`: every key where it was, a new key last, two
//! spaces of indent. A map that sorted its keys would reorder someone's file
//! on an unrelated edit.

use std::fmt;

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};

/// A JSON value whose objects keep their order.
#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

impl Json {
    /// `text` parsed, or the parser's sentence for why not.
    pub fn parse(text: &str) -> Result<Self, String> {
        serde_json::from_str(text).map_err(|err| err.to_string())
    }

    /// `text` as an object: an empty file is an empty object, anything else
    /// that is not an object is `None`.
    pub fn parse_object(text: &str) -> Option<Self> {
        if text.trim().is_empty() {
            return Some(Self::Object(Vec::new()));
        }
        Self::parse(text).ok().filter(Self::is_object)
    }

    pub fn is_object(&self) -> bool {
        matches!(self, Self::Object(_))
    }

    /// Indented by two spaces, as `JSON.stringify(value, null, 2)` writes it.
    pub fn pretty(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_default()
    }

    /// On one line, as `JSON.stringify(value)` writes it.
    pub fn compact(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    /// The value under `key`, for an object that has it.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Self::Object(entries) => entries
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    /// The entries of an object, or `None` for anything else.
    pub fn entries(&self) -> Option<&[(String, Json)]> {
        match self {
            Self::Object(entries) => Some(entries),
            _ => None,
        }
    }

    /// Sets `key`, in place when it is there and last when it is new. Does
    /// nothing to a value that is not an object.
    pub fn set(&mut self, key: &str, value: Json) {
        if let Self::Object(entries) = self {
            match entries.iter_mut().find(|(name, _)| name == key) {
                Some((_, slot)) => *slot = value,
                None => entries.push((key.to_owned(), value)),
            }
        }
    }

    /// Removes `key` from an object.
    pub fn remove(&mut self, key: &str) {
        if let Self::Object(entries) = self {
            entries.retain(|(name, _)| name != key);
        }
    }

    /// The object under `key`, made an empty one first when the key is
    /// missing or null (`obj[key] ??= {}`). `None` when this is not an
    /// object, or the key holds something else.
    pub fn object_at(&mut self, key: &str) -> Option<&mut Json> {
        let Self::Object(entries) = self else {
            return None;
        };
        let at = match entries.iter().position(|(name, _)| name == key) {
            Some(at) => {
                if entries[at].1 == Self::Null {
                    entries[at].1 = Self::Object(Vec::new());
                }
                at
            }
            None => {
                entries.push((key.to_owned(), Self::Object(Vec::new())));
                entries.len() - 1
            }
        };
        let value = &mut entries[at].1;
        value.is_object().then_some(value)
    }

    /// The strings in an array, skipping anything else; nothing for a value
    /// that is not an array.
    pub fn strings(&self) -> Vec<String> {
        match self {
            Self::Array(items) => items
                .iter()
                .filter_map(|item| match item {
                    Self::String(text) => Some(text.clone()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        }
    }
}

impl Serialize for Json {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Null => serializer.serialize_unit(),
            Self::Bool(value) => serializer.serialize_bool(*value),
            Self::Number(number) => match number.as_f64() {
                // A whole number read as a float prints as `1`, as
                // JavaScript prints it, not `1.0`.
                Some(float) if number.is_f64() && float.fract() == 0.0 && float.abs() < 9.0e15 => {
                    serializer.serialize_i64(float as i64)
                }
                _ => number.serialize(serializer),
            },
            Self::String(text) => serializer.serialize_str(text),
            Self::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Self::Object(entries) => {
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (key, value) in entries {
                    map.serialize_entry(key, value)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(JsonVisitor)
    }
}

struct JsonVisitor;

impl<'de> Visitor<'de> for JsonVisitor {
    type Value = Json;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }

    fn visit_bool<E>(self, value: bool) -> Result<Json, E> {
        Ok(Json::Bool(value))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Json, E> {
        Ok(Json::Number(value.into()))
    }

    fn visit_u64<E>(self, value: u64) -> Result<Json, E> {
        Ok(Json::Number(value.into()))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Json, E> {
        serde_json::Number::from_f64(value)
            .map(Json::Number)
            .ok_or_else(|| E::custom("a number JSON cannot hold"))
    }

    fn visit_str<E>(self, value: &str) -> Result<Json, E> {
        Ok(Json::String(value.to_owned()))
    }

    fn visit_string<E>(self, value: String) -> Result<Json, E> {
        Ok(Json::String(value))
    }

    fn visit_unit<E>(self) -> Result<Json, E> {
        Ok(Json::Null)
    }

    fn visit_none<E>(self) -> Result<Json, E> {
        Ok(Json::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element()? {
            items.push(item);
        }
        Ok(Json::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
        // A key given twice keeps its first place and its last value, as
        // `JSON.parse` does.
        let mut object = Json::Object(Vec::new());
        while let Some((key, value)) = map.next_entry::<String, Json>()? {
            object.set(&key, value);
        }
        Ok(object)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_document_comes_back_in_its_own_order_indented_as_javascript_writes_it() {
        let doc =
            Json::parse(r#"{"zeta":1,"alpha":{"b":[1,2.5,"x"],"a":{}},"mid":[],"n":1.0}"#).unwrap();
        assert_eq!(
            doc.pretty(),
            "{\n  \"zeta\": 1,\n  \"alpha\": {\n    \"b\": [\n      1,\n      2.5,\n      \"x\"\n    ],\n    \"a\": {}\n  },\n  \"mid\": [],\n  \"n\": 1\n}"
        );
        assert_eq!(
            doc.compact(),
            r#"{"zeta":1,"alpha":{"b":[1,2.5,"x"],"a":{}},"mid":[],"n":1}"#
        );
    }

    #[test]
    fn a_set_key_stays_where_it_was_and_a_new_one_goes_last() {
        let mut doc = Json::parse(r#"{"b":1,"a":2}"#).unwrap();
        doc.set("b", Json::Bool(true));
        doc.set("c", Json::Null);
        assert_eq!(doc.compact(), r#"{"b":true,"a":2,"c":null}"#);
        doc.object_at("d").unwrap().set("x", Json::Bool(false));
        assert_eq!(
            doc.compact(),
            r#"{"b":true,"a":2,"c":null,"d":{"x":false}}"#
        );
        assert!(doc.object_at("a").is_none());
    }
}
