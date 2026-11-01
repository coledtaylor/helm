//! Merging a client's own data into `floti.db`, for `carry:*`.
//!
//! Helm kept archived conversations, their usage, History's session names
//! and the config console's file versions in its own database before the
//! host ran its sessions; the host cannot rebuild them from the agent's
//! files. Helm reads them and sends them in batches, and each batch is merged
//! here in one transaction. What `floti.db` already holds always wins, and
//! nothing is written twice, so a batch sent again after a copy that stopped
//! part way changes nothing it already wrote:
//!
//! - a conversation `floti.db` holds in any state is kept whole and every
//!   part of it is skipped. A copied message is keyed by its uuid like every
//!   archived one, stored with the host's own compression and search entry.
//!   A conversation's row is written only with its last part, keeping when
//!   Helm captured it; a dropped one is copied as dropped, with its figures
//!   and no messages. The first part of a conversation clears what an
//!   earlier attempt left of it without a row, so a copy that stopped part
//!   way leaves no conversation showing part of its messages, and its retry
//!   duplicates nothing. The archive's size limit is applied after each
//!   batch, so the oldest conversations go first, copied or not;
//! - a session name the host has is kept;
//! - a config file version the host has (same folder, file, content and
//!   time) is not added again; a new one takes a new id and keeps when it was
//!   taken and why;
//! - usage of a message the host has usage for is kept.
//!
//! [`finish`] records that the copy ran to the end, under its own settings
//! key, which the host's settings never read. Nothing here logs or returns
//! what a conversation said: only counts.

use std::collections::BTreeSet;

use floti_protocol::channels::carry::{
    CarriedConfigVersion, CarriedConversationPart, CarriedConversationsMerged, CarriedSessionName,
    CarriedUsageRow, CarryMerged, CarryStatus,
};
use floti_protocol::channels::sessions::ArchiveSessionState;
use rusqlite::{Connection, OptionalExtension, params};

use crate::Result;
use crate::history::archive::{self, StoredMessage};
use crate::history::sql;

/// The `app_settings` key that records the copy finished. Not a host
/// setting: [`crate::workspace::settings`] reads only the keys it knows.
pub const FINISHED_SETTING: &str = "carriedClientDataAt";

/// A conversation part with its messages encoded as they will be stored.
/// Encoding is the slow part of a batch; it is done before the store is
/// taken, so the store is held only for the writes.
pub struct EncodedPart<'a> {
    pub part: &'a CarriedConversationPart,
    messages: Vec<StoredMessage<'a>>,
}

/// Encodes each part's messages. A dropped conversation's messages, which
/// it should not have, are left out.
pub fn encode(parts: &[CarriedConversationPart]) -> Vec<EncodedPart<'_>> {
    parts
        .iter()
        .map(|part| EncodedPart {
            part,
            messages: match part.conversation.state {
                ArchiveSessionState::Archived => {
                    part.messages.iter().map(StoredMessage::encode).collect()
                }
                ArchiveSessionState::Evicted => Vec::new(),
            },
        })
        .collect()
}

/// Whether the copy has finished on this host.
pub fn status(conn: &Connection) -> Result<CarryStatus> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?",
            [FINISHED_SETTING],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql("read whether Helm's data was copied"))?;
    Ok(CarryStatus {
        // Written as a JSON string, as every setting is; anything else still
        // says it finished.
        finished_at: value.map(|value| serde_json::from_str::<String>(&value).unwrap_or(value)),
    })
}

/// Records that the copy finished. The first record stands.
pub fn finish(conn: &Connection) -> Result<CarryStatus> {
    conn.execute(
        "INSERT INTO app_settings (key, value)
         VALUES (?, json_quote(strftime('%Y-%m-%dT%H:%M:%fZ','now')))
         ON CONFLICT(key) DO NOTHING",
        [FINISHED_SETTING],
    )
    .map_err(sql("record that Helm's data was copied"))?;
    status(conn)
}

/// Of `session_ids`, the ones `floti.db` holds no conversation for, in the
/// order given, each once.
pub fn missing(conn: &Connection, session_ids: &[String]) -> Result<Vec<String>> {
    let mut held = conn
        .prepare("SELECT 1 FROM transcript_sessions WHERE session_id = ?")
        .map_err(sql("look for archived conversations"))?;
    let mut asked = BTreeSet::new();
    let mut missing = Vec::new();
    for id in session_ids {
        let key = id.to_lowercase();
        if !asked.insert(key.clone()) {
            continue;
        }
        let there = held
            .exists([&key])
            .map_err(sql("look for archived conversations"))?;
        if !there {
            missing.push(id.clone());
        }
    }
    Ok(missing)
}

/// Merges History's session names; a session the host has a name for keeps
/// it.
pub fn merge_names(conn: &Connection, names: &[CarriedSessionName]) -> Result<CarryMerged> {
    in_transaction(conn, "copy session names", |tx| {
        let mut insert = tx.prepare(
            "INSERT INTO history_names (session_id, name, renamed_at) VALUES (?, ?, ?)
             ON CONFLICT(session_id) DO NOTHING",
        )?;
        let mut merged = CarryMerged::default();
        for name in names {
            let written = insert.execute(params![
                name.session_id.to_lowercase(),
                name.name,
                name.renamed_at
            ])?;
            count(&mut merged, written);
        }
        Ok(merged)
    })
}

/// Merges config file versions; one the host has is not added again.
pub fn merge_versions(conn: &Connection, versions: &[CarriedConfigVersion]) -> Result<CarryMerged> {
    in_transaction(conn, "copy config file versions", |tx| {
        let mut held = tx.prepare(
            "SELECT 1 FROM config_snapshots
             WHERE project_path = ? AND file_path = ? AND content_hash = ? AND created_at = ?",
        )?;
        let mut insert = tx.prepare(
            "INSERT INTO config_snapshots
               (project_path, file_path, content, content_hash, reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )?;
        let mut merged = CarryMerged::default();
        for version in versions {
            let key = params![
                version.scope_path,
                version.file_path,
                version.content_hash,
                version.created_at
            ];
            if held.exists(key)? {
                merged.kept += 1;
                continue;
            }
            insert.execute(params![
                version.scope_path,
                version.file_path,
                version.content,
                version.content_hash,
                version.reason,
                version.created_at
            ])?;
            merged.added += 1;
        }
        Ok(merged)
    })
}

/// Merges usage; a message the host has usage for keeps it.
pub fn merge_usage(conn: &Connection, rows: &[CarriedUsageRow]) -> Result<CarryMerged> {
    in_transaction(conn, "copy usage", |tx| {
        let mut insert = tx.prepare(
            "INSERT INTO usage_messages
               (uuid, at, model, input_tokens, output_tokens,
                cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(uuid) DO NOTHING",
        )?;
        let mut merged = CarryMerged::default();
        for row in rows {
            let written = insert.execute(params![
                row.uuid,
                to_i64(row.at),
                row.model,
                to_i64(row.input),
                to_i64(row.output),
                to_i64(row.cache_write5m),
                to_i64(row.cache_write1h),
                to_i64(row.cache_read)
            ])?;
            count(&mut merged, written);
        }
        Ok(merged)
    })
}

/// Merges conversation parts in one transaction, then brings the archive
/// under `ceiling`.
pub fn merge_conversations(
    conn: &Connection,
    parts: &[EncodedPart<'_>],
    ceiling: u64,
) -> Result<CarriedConversationsMerged> {
    let mut merged = in_transaction(conn, "copy archived conversations", |tx| {
        let mut merged = CarriedConversationsMerged::default();
        for encoded in parts {
            let part = encoded.part;
            let row = &part.conversation;
            let session = row.session_id.to_lowercase();
            let held = tx
                .prepare_cached("SELECT 1 FROM transcript_sessions WHERE session_id = ?")?
                .exists([&session])?;
            if held {
                merged.kept += 1;
                continue;
            }
            if part.part == 0 {
                // What an earlier attempt left: messages with no row. Their
                // delete trigger takes them out of the search index.
                tx.execute(
                    "DELETE FROM transcript_messages WHERE session_id = ?",
                    [&session],
                )?;
            }
            let (written, _) = archive::insert_messages(tx, &session, &encoded.messages)?;
            merged.messages += written;
            if !part.last {
                continue;
            }
            match row.state {
                ArchiveSessionState::Archived => tx.execute(
                    "INSERT INTO transcript_sessions
                       (session_id, source_file, state, first_at, last_at,
                        message_count, raw_bytes, stored_bytes, captured_at)
                     SELECT ?1, ?2, 'archived', COALESCE(MIN(at), ?3), COALESCE(MAX(at), ?4),
                            COUNT(*), COALESCE(SUM(raw_bytes), 0), COALESCE(SUM(stored_bytes), 0),
                            ?5
                     FROM transcript_messages WHERE session_id = ?1",
                    params![
                        session,
                        row.source_file,
                        row.first_at.map(to_i64),
                        row.last_at.map(to_i64),
                        row.captured_at
                    ],
                )?,
                ArchiveSessionState::Evicted => tx.execute(
                    "INSERT INTO transcript_sessions
                       (session_id, source_file, state, first_at, last_at,
                        message_count, raw_bytes, stored_bytes, captured_at, evicted_at)
                     VALUES (?, ?, 'evicted', ?, ?, ?, ?, 0, ?,
                             COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
                    params![
                        session,
                        row.source_file,
                        row.first_at.map(to_i64),
                        row.last_at.map(to_i64),
                        row.message_count,
                        to_i64(row.raw_bytes),
                        row.captured_at,
                        row.evicted_at
                    ],
                )?,
            };
            merged.added += 1;
        }
        Ok(merged)
    })?;
    let eviction = archive::evict_to_ceiling(conn, ceiling)?;
    merged.evicted = u32::try_from(eviction.sessions.len()).unwrap_or(u32::MAX);
    Ok(merged)
}

/// Runs `work` in one transaction: all of it lands, or none of it.
fn in_transaction<T>(
    conn: &Connection,
    action: &'static str,
    work: impl FnOnce(&Connection) -> rusqlite::Result<T>,
) -> Result<T> {
    let tx = conn.unchecked_transaction().map_err(sql(action))?;
    let done = work(&tx).map_err(sql(action))?;
    tx.commit().map_err(sql(action))?;
    Ok(done)
}

fn count(merged: &mut CarryMerged, written: usize) {
    if written == 0 {
        merged.kept += 1;
    } else {
        merged.added += 1;
    }
}

fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests;
