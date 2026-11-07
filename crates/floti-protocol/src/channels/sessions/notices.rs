//! Standing notices: what the host keeps for a person who is not looking.
//!
//! A notice stands on the host while it holds. A child that needs a person
//! stands until it no longer does; a start the host refused, and a child that
//! ended in error, stand until a client dismisses them or the parent ends.
//! Every client that connects is sent the whole list on `notices:changed`, so
//! the same notices are listed on whichever device the user is at.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::channel::Catalogue;

pub(super) fn declare(catalogue: &mut Catalogue) {
    catalogue
        .request::<DismissNotice>()
        .request::<AllowMoreStarts>()
        .event::<NoticesChanged>();
}

request_channel! {
    /// Dismisses a limit or error notice, for every client. A notice already
    /// gone, and a needs-you notice, which goes by itself when the child stops
    /// waiting, are left as they are.
    DismissNotice = "notices:dismiss", DismissNoticeRequest => ()
}

request_channel! {
    /// Lets one parent start more children after its starts limit refused it:
    /// as many more as the starts setting says, for that parent alone. Its
    /// starts notice goes.
    AllowMoreStarts = "notices:allowMore", AllowMoreStartsRequest => AllowMoreStartsResult
}

event_channel! {
    /// The notices standing on the host, the whole list on every change.
    NoticesChanged = "notices:changed", state Vec<StandingNotice>
}

/// What a notice is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
pub enum NoticeKind {
    /// A child is waiting on a person.
    NeedsYou,
    /// A parent's start was refused by a limit.
    Limit,
    /// A child ended in error, or its launch failed.
    Error,
}

/// The limit that refused a start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum NoticeLimit {
    /// Children running at once under one parent.
    Children,
    /// Agent-started sessions running at once on the host.
    Sessions,
    /// How deep a chain of parents may go.
    Depth,
    /// Starts one parent may make in all.
    Starts,
    /// Heavy children running at once on the host.
    Heavy,
}

/// One notice standing on a host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct StandingNotice {
    /// Names this notice for `notices:dismiss`; the host makes it, and it
    /// stays the same while the notice stands.
    pub id: String,
    pub kind: NoticeKind,
    /// The session the notice is under: the child's parent, or for a start
    /// refused the parent that asked.
    #[ts(type = "number")]
    pub parent_id: u64,
    /// What the parent is called on screen.
    pub parent_name: String,
    /// The child a needs-you or error notice is about, or none for a refused
    /// start.
    #[serde(default)]
    #[ts(type = "number | null", optional = nullable)]
    pub child_id: Option<u64>,
    /// What the parent calls the child, or none.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub child_name: Option<String>,
    /// For needs you, what the child waits on (a permission prompt, a
    /// question, a sign-in); for a limit or an error, its sentence.
    pub text: String,
    /// ISO 8601: when the notice began.
    pub since: String,
    /// Which limit refused a start. Only a limit notice has one.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub limit: Option<NoticeLimit>,
    /// For a starts limit, how many more starts Allow adds for this parent:
    /// the starts setting's value.
    #[serde(default)]
    #[ts(type = "number | null", optional = nullable)]
    pub allow_more: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct DismissNoticeRequest {
    /// The notice's `id`.
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AllowMoreStartsRequest {
    /// The parent session's row id.
    #[ts(type = "number")]
    pub parent_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AllowMoreStartsResult {
    /// How many more starts the parent may make now.
    #[ts(type = "number")]
    pub added: u32,
}
