//! Claude Code's own records of its live sessions, read.
//!
//! The CLI keeps one file per running session at
//! `<config>/sessions/<pid>.json` saying what it is doing: `busy`, `shell`,
//! `idle` or `waiting`. A clean exit removes the file and a hard kill leaves
//! it, so a record is believed only while its process is provably running.
//! The first record of a session has no status yet; a record with none, or
//! one this reader does not recognise, is Unknown and the tab stays plain.
//!
//! **`.json` files only.** Beside each record the CLI writes
//! `<pid>.<sha256>.key`, holding a bearer token for its own
//! session-to-session channel. Those are credentials: this reader skips them
//! by name and never opens one.

use std::path::Path;

use floti_protocol::Knowable;
use floti_protocol::channels::sessions::SessionActivity;
use serde_json::Value;

use crate::agent::SessionRef;
use crate::platform::process_tree::ProcessTree;

/// One record, as far as it could be read.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Record {
    pid: u32,
    session_id: Option<String>,
    status: Option<String>,
}

/// Whether `path` is one of the credential files beside the records.
pub(super) fn is_session_key(path: &Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("key"))
}

/// What the records say about `session`.
pub(super) fn status(
    dir: &Path,
    tree: &dyn ProcessTree,
    session: &SessionRef,
) -> Knowable<Option<SessionActivity>> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        // No folder is a machine whose CLI has never run a session.
        return Knowable::Known(None);
    };
    let mut live = Vec::new();
    let mut unreadable_own = false;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_record = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("json"));
        if !is_record {
            continue;
        }
        let record = std::fs::read(&path)
            .ok()
            .and_then(|bytes| parse_record(&bytes));
        match record {
            Some(record) if tree.is_alive(record.pid) == Knowable::Known(true) => {
                live.push(record);
            }
            Some(_) => {}
            None => {
                let named_for_session = path.file_stem().and_then(|stem| stem.to_str())
                    == Some(session.pid.to_string().as_str());
                unreadable_own |= named_for_session;
            }
        }
    }

    let found = session
        .conversation_id
        .as_deref()
        .and_then(|id| {
            live.iter()
                .find(|record| record.session_id.as_deref() == Some(id))
        })
        .or_else(|| live.iter().find(|record| record.pid == session.pid));
    match found {
        Some(record) => match record.status.as_deref().and_then(activity) {
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

/// A record, or `None` when it has no pid to join or probe by. Every other
/// field degrades to `None` on its own.
fn parse_record(bytes: &[u8]) -> Option<Record> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let row = value.as_object()?;
    let pid = row.get("pid")?.as_u64().filter(|&pid| pid > 0)?;
    let text = |key: &str| {
        row.get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    Some(Record {
        pid: u32::try_from(pid).ok()?,
        session_id: text("sessionId"),
        status: text("status"),
    })
}
