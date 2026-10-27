//! Payload types more than one domain uses.
//!
//! Each mirrors its type in `packages/core/src/types.ts`; where that type is
//! Claude-specific, the mirror is backend-neutral and says which backend it is
//! about.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::backend::BackendId;
use crate::channel::Catalogue;

pub fn declare(catalogue: &mut Catalogue) {
    catalogue
        .payload::<SessionRecord>()
        .payload::<PermissionMode>();
}

/// How a hosted session ended, or that it has not.
///
/// `lost` is a row that was still `running` when the process that owned it
/// went away: a crash, a kill, a power cut. Stamping an end time later would
/// invent a duration nobody measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Running,
    Exited,
    Lost,
}

/// One hosted agent process, from spawn to exit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    #[ts(type = "number")]
    pub id: u64,
    /// The name handed to the agent, so the session can be found in its own
    /// resume list later. Never rewritten; a rename writes `label`.
    pub name: String,
    /// What Floti calls it on screen, or null for "use `name`".
    pub label: Option<String>,
    pub cwd: String,
    /// The branch `cwd` was on when this was spawned. Null for a folder that
    /// is not a repository, a detached HEAD, or a read that failed.
    pub branch: Option<String>,
    /// The discovered project it was launched against, if it was one.
    pub project_path: Option<String>,
    /// The profile it was launched from, if it was one. The session outlives
    /// a deleted profile.
    #[ts(type = "number | null")]
    pub profile_id: Option<u64>,
    /// Arguments after the executable, as spawned.
    pub argv: Vec<String>,
    /// The agent's own id for the conversation this session is having, or
    /// null. Assigned at launch where the backend lets Floti pick it (Claude
    /// Code's `--session-id`); a resumed session carries the id it resumed.
    pub conversation_id: Option<String>,
    /// The agent backend running it. Claude Code is `claude-code`.
    pub backend: BackendId,
    pub status: SessionStatus,
    /// ISO 8601.
    pub started_at: String,
    /// ISO 8601, or null while running and for a lost session.
    pub ended_at: Option<String>,
    #[ts(type = "number | null")]
    pub duration_ms: Option<u64>,
    /// Null while running, and for a session whose exit code was never
    /// observed.
    pub exit_code: Option<i32>,
}

/// How a session asks before it acts. The values are the ones the launcher
/// offers; each backend maps them to its own flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    AcceptEdits,
    Auto,
    BypassPermissions,
    Manual,
    DontAsk,
    Plan,
}
