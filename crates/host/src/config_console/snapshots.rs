//! The undo history behind every config write, in floti.db's
//! `config_snapshots` table (the table today's app keeps in helm.db).
//!
//! A row holds the bytes as they were before a write, inline: a snapshot that
//! needs the file still on disk is not one. The row goes in before the file
//! is touched, and a write whose row cannot go in does not happen.

use floti_protocol::channels::workspace::{ConfigSnapshotMeta, ConfigWriteReason};
use rusqlite::{Connection, OptionalExtension, Row, params};

/// How many versions of one file a listing returns.
const LIST_LIMIT: u32 = 100;

/// A row to take.
#[derive(Debug, Clone)]
pub struct NewSnapshot<'a> {
    /// The scope's base folder.
    pub scope_path: &'a str,
    /// Relative to `scope_path`, forward-slashed.
    pub file_path: &'a str,
    /// The bytes as they are now, before the write; empty for a new file.
    pub content: &'a str,
    /// sha256 of `content`, from the same bytes.
    pub content_hash: &'a str,
    pub reason: ConfigWriteReason,
}

/// A version, with its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub meta: ConfigSnapshotMeta,
    pub content: String,
}

pub fn reason_name(reason: ConfigWriteReason) -> &'static str {
    match reason {
        ConfigWriteReason::Edit => "edit",
        ConfigWriteReason::Create => "create",
        ConfigWriteReason::Restore => "restore",
        ConfigWriteReason::Mcp => "mcp",
        ConfigWriteReason::Approve => "approve",
        ConfigWriteReason::Rename => "rename",
        ConfigWriteReason::Delete => "delete",
    }
}

/// A stored reason; one this build does not know reads as an edit, as today.
fn reason_of(name: &str) -> ConfigWriteReason {
    match name {
        "create" => ConfigWriteReason::Create,
        "restore" => ConfigWriteReason::Restore,
        "mcp" => ConfigWriteReason::Mcp,
        "approve" => ConfigWriteReason::Approve,
        "rename" => ConfigWriteReason::Rename,
        "delete" => ConfigWriteReason::Delete,
        _ => ConfigWriteReason::Edit,
    }
}

/// Takes the row and answers its id, or the sentence saying why it could
/// not, which is the sentence a write aborts with.
pub fn insert(conn: &Connection, row: &NewSnapshot<'_>) -> Result<u64, String> {
    conn.execute(
        "INSERT INTO config_snapshots (project_path, file_path, content, content_hash, reason)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            row.scope_path,
            row.file_path,
            row.content,
            row.content_hash,
            reason_name(row.reason)
        ],
    )
    .map_err(|err| {
        format!(
            "Floti could not take a snapshot of {} before changing it, so it left the file as it was: {err}",
            row.file_path
        )
    })?;
    u64::try_from(conn.last_insert_rowid()).map_err(|_| "The snapshot got no id.".to_owned())
}

fn meta(row: &Row<'_>) -> rusqlite::Result<ConfigSnapshotMeta> {
    let reason: String = row.get("reason")?;
    Ok(ConfigSnapshotMeta {
        id: row.get::<_, i64>("id")?.max(0) as u64,
        scope_path: row.get("project_path")?,
        file_path: row.get("file_path")?,
        content_hash: row.get("content_hash")?,
        bytes: row.get::<_, i64>("bytes")?.max(0) as u64,
        reason: reason_of(&reason),
        created_at: row.get("created_at")?,
    })
}

/// One file's versions, newest first, without their bytes.
pub fn list(
    conn: &Connection,
    scope_path: &str,
    file_path: &str,
) -> Result<Vec<ConfigSnapshotMeta>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, project_path, file_path, content_hash, length(content) AS bytes, reason, created_at
             FROM config_snapshots WHERE project_path = ?1 AND file_path = ?2
             ORDER BY id DESC LIMIT ?3",
        )
        .map_err(|err| format!("Floti could not read the snapshot history: {err}"))?;
    statement
        .query_map(params![scope_path, file_path, LIST_LIMIT], meta)
        .and_then(Iterator::collect)
        .map_err(|err| format!("Floti could not read the snapshot history: {err}"))
}

/// One version with its bytes, or `None` when there is no such row.
pub fn read(conn: &Connection, id: u64) -> Result<Option<Snapshot>, String> {
    let Ok(id) = i64::try_from(id) else {
        return Ok(None);
    };
    conn.query_row(
        "SELECT id, project_path, file_path, content, content_hash, length(content) AS bytes, reason, created_at
         FROM config_snapshots WHERE id = ?1",
        params![id],
        |row| {
            Ok(Snapshot {
                meta: meta(row)?,
                content: row.get("content")?,
            })
        },
    )
    .optional()
    .map_err(|err| format!("Floti could not read the snapshot history: {err}"))
}

/// How many rows the history holds.
pub fn count(conn: &Connection) -> Result<u64, String> {
    conn.query_row("SELECT COUNT(*) FROM config_snapshots", [], |row| {
        row.get::<_, i64>(0)
    })
    .map(|n| n.max(0) as u64)
    .map_err(|err| format!("Floti could not count the snapshot history: {err}"))
}
