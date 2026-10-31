//! The host's sessions as a plugin may see them: `sessions.list`, the
//! `sessions` event, and the caller a session's call to a plugin's tool
//! names.
//!
//! **Nothing of a conversation.** What is kept of a session is its name, its
//! folder, when it started and ended, and the word for what it is doing; the
//! shape ([`PluginSession`]) has no field for argv, a conversation id or
//! `waitingFor`, and nothing here reads them.
//!
//! **One id per session, minted by the host.** The first time the host meets
//! a session it started (its activity, its exit, or a call from it) it mints
//! a random id for it. That id is the one `sessions.list` and the `sessions`
//! event show and the one a tool call names, never the row id, and it does
//! not survive a restart.
//!
//! **Since the host opened.** Only sessions this host has run are met, so
//! the list is those, running and ended.

use std::collections::BTreeMap;
use std::collections::btree_map::Entry;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use floti_protocol::channels::agent_plugin::AgentPluginCaller;
use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::plugins::{PluginSession, PluginSessionActivity, PluginSessionState};
use floti_protocol::channels::sessions::{SessionActivity, SessionActivityState};

use crate::agent::claude_code::parse_instant;
use crate::agent::new_conversation_id;
use crate::server::hosted::{Hosted, label_of, session_id};

/// The sessions plugins may see, by the host's row id, which orders them by
/// start.
pub(crate) struct PluginSessions {
    /// Session `row`'s record, while the host has it.
    records: Records,
    known: Mutex<BTreeMap<u64, Known>>,
}

type Records = Box<dyn Fn(u64) -> Option<SessionRecord> + Send + Sync>;

/// One session the host ran, as a plugin may see it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Known {
    id: String,
    name: String,
    cwd: String,
    started_at: u64,
    ended_at: Option<u64>,
    activity: Option<PluginSessionActivity>,
    since: Option<u64>,
}

impl Known {
    fn met(record: &SessionRecord, now: u64) -> Self {
        Self {
            id: new_conversation_id(),
            name: label_of(record),
            cwd: record.cwd.clone(),
            started_at: parse_instant(&record.started_at).unwrap_or(now),
            ended_at: None,
            activity: None,
            since: None,
        }
    }

    fn shown(&self) -> PluginSession {
        let running = self.ended_at.is_none();
        PluginSession {
            id: self.id.clone(),
            name: self.name.clone(),
            cwd: self.cwd.clone(),
            state: if running {
                PluginSessionState::Running
            } else {
                PluginSessionState::Ended
            },
            activity: self.activity.filter(|_| running),
            activity_since: self.since.filter(|_| running && self.activity.is_some()),
            started_at: self.started_at,
            ended_at: self.ended_at,
        }
    }
}

/// The word a plugin is given for what a session is doing.
fn word(activity: SessionActivity) -> PluginSessionActivity {
    match activity {
        SessionActivity::Busy => PluginSessionActivity::Busy,
        SessionActivity::Idle => PluginSessionActivity::Idle,
        SessionActivity::Waiting => PluginSessionActivity::Waiting,
        SessionActivity::Shell => PluginSessionActivity::Shell,
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl PluginSessions {
    /// The sessions `hosted` runs, read while it is there.
    pub fn new(hosted: &Arc<Hosted>) -> Self {
        let hosted = Arc::downgrade(hosted);
        Self::reading(move |row| hosted.upgrade()?.record(session_id(row)?).ok())
    }

    /// The sessions whose records `records` reads.
    fn reading(records: impl Fn(u64) -> Option<SessionRecord> + Send + Sync + 'static) -> Self {
        Self {
            records: Box::new(records),
            known: Mutex::new(BTreeMap::new()),
        }
    }

    fn record(&self, row: u64) -> Option<SessionRecord> {
        (self.records)(row)
    }

    /// The caller a tool call from session `row` names: the id plugins know
    /// it by, what its tab says and its folder. `None` for a session the host
    /// has no record of.
    pub fn caller(&self, row: u64) -> Option<AgentPluginCaller> {
        let mut known = lock(&self.known);
        let session = match known.entry(row) {
            Entry::Occupied(met) => met.into_mut(),
            Entry::Vacant(new) => new.insert(Known::met(&self.record(row)?, now_ms())),
        };
        Some(AgentPluginCaller {
            id: session.id.clone(),
            label: session.name.clone(),
            folder: session.cwd.clone(),
        })
    }

    /// Every session the host ran, oldest first.
    pub fn list(&self) -> Vec<PluginSession> {
        lock(&self.known).values().map(Known::shown).collect()
    }

    /// What each running session is doing now, as of `now`, epoch ms: a
    /// session met for the first time is added, and its name follows a
    /// rename. True when anything a plugin sees moved.
    pub fn activity(&self, states: &[SessionActivityState], now: u64) -> bool {
        let mut moved = false;
        for state in states {
            let record = self.record(state.id);
            let mut known = lock(&self.known);
            let session = match (known.get_mut(&state.id), &record) {
                (Some(session), _) => session,
                (None, Some(record)) => {
                    moved = true;
                    known
                        .entry(state.id)
                        .or_insert_with(|| Known::met(record, now))
                }
                (None, None) => continue,
            };
            if session.ended_at.is_some() {
                continue;
            }
            if let Some(record) = &record {
                let name = label_of(record);
                if session.name != name {
                    session.name = name;
                    moved = true;
                }
            }
            let activity = state.activity.map(word);
            if session.activity != activity {
                session.activity = activity;
                session.since = activity.map(|_| now);
                moved = true;
            }
        }
        moved
    }

    /// The session `record` is for has ended. True when that is news.
    pub fn ended(&self, record: &SessionRecord, now: u64) -> bool {
        let mut known = lock(&self.known);
        let session = known
            .entry(record.id)
            .or_insert_with(|| Known::met(record, now));
        if session.ended_at.is_some() {
            return false;
        }
        session.ended_at = Some(
            record
                .ended_at
                .as_deref()
                .and_then(parse_instant)
                .unwrap_or(now),
        );
        session.name = label_of(record);
        session.activity = None;
        session.since = None;
        true
    }

    /// Exits may have been missed: each session met that is no longer among
    /// `running`, the row ids of those running now, has ended as of `now`.
    /// True when any had not been seen to end.
    pub fn running_now(&self, running: &[u64], now: u64) -> bool {
        let mut moved = false;
        for (row, session) in lock(&self.known).iter_mut() {
            if session.ended_at.is_none() && !running.contains(row) {
                session.ended_at = Some(now);
                session.activity = None;
                session.since = None;
                moved = true;
            }
        }
        moved
    }
}

/// Now, epoch ms.
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: u64, name: &str, cwd: &str) -> SessionRecord {
        SessionRecord {
            id,
            name: name.to_owned(),
            label: None,
            cwd: cwd.to_owned(),
            branch: None,
            project_path: None,
            profile_id: None,
            argv: vec!["--secret-prompt".to_owned()],
            conversation_id: Some("a-conversation".to_owned()),
            backend: floti_protocol::BackendId::new("fake-agent"),
            status: floti_protocol::channels::common::SessionStatus::Running,
            started_at: "2026-10-30T10:00:00Z".to_owned(),
            ended_at: None,
            duration_ms: None,
            exit_code: None,
        }
    }

    fn state(id: u64, activity: Option<SessionActivity>) -> SessionActivityState {
        SessionActivityState {
            id,
            activity,
            waiting_for: Some("Allow Bash?".to_owned()),
            conversation_id: Some("a-conversation".to_owned()),
        }
    }

    fn sessions() -> PluginSessions {
        PluginSessions::reading(|row| match row {
            1 => Some(record(1, "alpha", "/work/alpha")),
            2 => Some(record(2, "beta", "/work/beta")),
            _ => None,
        })
    }

    #[test]
    fn a_session_is_listed_from_its_start_through_its_activity_to_its_end_under_one_minted_id() {
        let sessions = sessions();
        assert!(sessions.activity(&[state(1, None)], 1_000));
        let started = sessions.list();
        assert_eq!(started.len(), 1);
        let id = started[0].id.clone();
        assert_ne!(id, "1", "never the row id");
        assert_eq!(started[0].name, "alpha");
        assert_eq!(started[0].cwd, "/work/alpha");
        assert_eq!(started[0].state, PluginSessionState::Running);
        assert_eq!(started[0].activity, None);

        assert!(sessions.activity(&[state(1, Some(SessionActivity::Waiting))], 2_000));
        let waiting = &sessions.list()[0];
        assert_eq!(waiting.activity, Some(PluginSessionActivity::Waiting));
        assert_eq!(waiting.activity_since, Some(2_000));
        // Nothing moved, nothing to tell.
        assert!(!sessions.activity(&[state(1, Some(SessionActivity::Waiting))], 3_000));

        assert!(sessions.ended(&record(1, "alpha", "/work/alpha"), 4_000));
        let ended = &sessions.list()[0];
        assert_eq!(ended.id, id);
        assert_eq!(ended.state, PluginSessionState::Ended);
        assert_eq!((ended.activity, ended.ended_at), (None, Some(4_000)));
        assert!(!sessions.ended(&record(1, "alpha", "/work/alpha"), 5_000));
    }

    #[test]
    fn a_tool_call_names_the_session_by_the_id_the_list_shows() {
        let sessions = sessions();
        let caller = sessions.caller(2).expect("a session the host has");
        assert_eq!(
            (caller.label.as_str(), caller.folder.as_str()),
            ("beta", "/work/beta")
        );
        assert!(sessions.activity(&[state(1, None), state(2, None)], 1_000));
        let listed = sessions.list();
        assert_eq!(
            listed
                .iter()
                .find(|session| session.name == "beta")
                .unwrap()
                .id,
            caller.id
        );
        assert_eq!(
            sessions.caller(2).unwrap().id,
            caller.id,
            "the same id each call"
        );
        assert_ne!(listed[0].id, listed[1].id);
        assert_eq!(
            sessions.caller(9),
            None,
            "a session the host has no record of"
        );
    }

    #[test]
    fn a_session_no_longer_running_has_ended_even_when_its_exit_was_missed() {
        let sessions = sessions();
        sessions.activity(&[state(1, None), state(2, None)], 1_000);
        assert!(sessions.running_now(&[2], 2_000));
        let listed = sessions.list();
        assert_eq!(listed[0].state, PluginSessionState::Ended);
        assert_eq!(listed[1].state, PluginSessionState::Running);
        assert!(!sessions.running_now(&[2], 3_000));
    }

    #[test]
    fn nothing_of_a_conversation_reaches_what_a_plugin_is_given() {
        let sessions = sessions();
        sessions.activity(&[state(1, Some(SessionActivity::Waiting))], 1_000);
        let shown = serde_json::to_string(&sessions.list()).unwrap();
        assert!(!shown.contains("Allow Bash"), "{shown}");
        assert!(!shown.contains("a-conversation"), "{shown}");
        assert!(!shown.contains("secret-prompt"), "{shown}");
    }
}
