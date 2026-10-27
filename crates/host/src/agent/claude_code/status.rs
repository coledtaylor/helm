//! Claude Code's own records of its live sessions, read.
//!
//! The CLI keeps one file per running session at
//! `<config>/sessions/<pid>.json` saying what it is doing: `busy`, `shell`,
//! `idle` or `waiting`. A clean exit removes the file and a hard kill leaves
//! it, so a record is believed only while its process is provably running.
//! The first record of a session has no status yet; a record with none, or
//! one this reader does not recognise, is Unknown and the tab stays plain.
//!
//! The records are machine-wide: a `claude` started in any terminal registers
//! beside the ones the host runs. [`registry`] hands back every live one;
//! joining them to the host's sessions is `join_record`, one layer up.
//!
//! **`.json` files only.** Beside each record the CLI writes
//! `<pid>.<sha256>.key`, holding a bearer token for its own
//! session-to-session channel. Those are credentials: this reader skips them
//! by name and never opens one.

use std::path::Path;

use floti_protocol::Knowable;
use floti_protocol::channels::sessions::SessionActivity;
use serde_json::Value;

use crate::agent::{LiveRecord, SessionRef};
use crate::platform::process_tree::ProcessTree;

/// Whether `path` is one of the credential files beside the records.
pub(super) fn is_session_key(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("key"))
}

/// Every record in `dir`, live or not, each as far as it could be read:
/// `None` for one that could not be, with the file's name.
fn records(dir: &Path) -> Option<Vec<(String, Option<LiveRecord>)>> {
    let entries = std::fs::read_dir(dir).ok()?;
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_record = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("json"));
        if !is_record {
            continue;
        }
        let Some(file) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let record = std::fs::read(&path)
            .ok()
            .and_then(|bytes| parse_record(file, &bytes));
        found.push((file.to_owned(), record));
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    Some(found)
}

/// Every live record in `dir`. No folder is a machine whose CLI has never
/// run a session: known, and empty. An unreadable record is skipped, since
/// the CLI writes them without locking and a read can land mid-write.
pub(super) fn registry(dir: &Path, tree: &dyn ProcessTree) -> Knowable<Vec<LiveRecord>> {
    let live = records(dir)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(_, record)| record)
        .filter(|record| tree.is_alive(record.pid) == Knowable::Known(true))
        .collect();
    Knowable::Known(live)
}

/// What the records say about `session`.
pub(super) fn status(
    dir: &Path,
    tree: &dyn ProcessTree,
    session: &SessionRef,
) -> Knowable<Option<SessionActivity>> {
    let Some(all) = records(dir) else {
        // No folder is a machine whose CLI has never run a session.
        return Knowable::Known(None);
    };
    let own_file = format!("{}.json", session.pid);
    let mut live = Vec::new();
    let mut unreadable_own = false;
    for (file, record) in all {
        match record {
            Some(record) if tree.is_alive(record.pid) == Knowable::Known(true) => {
                live.push(record);
            }
            Some(_) => {}
            None => unreadable_own |= file.eq_ignore_ascii_case(&own_file),
        }
    }

    let found = session
        .conversation_id
        .as_deref()
        .and_then(|id| {
            live.iter()
                .find(|record| record.conversation_id.as_deref() == Some(id))
        })
        .or_else(|| live.iter().find(|record| record.pid == session.pid));
    match found {
        Some(record) => match record.activity {
            Some(activity) => Knowable::Known(Some(activity)),
            None => Knowable::Unknown,
        },
        None if unreadable_own => Knowable::Unknown,
        None => Knowable::Known(None),
    }
}

fn activity(status: &str) -> Option<SessionActivity> {
    match status {
        "busy" => Some(SessionActivity::Busy),
        "shell" => Some(SessionActivity::Shell),
        "idle" => Some(SessionActivity::Idle),
        "waiting" => Some(SessionActivity::Waiting),
        _ => None,
    }
}

/// A record, or `None` when it is not a JSON object with a pid to join or
/// probe by. Every other field degrades to `None` on its own.
fn parse_record(file: &str, bytes: &[u8]) -> Option<LiveRecord> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let row = value.as_object()?;
    let pid = row.get("pid")?.as_u64().filter(|&pid| pid > 0)?;
    let text = |key: &str| {
        row.get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let number = |key: &str| {
        row.get(key)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n >= 0.0)
            .map(|n| n as u64)
    };
    // A FILETIME is written as a string because it does not fit a double
    // exactly; a number is taken too, so a shape that changed to one keeps
    // the pid-reuse guard.
    let proc_start = text("procStart").or_else(|| {
        row.get("procStart")
            .filter(|value| value.is_number())
            .map(Value::to_string)
    });
    Some(LiveRecord {
        file: file.to_owned(),
        pid: u32::try_from(pid).ok()?,
        proc_start,
        conversation_id: text("sessionId"),
        cwd: text("cwd"),
        name: text("name"),
        version: text("version"),
        entrypoint: text("entrypoint"),
        started_at_ms: number("startedAt"),
        activity: text("status").as_deref().and_then(activity),
        waiting_for: text("waitingFor"),
        status_since_ms: number("statusUpdatedAt"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(text: &str) -> Option<LiveRecord> {
        parse_record("1.json", text.as_bytes())
    }

    #[test]
    fn a_record_is_read_field_by_field_and_each_bad_field_is_none_on_its_own() {
        let record = parsed(
            r#"{"pid":4068,"sessionId":"7b3d","cwd":"C:\\work","name":"api","version":"2.1.238",
                "entrypoint":"cli","startedAt":1700000000000,"status":"waiting",
                "waitingFor":"permission prompt","statusUpdatedAt":1700000005000,
                "procStart":"133700000000000000"}"#,
        )
        .unwrap();
        assert_eq!(record.pid, 4068);
        assert_eq!(record.conversation_id.as_deref(), Some("7b3d"));
        assert_eq!(record.cwd.as_deref(), Some("C:\\work"));
        assert_eq!(record.activity, Some(SessionActivity::Waiting));
        assert_eq!(record.waiting_for.as_deref(), Some("permission prompt"));
        assert_eq!(record.started_at_ms, Some(1_700_000_000_000));
        assert_eq!(record.status_since_ms, Some(1_700_000_005_000));
        assert_eq!(record.proc_start.as_deref(), Some("133700000000000000"));

        let odd = parsed(r#"{"pid":7,"status":3,"sessionId":"","name":5,"procStart":42}"#).unwrap();
        assert_eq!(odd.activity, None);
        assert_eq!(odd.conversation_id, None);
        assert_eq!(odd.name, None);
        assert_eq!(odd.proc_start.as_deref(), Some("42"));
        assert_eq!(
            parsed(r#"{"pid":7,"status":"thinking"}"#).unwrap().activity,
            None
        );
    }

    #[test]
    fn a_record_with_no_pid_or_that_is_not_an_object_is_no_record() {
        for text in [
            "",
            "not json",
            "[1,2]",
            r#"{"pid":"12"}"#,
            r#"{"pid":0}"#,
            r#"{"pid":-4}"#,
            r#"{"sessionId":"x"}"#,
        ] {
            assert_eq!(parsed(text), None, "{text}");
        }
    }
}
