//! History and the transcript archive, in `floti.db`, built from a
//! backend's own history ([`HistorySource`]) and nothing else.
//!
//! - [`index`]: the history index, the conversations and their prompts.
//! - [`archive`]: the transcript archive, the conversations kept after the
//!   agent deletes them, under a ceiling.
//!
//! [`index_history`] is one pass over a backend's history into both. A pass
//! reads the agent's prompt record, where it keeps one, and its transcripts
//! without holding the store, then writes what it read in its own
//! transactions. Only what the record gained and a transcript that changed
//! since the last pass are read again; nothing in the agent's folder is ever
//! written.

pub mod archive;
pub mod index;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::MutexGuard;

use floti_protocol::BackendId;
use floti_protocol::channels::sessions::{ArchiveRole, ArchiveStats, HistorySummary};
use rusqlite::Connection;

use crate::agent::HistorySource;
use crate::store::Store;
use crate::{Error, Result};

use archive::ArchiveInput;
use index::{HistoryIndex, IndexInput, PromptLine, TranscriptFile};

/// A failed statement as an error naming what the host was doing.
pub(crate) fn sql(action: &'static str) -> impl FnOnce(rusqlite::Error) -> Error {
    move |err| Error::io(action, std::io::Error::other(err))
}

/// What a pass left the index and the archive holding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Indexed {
    pub summary: HistorySummary,
    pub stats: ArchiveStats,
}

/// What the index and the archive hold now, without a pass.
pub fn read_indexed(conn: &Connection, backend: &BackendId) -> Result<Indexed> {
    let index = HistoryIndex::new(conn, backend);
    let record = index.last_record()?.unwrap_or_default();
    Ok(Indexed {
        summary: index.summary(&record)?,
        stats: archive::read_stats(conn, archive::ceiling(conn)?)?,
    })
}

/// Whether a recorded folder is still a folder.
pub fn directory_exists(folder: &str) -> bool {
    Path::new(folder).is_dir()
}

/// One pass over `source`, `backend`'s history, into the index and the
/// archive in the store `lock` opens.
///
/// Where the backend keeps a prompt record, the index is fed what the record
/// gained since its cursor, and every conversation it names is a session,
/// whether or not its transcript survives. Where it keeps none, every
/// conversation with a transcript is a session and its prompts are what its
/// transcript says the person submitted. Either way a transcript is read
/// again, for its messages for the archive, only when it changed size since
/// the last pass, and a conversation whose transcript has gone stays in
/// both, marked as no longer on disk. When the transcripts cannot be listed
/// at all, nothing indexed is touched and the summary says why.
///
/// The store is held only to write, and for one transcript's messages at a
/// time, so a first pass over a long history does not keep sessions waiting
/// on it. `keep_going` is asked between transcripts: once it says no, the
/// pass writes nothing more and returns what is indexed, and the next pass
/// carries on from there, because a transcript's cursor moves only with its
/// messages.
pub fn index_history<'s>(
    lock: impl Fn() -> MutexGuard<'s, Store>,
    source: &dyn HistorySource,
    backend: &BackendId,
    keep_going: &dyn Fn() -> bool,
) -> Result<Indexed> {
    let conversations = match source.conversations() {
        Ok(conversations) => conversations,
        Err(err) => {
            let store = lock();
            let mut indexed = read_indexed(store.connection(), backend)?;
            indexed.summary.error = Some(err.to_string());
            return Ok(indexed);
        }
    };
    let cursors = archive::indexed_files(lock().connection())?;
    // Read before the transcripts are listed, as today's app does: a prompt
    // appended in between finds its transcript on this pass or the next.
    let recorded = match source.prompt_record() {
        Some(record) => {
            let file = record.prompt_file().display().to_string();
            let cursor = {
                let store = lock();
                HistoryIndex::new(store.connection(), backend).cursor(&file)?
            };
            Some((file, record.prompts_since(cursor)))
        }
        None => None,
    };

    let mut transcripts = BTreeMap::new();
    let mut replaced = BTreeSet::new();
    let mut lines = Vec::new();
    let mut tails = Vec::new();
    let mut record = None;
    for conversation in conversations {
        if !keep_going() {
            return read_indexed(lock().connection(), backend);
        }
        let Ok(meta) = std::fs::metadata(&conversation.file) else {
            continue;
        };
        let file = conversation.file.display().to_string();
        let bytes = meta.len();
        record = record.or_else(|| {
            conversation
                .file
                .parent()
                .and_then(Path::parent)
                .map(|projects| projects.display().to_string())
        });
        transcripts.insert(
            conversation.id.clone(),
            TranscriptFile {
                file: file.clone(),
                bytes,
            },
        );
        if cursors.get(&file) == Some(&bytes) {
            continue;
        }
        let Some(transcript) = source.transcript(&conversation.id)? else {
            continue;
        };
        // With a prompt record the transcript is read for the archive only.
        if recorded.is_none() {
            replaced.insert(conversation.id.clone());
            if let Some(project) = &transcript.conversation.folder {
                lines.extend(
                    transcript
                        .messages
                        .iter()
                        .filter(|message| message.role == ArchiveRole::User)
                        .map(|message| PromptLine {
                            session_id: conversation.id.clone(),
                            project: project.clone(),
                            at: message.at,
                            text: message.text.clone(),
                        }),
                );
            }
        }
        tails.push((conversation.id, file, bytes, transcript.messages));
    }

    let summary = {
        let store = lock();
        let index = HistoryIndex::new(store.connection(), backend);
        let none_replaced = BTreeSet::new();
        let transcript_record: String;
        let input = match &recorded {
            Some((file, tail)) => IndexInput {
                record: file,
                bytes: tail.bytes,
                reset: tail.reset,
                replaced: &none_replaced,
                lines: &tail.lines,
                transcripts: &transcripts,
                directory_exists: &directory_exists,
                error: tail.error.clone(),
            },
            None => {
                let record = match record {
                    Some(record) => record,
                    None => index.last_record()?.unwrap_or_default(),
                };
                transcript_record = record;
                IndexInput {
                    record: &transcript_record,
                    bytes: transcripts
                        .values()
                        .map(|transcript| transcript.bytes)
                        .sum(),
                    reset: false,
                    replaced: &replaced,
                    lines: &lines,
                    transcripts: &transcripts,
                    directory_exists: &directory_exists,
                    error: None,
                }
            }
        };
        index.index(&input)?
    };
    for (session_id, file, bytes, messages) in &tails {
        if !keep_going() {
            break;
        }
        archive::archive_transcript(
            lock().connection(),
            &ArchiveInput {
                file,
                session_id,
                bytes: *bytes,
                messages,
            },
        )?;
    }
    let store = lock();
    let conn = store.connection();
    let on_disk: BTreeSet<&String> = transcripts
        .values()
        .map(|transcript| &transcript.file)
        .collect();
    archive::forget_files(conn, cursors.keys().filter(|file| !on_disk.contains(file)))?;
    let ceiling = archive::ceiling(conn)?;
    archive::evict_to_ceiling(conn, ceiling)?;
    Ok(Indexed {
        summary,
        stats: archive::read_stats(conn, ceiling)?,
    })
}
