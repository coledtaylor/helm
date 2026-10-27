//! Profiles: saved launch compositions.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::channel::Catalogue;
use crate::channels::common::{PermissionMode, SessionRecord};

pub(super) fn declare(catalogue: &mut Catalogue) {
    catalogue
        .request::<ProfileList>()
        .request::<ProfileSave>()
        .request::<ProfileDelete>()
        .request::<ProfilePin>()
        .request::<ProfileExport>()
        .request::<ProfileImport>()
        .request::<ProfileLaunch>()
        .event::<ProfilesChanged>();
}

request_channel! {
    ProfileList = "profile:list", () => Vec<Profile>
}

request_channel! {
    /// Creates or updates. A draft with problems is answered with them and
    /// nothing is written.
    ProfileSave = "profile:save", SaveProfileRequest => SaveProfileResult
}

request_channel! {
    ProfileDelete = "profile:delete", ProfileRef => ProfileDeleted
}

request_channel! {
    /// Rewrites the pin order from the given ids; anything left out is
    /// unpinned.
    ProfilePin = "profile:pin", PinProfilesRequest => Vec<Profile>
}

request_channel! {
    /// The profile as a document. Where it is saved is the client's: its save
    /// dialog stays in the client.
    ProfileExport = "profile:export", ProfileRef => ProfileDocument
}

request_channel! {
    /// Adds the profile a document describes. The client's open dialog chose
    /// the document.
    ProfileImport = "profile:import", ProfileDocument => ImportProfileResult
}

request_channel! {
    /// Composes the profile's overlays and spawns its session.
    ProfileLaunch = "profile:launch", LaunchProfileRequest => LaunchedProfile
}

event_channel! {
    /// The whole list after any write.
    ProfilesChanged = "profiles:changed", state Vec<Profile>
}

/// How hard the agent thinks, named as the launcher offers it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum EffortLevel {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

/// A saved launch composition. `overlays` are composed into the session so
/// their skills and agents resolve; `access` is which folders the session
/// may touch. The two are not the same thing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    #[ts(type = "number")]
    pub id: u64,
    pub name: String,
    /// The folder the session runs in.
    pub root: String,
    /// Project paths composed into the session as plugins.
    pub overlays: Vec<String>,
    /// Folders the session may also touch.
    pub access: Vec<String>,
    pub model: Option<String>,
    pub effort: Option<EffortLevel>,
    pub permission_mode: Option<PermissionMode>,
    pub agent: Option<String>,
    /// MCP server names.
    pub mcp: Vec<String>,
    /// Submitted as the session's first message.
    pub opening_prompt: Option<String>,
    /// Launcher ordering; null means unpinned.
    pub pinned_order: Option<u32>,
    /// ISO 8601.
    pub created_at: String,
    /// ISO 8601.
    pub updated_at: String,
}

/// A profile before the host has given it an identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDraft {
    pub name: String,
    pub root: String,
    pub overlays: Vec<String>,
    pub access: Vec<String>,
    pub model: Option<String>,
    pub effort: Option<EffortLevel>,
    pub permission_mode: Option<PermissionMode>,
    pub agent: Option<String>,
    pub mcp: Vec<String>,
    pub opening_prompt: Option<String>,
    pub pinned_order: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SaveProfileRequest {
    /// Null to create; an id to update that profile in place.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub id: Option<u64>,
    pub draft: ProfileDraft,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SaveProfileResult {
    pub profile: Option<Profile>,
    /// Field-level problems. Non-empty means nothing was written.
    pub problems: Vec<String>,
}

/// Names one profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRef {
    #[ts(type = "number")]
    pub id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDeleted {
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PinProfilesRequest {
    /// The pinned profiles, in order.
    #[ts(type = "number[]")]
    pub ids: Vec<u64>,
}

/// A profile as a portable document: what `profile:export` returns and
/// `profile:import` takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDocument {
    /// From export, the file name to suggest; on import, the name of the file
    /// it was read from, so an error can name it.
    pub file_name: String,
    /// The profile, as YAML.
    pub yaml: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ImportProfileResult {
    /// The profile added, or null when the document was not one.
    pub profile: Option<Profile>,
    /// Why the document was not a profile, or null.
    #[serde(default)]
    pub error: Option<String>,
    /// The name it was given because its own was taken, or null.
    #[serde(default)]
    pub renamed_to: Option<String>,
}

/// Launching a profile: the profile supplies the folder, the overlays and
/// every flag, so the client sends an id and a grid and nothing else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LaunchProfileRequest {
    #[ts(type = "number")]
    pub profile_id: u64,
    pub cols: u16,
    pub rows: u16,
}

/// What a profile launch composed, for the pane to report before the terminal
/// paints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LaunchedProfile {
    pub session: SessionRecord,
    pub profile: Profile,
    /// Plugin namespaces the session was given.
    pub overlays: Vec<String>,
    /// Whether composed project instructions were passed.
    pub composed_instructions: bool,
    /// Problems that did not stop the launch.
    pub warnings: Vec<String>,
}
