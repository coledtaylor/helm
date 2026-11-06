//! Where a session's row is written: on spawn, and again when it ends.
//!
//! The rows have the shape of helm.db's `sessions` table
//! (`packages/core/src/store/schema.ts`): a row is `running` from the spawn,
//! naming the agent backend it runs on, and `exited` with its code, end time
//! and duration once the program ends. The end is written only over a row
//! still running, so an exit reported twice keeps the first code.

use std::io;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use floti_protocol::BackendId;
use rusqlite::{OptionalExtension, params};

use super::SessionExit;
use crate::store::Store;
use crate::{Error, Result};

/// A session's id: its row in the store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SessionId(pub i64);

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// What the row of a new session records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewSessionRow {
    /// The name the session was started with.
    pub name: String,
    /// The folder it runs in.
    pub cwd: PathBuf,
    /// Its program's arguments.
    pub argv: Vec<String>,
    /// The agent's own id for the conversation, when the launch chose one.
    pub conversation_id: Option<String>,
    /// The agent backend it runs on, which a restore reopens it through.
    pub backend: BackendId,
    /// Where the launch came from.
    pub origin: SessionOrigin,
}

/// What a launch came from, recorded in its row and nowhere else.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionOrigin {
    /// The discovered project it is, when it is one.
    pub project_path: Option<String>,
    /// The saved profile it was launched from.
    pub profile_id: Option<i64>,
    /// The permission mode it was launched with, as the agent spells it, so
    /// a restore reopens it in the mode it had.
    pub permission_mode: Option<String>,
    /// The branch its folder had checked out when it was launched, read
    /// before the spawn: what a session's detail calls the branch at spawn.
    pub branch: Option<String>,
    /// The session that started it with an agent tool, when one did.
    pub parent: Option<ParentLink>,
}

/// What a child's row keeps of the session that started it, so the link
/// outlives both processes: a host restart restores it with the sessions, and
/// a child that outlived its parent is found again by the parent's
/// conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParentLink {
    /// The parent's row.
    pub session: SessionId,
    /// The conversation the parent was in when it started this child.
    pub conversation_id: Option<String>,
    /// What the parent calls this child, unique among its children.
    pub name: String,
    /// The role it was started in.
    pub role: Option<String>,
    /// Whether it keeps running when its parent ends.
    pub outlive: bool,
    /// Whether it may start children of its own.
    pub can_start: bool,
    /// Whether its role is heavy, which a host runs one of at a time.
    pub heavy: bool,
    /// Whether its role asks for a worktree of its own.
    pub worktree: bool,
}

/// The record of sessions: a row on spawn, its end when the program ends.
pub trait SessionLedger: Send + Sync {
    /// Writes the row of a session that has just been spawned.
    fn started(&self, row: &NewSessionRow) -> Result<SessionId>;

    /// Records that session `id` ended with `exit`. A row that is no longer
    /// running is left as it is. The host no longer lists the session by
    /// then.
    fn finished(&self, id: SessionId, exit: &SessionExit) -> Result<()>;

    /// Records that session `id` was lost: the session keeper holding it went
    /// away, and how it ended is not known. Where nothing tells the two
    /// apart, it ended with code 1.
    fn lost(&self, id: SessionId) -> Result<()> {
        self.finished(
            id,
            &SessionExit {
                code: 1,
                signal: None,
            },
        )
    }
}

/// The SQL for "now" in the store's timestamp format, as today's app writes.
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

impl SessionLedger for Mutex<Store> {
    fn started(&self, row: &NewSessionRow) -> Result<SessionId> {
        let argv = serde_json::to_string(&row.argv)
            .map_err(|err| Error::io("record the session's arguments", io::Error::other(err)))?;
        let store = self.lock().unwrap_or_else(PoisonError::into_inner);
        let parent = row.origin.parent.as_ref();
        let id = store
            .connection()
            .query_row(
                "INSERT INTO sessions (name, cwd, argv, claude_session_id, backend, \
                 project_path, profile_id, permission_mode, branch, parent_session_id, \
                 parent_conversation_id, child_name, role, outlive, can_start, child_class, \
                 child_worktree, status) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, \
                 ?16, ?17, 'running') RETURNING id",
                params![
                    row.name,
                    row.cwd.to_string_lossy(),
                    argv,
                    row.conversation_id,
                    row.backend.as_str(),
                    row.origin.project_path,
                    row.origin.profile_id,
                    row.origin.permission_mode,
                    row.origin.branch,
                    parent.map(|link| link.session.0),
                    parent.and_then(|link| link.conversation_id.as_deref()),
                    parent.map(|link| link.name.as_str()),
                    parent.and_then(|link| link.role.as_deref()),
                    parent.is_some_and(|link| link.outlive),
                    parent.is_some_and(|link| link.can_start),
                    parent.map(|link| if link.heavy { "heavy" } else { "light" }),
                    parent.is_some_and(|link| link.worktree),
                ],
                |found| found.get(0),
            )
            .map_err(sql("record the session's start"))?;
        Ok(SessionId(id))
    }

    fn finished(&self, id: SessionId, exit: &SessionExit) -> Result<()> {
        let store = self.lock().unwrap_or_else(PoisonError::into_inner);
        store
            .connection()
            .query_row(
                &format!(
                    "UPDATE sessions SET status = 'exited', exit_code = ?2, ended_at = {NOW}, \
                     duration_ms = CAST((julianday({NOW}) - julianday(started_at)) * 86400000 AS INTEGER) \
                     WHERE id = ?1 AND status = 'running' RETURNING id"
                ),
                params![id.0, i64::from(exit.code)],
                |found| found.get::<_, i64>(0),
            )
            .optional()
            .map_err(sql("record the session's end"))?;
        Ok(())
    }
}

fn sql(action: &'static str) -> impl FnOnce(rusqlite::Error) -> Error {
    move |err| Error::io(action, io::Error::other(err))
}
