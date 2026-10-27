//! Claude Code's conversations, read from its transcripts and nothing else.
//!
//! A conversation's transcript is `<config>/projects/<folder>/<id>.jsonl`.
//! It is found by scanning every project folder for `<id>.jsonl`, never by
//! deriving the folder name from where it ran: the CLI's naming of that
//! folder is its own business. Reads only; nothing under the config folder
//! is written.
//!
//! `text` and `thinking` blocks are kept whole, a `tool_use` becomes a
//! one-line marker naming the tool, and `tool_result`s are dropped. An
//! unusable line is skipped, not fatal, and rows are de-duplicated by their
//! own `uuid`, because a forked conversation copies its parent's rows.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::SystemTime;

use floti_protocol::channels::sessions::{ArchiveMessage, ArchiveRole};
use serde_json::Value;

use super::time::parse_instant;
use super::title::session_title_from;
use crate::agent::{Conversation, Transcript};
use crate::{Error, Result};

/// A transcript's conversation as last read, with the size and
/// modification time it was read at.
type Seen = HashMap<PathBuf, (u64, Option<SystemTime>, Conversation)>;

/// The conversations last read under each config folder. A transcript is
/// parsed again only when its size or modification time moved, so listing
/// the conversations costs a directory scan once they have been read.
static SEEN: LazyLock<Mutex<HashMap<PathBuf, Seen>>> = LazyLock::new(Mutex::default);

/// Every conversation with a transcript on disk, most recent first.
pub(super) fn conversations(config_dir: &Path) -> Result<Vec<Conversation>> {
    let files = transcripts(config_dir)?;
    let mut before = SEEN
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(config_dir)
        .unwrap_or_default();
    let mut now = Seen::with_capacity(files.len());
    for (id, file) in files {
        let Ok(meta) = std::fs::metadata(&file) else {
            continue;
        };
        let stamp = (meta.len(), meta.modified().ok());
        let conversation = match before.remove(&file) {
            Some((len, modified, conversation)) if (len, modified) == stamp => conversation,
            _ => match read(&id, &file) {
                Some((conversation, _)) => conversation,
                None => continue,
            },
        };
        now.insert(file, (stamp.0, stamp.1, conversation));
    }
    let mut found: Vec<Conversation> = now
        .values()
        .map(|(_, _, conversation)| conversation.clone())
        .collect();
    SEEN.lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(config_dir.to_path_buf(), now);
    found.sort_by(|a, b| b.last_at_ms.cmp(&a.last_at_ms).then(a.id.cmp(&b.id)));
    Ok(found)
}

/// One conversation's messages, or `None` when no transcript holds it.
pub(super) fn transcript(config_dir: &Path, id: &str) -> Result<Option<Transcript>> {
    let id = id.to_lowercase();
    // Where the last listing found it, which spares a scan of every project
    // folder for each conversation a pass reads; a scan when it has moved.
    let listed = SEEN
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(config_dir)
        .and_then(|seen| {
            seen.iter()
                .find(|(_, (_, _, conversation))| conversation.id == id)
                .map(|(file, _)| file.clone())
        })
        .filter(|file| file.is_file());
    let file = match listed {
        Some(file) => file,
        None => match transcripts(config_dir)?.remove(&id) {
            Some(file) => file,
            None => return Ok(None),
        },
    };
    Ok(read(&id, &file).map(|(conversation, messages)| Transcript {
        conversation,
        messages,
    }))
}

/// Each conversation id with its transcript. Where one id is in two project
/// folders the larger file is kept, the fuller record of the two.
fn transcripts(config_dir: &Path) -> Result<BTreeMap<String, PathBuf>> {
    let projects = config_dir.join("projects");
    let entries = match std::fs::read_dir(&projects) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(source) => return Err(Error::path("list", &projects, source)),
    };
    let mut found: BTreeMap<String, (PathBuf, u64)> = BTreeMap::new();
    for project in entries.flatten() {
        let Ok(kind) = project.file_type() else {
            continue;
        };
        if !kind.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            let Some(id) = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_suffix(".jsonl"))
                .filter(|stem| is_uuid(stem))
                .map(str::to_lowercase)
            else {
                continue;
            };
            let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
            match found.get(&id) {
                Some((_, kept)) if *kept >= size => {}
                _ => {
                    found.insert(id, (path, size));
                }
            }
        }
    }
    Ok(found
        .into_iter()
        .map(|(id, (path, _))| (id, path))
        .collect())
}

fn is_uuid(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(group, len)| group.len() == len && group.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// A transcript's conversation and messages, or `None` when it cannot be
/// read.
fn read(id: &str, file: &Path) -> Option<(Conversation, Vec<ArchiveMessage>)> {
    let text = std::fs::read_to_string(file).ok()?;
    let mut seen = HashSet::new();
    let mut messages = Vec::new();
    let mut prompts = Vec::new();
    let mut folder = None;
    for line in text.lines().filter(|line| !line.is_empty()) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if folder.is_none() {
            folder = value
                .get("cwd")
                .and_then(Value::as_str)
                .filter(|cwd| !cwd.is_empty())
                .map(str::to_owned);
        }
        let Some(message) = message(&value) else {
            continue;
        };
        if !seen.insert(message.uuid.clone()) {
            continue;
        }
        if message.role == ArchiveRole::User {
            prompts.push(message.text.clone());
        }
        messages.push(message);
    }
    let title = session_title_from(&prompts);
    Some((
        Conversation {
            id: id.to_owned(),
            folder,
            title: title.text,
            title_fallback: title.fallback,
            first_at_ms: messages.iter().map(|message| message.at).min(),
            last_at_ms: messages.iter().map(|message| message.at).max(),
            file: file.to_path_buf(),
        },
        messages,
    ))
}

/// One transcript row as a message somebody said, or `None` for every other
/// row: system rows, attachments, the caveats the CLI injects (`isMeta`), and
/// a message with nothing to read.
fn message(value: &Value) -> Option<ArchiveMessage> {
    let role = match value.get("type")?.as_str()? {
        "user" => ArchiveRole::User,
        "assistant" => ArchiveRole::Assistant,
        _ => return None,
    };
    if value.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let uuid = value
        .get("uuid")?
        .as_str()
        .filter(|uuid| !uuid.is_empty())?;
    let at = parse_instant(value.get("timestamp")?.as_str()?)?;
    let text = message_text(value.get("message")?.get("content")?);
    (!text.is_empty()).then(|| ArchiveMessage {
        uuid: uuid.to_owned(),
        role,
        at,
        text,
    })
}

/// The readable text of one message's content, blocks joined by blank lines.
pub(super) fn message_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.trim().to_owned();
    }
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    blocks
        .iter()
        .filter_map(block_text)
        .collect::<Vec<_>>()
        .join("\n\n")
        .trim()
        .to_owned()
}

fn block_text(block: &Value) -> Option<String> {
    if let Some(text) = block.as_str() {
        return (!text.is_empty()).then(|| text.to_owned());
    }
    let field = |key: &str| {
        block
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    match block.get("type")?.as_str()? {
        "text" => field("text"),
        "thinking" => field("thinking"),
        "tool_use" => Some(match field("name") {
            Some(name) => format!("[tool: {name}]"),
            None => "[tool]".to_owned(),
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn row(kind: &str, content: Value) -> Value {
        json!({
            "type": kind,
            "uuid": "00000000-0000-4000-8000-000000000001",
            "sessionId": "sess",
            "timestamp": "2025-10-09T08:53:20.000Z",
            "message": { "content": content },
        })
    }

    #[test]
    fn user_and_assistant_messages_are_kept_and_nothing_else() {
        assert_eq!(
            message(&row("user", json!("hello"))).map(|m| m.role),
            Some(ArchiveRole::User)
        );
        assert_eq!(
            message(&row("assistant", json!([{ "type": "text", "text": "hi" }]))).map(|m| m.role),
            Some(ArchiveRole::Assistant)
        );
        for kind in [
            "system",
            "attachment",
            "file-history-snapshot",
            "queue-operation",
            "mode",
        ] {
            assert_eq!(message(&row(kind, json!("hello"))), None, "{kind}");
        }
    }

    #[test]
    fn a_row_that_is_not_usable_is_skipped() {
        assert_eq!(message(&json!([])), None);
        assert_eq!(message(&json!({ "type": "user" })), None);
        // No timestamp to read is a row with no place on a time axis.
        assert_eq!(
            message(&json!({
                "type": "user", "uuid": "u", "timestamp": "never",
                "message": { "content": "x" },
            })),
            None
        );
    }

    #[test]
    fn the_caveats_the_cli_injects_around_a_slash_command_are_skipped() {
        let mut caveat = row("user", json!("Caveat: the messages below were generated"));
        caveat["isMeta"] = json!(true);
        assert_eq!(message(&caveat), None);
    }

    #[test]
    fn text_and_thinking_are_kept_tools_are_marked_and_their_results_dropped() {
        let content = json!([
            { "type": "text", "text": "first" },
            { "type": "thinking", "thinking": "second" },
            { "type": "tool_use", "name": "Read", "input": { "file": "x".repeat(10_000) } },
            { "type": "tool_result", "content": "y".repeat(10_000) },
            { "type": "image", "source": {} },
        ]);
        assert_eq!(message_text(&content), "first\n\nsecond\n\n[tool: Read]");
    }

    #[test]
    fn a_plain_string_content_is_taken_as_it_is() {
        assert_eq!(message_text(&json!("  just words  ")), "just words");
    }

    #[test]
    fn a_message_nobody_said_anything_in_is_empty_and_not_kept() {
        let results = json!([{ "type": "tool_result", "content": "x" }]);
        assert_eq!(message_text(&results), "");
        assert_eq!(message_text(&Value::Null), "");
        assert_eq!(message(&row("user", results)), None);
    }
}
