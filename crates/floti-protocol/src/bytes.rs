//! Raw bytes, as a CBOR byte string.
//!
//! Terminal output is most of the traffic and is not text: it can split a
//! UTF-8 sequence anywhere, or not be UTF-8 at all. So it travels as a CBOR
//! byte string (major type 2), never as text, base64 or an array of numbers,
//! and arrives byte for byte. TypeScript sees a `Uint8Array`.

use std::borrow::Cow;
use std::fmt;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Bytes(#[serde(with = "serde_bytes")] pub Vec<u8>);

impl Bytes {
    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.0
    }
}

impl From<Vec<u8>> for Bytes {
    fn from(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }
}

impl From<&[u8]> for Bytes {
    fn from(bytes: &[u8]) -> Self {
        Self(bytes.to_vec())
    }
}

impl fmt::Debug for Bytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Bytes({} bytes)", self.0.len())
    }
}

impl JsonSchema for Bytes {
    fn schema_name() -> Cow<'static, str> {
        "Bytes".into()
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "type": "string",
            "contentEncoding": "base64url",
            "description": "Raw bytes. On the wire this is a CBOR byte string (major type 2). JSON has no byte type, so a JSON rendering of it is base64url text, as RFC 8949 converts it."
        })
    }
}

impl TS for Bytes {
    type WithoutGenerics = Self;
    type OptionInnerType = Self;

    fn name() -> String {
        "Uint8Array".to_owned()
    }

    fn inline() -> String {
        Self::name()
    }

    fn inline_flattened() -> String {
        panic!("Uint8Array cannot be flattened")
    }

    fn decl() -> String {
        panic!("Uint8Array is built in and has no declaration")
    }

    fn decl_concrete() -> String {
        Self::decl()
    }
}
