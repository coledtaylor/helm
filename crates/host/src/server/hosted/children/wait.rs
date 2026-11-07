//! Waiting on news: what `agents_wait`, `floti agent wait` and a start with
//! `wait` do once they know whether their call holds.
//!
//! **A wait answers from the inbox.** *Any* answers with the unseen news at
//! once when there is some, else holds for the next event. *All* holds until
//! none of the children it names (all of the caller's when it names none) is
//! working, then answers with their unseen news. A name that is not one of the
//! caller's children is not found, before anything waits.
//!
//! **A call that does not hold answers at once** with what is unseen and who
//! is still working, and says nothing is new when nothing is. Which calls hold
//! is the caller's backend's (`Hosted::waits_hold`), not this module's.
//!
//! **A held wait ends early, with what is unseen,** when a person types into
//! the caller's terminal (so a person is never queued behind a wait) and when
//! the caller ends. It never ends on a timer: the stream the listener answers
//! it with says it is still there.
//!
//! **Nothing is lost.** News is read, not taken: the answer carries the ids of
//! what it holds, and [`Waited::confirm`] marks them heard once the answer has
//! reached its caller in full. A wait dropped before that, because it was
//! cancelled or its connection went or the host restarted, leaves it unseen.
//!
//! **A wait can be an MCP task** (`Hosted::waits_as_task`): where the caller's
//! backend declares MCP tasks and the call carries the tasks extension, the
//! listener answers it at once with a working task and runs the wait inside
//! it. Inside a task the wait always holds, whatever the backend says about
//! moving long calls to the background, since the task is the background and
//! nothing keeps a connection open for it. It ends as a held wait ends: the
//! child's next news, every child it is about idle, a person typing into the
//! caller, or the caller ending. The task
//! then completes with the same answer a held wait gives, and the news counts
//! as heard (`Waited::confirm`, through the call's delivery) once that result
//! has been fetched in full. A task cancelled, dropped with its session or
//! cut off by a host restart leaves the news unseen.

use std::sync::Arc;

use floti_protocol::channels::sessions::SessionActivity;

use super::inbox::{self, News};
use super::rows;
use crate::server::hosted::Hosted;
use crate::session::SessionId;

/// What a wait waits for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WaitFor {
    /// News from any child.
    Any,
    /// Every child it names to stop working.
    All,
}

/// What a wait was asked.
#[derive(Debug, Clone)]
pub(crate) struct WaitRequest {
    pub wait_for: WaitFor,
    /// The children it is about, as the caller names them; none for all of
    /// the caller's.
    pub children: Vec<String>,
    /// Whether it may stay unanswered until something happens.
    pub hold: bool,
}

/// Why a wait answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WaitEnd {
    /// There was news to give.
    News,
    /// Every child it was about had stopped working.
    Idle,
    /// There was nothing new and the call does not hold.
    NothingNew,
    /// A person typed into the caller's terminal.
    Typed,
    /// The caller ended.
    CallerEnded,
}

/// What a wait answers.
pub(crate) struct Waited {
    pub news: Vec<News>,
    /// The children it was about that are still working.
    pub working: Vec<String>,
    pub end: WaitEnd,
}

impl Waited {
    /// Marks this answer's news heard. Run when the answer has reached its
    /// caller, and not before.
    pub fn confirm(&self, hosted: &Arc<Hosted>) -> Box<dyn FnOnce() + Send + Sync> {
        let hosted = Arc::clone(hosted);
        let ids: Vec<i64> = self.news.iter().map(|news| news.id).collect();
        Box::new(move || {
            if ids.is_empty() {
                return;
            }
            if let Err(err) = inbox::mark_seen(&hosted.ledger.store(), &ids) {
                log_line!("floti host: {err}");
            }
        })
    }
}

/// What the inbox and the children said at one look.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct Snapshot {
    pub news: Vec<News>,
    pub working: Vec<String>,
    pub caller_runs: bool,
}

/// Whether a wait for `wait_for` has what it waits for in `snapshot`.
pub(super) fn ready(wait_for: WaitFor, snapshot: &Snapshot) -> bool {
    match wait_for {
        WaitFor::Any => !snapshot.news.is_empty(),
        WaitFor::All => snapshot.working.is_empty(),
    }
}

impl Hosted {
    /// Waits for news for `parent` as `request` says.
    ///
    /// # Errors
    ///
    /// A sentence when `parent` has ended or names a child that is not its
    /// own.
    pub(crate) async fn wait_for_news(
        self: &Arc<Self>,
        parent: SessionId,
        request: WaitRequest,
    ) -> Result<Waited, String> {
        let session = self
            .sessions
            .get(parent)
            .ok_or_else(|| "Your session has ended, so there is nothing to wait for.".to_owned())?;
        // Typing that already happened does not end this wait.
        let mut typed = session.typing();
        typed.borrow_and_update();
        let mut changes = self.children.news.changes();
        let names = {
            let hosted = Arc::clone(self);
            let asked = request.children.clone();
            off_runtime(move || hosted.resolve_children(parent, &asked)).await?
        };
        loop {
            changes.borrow_and_update();
            let snapshot = {
                let hosted = Arc::clone(self);
                let names = names.clone();
                off_runtime(move || hosted.snapshot(parent, &names)).await?
            };
            let ended = if !snapshot.caller_runs {
                Some(WaitEnd::CallerEnded)
            } else if ready(request.wait_for, &snapshot) {
                Some(if snapshot.news.is_empty() {
                    WaitEnd::Idle
                } else {
                    WaitEnd::News
                })
            } else if !request.hold {
                Some(WaitEnd::NothingNew)
            } else {
                None
            };
            if let Some(end) = ended {
                return Ok(Waited {
                    news: snapshot.news,
                    working: snapshot.working,
                    end,
                });
            }
            tokio::select! {
                moved = changes.changed() => {
                    if moved.is_err() {
                        return Err("The host is stopping.".to_owned());
                    }
                }
                typing = typed.changed() => {
                    let end = if typing.is_ok() { WaitEnd::Typed } else { WaitEnd::CallerEnded };
                    let hosted = Arc::clone(self);
                    let names = names.clone();
                    let latest = off_runtime(move || hosted.snapshot(parent, &names)).await?;
                    return Ok(Waited { news: latest.news, working: latest.working, end });
                }
            }
        }
    }

    /// The names a wait is about, as the caller's children are called: each
    /// asked name resolved among them, or none for all of them.
    fn resolve_children(&self, parent: SessionId, asked: &[String]) -> Result<Vec<String>, String> {
        if asked.is_empty() {
            return Ok(Vec::new());
        }
        let store = self.ledger.store();
        let facts = rows::parent_facts(&store, parent).map_err(|err| err.to_string())?;
        let children = rows::children_of(&store, parent, facts.conversation_id.as_deref())
            .map_err(|err| err.to_string())?;
        let mut resolved = Vec::new();
        for name in asked {
            match children
                .iter()
                .rev()
                .find(|child| child.name.eq_ignore_ascii_case(name.trim()))
            {
                Some(child) => resolved.push(child.name.to_lowercase()),
                None => {
                    let known: Vec<&str> =
                        children.iter().map(|child| child.name.as_str()).collect();
                    return Err(if known.is_empty() {
                        format!("{name} is not one of your agents: you have started none.")
                    } else {
                        format!(
                            "{name} is not one of your agents. Yours are: {}.",
                            known.join(", ")
                        )
                    });
                }
            }
        }
        Ok(resolved)
    }

    /// What the inbox and the children say now, about `names` (lower case) or,
    /// with none, about all of `parent`'s children.
    fn snapshot(&self, parent: SessionId, names: &[String]) -> Result<Snapshot, String> {
        let in_scope =
            |name: &str| names.is_empty() || names.iter().any(|n| n.eq_ignore_ascii_case(name));
        let store = self.ledger.store();
        let facts = rows::parent_facts(&store, parent).map_err(|err| err.to_string())?;
        let conversation = facts.conversation_id.as_deref();
        let news = inbox::unseen(&store, parent, conversation)
            .map_err(|err| err.to_string())?
            .into_iter()
            .filter(|news| in_scope(&news.child))
            .collect();
        let children =
            rows::children_of(&store, parent, conversation).map_err(|err| err.to_string())?;
        drop(store);
        let working = children
            .iter()
            .filter(|child| in_scope(&child.name))
            .filter(|child| child.running && self.sessions.get(child.id).is_some())
            .filter(|child| {
                !matches!(
                    self.children.news.activity_of(child.id),
                    Some(SessionActivity::Idle | SessionActivity::Waiting | SessionActivity::Error)
                )
            })
            .map(|child| child.name.clone())
            .collect();
        Ok(Snapshot {
            news,
            working,
            caller_runs: self.sessions.get(parent).is_some(),
        })
    }

    /// Whether a wait by session `caller` holds: the caller's backend declares
    /// that a held tool call is moved to the background (for the agent's own
    /// tool call) or that a finished background command wakes it (for a
    /// command in its shell). Any other backend's wait answers at once.
    pub(crate) fn waits_hold(&self, caller: SessionId, from_shell: bool) -> bool {
        self.tool_support_of(caller).is_some_and(|support| {
            if from_shell {
                support.background_command_wakes
            } else {
                support.backgrounds_long_calls
            }
        })
    }

    /// Whether a wait by session `caller` is answered as an MCP task when the
    /// call asks for one: the caller's backend declares MCP tasks, and the
    /// call is the agent's own tool call, not a command in its shell (which
    /// reads one reply and has no tasks to poll). A backend that declares none
    /// is answered as `waits_hold` says, never as a task.
    pub(crate) fn waits_as_task(&self, caller: SessionId, from_shell: bool) -> bool {
        !from_shell
            && self
                .tool_support_of(caller)
                .is_some_and(|support| support.mcp_tasks)
    }

    /// What the backend session `caller` runs declares of its tool calls, or
    /// none when its row or its backend is not known.
    fn tool_support_of(&self, caller: SessionId) -> Option<crate::agent::ToolSupport> {
        let backend = {
            let store = self.ledger.store();
            records_backend(&store, caller)
        };
        backend
            .and_then(|id| self.find_backend(&id))
            .map(|backend| backend.tool_support())
    }
}

/// The backend session `id`'s row says it runs.
fn records_backend(
    store: &crate::store::Store,
    id: SessionId,
) -> Option<floti_protocol::BackendId> {
    crate::server::records::read_record(store, id)
        .ok()
        .map(|record| record.backend)
}

/// Runs `work`, which reads the store, off the runtime's workers.
async fn off_runtime<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|_| Err("Floti could not finish that. Try again.".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::super::inbox::{EventKind, Facts};
    use super::*;

    fn news(child: &str) -> News {
        News {
            id: 1,
            child: child.to_owned(),
            event: EventKind::TurnEnded,
            facts: Facts::default(),
            at: String::new(),
        }
    }

    #[test]
    fn a_wait_for_any_is_ready_with_news_and_not_without() {
        let mut snapshot = Snapshot {
            working: vec!["a".into()],
            caller_runs: true,
            ..Snapshot::default()
        };
        assert!(!ready(WaitFor::Any, &snapshot));
        snapshot.news.push(news("a"));
        assert!(ready(WaitFor::Any, &snapshot));
    }

    #[test]
    fn a_wait_for_all_is_ready_only_when_none_of_them_is_working_whatever_the_news() {
        let mut snapshot = Snapshot {
            news: vec![news("a")],
            working: vec!["b".into()],
            caller_runs: true,
        };
        assert!(!ready(WaitFor::All, &snapshot));
        snapshot.working.clear();
        assert!(ready(WaitFor::All, &snapshot));
    }
}
