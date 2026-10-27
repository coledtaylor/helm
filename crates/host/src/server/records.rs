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
use floti_protocol::channels::common::{SessionRecord, SessionStatus};
use rusqlite::{OptionalExtension, Row, params};
use tokio::sync::broadcast;

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
    pub conversation_id: Option<String>,
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
             RETURNING id, name, label, cwd, branch, profile_id, claude_session_id, backend",
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
