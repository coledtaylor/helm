//! The history index: the conversations a backend's history holds and every
//! prompt submitted in them, mirrored into `floti.db` so a client can search
//! and group hundreds of sessions without the host re-reading the agent's
//! records per keystroke.
//!
//! `history_prompts` is the record; `history_sessions` is derived from it and
//! rebuilt in full on any pass that changed the prompts, so arithmetic never
//! has to stay right across resets and re-reads. `history_names` holds the
//! names given by hand and is derived from nothing, which is why a rebuild
//! never touches it. The transcript columns say what is on disk now and are
//! written on every pass, because a transcript is reaped and a project
//! folder deleted without the record changing.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::time::Instant;

use floti_protocol::BackendId;
use floti_protocol::channels::sessions::{
    ArchiveSessionState, HistoryPage, HistoryProject, HistoryPrompt, HistoryQuery,
    HistorySearchScope, HistorySession, HistorySummary,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};

use super::archive::search_archive;
use super::sql;
use crate::Result;
use crate::agent::claude_code::session_title_from;

/// The most sessions one page returns when the query names no limit.
const DEFAULT_LIMIT: u32 = 2000;

/// The longest name a session can be given by hand, in characters.
pub const HISTORY_NAME_MAX: usize = 120;

/// One prompt as the record holds it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptLine {
    pub session_id: String,
    /// The folder the session ran in, exactly as recorded.
    pub project: String,
    /// Epoch ms.
    pub at: u64,
    /// The prompt as submitted. An empty one is still a submission.
    pub text: String,
}

/// A transcript still on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptFile {
    pub file: String,
    pub bytes: u64,
}

/// One pass's worth of what the backend's history says.
pub struct IndexInput<'a> {
    /// The record these prompts came from; also the cursor's key.
    pub record: &'a str,
    /// How much of the record has been consumed after this pass.
    pub bytes: u64,
    /// The record is not the one the cursor belonged to: everything indexed
    /// from it is discarded before `lines` are added.
    pub reset: bool,
    /// Sessions whose prompts `lines` replace whole rather than add to: a
    /// conversation read again from its transcript.
    pub replaced: &'a BTreeSet<String>,
    /// Prompts to add, in submission order.
    pub lines: &'a [PromptLine],
    /// Conversations with a transcript on disk now, keyed by lower-cased id.
    pub transcripts: &'a BTreeMap<String, TranscriptFile>,
    /// Whether a recorded folder is still a folder. Passed in so the answer
    /// is taken inside the pass that has to agree with it, and so a test can
    /// give it without a file system.
    pub directory_exists: &'a dyn Fn(&str) -> bool,
    /// Set when the record could not be read; what was indexed stays.
    pub error: Option<String>,
}

/// The history index of one backend, in `conn`.
pub struct HistoryIndex<'a> {
    conn: &'a Connection,
    backend: &'a BackendId,
}

impl<'a> HistoryIndex<'a> {
    /// The index in `conn` of the history `backend` records.
    pub fn new(conn: &'a Connection, backend: &'a BackendId) -> Self {
        Self { conn, backend }
    }

    /// Bytes of `record` already consumed, or 0 when it was never indexed.
    pub fn cursor(&self, record: &str) -> Result<u64> {
        let bytes: Option<i64> = self
            .conn
            .query_row(
                "SELECT bytes FROM history_index WHERE file = ?",
                [record],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql("read the history cursor"))?;
        Ok(bytes.map_or(0, to_u64))
    }

    /// The record the index was last fed from, when it has been fed at all.
    pub fn last_record(&self) -> Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT file FROM history_index ORDER BY indexed_at DESC, file LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql("read the history cursor"))
    }

    /// Applies one pass, in one transaction: a reader never sees new prompts
    /// without the sessions built from them.
    pub fn index(&self, input: &IndexInput<'_>) -> Result<HistorySummary> {
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(sql("start a history pass"))?;
        let fail = sql("index history");
        let run = || -> rusqlite::Result<()> {
            if input.reset {
                tx.execute("DELETE FROM history_prompts", [])?;
                tx.execute("DELETE FROM history_sessions", [])?;
            }
            for session in input.replaced {
                tx.execute(
                    "DELETE FROM history_prompts WHERE session_id = ?",
                    [session],
                )?;
            }
            if !input.lines.is_empty() {
                let next: i64 = tx.query_row(
                    "SELECT COALESCE(MAX(seq), -1) + 1 FROM history_prompts",
                    [],
                    |row| row.get(0),
                )?;
                let mut insert = tx.prepare(
                    "INSERT INTO history_prompts (seq, session_id, project, at, text, title_rank)
                     VALUES (?, ?, ?, ?, ?, ?)",
                )?;
                for (seq, line) in (next..).zip(input.lines) {
                    insert.execute(params![
                        seq,
                        line.session_id,
                        line.project,
                        to_i64(line.at),
                        line.text,
                        title_rank(&line.text),
                    ])?;
                }
            }
            // Always: rows written without a rank have no next prompt coming
            // to trigger a pass.
            let backfilled = rank_unranked(&tx)?;
            if input.reset
                || !input.lines.is_empty()
                || !input.replaced.is_empty()
                || backfilled > 0
            {
                rebuild_sessions(&tx)?;
            }
            apply_transcripts(&tx, input.transcripts)?;
            apply_project_existence(&tx, input.directory_exists)?;
            tx.execute(
                "INSERT INTO history_index (file, bytes, indexed_at)
                 VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 ON CONFLICT(file) DO UPDATE SET
                   bytes = excluded.bytes, indexed_at = excluded.indexed_at",
                params![input.record, to_i64(input.bytes)],
            )?;
            Ok(())
        };
        run().map_err(fail)?;
        tx.commit().map_err(sql("finish a history pass"))?;
        let mut summary = self.summary(input.record)?;
        summary.error.clone_from(&input.error);
        Ok(summary)
    }

    /// Most recently active first; `total` is the match count before the
    /// limit. A `messages` search asks the archive which conversations said
    /// it and lists those; a `prompts` search matches prompts, the project
    /// and a name given by hand. The two are never mixed.
    pub fn sessions(&self, query: &HistoryQuery) -> Result<HistoryPage> {
        let started = Instant::now();
        let search = query.search.as_deref().map_or("", str::trim);
        let archived = (query.scope == Some(HistorySearchScope::Messages) && !search.is_empty())
            .then(|| search_archive(self.conn, search, DEFAULT_LIMIT as usize))
            .transpose()?;

        let mut clauses: Vec<String> = Vec::new();
        let mut filter: Vec<SqlValue> = Vec::new();
        let mut like = None;
        if !search.is_empty() {
            match &archived {
                // Nothing said it is an answer, and lists no rows.
                Some(found) if found.is_empty() => clauses.push("0".to_owned()),
                Some(found) => {
                    clauses.push(format!(
                        "lower(s.session_id) IN ({})",
                        vec!["?"; found.len()].join(", ")
                    ));
                    filter.extend(found.keys().cloned().map(SqlValue::Text));
                }
                None => {
                    let pattern = like_pattern(search);
                    clauses.push(
                        "(s.session_id IN (SELECT session_id FROM history_prompts WHERE text LIKE ? ESCAPE '\\')
                          OR s.project_key LIKE ? ESCAPE '\\'
                          OR n.name LIKE ? ESCAPE '\\')"
                            .to_owned(),
                    );
                    filter.push(SqlValue::Text(pattern.clone()));
                    filter.push(SqlValue::Text(like_pattern(&search.to_lowercase())));
                    filter.push(SqlValue::Text(pattern.clone()));
                    like = Some(pattern);
                }
            }
        }
        if let Some(project) = query.project.as_deref().map(str::trim)
            && !project.is_empty()
        {
            clauses.push("s.project_key = ?".to_owned());
            filter.push(SqlValue::Text(project.to_lowercase()));
        }
        if query.resumable_only == Some(true) {
            clauses.push("s.transcript_file IS NOT NULL AND s.project_exists = 1".to_owned());
        }
        let where_clause = if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        };
        let limit = query.limit.unwrap_or(DEFAULT_LIMIT).max(1);

        // Only a prompt search pays for the matching prompt; a message
        // search has its match from the archive already.
        let match_column = if like.is_some() {
            ", (SELECT p.text FROM history_prompts p
                WHERE p.session_id = s.session_id AND p.text LIKE ? ESCAPE '\\'
                ORDER BY p.seq LIMIT 1) AS matched"
        } else {
            ", NULL AS matched"
        };
        let mut select_params: Vec<SqlValue> = like.into_iter().map(SqlValue::Text).collect();
        select_params.extend(filter.iter().cloned());
        select_params.push(SqlValue::Integer(i64::from(limit)));

        let fail = sql("read history sessions");
        let mut statement = self
            .conn
            .prepare(&format!(
                "{SESSION_COLUMNS}{match_column}
                 FROM history_sessions s {JOINS}
                 {where_clause}
                 ORDER BY s.last_at DESC, s.session_id
                 LIMIT ?"
            ))
            .map_err(sql("read history sessions"))?;
        let mut sessions = statement
            .query_map(params_from_iter(select_params), |row| self.session_row(row))
            .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
            .map_err(fail)?;
        let total: i64 = self
            .conn
            .query_row(
                &format!("SELECT COUNT(*) FROM history_sessions s {JOINS} {where_clause}"),
                params_from_iter(filter),
                |row| row.get(0),
            )
            .map_err(sql("count history sessions"))?;

        if let Some(found) = &archived {
            for session in &mut sessions {
                if let Some(hit) = found.get(&session.session_id.to_lowercase()) {
                    session.matched = Some(hit.clone());
                }
            }
        }
        Ok(HistoryPage {
            sessions,
            total: to_u32(total),
            took_ms: started.elapsed().as_secs_f64() * 1000.0,
        })
    }

    /// One session's prompts, in submission order.
    pub fn prompts(&self, session_id: &str) -> Result<Vec<HistoryPrompt>> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT seq, session_id, at, text FROM history_prompts
                 WHERE session_id = ? ORDER BY seq",
            )
            .map_err(sql("read history prompts"))?;
        statement
            .query_map([session_id], |row| {
                Ok(HistoryPrompt {
                    seq: to_u64(row.get(0)?),
                    session_id: row.get(1)?,
                    at: to_u64(row.get(2)?),
                    text: row.get(3)?,
                })
            })
            .and_then(Iterator::collect)
            .map_err(sql("read history prompts"))
    }

    /// The recorded folders, most recently active first. One folder recorded
    /// under two casings is one project.
    pub fn projects(&self) -> Result<Vec<HistoryProject>> {
        let mut statement = self
            .conn
            .prepare(
                "SELECT MAX(project), COUNT(*), SUM(prompt_count), MAX(last_at),
                        SUM(CASE WHEN transcript_file IS NOT NULL AND project_exists = 1
                                 THEN 1 ELSE 0 END),
                        MAX(project_exists)
                 FROM history_sessions
                 GROUP BY project_key
                 ORDER BY MAX(last_at) DESC",
            )
            .map_err(sql("read history projects"))?;
        statement
            .query_map([], |row| {
                let project: String = row.get(0)?;
                Ok(HistoryProject {
                    name: project_name(&project),
                    project,
                    sessions: to_u32(row.get(1)?),
                    prompts: to_u32(row.get(2)?),
                    last_at: to_u64(row.get(3)?),
                    resumable: to_u32(row.get(4)?),
                    exists: row.get::<_, i64>(5)? == 1,
                })
            })
            .and_then(Iterator::collect)
            .map_err(sql("read history projects"))
    }

    /// What the index holds now, fed from `record`.
    pub fn summary(&self, record: &str) -> Result<HistorySummary> {
        let (sessions, prompts, projects, latest, resumable): (i64, i64, i64, i64, Option<i64>) =
            self.conn
                .query_row(
                    "SELECT COUNT(*), COALESCE(SUM(prompt_count), 0), COUNT(DISTINCT project_key),
                            COALESCE(MAX(last_at), 0),
                            SUM(CASE WHEN transcript_file IS NOT NULL AND project_exists = 1
                                     THEN 1 ELSE 0 END)
                     FROM history_sessions",
                    [],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .map_err(sql("read the history summary"))?;
        Ok(HistorySummary {
            sessions: to_u32(sessions),
            prompts: to_u32(prompts),
            projects: to_u32(projects),
            resumable: resumable.map_or(0, to_u32),
            latest_at: (latest > 0).then(|| to_u64(latest)),
            history_file: record.to_owned(),
            indexed_bytes: self.cursor(record)?,
            error: None,
        })
    }

    /// One session by id, whatever case it is asked with, or `None`.
    pub fn session(&self, session_id: &str) -> Result<Option<HistorySession>> {
        self.conn
            .query_row(
                &format!(
                    "{SESSION_COLUMNS}, NULL AS matched
                     FROM history_sessions s {JOINS}
                     WHERE lower(s.session_id) = lower(?)
                     ORDER BY s.session_id = ? DESC
                     LIMIT 1"
                ),
                [session_id, session_id],
                |row| self.session_row(row),
            )
            .optional()
            .map_err(sql("read a history session"))
    }

    /// Names a session by hand, or clears its name when `name` is null or
    /// only whitespace, so it reads with its derived title again. The name
    /// is kept apart from the derived rows, so a rebuild keeps it. Control
    /// and format characters become spaces: they are invisible in a field
    /// and reorder the row they land in. `None` for a session the index
    /// does not have, and nothing is written for it.
    pub fn rename(&self, session_id: &str, name: Option<&str>) -> Result<Option<HistorySession>> {
        if self.session(session_id)?.is_none() {
            return Ok(None);
        }
        let key = session_id.to_lowercase();
        let clean = clean_name(name.unwrap_or(""));
        if clean.is_empty() {
            self.conn
                .execute("DELETE FROM history_names WHERE session_id = ?", [&key])
                .map_err(sql("clear a history name"))?;
        } else {
            let kept: String = clean.chars().take(HISTORY_NAME_MAX).collect();
            self.conn
                .execute(
                    "INSERT INTO history_names (session_id, name, renamed_at)
                     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                     ON CONFLICT(session_id) DO UPDATE SET
                       name = excluded.name, renamed_at = excluded.renamed_at",
                    params![key, kept],
                )
                .map_err(sql("name a history session"))?;
        }
        self.session(session_id)
    }

    fn session_row(&self, row: &Row<'_>) -> rusqlite::Result<HistorySession> {
        let project: String = row.get("project")?;
        let first_prompt: String = row.get("first_prompt")?;
        let title_prompt: Option<String> = row.get("title_prompt")?;
        // Derived at read time from which prompt was chosen, so a change to
        // the rule reaches rows an older build indexed.
        let title = session_title_from(&[title_prompt.unwrap_or_else(|| first_prompt.clone())]);
        let archive = row
            .get::<_, Option<String>>("archive_state")?
            .and_then(|state| match state.as_str() {
                "archived" => Some(ArchiveSessionState::Archived),
                "evicted" => Some(ArchiveSessionState::Evicted),
                _ => None,
            });
        Ok(HistorySession {
            session_id: row.get("session_id")?,
            backend: self.backend.clone(),
            project_name: project_name(&project),
            project,
            prompt_count: to_u32(row.get("prompt_count")?),
            first_at: to_u64(row.get("first_at")?),
            last_at: to_u64(row.get("last_at")?),
            first_prompt,
            title: title.text,
            title_fallback: title.fallback,
            label: row.get("label")?,
            transcript_file: row.get("transcript_file")?,
            transcript_bytes: row.get::<_, Option<i64>>("transcript_bytes")?.map(to_u64),
            project_exists: row.get::<_, i64>("project_exists")? == 1,
            archive,
            archived_messages: row.get::<_, Option<i64>>("archived_messages")?.map(to_u32),
            matched: row.get("matched")?,
        })
    }
}

/// The columns every session read takes, with what the archive holds for it
/// and the name given by hand joined on: which of those a row has is a
/// property of the row, read in the same query.
const SESSION_COLUMNS: &str =
    "SELECT s.session_id, s.project, s.prompt_count, s.first_at, s.last_at,
        s.first_prompt, s.title_prompt, s.transcript_file, s.transcript_bytes, s.project_exists,
        a.state AS archive_state,
        CASE WHEN a.session_id IS NULL THEN NULL ELSE a.message_count END AS archived_messages,
        n.name AS label";

const JOINS: &str = "LEFT JOIN transcript_sessions a ON a.session_id = lower(s.session_id)
     LEFT JOIN history_names n ON n.session_id = lower(s.session_id)";

/// Ranks the prompts with no rank yet, and says how many there were.
fn rank_unranked(tx: &Connection) -> rusqlite::Result<usize> {
    let rows: Vec<(i64, String)> = tx
        .prepare("SELECT seq, text FROM history_prompts WHERE title_rank IS NULL")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut set = tx.prepare("UPDATE history_prompts SET title_rank = ? WHERE seq = ?")?;
    for (seq, text) in &rows {
        set.execute(params![title_rank(text), seq])?;
    }
    Ok(rows.len())
}

/// Every session row again from the prompts. `project` and `first_prompt`
/// are the earliest prompt's, joined back on its `seq`; `title_prompt` is
/// the earliest that says something, failing that the earliest that is
/// legible. The transcript columns are left alone, and so is
/// `history_names`.
fn rebuild_sessions(tx: &Connection) -> rusqlite::Result<()> {
    tx.execute(
        "INSERT INTO history_sessions (
           session_id, project, project_key, prompt_count,
           first_at, last_at, first_prompt, title_prompt,
           transcript_file, transcript_bytes, project_exists
         )
         SELECT a.session_id, f.project, lower(f.project), a.n,
                a.first_at, a.last_at, f.text, COALESCE(t.text, f.text),
                NULL, NULL, 0
         FROM (
           SELECT session_id,
                  COUNT(*) AS n,
                  MIN(at)  AS first_at,
                  MAX(at)  AS last_at,
                  MIN(seq) AS first_seq,
                  COALESCE(
                    MIN(CASE WHEN title_rank = 0 THEN seq END),
                    MIN(CASE WHEN title_rank = 1 THEN seq END)
                  ) AS title_seq
           FROM history_prompts
           GROUP BY session_id
         ) a
         JOIN history_prompts f ON f.seq = a.first_seq
         LEFT JOIN history_prompts t ON t.seq = a.title_seq
         WHERE true
         ON CONFLICT(session_id) DO UPDATE SET
           project      = excluded.project,
           project_key  = excluded.project_key,
           prompt_count = excluded.prompt_count,
           first_at     = excluded.first_at,
           last_at      = excluded.last_at,
           first_prompt = excluded.first_prompt,
           title_prompt = excluded.title_prompt",
        [],
    )?;
    tx.execute(
        "DELETE FROM history_sessions
         WHERE session_id NOT IN (SELECT session_id FROM history_prompts)",
        [],
    )?;
    Ok(())
}

/// What is on disk now, not what was when the row was written.
fn apply_transcripts(
    tx: &Connection,
    transcripts: &BTreeMap<String, TranscriptFile>,
) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE history_sessions SET transcript_file = NULL, transcript_bytes = NULL",
        [],
    )?;
    let mut mark = tx.prepare(
        "UPDATE history_sessions SET transcript_file = ?, transcript_bytes = ?
         WHERE lower(session_id) = ?",
    )?;
    for (id, transcript) in transcripts {
        mark.execute(params![
            transcript.file,
            to_i64(transcript.bytes),
            id.to_lowercase()
        ])?;
    }
    Ok(())
}

/// One look per distinct recorded folder. A project recorded under several
/// casings exists when any of them does: on a case-sensitive file system only
/// the spelling on disk answers.
fn apply_project_existence(tx: &Connection, exists: &dyn Fn(&str) -> bool) -> rusqlite::Result<()> {
    let rows: Vec<(String, String)> = tx
        .prepare("SELECT DISTINCT project, project_key FROM history_sessions")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut found: HashMap<String, bool> = HashMap::new();
    for (project, key) in rows {
        if found.get(&key) == Some(&true) {
            continue;
        }
        found.insert(key, exists(&project));
    }
    let mut set =
        tx.prepare("UPDATE history_sessions SET project_exists = ? WHERE project_key = ?")?;
    for (key, present) in found {
        set.execute(params![i64::from(present), key])?;
    }
    Ok(())
}

/// How usable a prompt is as a title: 0 says something, 1 is legible but
/// says nothing on its own (`/usage`), 2 has nothing left once cleaned.
///
/// The title rule is [`session_title_from`], which picks the first prompt
/// of rank 0, failing that of rank 1. Its rank is read back from it exactly:
/// a prompt has rank 2 when its own title is a stand-in; otherwise, put
/// before [`RANK_PROBE`] (rank 0), it is chosen over the probe only when it
/// is rank 0. Its title cannot equal the probe's when it is rank 1, because
/// the probe is short enough never to be cut and a prompt cleaned to the
/// probe's text has the probe's rank.
fn title_rank(text: &str) -> i64 {
    let alone = session_title_from(&[text.to_owned()]);
    if alone.fallback {
        return 2;
    }
    let before_probe = session_title_from(&[text.to_owned(), RANK_PROBE.to_owned()]);
    if before_probe.text == alone.text {
        0
    } else {
        1
    }
}

/// A prompt of rank 0, short enough never to be cut.
const RANK_PROBE: &str = "rank probe";

/// A search box's text as a LIKE pattern matching it anywhere, with LIKE's
/// own wildcards made literal.
fn like_pattern(search: &str) -> String {
    let mut escaped = String::with_capacity(search.len() + 2);
    escaped.push('%');
    for c in search.chars() {
        if matches!(c, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped.push('%');
    escaped
}

/// A name as typed, made safe for the row it lands in.
fn clean_name(name: &str) -> String {
    let spaced: String = name
        .chars()
        .map(|c| if is_other(c) { ' ' } else { c })
        .collect();
    spaced.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Unicode's "other" characters: control, format (zero-width and
/// direction marks among them) and private use.
fn is_other(c: char) -> bool {
    c.is_control()
        || matches!(c,
            '\u{00AD}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061C}'
            | '\u{06DD}'
            | '\u{070F}'
            | '\u{0890}'..='\u{0891}'
            | '\u{08E2}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{110BD}'
            | '\u{110CD}'
            | '\u{13430}'..='\u{1343F}'
            | '\u{1BCA0}'..='\u{1BCA3}'
            | '\u{1D173}'..='\u{1D17A}'
            | '\u{E0001}'
            | '\u{E0020}'..='\u{E007F}'
            | '\u{E000}'..='\u{F8FF}'
            | '\u{F0000}'..='\u{FFFFD}'
            | '\u{100000}'..='\u{10FFFD}')
}

/// The last segment of a recorded folder, or the folder itself.
fn project_name(project: &str) -> String {
    Path::new(project)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(project)
        .to_owned()
}

pub(super) fn to_u64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

pub(super) fn to_u32(value: i64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

pub(super) fn to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prompts_rank_is_read_back_from_the_title_rule() {
        assert_eq!(title_rank("fix the login page redirect"), 0);
        assert_eq!(title_rank("/spec:quick when a user goes to admin"), 0);
        assert_eq!(title_rank("/usage"), 1);
        assert_eq!(title_rank("ok"), 1);
        assert_eq!(title_rank(RANK_PROBE), 0);
        assert_eq!(title_rank("[Image #1]"), 2);
        assert_eq!(title_rank(""), 2);
    }

    #[test]
    fn like_wildcards_typed_in_a_search_are_literal() {
        assert_eq!(like_pattern("50%"), "%50\\%%");
        assert_eq!(like_pattern("a_b\\c"), "%a\\_b\\\\c%");
    }

    #[test]
    fn a_name_loses_the_characters_that_would_corrupt_its_row() {
        assert_eq!(clean_name("alpha beta\u{200B}gamma"), "alpha beta gamma");
        assert_eq!(clean_name("  two\t\nlines  "), "two lines");
        assert_eq!(clean_name("\u{202E}reversed"), "reversed");
    }
}
