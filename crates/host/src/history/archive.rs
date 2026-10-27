//! The transcript archive: the conversations out of an agent's transcripts,
//! kept in `floti.db` after the agent deletes them.
//!
//! Read-only towards the agent's folder without exception: the only thing
//! done with a transcript is reading it and storing what was read. Every
//! message is keyed by its own `uuid`, so a fork that copies its parent's
//! rows into a second transcript stores each once, and offering a transcript
//! again is harmless.
//!
//! The ceiling drops whole conversations, oldest last message first, and
//! keeps their row as `evicted`: "Floti had this and dropped it to stay under
//! your limit" is a different fact from "this was gone before Floti saw it",
//! and it is what stops the next pass archiving it again.
//!
//! A body longer than [`COMPRESS_ABOVE_BYTES`] is stored as raw deflate
//! when that makes it shorter, and as read otherwise: raw deflate on a short
//! string comes out longer than the input, because the Huffman table has to
//! go somewhere. `compressed` says which, and `stored_bytes` is what the row
//! takes in the database, which is what the ceiling is measured on. A body
//! that cannot be inflated reads as empty text: it is one message of one
//! conversation, and failing the read would lose the rest with it.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::io::{Read as _, Write as _};

use flate2::Compression;
use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;

use floti_protocol::channels::sessions::{
    ArchiveMessage, ArchiveRole, ArchiveSessionState, ArchiveStats, ArchivedConversation,
};
use rusqlite::{Connection, OptionalExtension, params};

use super::index::{to_i64, to_u32, to_u64};
use super::sql;
use crate::Result;

/// The `app_settings` key holding the ceiling, as today's settings name it.
pub const CEILING_SETTING: &str = "transcriptArchiveMaxBytes";

/// The ceiling when none is set: 1 GiB.
pub const DEFAULT_CEILING: u64 = 1024 * 1024 * 1024;

/// The smallest and largest ceiling a setting may name.
pub const CEILING_RANGE: std::ops::RangeInclusive<u64> = 1024..=64 * 1024 * 1024 * 1024;

/// One transcript's messages, to be archived.
pub struct ArchiveInput<'a> {
    /// The transcript they were read from; also the cursor's key.
    pub file: &'a str,
    /// The conversation they belong to.
    pub session_id: &'a str,
    /// The transcript's size when it was read.
    pub bytes: u64,
    /// Every message the transcript holds now, in order.
    pub messages: &'a [ArchiveMessage],
}

/// What archiving one transcript did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ArchiveWrite {
    /// Messages added. A message already stored is not counted.
    pub messages: u64,
    /// Bytes those messages take in the database.
    pub stored_bytes: u64,
    /// True when the conversation is one the ceiling has already dropped.
    pub skipped_evicted: bool,
}

/// What a ceiling pass dropped.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Eviction {
    /// Conversations dropped whole, oldest first.
    pub sessions: Vec<String>,
    pub messages: u64,
    /// Stored bytes reclaimed.
    pub bytes: u64,
    /// Stored bytes after it, at or under the ceiling unless nothing was
    /// left to drop.
    pub stored_bytes: u64,
}

/// The transcript size the archive last read `file` at, or `None` when it
/// never has.
pub fn cursor(conn: &Connection, file: &str) -> Result<Option<u64>> {
    conn.query_row(
        "SELECT bytes FROM transcript_index WHERE file = ?",
        [file],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .map(|bytes| bytes.map(to_u64))
    .map_err(sql("read the archive cursor"))
}

/// Every transcript the archive has a cursor for, with its size then.
pub fn indexed_files(conn: &Connection) -> Result<BTreeMap<String, u64>> {
    let mut statement = conn
        .prepare("SELECT file, bytes FROM transcript_index")
        .map_err(sql("read the archive cursors"))?;
    statement
        .query_map([], |row| Ok((row.get(0)?, to_u64(row.get(1)?))))
        .and_then(Iterator::collect)
        .map_err(sql("read the archive cursors"))
}

/// Forgets the cursors of transcripts no longer on disk. The conversations
/// they held stay; that is the archive's whole point.
pub fn forget_files<'a>(
    conn: &Connection,
    files: impl IntoIterator<Item = &'a String>,
) -> Result<usize> {
    let tx = conn
        .unchecked_transaction()
        .map_err(sql("forget archive cursors"))?;
    let mut removed = 0;
    {
        let mut drop = tx
            .prepare("DELETE FROM transcript_index WHERE file = ?")
            .map_err(sql("forget archive cursors"))?;
        for file in files {
            removed += drop
                .execute([file])
                .map_err(sql("forget archive cursors"))?;
        }
    }
    tx.commit().map_err(sql("forget archive cursors"))?;
    Ok(removed)
}

/// What the archive holds for a conversation, or `None` when it never held
/// anything.
pub fn state_of(conn: &Connection, session_id: &str) -> Result<Option<ArchiveSessionState>> {
    conn.query_row(
        "SELECT state FROM transcript_sessions WHERE session_id = ?",
        [session_id.to_lowercase()],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map(|state| state.as_deref().and_then(parse_state))
    .map_err(sql("read an archive state"))
}

/// Archives one transcript's messages. A message already stored is left as
/// it is; a conversation the ceiling dropped has nothing stored, and its
/// cursor still moves, so it is not offered again.
pub fn archive_transcript(conn: &Connection, input: &ArchiveInput<'_>) -> Result<ArchiveWrite> {
    let session = input.session_id.to_lowercase();
    let mut result = ArchiveWrite::default();
    let tx = conn
        .unchecked_transaction()
        .map_err(sql("start an archive pass"))?;
    let run = |result: &mut ArchiveWrite| -> rusqlite::Result<()> {
        let evicted = tx
            .query_row(
                "SELECT state = 'evicted' FROM transcript_sessions WHERE session_id = ?",
                [&session],
                |row| row.get::<_, bool>(0),
            )
            .optional()?
            .unwrap_or(false);
        if evicted {
            result.skipped_evicted = !input.messages.is_empty();
        } else {
            let mut insert = tx.prepare(
                "INSERT INTO transcript_messages
                   (uuid, session_id, role, at, body, compressed, raw_bytes, stored_bytes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(uuid) DO NOTHING",
            )?;
            let mut index = tx.prepare("INSERT INTO transcript_fts(rowid, text) VALUES (?, ?)")?;
            for message in input.messages {
                let raw_bytes = message.text.len() as u64;
                let (body, compressed) = encode_body(&message.text);
                let written = insert.execute(params![
                    message.uuid,
                    session,
                    role_name(message.role),
                    to_i64(message.at),
                    body.as_ref(),
                    compressed,
                    to_i64(raw_bytes),
                    to_i64(body.len() as u64),
                ])?;
                if written == 0 {
                    continue;
                }
                // Written beside the row and in its transaction, so a message
                // and its search entry cannot disagree.
                index.execute(params![tx.last_insert_rowid(), message.text])?;
                result.messages += 1;
                result.stored_bytes += body.len() as u64;
            }
            if result.messages > 0 {
                tx.execute(
                    "INSERT INTO transcript_sessions
                       (session_id, source_file, state, first_at, last_at,
                        message_count, raw_bytes, stored_bytes, captured_at)
                     SELECT ?1, ?2, 'archived', MIN(at), MAX(at),
                            COUNT(*), COALESCE(SUM(raw_bytes), 0), COALESCE(SUM(stored_bytes), 0),
                            strftime('%Y-%m-%dT%H:%M:%fZ','now')
                     FROM transcript_messages WHERE session_id = ?1
                     ON CONFLICT(session_id) DO UPDATE SET
                       source_file   = excluded.source_file,
                       first_at      = excluded.first_at,
                       last_at       = excluded.last_at,
                       message_count = excluded.message_count,
                       raw_bytes     = excluded.raw_bytes,
                       stored_bytes  = excluded.stored_bytes",
                    params![session, input.file],
                )?;
            }
        }
        tx.execute(
            "INSERT INTO transcript_index (file, bytes, messages, indexed_at)
             VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             ON CONFLICT(file) DO UPDATE SET
               bytes = excluded.bytes,
               messages = transcript_index.messages + excluded.messages,
               indexed_at = excluded.indexed_at",
            params![input.file, to_i64(input.bytes), to_i64(result.messages)],
        )?;
        Ok(())
    };
    run(&mut result).map_err(sql("archive a transcript"))?;
    tx.commit().map_err(sql("finish an archive pass"))?;
    Ok(result)
}

/// Stored bytes of every conversation still archived: what the ceiling is
/// measured on.
pub fn archived_bytes(conn: &Connection) -> Result<u64> {
    conn.query_row(
        "SELECT COALESCE(SUM(stored_bytes), 0) FROM transcript_sessions WHERE state = 'archived'",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map(to_u64)
    .map_err(sql("measure the archive"))
}

/// Brings the archive under `max_bytes` by dropping whole conversations,
/// oldest last message first, and only as many as it has to. Never part of
/// one: half a conversation under a row that says how many messages it has
/// is a transcript that lies about being complete. Stops when nothing is
/// left to drop.
pub fn evict_to_ceiling(conn: &Connection, max_bytes: u64) -> Result<Eviction> {
    let mut result = Eviction::default();
    let tx = conn
        .unchecked_transaction()
        .map_err(sql("start an archive eviction"))?;
    let run = |result: &mut Eviction| -> rusqlite::Result<()> {
        let measure = |tx: &Connection| {
            tx.query_row(
                "SELECT COALESCE(SUM(stored_bytes), 0) FROM transcript_sessions WHERE state = 'archived'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(to_u64)
        };
        let mut stored = measure(&tx)?;
        let mut oldest = tx.prepare(
            "SELECT session_id, stored_bytes, message_count
             FROM transcript_sessions
             WHERE state = 'archived'
             ORDER BY COALESCE(last_at, 0), session_id
             LIMIT 1",
        )?;
        // The messages go first: their delete trigger is what takes them out
        // of the search index.
        let mut drop_messages =
            tx.prepare("DELETE FROM transcript_messages WHERE session_id = ?")?;
        let mut mark = tx.prepare(
            "UPDATE transcript_sessions
             SET state = 'evicted', stored_bytes = 0,
                 evicted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
             WHERE session_id = ?",
        )?;
        while stored > max_bytes {
            let Some((session, bytes, messages)) = oldest
                .query_row([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        to_u64(row.get(1)?),
                        to_u64(row.get(2)?),
                    ))
                })
                .optional()?
            else {
                break;
            };
            drop_messages.execute([&session])?;
            mark.execute([&session])?;
            result.sessions.push(session);
            result.messages += messages;
            result.bytes += bytes;
            stored = stored.saturating_sub(bytes);
        }
        result.stored_bytes = measure(&tx)?;
        Ok(())
    };
    run(&mut result).map_err(sql("evict from the archive"))?;
    tx.commit().map_err(sql("finish an archive eviction"))?;
    Ok(result)
}

/// One archived conversation in the order it happened, or `None` when the
/// archive never held it. An evicted one is returned with no messages: "we
/// had this" is the answer to paint.
pub fn read_conversation(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<ArchivedConversation>> {
    let key = session_id.to_lowercase();
    let fail = sql("read an archived conversation");
    let Some(mut conversation) = conn
        .query_row(
            "SELECT session_id, source_file, state, first_at, last_at,
                    message_count, raw_bytes, stored_bytes, captured_at, evicted_at
             FROM transcript_sessions WHERE session_id = ?",
            [&key],
            |row| {
                Ok(ArchivedConversation {
                    session_id: row.get(0)?,
                    source_file: row.get(1)?,
                    state: parse_state(&row.get::<_, String>(2)?)
                        .unwrap_or(ArchiveSessionState::Archived),
                    first_at: row.get::<_, Option<i64>>(3)?.map(to_u64),
                    last_at: row.get::<_, Option<i64>>(4)?.map(to_u64),
                    message_count: to_u32(row.get(5)?),
                    raw_bytes: to_u64(row.get(6)?),
                    stored_bytes: to_u64(row.get(7)?),
                    captured_at: row.get(8)?,
                    evicted_at: row.get(9)?,
                    messages: Vec::new(),
                })
            },
        )
        .optional()
        .map_err(sql("read an archived conversation"))?
    else {
        return Ok(None);
    };
    if conversation.state == ArchiveSessionState::Archived {
        let mut statement = conn
            .prepare(
                "SELECT uuid, role, at, body, compressed FROM transcript_messages
                 WHERE session_id = ? ORDER BY at, id",
            )
            .map_err(sql("read an archived conversation"))?;
        conversation.messages = statement
            .query_map([&key], |row| {
                Ok(ArchiveMessage {
                    uuid: row.get(0)?,
                    role: if row.get::<_, String>(1)? == "assistant" {
                        ArchiveRole::Assistant
                    } else {
                        ArchiveRole::User
                    },
                    at: to_u64(row.get(2)?),
                    text: decode_body(&row.get::<_, Vec<u8>>(3)?, row.get(4)?),
                })
            })
            .and_then(Iterator::collect)
            .map_err(fail)?;
    }
    Ok(Some(conversation))
}

/// A search box's text as an FTS5 query: every token quoted, so FTS5's own
/// syntax typed into the box is inert, and the last a prefix, so a word is
/// found while it is still being typed. `None` when there is nothing to
/// search for, which is not a query that matches nothing.
pub fn search_query(search: &str) -> Option<String> {
    let lowered = search.to_lowercase();
    let tokens: Vec<&str> = lowered
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|token| !token.is_empty())
        .collect();
    let last = tokens.len().checked_sub(1)?;
    Some(
        tokens
            .iter()
            .enumerate()
            .map(|(index, token)| {
                if index == last {
                    format!("\"{token}\"*")
                } else {
                    format!("\"{token}\"")
                }
            })
            .collect::<Vec<_>>()
            .join(" AND "),
    )
}

/// The archived conversations whose messages match `search`, each with the
/// first matching message's text, keyed by lower-cased id. At most `limit`
/// conversations. A search FTS5 refuses whatever the quoting matches
/// nothing rather than failing.
pub fn search_archive(
    conn: &Connection,
    search: &str,
    limit: usize,
) -> Result<BTreeMap<String, String>> {
    let mut found = BTreeMap::new();
    let Some(query) = search_query(search) else {
        return Ok(found);
    };
    let Ok(mut statement) = conn.prepare(
        "SELECT m.session_id, m.body, m.compressed
         FROM transcript_fts f
         JOIN transcript_messages m ON m.id = f.rowid
         WHERE transcript_fts MATCH ?
         ORDER BY rank
         LIMIT ?",
    ) else {
        return Ok(found);
    };
    let Ok(rows) = statement
        .query_map(params![query, to_i64(limit as u64 * 4)], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })
        .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
    else {
        return Ok(found);
    };
    for (session, body, compressed) in rows {
        if found.len() >= limit {
            break;
        }
        found
            .entry(session)
            .or_insert_with(|| decode_body(&body, compressed));
    }
    Ok(found)
}

/// What the archive holds, against `max_bytes`.
pub fn read_stats(conn: &Connection, max_bytes: u64) -> Result<ArchiveStats> {
    conn.query_row(
        "SELECT
           COALESCE(SUM(CASE WHEN state = 'archived' THEN 1 ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN state = 'evicted'  THEN 1 ELSE 0 END), 0),
           COALESCE(SUM(CASE WHEN state = 'archived' THEN message_count END), 0),
           COALESCE(SUM(CASE WHEN state = 'archived' THEN raw_bytes END), 0),
           COALESCE(SUM(CASE WHEN state = 'archived' THEN stored_bytes END), 0),
           MIN(CASE WHEN state = 'archived' THEN last_at END),
           MAX(CASE WHEN state = 'archived' THEN last_at END)
         FROM transcript_sessions",
        [],
        |row| {
            Ok(ArchiveStats {
                sessions: to_u32(row.get(0)?),
                evicted_sessions: to_u32(row.get(1)?),
                messages: to_u64(row.get(2)?),
                raw_bytes: to_u64(row.get(3)?),
                stored_bytes: to_u64(row.get(4)?),
                max_bytes,
                oldest_at: row.get::<_, Option<i64>>(5)?.map(to_u64),
                newest_at: row.get::<_, Option<i64>>(6)?.map(to_u64),
            })
        },
    )
    .map_err(sql("read the archive's size"))
}

/// The ceiling the settings name, or [`DEFAULT_CEILING`] when they name
/// none or one outside [`CEILING_RANGE`]. Read on every pass: it can change
/// while the host runs.
pub fn ceiling(conn: &Connection) -> Result<u64> {
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?",
            [CEILING_SETTING],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql("read the archive's ceiling"))?;
    Ok(value
        .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
        .and_then(|value| value.as_u64())
        .filter(|bytes| CEILING_RANGE.contains(bytes))
        .unwrap_or(DEFAULT_CEILING))
}

fn parse_state(state: &str) -> Option<ArchiveSessionState> {
    match state {
        "archived" => Some(ArchiveSessionState::Archived),
        "evicted" => Some(ArchiveSessionState::Evicted),
        _ => None,
    }
}

fn role_name(role: ArchiveRole) -> &'static str {
    match role {
        ArchiveRole::User => "user",
        ArchiveRole::Assistant => "assistant",
    }
}

/// Bodies this long or shorter are stored as they are without trying:
/// deflate does not make them shorter.
pub const COMPRESS_ABOVE_BYTES: usize = 120;

/// A message's text as it is stored, and whether that is raw deflate: the
/// deflated bytes when they are shorter, the text's own bytes otherwise.
fn encode_body(text: &str) -> (Cow<'_, [u8]>, bool) {
    let raw = text.as_bytes();
    if raw.len() <= COMPRESS_ABOVE_BYTES {
        return (Cow::Borrowed(raw), false);
    }
    let mut encoder =
        DeflateEncoder::new(Vec::with_capacity(raw.len() / 2), Compression::default());
    // Writing into a `Vec` cannot fail; were it to, the body is kept as read.
    match encoder.write_all(raw).and_then(|()| encoder.finish()) {
        Ok(packed) if packed.len() < raw.len() => (Cow::Owned(packed), true),
        _ => (Cow::Borrowed(raw), false),
    }
}

/// A stored body as text. One that cannot be inflated reads as empty: it is
/// one message, and failing the read would take its conversation down with
/// it.
fn decode_body(body: &[u8], compressed: bool) -> String {
    if !compressed {
        return String::from_utf8_lossy(body).into_owned();
    }
    let mut raw = Vec::with_capacity(body.len() * 4);
    match DeflateDecoder::new(body).read_to_end(&mut raw) {
        Ok(_) => String::from_utf8_lossy(&raw).into_owned(),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_search_is_quoted_so_fts_syntax_cannot_leak_out_of_the_box() {
        assert_eq!(
            search_query("hello world").as_deref(),
            Some("\"hello\" AND \"world\"*")
        );
        assert_eq!(
            search_query("-not \"a phrase\"").as_deref(),
            Some("\"not\" AND \"a\" AND \"phrase\"*")
        );
        assert_eq!(search_query("   "), None);
    }
}
