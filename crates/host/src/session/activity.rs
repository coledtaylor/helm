//! What the host's sessions are doing, and every live agent session on the
//! machine, from each backend's own records.
//!
//! One pass joins each hosted session to its backend's records
//! ([`join_record`]) and lists every record nobody claimed as a session the
//! host does not run. A hosted session with no record is still listed, with
//! no activity: it is running, the host holds its pid, and it may simply not
//! have registered yet. Its activity is never a stale answer: no record means
//! none.
//!
//! The process a session's records came from is pinned once found and
//! followed after, so a cleared conversation, which gets a new id in the same
//! process, stays joined. The pin goes when the session does, so a pid the
//! machine reuses is never picked up by a session that has ended.

use std::collections::{HashMap, HashSet};

use floti_protocol::channels::sessions::{LiveSession, SessionActivityState, SessionsOverview};
use floti_protocol::{BackendId, Knowable};

use crate::agent::{LiveRecord, RecordJoin, RecordPin, join_record};

/// One hosted session, as a pass sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostedView {
    /// Its row id.
    pub id: u64,
    pub backend: BackendId,
    /// The pid of the program its pty runs.
    pub pty_pid: u32,
    /// The conversation it is known to be in.
    pub conversation_id: Option<String>,
    pub cwd: String,
    /// What its tab says.
    pub label: String,
    pub started_at_ms: Option<u64>,
}

/// What one pass found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityPass {
    /// Each hosted session's activity, in the order given.
    pub states: Vec<SessionActivityState>,
    /// Every live session on the machine, hosted first.
    pub overview: SessionsOverview,
    /// Hosted sessions whose records name a conversation other than the one
    /// they were known to be in, with that conversation.
    pub moved: Vec<(u64, String)>,
}

/// Joins passes over time: the pins live here.
#[derive(Debug, Default)]
pub struct ActivityTracker {
    pins: HashMap<u64, RecordPin>,
}

impl ActivityTracker {
    /// One pass over `hosted`, with each backend's records as `registries`
    /// read them at `read_at_ms`. A backend missing from `registries`, or
    /// answering Unknown, has nothing to join to.
    pub fn pass(
        &mut self,
        hosted: &[HostedView],
        registries: &[(BackendId, Knowable<Vec<LiveRecord>>)],
        read_at_ms: u64,
    ) -> ActivityPass {
        let records_of = |backend: &BackendId| -> &[LiveRecord] {
            registries
                .iter()
                .find(|(id, _)| id == backend)
                .and_then(|(_, records)| match records {
                    Knowable::Known(records) => Some(records.as_slice()),
                    Knowable::Unknown => None,
                })
                .unwrap_or(&[])
        };

        let mut states = Vec::with_capacity(hosted.len());
        let mut listed = Vec::new();
        let mut moved = Vec::new();
        let mut claimed: HashSet<(&BackendId, &str)> = HashSet::new();
        for session in hosted {
            let records = records_of(&session.backend);
            let found = join_record(
                records,
                &RecordJoin {
                    conversation_id: session.conversation_id.clone(),
                    pty_pid: Some(session.pty_pid),
                    pinned: self.pins.get(&session.id).cloned(),
                },
            );
            let Some(found) = found else {
                states.push(SessionActivityState {
                    id: session.id,
                    activity: None,
                    waiting_for: None,
                    conversation_id: None,
                });
                listed.push(LiveSession {
                    host_session_id: Some(session.id),
                    backend: session.backend.clone(),
                    pid: session.pty_pid,
                    registered: false,
                    cwd: Some(session.cwd.clone()),
                    name: Some(session.label.clone()),
                    activity: None,
                    waiting_for: None,
                    // No record, so no status to time from.
                    status_since_ms: None,
                    version: None,
                    entrypoint: None,
                    started_at_ms: session.started_at_ms,
                    conversation_id: session.conversation_id.clone(),
                });
                continue;
            };
            claimed.insert((&session.backend, found.file.as_str()));
            self.pins.insert(
                session.id,
                RecordPin {
                    pid: found.pid,
                    proc_start: found.proc_start.clone(),
                },
            );
            if let Some(conversation) = &found.conversation_id
                && session.conversation_id.as_ref() != Some(conversation)
            {
                moved.push((session.id, conversation.clone()));
            }
            states.push(SessionActivityState {
                id: session.id,
                activity: found.activity,
                waiting_for: found.waiting_for.clone(),
                conversation_id: found.conversation_id.clone(),
            });
            listed.push(LiveSession {
                host_session_id: Some(session.id),
                backend: session.backend.clone(),
                pid: found.pid,
                registered: true,
                // The host's own row for both: the folder it launched into
                // and the name the tab has are what a user acts on.
                cwd: Some(session.cwd.clone()),
                name: Some(session.label.clone()),
                activity: found.activity,
                waiting_for: found.waiting_for.clone(),
                status_since_ms: found.status_since_ms,
                version: found.version.clone(),
                entrypoint: found.entrypoint.clone(),
                started_at_ms: found.started_at_ms.or(session.started_at_ms),
                conversation_id: found.conversation_id.clone(),
            });
        }

        for (backend, records) in registries {
            let Knowable::Known(records) = records else {
                continue;
            };
            for record in records {
                if claimed.contains(&(backend, record.file.as_str())) {
                    continue;
                }
                listed.push(LiveSession {
                    host_session_id: None,
                    backend: backend.clone(),
                    pid: record.pid,
                    registered: true,
                    cwd: record.cwd.clone(),
                    name: record.name.clone(),
                    activity: record.activity,
                    waiting_for: record.waiting_for.clone(),
                    status_since_ms: record.status_since_ms,
                    version: record.version.clone(),
                    entrypoint: record.entrypoint.clone(),
                    started_at_ms: record.started_at_ms,
                    conversation_id: record.conversation_id.clone(),
                });
            }
        }

        // Hosted first, then by start time and pid, so the order holds from
        // one pass to the next whatever order the folder listed in.
        listed.sort_by_key(|session| {
            (
                session.host_session_id.is_none(),
                session.started_at_ms.unwrap_or(0),
                session.pid,
            )
        });
        let ids: HashSet<u64> = hosted.iter().map(|session| session.id).collect();
        self.pins.retain(|id, _| ids.contains(id));
        ActivityPass {
            states,
            overview: SessionsOverview {
                sessions: listed,
                read_at_ms,
            },
            moved,
        }
    }
}

#[cfg(test)]
mod tests {
    use floti_protocol::channels::sessions::SessionActivity;

    use super::*;

    fn claude() -> BackendId {
        BackendId::claude_code()
    }

    fn record(
        file: &str,
        pid: u32,
        conversation: &str,
        activity: Option<SessionActivity>,
    ) -> LiveRecord {
        LiveRecord {
            file: file.into(),
            pid,
            proc_start: Some(format!("start-{pid}")),
            conversation_id: Some(conversation.into()),
            cwd: Some(format!("C:/elsewhere/{pid}")),
            name: Some(format!("outside {pid}")),
            version: Some("2.1.238".into()),
            entrypoint: Some("cli".into()),
            started_at_ms: Some(u64::from(pid)),
            activity,
            waiting_for: None,
            status_since_ms: Some(5),
        }
    }

    fn hosted(id: u64, pty_pid: u32, conversation: &str) -> HostedView {
        HostedView {
            id,
            backend: claude(),
            pty_pid,
            conversation_id: Some(conversation.into()),
            cwd: format!("C:/work/{id}"),
            label: format!("tab {id}"),
            started_at_ms: Some(1),
        }
    }

    #[test]
    fn a_hosted_session_joins_its_record_by_conversation_and_the_rest_are_listed_unmarked() {
        let mut tracker = ActivityTracker::default();
        // Through a batch-file shim the pty's pid is the shell's, not the
        // agent's: the conversation id finds it.
        let registry = vec![
            record("4068.json", 4068, "c-1", Some(SessionActivity::Busy)),
            record("900.json", 900, "c-outside", Some(SessionActivity::Idle)),
        ];
        let pass = tracker.pass(
            &[hosted(7, 23496, "c-1")],
            &[(claude(), Knowable::Known(registry))],
            99,
        );
        assert_eq!(
            pass.states,
            [SessionActivityState {
                id: 7,
                activity: Some(SessionActivity::Busy),
                waiting_for: None,
                conversation_id: Some("c-1".into()),
            }]
        );
        let overview = pass.overview;
        assert_eq!(overview.read_at_ms, 99);
        assert_eq!(overview.sessions.len(), 2);
        assert_eq!(overview.sessions[0].host_session_id, Some(7));
        assert_eq!(overview.sessions[0].pid, 4068);
        assert_eq!(overview.sessions[0].cwd.as_deref(), Some("C:/work/7"));
        assert_eq!(overview.sessions[0].name.as_deref(), Some("tab 7"));
        assert_eq!(overview.sessions[1].host_session_id, None);
        assert_eq!(overview.sessions[1].name.as_deref(), Some("outside 900"));
        assert!(pass.moved.is_empty());
    }

    #[test]
    fn a_cleared_conversation_stays_joined_through_the_pinned_process_and_is_reported_moved() {
        let mut tracker = ActivityTracker::default();
        let session = hosted(7, 4068, "c-1");
        tracker.pass(
            std::slice::from_ref(&session),
            &[(
                claude(),
                Knowable::Known(vec![record("4068.json", 4068, "c-1", None)]),
            )],
            1,
        );
        // `/clear`: the same process, a new conversation id, and a pty pid
        // that matches nothing now.
        let after = HostedView {
            pty_pid: 1,
            ..session
        };
        let pass = tracker.pass(
            &[after],
            &[(
                claude(),
                Knowable::Known(vec![record(
                    "4068.json",
                    4068,
                    "c-2",
                    Some(SessionActivity::Idle),
                )]),
            )],
            2,
        );
        assert_eq!(pass.states[0].conversation_id.as_deref(), Some("c-2"));
        assert_eq!(pass.states[0].activity, Some(SessionActivity::Idle));
        assert_eq!(pass.moved, [(7, "c-2".to_owned())]);
    }

    #[test]
    fn a_pid_reused_by_another_process_is_not_the_pinned_one() {
        let mut tracker = ActivityTracker::default();
        let session = hosted(7, 4068, "c-1");
        tracker.pass(
            std::slice::from_ref(&session),
            &[(
                claude(),
                Knowable::Known(vec![record("4068.json", 4068, "c-1", None)]),
            )],
            1,
        );
        let mut reused = record("4068.json", 4068, "c-other", Some(SessionActivity::Busy));
        reused.proc_start = Some("a later process".into());
        let pass = tracker.pass(&[session], &[(claude(), Knowable::Known(vec![reused]))], 2);
        assert_eq!(pass.states[0].activity, None);
        assert!(!pass.overview.sessions[0].registered);
        // Unclaimed, it is listed as a session the host does not run.
        assert_eq!(pass.overview.sessions[1].host_session_id, None);
    }

    #[test]
    fn with_no_record_or_records_that_could_not_be_read_a_hosted_session_is_listed_with_no_activity()
     {
        let mut tracker = ActivityTracker::default();
        for registry in [Knowable::Known(vec![]), Knowable::Unknown] {
            let pass = tracker.pass(&[hosted(3, 55, "c-3")], &[(claude(), registry)], 1);
            assert_eq!(pass.states[0].activity, None);
            assert_eq!(pass.states[0].conversation_id, None);
            let listed = &pass.overview.sessions[0];
            assert_eq!(listed.host_session_id, Some(3));
            assert_eq!(listed.pid, 55);
            assert!(!listed.registered);
            assert_eq!(listed.status_since_ms, None);
            assert_eq!(listed.conversation_id.as_deref(), Some("c-3"));
        }
    }

    #[test]
    fn the_overview_lists_hosted_first_then_by_start_time() {
        let mut tracker = ActivityTracker::default();
        let registry = vec![
            record("30.json", 30, "c-30", None),
            record("10.json", 10, "c-10", None),
            record("20.json", 20, "c-hosted", None),
        ];
        let pass = tracker.pass(
            &[hosted(1, 20, "c-hosted")],
            &[(claude(), Knowable::Known(registry))],
            1,
        );
        let pids: Vec<u32> = pass.overview.sessions.iter().map(|s| s.pid).collect();
        assert_eq!(pids, [20, 10, 30]);
    }
}
