//! Usage: how close each backend is to its plan limits, and an estimate of
//! spend. One reading per backend that declares usage; every reading names
//! the backend it measures. A backend with no reading shows Unknown.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::backend::BackendId;
use crate::channel::Catalogue;

pub(super) fn declare(catalogue: &mut Catalogue) {
    catalogue.request::<ReadUsage>().event::<UsageChanged>();
}

request_channel! {
    /// The latest reading of each backend that declares usage. Shipped raw:
    /// what may be painted from a reading is decided by the client, because a
    /// reading goes stale and a window rolls over without anything changing.
    ReadUsage = "usage:read", () => Vec<UsageSnapshot>
}

event_channel! {
    /// A backend's usage figures were refreshed.
    UsageChanged = "usage:changed", state Vec<UsageSnapshot>
}

/// The two windows a limit is measured over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum UsageGroup {
    Session,
    Weekly,
}

/// The provider's own judgement of how close a limit is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum UsageSeverity {
    Normal,
    Warning,
    Critical,
}

/// One plan limit, after every field has been checked.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageLimit {
    /// The provider's name for it, such as `session` or `weekly_all`.
    pub kind: String,
    pub group: UsageGroup,
    /// 0 to 100 as the provider reported it. Not rounded, not derived.
    pub percent: f64,
    pub severity: UsageSeverity,
    /// Epoch ms, or null when the provider sent no reset time.
    #[ts(type = "number | null")]
    pub resets_at_ms: Option<u64>,
    /// The model a scoped limit applies to, or null.
    pub scope: Option<String>,
    /// Whether this is the limit currently binding.
    pub is_active: bool,
}

/// Why there is no number to show. Every one of these paints nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
pub enum UsageProblemKind {
    /// The file the reading comes from is not there.
    NoFile,
    /// It is there and could not be read.
    Unreadable,
    /// It is there and is not JSON.
    NotJson,
    /// It holds no reading.
    MissingKey,
    /// The reading does not have the shape the host was written against.
    Unrecognised,
    /// The reading is too old to stand behind.
    Stale,
    /// Every window in it has already reset.
    RolledOver,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageProblem {
    pub kind: UsageProblemKind,
    /// One sentence.
    pub detail: String,
}

/// One backend's usage reading.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    /// The backend this measures, such as `claude-code`.
    pub backend: BackendId,
    /// The file it came from, so the number is traceable.
    pub file: String,
    /// When the agent last had these figures from its provider, epoch ms.
    #[ts(type = "number | null")]
    pub fetched_at_ms: Option<u64>,
    pub limits: Vec<UsageLimit>,
    /// Set exactly when `limits` is empty and something was wrong.
    pub problem: Option<UsageProblem>,
    /// The estimated-dollars half, or null where it has not been built.
    pub spend: Option<UsageSpend>,
}

/// The four token classes, priced separately.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokens {
    #[ts(type = "number")]
    pub input: u64,
    #[ts(type = "number")]
    pub output: u64,
    #[ts(type = "number")]
    pub cache_write: u64,
    #[ts(type = "number")]
    pub cache_read: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindowCost {
    pub tokens: UsageTokens,
    /// US dollars, estimated from the price table.
    pub dollars: f64,
    /// Assistant messages the figure is a sum over.
    pub messages: u32,
}

/// Estimated spend, always an estimate and labelled as one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageSpend {
    /// The session window, aligned with the session limit's reset.
    pub session: UsageWindowCost,
    /// Local midnight to now.
    pub today: UsageWindowCost,
    /// A rolling 7 days.
    pub week: UsageWindowCost,
    /// Version of the price table, such as `2026-08-10`.
    pub priced_at: String,
    /// Models seen with no entry in the price table.
    pub unpriced_models: Vec<String>,
    /// How long the last incremental pass took, in ms.
    pub index_ms: f64,
}
