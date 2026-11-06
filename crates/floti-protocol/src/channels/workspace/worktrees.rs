//! The git worktrees Floti makes for agents: `worktrees:list` and
//! `worktrees:remove`.
//!
//! A child started with a worktree runs in `<repo>/.floti/worktrees/<name>`
//! on the branch `agent/<name>`, and the worktree stays when the child ends,
//! because its branch holds the work. A project's page lists them and removes
//! one on request. Every request names a `project` the host knows, and a
//! project it does not is refused with a sentence before git is asked
//! anything.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

request_channel!(
    /// The agent worktrees of the repository `project` is in: each folder
    /// under `.floti/worktrees`, and no other worktree of the repository.
    ListAgentWorktrees = "worktrees:list", WorktreesProject => AgentWorktrees
);
request_channel!(
    /// Removes one agent worktree with git, keeping its `agent/<name>` branch
    /// and the work on it. A worktree a running session works in, or one with
    /// uncommitted changes, is refused and left as it is.
    RemoveAgentWorktree = "worktrees:remove", RemoveWorktreeRequest => WorktreeRemoval
);

/// A project whose agent worktrees are asked for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreesProject {
    /// The project's folder, as the host knows it.
    pub project: String,
}

/// One agent worktree to remove.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemoveWorktreeRequest {
    pub project: String,
    /// The worktree's folder, as `worktrees:list` gave it.
    pub folder: String,
}

/// A project's agent worktrees, by name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorktrees {
    pub worktrees: Vec<AgentWorktree>,
}

/// One checkout under `.floti/worktrees`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentWorktree {
    /// The folder's name, which is also the branch's after `agent/`.
    pub name: String,
    /// The checkout's root.
    pub folder: String,
    /// The branch checked out there; null for a detached checkout.
    pub branch: Option<String>,
    /// The session that last worked there, a running one first; null when
    /// none ever did.
    pub child: Option<WorktreeChild>,
    /// Whether git sees a modified or untracked file there. Null when git
    /// could not be asked, which is not the same as nothing changed.
    pub uncommitted: Option<bool>,
}

/// The session that worked in a worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeChild {
    /// The child's name; a session a person started has its own name.
    pub name: String,
    /// The name of the session that started it; null for a session a person
    /// started, or when that session's record is gone.
    pub parent: Option<String>,
    /// Whether it is running now.
    pub running: bool,
}

/// What removing a worktree came to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoval {
    pub removed: bool,
    /// Why it was not removed, as a sentence; null when it was.
    pub refusal: Option<String>,
}
