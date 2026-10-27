//! History, the index of an agent's past conversations, and the archive, the
//! conversations the host kept after the agent deleted them. Both are
//! read-only to clients, except that a history session can be named by hand.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::backend::BackendId;
use crate::channel::Catalogue;
use crate::channels::common::SessionRecord;

pub(super) fn declare(catalogue: &mut Catalogue) {
    catalogue
        .request::<ReadHistorySummary>()
        .request::<HistorySessions>()
        .request::<HistoryPrompts>()
        .request::<HistoryProjects>()
        .request::<HistoryRefresh>()
        .request::<HistoryRename>()
        .request::<HistoryResume>()
        .event::<HistoryChanged>()
        .request::<ArchiveConversation>()
        .request::<ReadArchiveStats>()
        .event::<ArchiveChanged>();
}

request_channel! {
    /// What the history index holds now.
    ReadHistorySummary = "history:summary", () => HistorySummary
}

request_channel! {
    HistorySessions = "history:sessions", HistoryQuery => HistoryPage
}

request_channel! {
    /// Every prompt of one conversation, in the order it was submitted.
    HistoryPrompts = "history:prompts", HistorySessionRef => Vec<HistoryPrompt>
}

request_channel! {
    HistoryProjects = "history:projects", () => Vec<HistoryProject>
}

request_channel! {
    /// Forces an index pass now.
    HistoryRefresh = "history:refresh", () => HistorySummary
}

request_channel! {
    /// Names one conversation by hand, or clears its name. Null for a
    /// conversation the index does not have.
    HistoryRename = "history:rename", RenameHistorySessionRequest => Option<HistorySession>
}

request_channel! {
    /// Reopens a conversation in the folder history recorded for it. Fails
    /// with a sentence when its transcript or folder has gone.
    HistoryResume = "history:resume", ResumeSessionRequest => ResumedSession
}

event_channel! {
    /// The history index moved.
    HistoryChanged = "history:changed", state HistorySummary
}

request_channel! {
    /// One archived conversation, or null when the archive never held it.
    ArchiveConversation = "archive:conversation", HistorySessionRef => Option<ArchivedConversation>
}

request_channel! {
    /// What the archive holds, against its ceiling.
    ReadArchiveStats = "archive:stats", () => ArchiveStats
}

event_channel! {
    /// The archive moved: a conversation was captured, or the ceiling dropped
    /// one.
    ArchiveChanged = "archive:changed", state ArchiveStats
}

/// Names one conversation by the id its agent gave it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistorySessionRef {
    pub session_id: String,
}

/// One prompt a person submitted, as the agent recorded it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPrompt {
    pub session_id: String,
    /// Submission order across the whole record. Monotonic, not dense.
    #[ts(type = "number")]
    pub seq: u64,
    /// The prompt as typed.
    pub text: String,
    /// Epoch ms.
    #[ts(type = "number")]
    pub at: u64,
}

/// What the archive holds for a conversation. "Never captured" is the
/// absence of a value, and is not the same fact as `evicted`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveSessionState {
    Archived,
    Evicted,
}

/// A conversation the history index knows about, and whether it can still be
/// resumed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistorySession {
    pub session_id: String,
    /// The backend that recorded it, and that a resume runs.
    pub backend: BackendId,
    /// The folder it ran in, exactly as recorded.
    pub project: String,
    /// Last path segment of `project`.
    pub project_name: String,
    pub prompt_count: u32,
    #[ts(type = "number")]
    pub first_at: u64,
    #[ts(type = "number")]
    pub last_at: u64,
    /// The opening prompt, verbatim.
    pub first_prompt: String,
    /// What to call it, derived from its prompts. Never empty.
    pub title: String,
    /// True when `title` is the host's stand-in for a record with no usable
    /// prompt.
    pub title_fallback: bool,
    /// The name given by hand, or null.
    pub label: Option<String>,
    /// The transcript on disk, or null once it has been reaped.
    pub transcript_file: Option<String>,
    #[ts(type = "number | null")]
    pub transcript_bytes: Option<u64>,
    /// False when the recorded folder is no longer there.
    pub project_exists: bool,
    /// What the archive holds for it, or null when it never held anything.
    pub archive: Option<ArchiveSessionState>,
    /// Messages in the archive for it. Zero once the ceiling dropped them.
    pub archived_messages: Option<u32>,
    /// The first prompt that matched the search, when the query had one.
    /// Null for an unfiltered listing.
    #[serde(default, rename = "match")]
    pub matched: Option<String>,
}

/// One recorded folder, with how much history it holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryProject {
    pub project: String,
    pub name: String,
    pub sessions: u32,
    pub prompts: u32,
    #[ts(type = "number")]
    pub last_at: u64,
    pub resumable: u32,
    pub exists: bool,
}

/// What the history index holds now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistorySummary {
    pub sessions: u32,
    pub prompts: u32,
    pub projects: u32,
    /// Conversations that could be resumed right now.
    pub resumable: u32,
    /// Newest prompt in the index, epoch ms, or null when it is empty.
    #[ts(type = "number | null")]
    pub latest_at: Option<u64>,
    /// The record being indexed, so a client can say where this came from.
    pub history_file: String,
    /// Bytes of it consumed so far.
    #[ts(type = "number")]
    pub indexed_bytes: u64,
    /// Set when the record could not be read at all.
    #[serde(default)]
    pub error: Option<String>,
}

/// What a search is over: prompts typed, or every archived message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum HistorySearchScope {
    Prompts,
    Messages,
}

/// Every field may be left out.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryQuery {
    /// Case-insensitive substring. Null or empty means no filter.
    #[serde(default)]
    pub search: Option<String>,
    /// What `search` is matched against. Null means `prompts`.
    #[serde(default)]
    pub scope: Option<HistorySearchScope>,
    /// One recorded folder, compared case-insensitively.
    #[serde(default)]
    pub project: Option<String>,
    /// Drop conversations that could not be resumed.
    #[serde(default)]
    pub resumable_only: Option<bool>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPage {
    /// Most recently active first.
    pub sessions: Vec<HistorySession>,
    /// Conversations the query matched, before `limit`.
    pub total: u32,
    /// How long the query took, in ms.
    pub took_ms: f64,
}

/// Naming a conversation in history. Null, or only whitespace, restores the
/// title derived from its prompts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RenameHistorySessionRequest {
    pub session_id: String,
    pub name: Option<String>,
}

/// Reopening a conversation: an id and a grid. The folder and the command are
/// decided by the host from its own index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResumeSessionRequest {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ResumedSession {
    pub session: SessionRecord,
    /// The history row it came from.
    pub history: HistorySession,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveRole {
    User,
    Assistant,
}

/// One message of an archived conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveMessage {
    pub uuid: String,
    pub role: ArchiveRole,
    /// Epoch ms.
    #[ts(type = "number")]
    pub at: u64,
    pub text: String,
}

/// One archived conversation. `messages` is empty for an evicted one, and the
/// row is still returned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedConversation {
    pub session_id: String,
    /// The transcript it was read from. Usually gone by the time this is read.
    pub source_file: String,
    pub state: ArchiveSessionState,
    #[ts(type = "number | null")]
    pub first_at: Option<u64>,
    #[ts(type = "number | null")]
    pub last_at: Option<u64>,
    pub message_count: u32,
    /// Message text as read, before compression.
    #[ts(type = "number")]
    pub raw_bytes: u64,
    /// What it costs in the database now. Zero once evicted.
    #[ts(type = "number")]
    pub stored_bytes: u64,
    /// ISO 8601.
    pub captured_at: String,
    /// ISO 8601, or null.
    pub evicted_at: Option<String>,
    pub messages: Vec<ArchiveMessage>,
}

/// What the archive holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveStats {
    pub sessions: u32,
    /// Conversations the ceiling dropped.
    pub evicted_sessions: u32,
    #[ts(type = "number")]
    pub messages: u64,
    #[ts(type = "number")]
    pub raw_bytes: u64,
    /// Compressed message bodies: what the ceiling is enforced against.
    #[ts(type = "number")]
    pub stored_bytes: u64,
    /// The ceiling in force.
    #[ts(type = "number")]
    pub max_bytes: u64,
    /// Last-message time of the oldest and newest archived conversation.
    #[ts(type = "number | null")]
    pub oldest_at: Option<u64>,
    #[ts(type = "number | null")]
    pub newest_at: Option<u64>,
}
