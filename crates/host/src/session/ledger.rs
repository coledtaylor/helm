//! Where a session's row is written: on spawn, and again when it ends.
//!
//! The rows are today's `sessions` table (`packages/core/src/store/schema.ts`):
//! a row is `running` from the spawn, naming the agent backend it runs on,
//! and `exited` with its code, end time and duration once the program ends.
//! The end is written only over a row still running, so an exit reported
//! twice keeps the first code, as `finishSession` does today.

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
}

/// The record of sessions: a row on spawn, its end when the program ends.
pub trait SessionLedger: Send + Sync {
    /// Writes the row of a session that has just been spawned.
    fn started(&self, row: &NewSessionRow) -> Result<SessionId>;

    /// Records that session `id` ended with `exit`. A row that is no longer
    /// running is left as it is.
    fn finished(&self, id: SessionId, exit: &SessionExit) -> Result<()>;
}

/// The SQL for "now" in the store's timestamp format, as today's app writes.
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

impl SessionLedger for Mutex<Store> {
    fn started(&self, row: &NewSessionRow) -> Result<SessionId> {
        let argv = serde_json::to_string(&row.argv)
            .map_err(|err| Error::io("record the session's arguments", io::Error::other(err)))?;
        let store = self.lock().unwrap_or_else(PoisonError::into_inner);
        let id = store
            .connection()
            .query_row(
                "INSERT INTO sessions (name, cwd, argv, claude_session_id, backend, \
                 project_path, profile_id, permission_mode, status) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'running') RETURNING id",
                params![
                    row.name,
                    row.cwd.to_string_lossy(),
                    argv,
                    row.conversation_id,
                    row.backend.as_str(),
                    row.origin.project_path,
                    row.origin.profile_id,
                    row.origin.permission_mode
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
