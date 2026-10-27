//! The Files view: `files:*` and `files:changed`. Each needs the `files`
//! capability.
//!
//! Read-only, all of it. Every request names a `root`, which the host checks
//! is a folder it knows before listing or reading anything under it. Changed
//! lines are the working tree against `HEAD`, never attributed to a session.

use std::collections::BTreeMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{ContentDirListing, Millis};

request_channel!(
    ReadFilesDir = "files:dir", FilesDirRequest => ContentDirListing, needs Files
);
request_channel!(
    ReadFilesStatus = "files:status", FilesRoot => FilesStatus, needs Files
);
request_channel!(ReadFile = "files:read", FilesPathRequest => FileView, needs Files);
request_channel!(
    /// Every file in a project, for a quick-open list.
    ListFiles = "files:list", FilesRoot => FileListing, needs Files
);
request_channel!(
    /// The roots this client has on screen, all of them, each time the set
    /// changes. The host lets go of any other this client was watching.
    WatchFiles = "files:watch", FilesWatchRequest => (), needs Files
);
event_channel!(
    /// Files changed under a watched root.
    FilesChanged = "files:changed", event FilesChange, needs Files
);

/// A project the Files view shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct FilesRoot {
    pub root: String,
}

/// One folder under a root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct FilesDirRequest {
    pub root: String,
    /// Relative to the root, forward-slashed; empty for the root itself.
    pub rel_path: String,
}

/// One file under a root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct FilesPathRequest {
    pub root: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct FilesWatchRequest {
    pub roots: Vec<String>,
}

/// What changed under a root.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct FilesChange {
    pub root: String,
    /// Root-relative and forward-slashed, `.git` standing for "the status
    /// moved"; null when there were too many to name.
    pub paths: Option<Vec<String>>,
}

/// How git sees one path, against `HEAD` and the index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitFileState {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

/// Every changed path under a project.
///
/// `files` is null when git could not be asked, which is Unknown and never
/// clean, and empty when it answered with nothing changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct FilesStatus {
    pub root: String,
    /// The repository's top level, or null outside one.
    pub repo: Option<String>,
    /// Root-relative, forward-slashed path to its state.
    pub files: Option<BTreeMap<String, GitFileState>>,
    pub error: Option<String>,
}

/// The lines of a file that differ from the last commit, numbered in the file
/// as it is now. Ranges are inclusive and 1-based.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LineChanges {
    pub changed: Vec<(u32, u32)>,
    /// Lines with something removed directly below them; 0 is above the
    /// first line.
    pub removed_after: Vec<u32>,
    pub changed_count: u32,
    pub removed_count: u32,
}

/// How one file stands against the last commit. "No changes" and "could not
/// look" are different answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileChangeState {
    /// In the last commit; `lines` empty means unchanged since.
    Tracked {
        lines: LineChanges,
    },
    /// Untracked, or staged but never committed: every line is new.
    New,
    Ignored,
    /// Not inside any repository.
    Outside,
    /// Git could not be asked.
    Unknown {
        reason: String,
    },
}

/// How a file ends its lines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub enum LineEnding {
    #[serde(rename = "LF")]
    Lf,
    #[serde(rename = "CRLF")]
    Crlf,
    #[serde(rename = "mixed")]
    Mixed,
}

/// One file, read for the Files view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    pub root: String,
    pub path: String,
    /// Relative to `root`, forward-slashed.
    pub rel_path: String,
    pub exists: bool,
    #[ts(type = "number")]
    pub size: u64,
    pub mtime_ms: Millis,
    pub binary: bool,
    /// Past the view's ceiling: not read.
    pub too_large: bool,
    /// The text, with line feeds only; how the file ends its lines is `eol`.
    pub content: String,
    pub eol: Option<LineEnding>,
    pub changes: FileChangeState,
    /// Set when the file could not be shown at all.
    pub error: Option<String>,
}

/// Where a file list came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum FileListSource {
    /// The repository's own list.
    Git,
    /// A walk, where there is no repository.
    Walk,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct FileListing {
    pub root: String,
    /// Root-relative, forward-slashed.
    pub files: Vec<String>,
    pub source: FileListSource,
    /// The walk stopped at its ceiling.
    pub truncated: bool,
    pub error: Option<String>,
}
