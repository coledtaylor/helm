//! Calls answered as MCP tasks, held by the listener.
//!
//! A task is a family's call that was started and answered at once with its
//! handle, while the call itself goes on. It lives in memory, under the grant
//! whose token made the call, and nowhere else: a host that restarts has none,
//! and nothing is stored that could bring one back. Nothing here is timed: a
//! task is working until its call's future finishes.
//!
//! - **Completing** is the future finishing. `tasks/get` then answers the
//!   result, and the family's [`Delivery`] hook runs only once that reply has
//!   been handed to the connection whole. The task is gone after it, so the
//!   result is taken once; a reply the connection dropped leaves it there for
//!   the next `tasks/get`.
//! - **Cancelling**, a grant's token being revoked and the listener stopping
//!   drop the future, and the hook is never run.
//! - **A grant's own.** A task is found only by the grant that started it; any
//!   other id is answered exactly as one that never was.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use rmcp::model::{
    CallToolResult, DetailedTask, GetTaskResult, JsonObject, Task, TaskPayload, TaskStatus,
};
use tokio::task::AbortHandle;

use super::{Caller, Delivery, GrantId, ToolFamily};
use crate::agent::{fill_random, hex};
use crate::config_console::time::now_iso;

/// How often a client is asked to poll a working task, in milliseconds. A
/// poll is a cheap lookup in memory, and the answer is a task that completes
/// when its call does.
pub(super) const POLL_INTERVAL_MS: u64 = 1000;

/// Bytes of randomness in a task id.
const ID_BYTES: usize = 16;

/// Put in a request's extensions by the listener when the call in it is to
/// be answered as a task.
#[derive(Clone, Copy)]
pub(super) struct AsTask;

/// The listener's tasks, by the grant that started each.
#[derive(Default)]
pub(super) struct Tasks {
    held: Mutex<HashMap<GrantId, HashMap<String, Arc<Held>>>>,
}

/// One task: its call, running, and what it has become.
struct Held {
    created_at: String,
    state: Mutex<State>,
    /// What the family asked to be done once its result is delivered.
    delivery: Delivery,
    /// Ends the call's future.
    abort: OnceLock<AbortHandle>,
}

enum State {
    Working,
    Completed {
        result: Box<CallToolResult>,
        at: String,
    },
}

impl Held {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Drops the call's future, if it is still running.
    fn abort(&self) {
        if let Some(abort) = self.abort.get() {
            abort.abort();
        }
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        self.abort();
    }
}

impl Tasks {
    fn held(&self) -> MutexGuard<'_, HashMap<GrantId, HashMap<String, Arc<Held>>>> {
        self.held.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts `name` for `caller` and holds it. Returns the task as it is
    /// now: working.
    pub(super) fn start(
        &self,
        caller: Caller,
        family: Arc<dyn ToolFamily>,
        name: String,
        arguments: JsonObject,
    ) -> Task {
        let id = new_id();
        let held = Arc::new(Held {
            created_at: now_iso(),
            state: Mutex::new(State::Working),
            delivery: Delivery::default(),
            abort: OnceLock::new(),
        });
        let seed = task_of(&id, &held.created_at, &held.created_at, TaskStatus::Working);
        let finished = Arc::downgrade(&held);
        let delivery = held.delivery.clone();
        // Under the lock, so a grant abandoned meanwhile finds this one too.
        let mut all = self.held();
        let running = tokio::spawn(async move {
            let result = family.call_with(caller, &name, arguments, delivery).await;
            if let Some(held) = finished.upgrade() {
                *held.state() = State::Completed {
                    result: Box::new(result),
                    at: now_iso(),
                };
            }
        });
        let _ = held.abort.set(running.abort_handle());
        all.entry(caller.grant).or_default().insert(id, held);
        seed
    }

    /// `grant`'s task `id`: working, or completed with its result, which
    /// counts as taken once `reply` has been delivered whole. `None` for an
    /// id that is not this grant's, never was, or is gone.
    pub(super) fn get(
        self: &Arc<Self>,
        grant: GrantId,
        id: &str,
        reply: &Delivery,
    ) -> Option<GetTaskResult> {
        let held = self.held().get(&grant)?.get(id).cloned()?;
        let state = held.state();
        let (status, payload, updated_at) = match &*state {
            State::Working => (
                TaskStatus::Working,
                TaskPayload::Working,
                held.created_at.clone(),
            ),
            State::Completed { result, at } => {
                let tasks = Arc::clone(self);
                let (id, taken) = (id.to_owned(), Arc::clone(&held));
                reply.on_delivered(move || {
                    // Gone first, so a grant abandoned meanwhile runs nothing.
                    if tasks.remove(grant, &id).is_some()
                        && let Some(hook) = taken.delivery.take()
                    {
                        hook();
                    }
                });
                let result = match serde_json::to_value(result) {
                    Ok(serde_json::Value::Object(result)) => result,
                    _ => JsonObject::new(),
                };
                (
                    TaskStatus::Completed,
                    TaskPayload::Completed { result },
                    at.clone(),
                )
            }
        };
        let task = task_of(id, &held.created_at, &updated_at, status);
        Some(GetTaskResult::new(DetailedTask::new(task, payload)))
    }

    /// Drops `grant`'s task `id` and its call. Whether there was one.
    pub(super) fn cancel(&self, grant: GrantId, id: &str) -> bool {
        self.remove(grant, id).is_some()
    }

    /// Drops every task `grant` has: its token is gone.
    pub(super) fn abandon_grant(&self, grant: GrantId) {
        let dropped = self.held().remove(&grant);
        for held in dropped.iter().flat_map(HashMap::values) {
            held.abort();
        }
    }

    /// Drops every task: the listener is stopping.
    pub(super) fn abandon_all(&self) {
        let dropped: Vec<_> = self.held().drain().collect();
        for (_, tasks) in dropped {
            for held in tasks.values() {
                held.abort();
            }
        }
    }

    /// Takes a task out and ends its call.
    fn remove(&self, grant: GrantId, id: &str) -> Option<Arc<Held>> {
        let mut all = self.held();
        let calls = all.get_mut(&grant)?;
        let held = calls.remove(id)?;
        if calls.is_empty() {
            all.remove(&grant);
        }
        drop(all);
        held.abort();
        Some(held)
    }
}

fn task_of(id: &str, created_at: &str, updated_at: &str, status: TaskStatus) -> Task {
    let mut task = Task::new(id, status, created_at, updated_at);
    task.poll_interval_ms = Some(POLL_INTERVAL_MS);
    task
}

/// An id nobody can guess: a task is found by it, under its grant.
fn new_id() -> String {
    let mut bytes = [0u8; ID_BYTES];
    fill_random(&mut bytes);
    hex(&bytes)
}
