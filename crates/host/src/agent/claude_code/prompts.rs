//! Claude Code's prompt record, `<config>/history.jsonl`: every prompt ever
//! submitted, on every project, appended to and never rewritten. It is the
//! list of conversations; the transcripts under `projects/` say which of them
//! can still be opened, and the CLI reaps those on its own schedule.
//!
//! Read a tail at a time from a byte cursor, because the file only grows and
//! re-reading it whole to learn of one prompt stops being affordable. Reads
//! only; the file is not a credential, and nothing in the config folder is
//! written.

use std::fs::File;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::agent::PromptTail;
use crate::history::index::PromptLine;

/// The record in `config_dir`.
pub(super) fn history_file(config_dir: &Path) -> PathBuf {
    config_dir.join("history.jsonl")
}

/// The prompts `file` holds past `from` bytes.
///
/// A file smaller than the cursor is a different file (rotated, cleared, or
/// another config folder) and is read again from the start, marked as a
/// reset; so is one that is gone. Everything after the last line break is a
/// record still being written and is left for the next read. A line that is
/// not a usable record is counted and skipped.
pub(super) fn read_since(file: &Path, from: u64) -> PromptTail {
    let tail = read_tail(file, from);
    if tail.error.is_some() {
        return PromptTail {
            lines: Vec::new(),
            bytes: tail.bytes,
            reset: tail.reset,
            skipped: 0,
            error: tail.error,
        };
    }
    let mut lines = Vec::new();
    let mut skipped = 0;
    for raw in tail.text.split('\n') {
        if raw.trim().is_empty() {
            continue;
        }
        match parse_line(raw) {
            Some(line) => lines.push(line),
            None => skipped += 1,
        }
    }
    PromptTail {
        lines,
        bytes: tail.bytes,
        reset: tail.reset,
        skipped,
        error: None,
    }
}

/// Complete lines past a cursor.
struct Tail {
    text: String,
    /// The byte after the last line break read, where the next read resumes.
    bytes: u64,
    reset: bool,
    error: Option<String>,
}

/// Bytes `from`..end of `file`, cut back to the last complete line.
fn read_tail(file: &Path, from: u64) -> Tail {
    let size = match std::fs::metadata(file) {
        Ok(meta) => meta.len(),
        Err(err) => {
            return Tail {
                text: String::new(),
                bytes: 0,
                reset: true,
                error: Some(err.to_string()),
            };
        }
    };
    let reset = size < from;
    let start = if reset { 0 } else { from };
    if size == start {
        return Tail {
            text: String::new(),
            bytes: size,
            reset,
            error: None,
        };
    }
    let read = || -> std::io::Result<Vec<u8>> {
        let mut handle = File::open(file)?;
        handle.seek(SeekFrom::Start(start))?;
        let mut chunk = Vec::with_capacity(usize::try_from(size - start).unwrap_or(0));
        handle.take(size - start).read_to_end(&mut chunk)?;
        Ok(chunk)
    };
    let mut chunk = match read() {
        Ok(chunk) => chunk,
        Err(err) => {
            return Tail {
                text: String::new(),
                bytes: from,
                reset: false,
                error: Some(err.to_string()),
            };
        }
    };
    // The fragment after the last break is held back by its byte length, so
    // the cursor always lands just after a `\n`, which never sits inside a
    // UTF-8 sequence.
    let complete = chunk
        .iter()
        .rposition(|&byte| byte == b'\n')
        .map_or(0, |at| at + 1);
    chunk.truncate(complete);
    Tail {
        text: String::from_utf8_lossy(&chunk).into_owned(),
        bytes: start + complete as u64,
        reset,
        error: None,
    }
}

/// One line as a prompt: JSON whose `sessionId` and `project` are non-empty
/// strings and whose `timestamp` is a number. Nothing is assumed about the
/// rest. A prompt submitted as an empty line is still a submission, so a
/// `display` that is not a string reads as empty rather than dropping it.
fn parse_line(raw: &str) -> Option<PromptLine> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let record = value.as_object()?;
    let non_empty = |key: &str| {
        record
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let session_id = non_empty("sessionId")?;
    let project = non_empty("project")?;
    let timestamp = record.get("timestamp")?;
    // Epoch ms. A fractional one is cut to the millisecond; `as` holds a
    // negative one at zero.
    let at = timestamp
        .as_u64()
        .or_else(|| timestamp.as_f64().map(|ms| ms as u64))?;
    Some(PromptLine {
        session_id,
        project,
        at,
        text: record
            .get("display")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    })
}
