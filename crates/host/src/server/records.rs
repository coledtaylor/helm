//! The host's reads and writes of session rows beyond the spawn and exit the
//! session module records: reconciling what a crash or an update left
//! running, recording a deliberate stop, and reading rows back as the
//! protocol's [`SessionRecord`].
//!
//! All of it is today's `sessions` table, whose `backend` column names the
//! agent backend each session ran on ([`recorded_backend`]).

use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use floti_protocol::BackendId;
use floti_protocol::channels::common::{PermissionMode, SessionRecord, SessionStatus};
use floti_protocol::channels::sessions::{HistorySession, Profile};
use rusqlite::{OptionalExtension, Row, params};
use tokio::sync::broadcast;

use crate::agent::claude_code::session_title_from;
use crate::session::{NewSessionRow, SessionExit, SessionId, SessionLedger};
use crate::store::Store;
use crate::{Error, Result};

/// "Now" in the store's timestamp format, as today's app writes it.
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/// The columns [`read_record`] reads, in its order.
const RECORD_COLUMNS: &str = "id, name, label, cwd, branch, project_path, profile_id, argv, \
     claude_session_id, status, started_at, ended_at, duration_ms, exit_code, backend";

/// The backend a row ran on, from its `backend` column.
///
/// A row with none was written by today's app or before the column existed.
/// Today's app runs only Claude Code, and before the column only Claude Code
/// recorded a conversation id (a shell session has none to reopen), so such a
/// row is Claude Code's. That keeps a conversation started before the column
/// restorable through `claude --resume`, as it was in today's app.
fn recorded_backend(column: Option<String>) -> BackendId {
    column
        .filter(|id| !id.trim().is_empty())
        .map_or_else(BackendId::claude_code, BackendId::new)
}

/// A session that ended, numbered for the clients listening on
/// `session:exit`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ExitNotice {
    pub seq: u64,
    pub session: SessionId,
}

/// The ledger the host's sessions write to: the store, plus a notice to the
/// connections when a session ends.
///
/// Once the host is stopping its sessions' rows are settled, so it is
/// frozen: an exit that follows writes nothing. A plain stop has already
/// recorded every row as exited; a stop for an update leaves them running
/// for the next start to find lost.
pub(crate) struct HostLedger {
    store: Arc<Mutex<Store>>,
    frozen: AtomicBool,
    next_seq: AtomicU64,
    exits: broadcast::Sender<ExitNotice>,
}

impl HostLedger {
    pub fn new(store: Arc<Mutex<Store>>) -> Self {
        let (exits, _) = broadcast::channel(256);
        Self {
            store,
            frozen: AtomicBool::new(false),
            next_seq: AtomicU64::new(1),
            exits,
        }
    }

    pub fn store(&self) -> MutexGuard<'_, Store> {
        self.store.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The store itself, for a feature that keeps its own rows in it.
    pub fn shared_store(&self) -> Arc<Mutex<Store>> {
        Arc::clone(&self.store)
    }

    /// Exits from now on, for one connection.
    pub fn exits(&self) -> broadcast::Receiver<ExitNotice> {
        self.exits.subscribe()
    }

    /// Records nothing more: the rows are settled for this stop.
    pub fn freeze(&self) {
        self.frozen.store(true, Ordering::SeqCst);
    }
}

impl SessionLedger for HostLedger {
    fn started(&self, row: &NewSessionRow) -> Result<SessionId> {
        if self.frozen.load(Ordering::SeqCst) {
            return Err(Error::Refused(
                "The Floti host is stopping, so it starts no more sessions.".to_owned(),
            ));
        }
        self.store.as_ref().started(row)
    }

    fn finished(&self, id: SessionId, exit: &SessionExit) -> Result<()> {
        let written = if self.frozen.load(Ordering::SeqCst) {
            Ok(())
        } else {
            self.store.as_ref().finished(id, exit)
        };
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst);
        // Nobody listening is not a failure.
        let _ = self.exits.send(ExitNotice { seq, session: id });
        written
    }
}

/// A row a crash or an update left running, now `lost`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LostRow {
    pub id: SessionId,
    /// What its tab said: the label, or the name when it has none.
    pub name: String,
    pub cwd: String,
    pub branch: Option<String>,
    pub profile_id: Option<i64>,
    pub project_path: Option<String>,
    /// The conversation it was last in: the one it moved to after a clear,
    /// or the one it started in.
    pub conversation_id: Option<String>,
    /// The permission mode it was launched with, which it reopens in.
    pub permission_mode: Option<PermissionMode>,
    /// The backend it ran on, which reopens it ([`recorded_backend`]).
    pub backend: BackendId,
}

/// Records every row still `running` as `lost`, as the start after a crash
/// or an update does, and returns them oldest first. Stamping an end time
/// would invent a duration nobody measured, so none is written.
pub(crate) fn reconcile_running(store: &Store) -> Result<Vec<LostRow>> {
    let mut statement = store
        .connection()
        .prepare(
            "UPDATE sessions SET status = 'lost' WHERE status = 'running' \
             RETURNING id, name, label, cwd, branch, profile_id, \
             coalesce(last_claude_session_id, claude_session_id), backend, project_path, \
             permission_mode",
        )
        .map_err(sql("reconcile the sessions the last run left running"))?;
    let mut lost = statement
        .query_map([], |row| {
            let name: String = row.get(1)?;
            let label: Option<String> = row.get(2)?;
            Ok(LostRow {
                id: SessionId(row.get(0)?),
                name: label
                    .filter(|label| !label.trim().is_empty())
                    .unwrap_or(name),
                cwd: row.get(3)?,
                branch: row.get(4)?,
                profile_id: row.get(5)?,
                conversation_id: row.get(6)?,
                backend: recorded_backend(row.get(7)?),
                project_path: row.get(8)?,
                permission_mode: named(row.get(9)?),
            })
        })
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
        .map_err(sql("reconcile the sessions the last run left running"))?;
    lost.sort_by_key(|row| row.id);
    Ok(lost)
}

/// Records `ids` as exited now, with no exit code, as a deliberate stop does
/// before it ends their processes, so none is offered for restore. A row
/// that is no longer running is left as it is.
pub(crate) fn record_stopped(store: &Store, ids: &[SessionId]) -> Result<()> {
    let mut statement = store
        .connection()
        .prepare(&format!(
            "UPDATE sessions SET status = 'exited', ended_at = {NOW}, \
             duration_ms = CAST((julianday({NOW}) - julianday(started_at)) * 86400000 AS INTEGER) \
             WHERE id = ?1 AND status = 'running'"
        ))
        .map_err(sql("record the stopped sessions"))?;
    for id in ids {
        statement
            .execute(params![id.0])
            .map_err(sql("record the stopped sessions"))?;
    }
    Ok(())
}

/// The columns [`profile_row`] reads, in its order.
pub(crate) const PROFILE_COLUMNS: &str = "id, name, root, overlays, access, model, effort, \
     permission_mode, agent, mcp, opening_prompt, pinned_order, created_at, updated_at";

/// Profile `id` as its row in `profiles` holds it, or `None` when it has
/// been deleted.
pub(crate) fn read_profile(store: &Store, id: u64) -> Result<Option<Profile>> {
    let Ok(id) = i64::try_from(id) else {
        return Ok(None);
    };
    store
        .connection()
        .query_row(
            &format!("SELECT {PROFILE_COLUMNS} FROM profiles WHERE id = ?1"),
            [id],
            profile_row,
        )
        .optional()
        .map_err(sql("read a profile"))
}

/// A `profiles` row selected with [`PROFILE_COLUMNS`]. A value the row
/// holds that this host does not know, such as an effort level from a later
/// app, reads as not chosen.
pub(crate) fn profile_row(row: &Row<'_>) -> rusqlite::Result<Profile> {
    let list = |index: usize| -> rusqlite::Result<Vec<String>> {
        let text: Option<String> = row.get(index)?;
        Ok(text
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default())
    };
    Ok(Profile {
        id: unsigned(row.get(0)?),
        name: row.get(1)?,
        root: row.get(2)?,
        overlays: list(3)?,
        access: list(4)?,
        model: non_empty(row.get(5)?),
        effort: named(row.get(6)?),
        permission_mode: named(row.get(7)?),
        agent: non_empty(row.get(8)?),
        mcp: list(9)?,
        opening_prompt: non_empty(row.get(10)?),
        pinned_order: row
            .get::<_, Option<i64>>(11)?
            .and_then(|order| u32::try_from(order).ok()),
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
    })
}

/// A value stored under its protocol name, such as `acceptEdits`, or `None`
/// for none or a name this host does not know.
fn named<T: serde::de::DeserializeOwned>(text: Option<String>) -> Option<T> {
    serde_json::from_value(serde_json::Value::String(text?)).ok()
}

/// How a permission mode is stored: by its protocol name.
pub(crate) fn permission_mode_name(mode: PermissionMode) -> String {
    serde_json::to_value(mode)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn non_empty(text: Option<String>) -> Option<String> {
    text.filter(|text| !text.trim().is_empty())
}

/// Conversation `conversation_id` in the history index, with any name given
/// by hand, or `None` when the index does not have it. History is Claude
/// Code's: its index rows name no backend because only Claude Code records
/// one, so a row is Claude Code's, as [`recorded_backend`] reads a session
/// row with none.
pub(crate) fn read_history_session(
    store: &Store,
    conversation_id: &str,
) -> Result<Option<HistorySession>> {
    store
        .connection()
        .query_row(
            "SELECT h.session_id, h.project, h.prompt_count, h.first_at, h.last_at, \
             h.first_prompt, h.title_prompt, h.transcript_file, h.transcript_bytes, \
             h.project_exists, n.name \
             FROM history_sessions h \
             LEFT JOIN history_names n ON n.session_id = lower(h.session_id) \
             WHERE lower(h.session_id) = lower(?1)",
            [conversation_id],
            |row| {
                let project: String = row.get(1)?;
                let first_prompt: String = row.get(5)?;
                let title_prompt: Option<String> = row.get(6)?;
                let title =
                    session_title_from(&[title_prompt.unwrap_or_else(|| first_prompt.clone())]);
                Ok(HistorySession {
                    session_id: row.get(0)?,
                    backend: BackendId::claude_code(),
                    project_name: last_segment(&project),
                    project,
                    prompt_count: u32::try_from(row.get::<_, i64>(2)?).unwrap_or(0),
                    first_at: unsigned(row.get(3)?),
                    last_at: unsigned(row.get(4)?),
                    first_prompt,
                    title: title.text,
                    title_fallback: title.fallback,
                    label: non_empty(row.get(10)?),
                    transcript_file: row.get(7)?,
                    transcript_bytes: row.get::<_, Option<i64>>(8)?.map(unsigned),
                    project_exists: row.get::<_, Option<bool>>(9)?.unwrap_or(false),
                    archive: None,
                    archived_messages: None,
                    matched: None,
                })
            },
        )
        .optional()
        .map_err(sql("read a conversation from the history index"))
}

/// The last segment of a recorded folder, whichever separator it was
/// recorded with.
fn last_segment(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_owned()
}

/// Sets session `id`'s label, or clears it with `None`. False when there is
/// no such row.
pub(crate) fn set_label(store: &Store, id: SessionId, label: Option<&str>) -> Result<bool> {
    let changed = store
        .connection()
        .execute(
            "UPDATE sessions SET label = ?2 WHERE id = ?1",
            params![id.0, label],
        )
        .map_err(sql("rename a session"))?;
    Ok(changed > 0)
}

/// Session `id` is in `conversation_id` now, which is not the one it started
/// in: a cleared conversation. A restore reopens this one.
pub(crate) fn record_conversation(
    store: &Store,
    id: SessionId,
    conversation_id: &str,
) -> Result<()> {
    store
        .connection()
        .execute(
            "UPDATE sessions SET last_claude_session_id = ?2 WHERE id = ?1 AND status = 'running'",
            params![id.0, conversation_id],
        )
        .map_err(sql("record a session's conversation"))?;
    Ok(())
}

/// The conversation session `id` is in now, as far as its row knows.
pub(crate) fn current_conversation(store: &Store, id: SessionId) -> Result<Option<String>> {
    store
        .connection()
        .query_row(
            "SELECT coalesce(last_claude_session_id, claude_session_id) FROM sessions WHERE id = ?1",
            [id.0],
            |row| row.get(0),
        )
        .optional()
        .map(Option::flatten)
        .map_err(sql("read a session's conversation"))
}

/// The name of profile `id`, or `None` when it has been deleted.
pub(crate) fn profile_name(store: &Store, id: i64) -> Result<Option<String>> {
    store
        .connection()
        .query_row("SELECT name FROM profiles WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()
        .map_err(sql("read a profile"))
}

/// Session `id`'s row.
pub(crate) fn read_record(store: &Store, id: SessionId) -> Result<SessionRecord> {
    store
        .connection()
        .query_row(
            &format!("SELECT {RECORD_COLUMNS} FROM sessions WHERE id = ?1"),
            [id.0],
            record_from,
        )
        .map_err(sql("read a session's row"))
}

fn record_from(row: &Row<'_>) -> rusqlite::Result<SessionRecord> {
    let argv: String = row.get(7)?;
    let status: String = row.get(9)?;
    Ok(SessionRecord {
        id: unsigned(row.get::<_, i64>(0)?),
        name: row.get(1)?,
        label: row.get(2)?,
        cwd: row.get(3)?,
        branch: row.get(4)?,
        project_path: row.get(5)?,
        profile_id: row.get::<_, Option<i64>>(6)?.map(unsigned),
        // A row written by an older app with something unreadable here still
        // lists; its arguments are simply not known.
        argv: serde_json::from_str(&argv).unwrap_or_default(),
        conversation_id: row.get(8)?,
        backend: recorded_backend(row.get(14)?),
        status: match status.as_str() {
            "running" => SessionStatus::Running,
            "exited" => SessionStatus::Exited,
            _ => SessionStatus::Lost,
        },
        started_at: row.get(10)?,
        ended_at: row.get(11)?,
        duration_ms: row.get::<_, Option<i64>>(12)?.map(unsigned),
        exit_code: row
            .get::<_, Option<i64>>(13)?
            .map(|code| i32::try_from(code).unwrap_or(i32::MAX)),
    })
}

fn unsigned(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

fn sql(action: &'static str) -> impl Fn(rusqlite::Error) -> Error {
    move |err| Error::io(action, io::Error::other(err))
}
