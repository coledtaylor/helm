//! Protocol versions and the one negotiation rule.
//!
//! The host accepts its own version and the previous minor of the same major,
//! because clients on a phone or a laptop lag the host by weeks. Anything else
//! is refused with a message that names both versions and which side to
//! update. "Previous minor" stays inside one major: a host on 2.0 accepts only
//! 2.0, since a major is where removals happen.
//!
//! # Which change takes which version
//!
//! - A **minor** only adds: a channel, a message, a type, an optional field,
//!   an enum variant. Everything the previous minor had is still there, in
//!   the same shape, so a client one minor behind still reads every frame it
//!   knows.
//! - A **major** is any removal or change of shape: a channel, type, field or
//!   variant removed or renamed, a field's type changed, an optional field
//!   made required, a channel's kind or capability changed. The handshake
//!   counts too: `hello`, `welcome`, `refused` and the restart frames.
//!
//! Each version's record (`crates/floti-protocol/versions/<major>.<minor>.json`,
//! [`crate::record`]) holds what it contains. A protocol that differs from the
//! current version's record fails the crate's tests, naming each channel and
//! type that differs, until [`PROTOCOL_VERSION`] is bumped by this rule and
//! `cargo run -p floti-protocol --bin generate` writes the new version's
//! record; a minor whose record removes or changes anything from the previous
//! minor's fails them too.

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
pub const PROTOCOL_VERSION: ProtocolVersion = ProtocolVersion::new(2, 1);

/// The version of the link between a host and its session keeper, which a
/// keeper names in its greeting. A host takes back a keeper that speaks this
/// link version, whatever floti version built it, and ends any other, with
/// what it holds. Link version 1 is also what a keeper whose greeting names
/// none speaks: one built before the greeting carried it, as
/// 2.4.1-preview.7's was, so this host takes such a keeper back. It changes
/// only when what a host and its keeper say to each other changes in a way
/// the other cannot read.
pub const KEEPER_LINK_VERSION: u32 = 1;

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
