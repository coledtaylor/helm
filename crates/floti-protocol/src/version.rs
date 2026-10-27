//! Protocol versions and the one negotiation rule.
//!
//! The host accepts its own version and the previous minor of the same major,
//! because clients on a phone or a laptop lag the host by weeks. Anything else
//! is refused with a message that names both versions and which side to
//! update. "Previous minor" stays inside one major: a host on 2.0 accepts only
//! 2.0, since a major is where removals happen.

use std::fmt;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// A protocol version: `major.minor`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, JsonSchema, TS,
)]
pub struct ProtocolVersion {
    pub major: u16,
    pub minor: u16,
}

impl ProtocolVersion {
    pub const fn new(major: u16, minor: u16) -> Self {
        Self { major, minor }
    }
}

impl fmt::Display for ProtocolVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.major, self.minor)
    }
}

/// The version this crate speaks.
pub const PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion::new(1, 0);

/// Which side has to be updated for two versions to talk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum UpdateSide {
    Client,
    Host,
}

/// Two versions that cannot talk, and what to do about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VersionMismatch {
    pub host: ProtocolVersion,
    pub client: ProtocolVersion,
    pub update: UpdateSide,
}

impl VersionMismatch {
    /// The sentence a client shows, whatever version it is.
    pub fn message(&self) -> String {
        let side = match self.update {
            UpdateSide::Client => "client",
            UpdateSide::Host => "host",
        };
        format!(
            "This client speaks Floti protocol {} and the host speaks {}. Update the {side}.",
            self.client, self.host
        )
    }
}

/// The version a connection uses, or why there is none.
///
/// The version in use is the client's: a host one minor ahead still speaks the
/// minor before it.
pub fn negotiate(
    host: ProtocolVersion,
    client: ProtocolVersion,
) -> Result<ProtocolVersion, VersionMismatch> {
    let accepted = client.major == host.major
        && (client.minor == host.minor || client.minor.checked_add(1) == Some(host.minor));
    if accepted {
        return Ok(client);
    }
    let update = if client < host {
        UpdateSide::Client
    } else {
        UpdateSide::Host
    };
    Err(VersionMismatch {
        host,
        client,
        update,
    })
}
