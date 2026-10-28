//! Project discovery, scan roots and harnesses: `discovery:*`, `scan:status`,
//! `git:updated`, `roots:*` and `harness:create`.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::Millis;

request_channel!(
    /// Rows from the last scan, for painting before a fresh one finishes.
    ReadCachedDiscovery = "discovery:cached", () => Vec<CachedProject>
);
request_channel!(ScanForProjects = "discovery:scan", ScanRequest => DiscoveryResult);
event_channel!(
    /// The result of every scan. The snapshot is null until one has
    /// finished.
    DiscoveryUpdated = "discovery:updated",
    state DiscoveryResult,
    snapshot Option<DiscoveryResult>
);
event_channel!(ScanStatusChanged = "scan:status", state ScanStatus);
event_channel!(
    /// Git state only, by project path; null where git could not answer.
    GitUpdated = "git:updated", state BTreeMap<String, Option<GitState>>
);
request_channel!(
    /// The client's window came back to the front: git state is read again
    /// for the projects the last scan found (the cached ones before any
    /// scan), sent on `git:updated` and answered. One asked while a refresh
    /// runs waits for that one and answers what it read. Not in ipc.ts,
    /// where the desktop's main process saw its own window's focus.
    RefreshGit = "git:refresh", () => BTreeMap<String, Option<GitState>>
);
request_channel!(
    /// Best guesses for a first-run scan root; may be empty.
    SuggestRoots = "roots:suggest", () => Vec<String>
);
request_channel!(
    /// Adds a scan root: a suggestion accepted, a harness created, or the
    /// folder the client's picker chose. Answers the roots after.
    AcceptRoot = "roots:accept", RootPath => Vec<String>
);
request_channel!(RemoveRoot = "roots:remove", RootPath => Vec<String>);
request_channel!(
    /// Scaffolds a harness, or turns a folder that holds repositories into
    /// one. The new harness becomes a scan root in the same call.
    CreateHarness = "harness:create", CreateHarnessRequest => CreateHarnessOutcome
);

/// What a discovered folder turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ProjectKind {
    /// Has a `harness.yaml`. Its `repos/*` children are projects too.
    Harness,
    /// A repository inside a harness's `repos/`.
    Repo,
    /// Neither, scanned because a root pointed at it.
    Folder,
}

/// What a project's `.claude/` folder holds, counted the way Claude Code
/// resolves it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeInventory {
    pub skills: u32,
    pub commands: u32,
    pub agents: u32,
    pub hooks: bool,
    pub settings: bool,
    pub claude_md: bool,
    pub mcp: bool,
}

/// A working tree's summary, for a project's chips.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct GitState {
    pub branch: Option<String>,
    /// Detached HEAD, mid-rebase, or otherwise not on a named branch.
    pub detached: bool,
    /// Files with any staged, unstaged or untracked change.
    pub dirty: u32,
    pub ahead: u32,
    pub behind: u32,
    /// Set when the folder is a repository but git could not answer.
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// Absolute and normalised; a project's identity across scans.
    pub path: String,
    pub name: String,
    pub kind: ProjectKind,
    /// The harness this project belongs to, if any.
    pub harness_path: Option<String>,
    pub has_claude_dir: bool,
    pub inventory: ClaudeInventory,
    pub git: Option<GitState>,
}

/// A project as the last scan left it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CachedProject {
    pub path: String,
    pub name: String,
    pub kind: ProjectKind,
    pub harness_path: Option<String>,
    pub has_claude_dir: bool,
    pub inventory: ClaudeInventory,
    pub git: Option<GitState>,
    /// ISO 8601.
    pub last_seen_at: String,
    /// The harness manifest's `template:`, for a harness row; null otherwise.
    pub template: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct Harness {
    pub path: String,
    pub name: String,
    /// From `harness.yaml` when present.
    pub template: Option<String>,
    pub version: Option<String>,
    /// The projects found under `repos/`.
    pub repo_paths: Vec<String>,
}

/// A root that could not be read, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryError {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryResult {
    /// The roots that were scanned.
    pub roots: Vec<String>,
    pub harnesses: Vec<Harness>,
    pub projects: Vec<Project>,
    pub errors: Vec<DiscoveryError>,
    /// ISO 8601.
    pub scanned_at: String,
    pub duration_ms: Millis,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    /// Read git state during the scan. A first paint skips it and refreshes
    /// after.
    #[serde(default)]
    pub include_git: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScanStatus {
    pub running: bool,
    /// Set when the last scan failed outright rather than returning errors.
    #[serde(default)]
    pub error: Option<String>,
}

/// A scan root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RootPath {
    pub path: String,
}

/// A new harness, or a folder of repositories turned into one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum HarnessMode {
    New,
    Convert,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateHarnessRequest {
    pub mode: HarnessMode,
    pub dir: String,
    #[serde(default)]
    pub name: Option<String>,
    /// For `new` only: `minimal` or absent writes the built-in scaffold, and
    /// anything else names a template.
    #[serde(default)]
    pub template: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateHarnessOutcome {
    /// The harness folder, or null when nothing was written.
    pub path: Option<String>,
    /// Paths written, relative to `path`.
    pub created: Vec<String>,
    /// What went wrong, as sentences. With `path` set, a template applied in
    /// part: `created` is what landed, and no rollback is claimed.
    pub problems: Vec<String>,
    /// The scan roots after the new harness was added to them.
    pub roots: Vec<String>,
}
