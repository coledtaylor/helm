//! A client's own data, carried into the host once: `carry:*`.
//!
//! Helm kept some things in its own database before the host ran its
//! sessions, and the host cannot rebuild them from the agent's files:
//! conversations it archived whose transcripts the agent has since deleted,
//! their usage, the names given to sessions in History, and the config
//! console's file versions. The client reads them from its own database and
//! sends them here in batches; the host merges each batch into its own, and
//! what the host already holds wins. The client never names its data folder
//! and the host never opens the client's database.
//!
//! The copy runs once per host. `carry:status` says whether it has finished;
//! `carry:finish` records that it has. Until then every batch may be sent
//! again (after a copy that stopped part way) and is merged without
//! duplicating anything.
//!
//! A conversation larger than one batch arrives in parts, numbered from 0;
//! its row is written only with its last part, so a copy that stops part way
//! leaves no conversation showing part of its messages, and the part numbered
//! 0 of a retried one first clears whatever an earlier attempt left of it.
//!
//! Every channel writes the host's database, and every device that completes
//! the handshake may call it. What a batch carries is the user's own conversation text; the host logs
//! how many rows it merged, never what they said.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::channel::Catalogue;
use crate::channels::sessions::{ArchiveMessage, ArchiveSessionState};

pub fn declare(catalogue: &mut Catalogue) {
    catalogue
        .request::<CarryStatusRead>()
        .request::<CarryMissing>()
        .request::<CarryNames>()
        .request::<CarryVersions>()
        .request::<CarryUsage>()
        .request::<CarryConversations>()
        .request::<CarryFinish>();
}

request_channel! {
    /// Whether the client's data has been carried into this host.
    CarryStatusRead = "carry:status", () => CarryStatus
}

request_channel! {
    /// Of the conversations named, the ones the host holds nothing for, in
    /// any state: only those are sent.
    CarryMissing = "carry:missing", CarrySessionIds => CarrySessionIds
}

request_channel! {
    /// Names given to sessions in History. A session the host already has a
    /// name for keeps it.
    CarryNames = "carry:names", CarriedSessionNames => CarryMerged
}

request_channel! {
    /// Config file versions. A version the host already has (same folder,
    /// file, content and time) is not added again.
    CarryVersions = "carry:versions", CarriedConfigVersions => CarryMerged
}

request_channel! {
    /// Token usage of assistant messages. A message the host already has
    /// usage for keeps it.
    CarryUsage = "carry:usage", CarriedUsageRows => CarryMerged
}

request_channel! {
    /// Archived conversations, or parts of them. A conversation the host
    /// already holds, archived or dropped, is kept whole and the part is
    /// skipped. The archive's size limit is applied after each batch.
    CarryConversations = "carry:conversations", CarriedConversations => CarriedConversationsMerged
}

request_channel! {
    /// Records that the copy finished, so it does not run again. The first
    /// record stands.
    CarryFinish = "carry:finish", () => CarryStatus
}

/// Whether the copy has run to the end on this host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CarryStatus {
    /// ISO 8601 time it finished, or null while it has not.
    pub finished_at: Option<String>,
}

/// Conversations by the id their agent gave them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CarrySessionIds {
    pub session_ids: Vec<String>,
}

/// What one batch did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CarryMerged {
    /// Rows the host did not have, and now has.
    pub added: u32,
    /// Rows the host already had, kept as they were.
    pub kept: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CarriedSessionNames {
    pub names: Vec<CarriedSessionName>,
}

/// A name somebody gave a session in History.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CarriedSessionName {
    pub session_id: String,
    pub name: String,
    /// ISO 8601.
    pub renamed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CarriedConfigVersions {
    pub versions: Vec<CarriedConfigVersion>,
}

/// One config file as it was before a write, with its bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CarriedConfigVersion {
    /// The scope's base folder.
    pub scope_path: String,
    /// Relative to `scope_path`, forward-slashed.
    pub file_path: String,
    pub content: String,
    /// sha256 of `content`.
    pub content_hash: String,
    /// Why the write was made, as stored; one this build does not know is
    /// kept as it is.
    pub reason: String,
    /// ISO 8601.
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CarriedUsageRows {
    pub rows: Vec<CarriedUsageRow>,
}

/// One assistant message's token usage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CarriedUsageRow {
    /// The message's own uuid, from its transcript.
    pub uuid: String,
    /// Epoch ms.
    #[ts(type = "number")]
    pub at: u64,
    pub model: String,
    #[ts(type = "number")]
    pub input: u64,
    #[ts(type = "number")]
    pub output: u64,
    #[ts(type = "number")]
    pub cache_write5m: u64,
    #[ts(type = "number")]
    pub cache_write1h: u64,
    #[ts(type = "number")]
    pub cache_read: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CarriedConversations {
    pub parts: Vec<CarriedConversationPart>,
}

/// One conversation's messages, or part of them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CarriedConversationPart {
    /// The conversation's row, the same on every part.
    pub conversation: CarriedConversation,
    /// 0 for its first part.
    pub part: u32,
    /// In the order they happened. Empty for a dropped conversation.
    pub messages: Vec<ArchiveMessage>,
    /// True on the part that ends the conversation.
    pub last: bool,
}

/// An archived conversation's row as the client kept it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CarriedConversation {
    pub session_id: String,
    /// The transcript it was read from, usually gone.
    pub source_file: String,
    pub state: ArchiveSessionState,
    #[ts(type = "number | null")]
    pub first_at: Option<u64>,
    #[ts(type = "number | null")]
    pub last_at: Option<u64>,
    pub message_count: u32,
    #[ts(type = "number")]
    pub raw_bytes: u64,
    #[ts(type = "number")]
    pub stored_bytes: u64,
    /// ISO 8601.
    pub captured_at: String,
    /// ISO 8601, or null.
    pub evicted_at: Option<String>,
}

/// What one batch of conversations did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CarriedConversationsMerged {
    /// Conversations whose last part arrived and whose row was written.
    pub added: u32,
    /// Parts skipped because the host already holds their conversation.
    pub kept: u32,
    /// Messages written.
    #[ts(type = "number")]
    pub messages: u64,
    /// Conversations the archive's size limit dropped after the batch, the
    /// host's own included.
    pub evicted: u32,
}
