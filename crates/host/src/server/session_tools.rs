//! floti-sessions: what the other sessions on this machine are doing, served
//! to the host's sessions on the agent tools listener at `/mcp/sessions`.
//!
//! **Read-only awareness, so a session can get out of another's way.** Two
//! agents in one working tree is the failure this exists to prevent, and it is
//! prevented by looking, not by talking. Nothing here sends a session anything,
//! waits on one, hands one work, or lets one address another. That is
//! coordination, which is out of scope, and Claude Code has its own channel
//! for it.
//!
//! **No answer carries any part of another session's conversation.** The
//! mechanism is [`crate::session::describe`]'s input types, which have no
//! field for argv, a conversation id or a child's command line; this module
//! builds those inputs field by field and is the only way a tool reaches them.
//!
//! **Nothing here reads anything a second time.** Every fact comes from what
//! the host already keeps: the activity pass's machine-wide listing, re-read
//! now for each call; the store's session rows and profiles; and one
//! processes-and-ports pass, taken for a `session_detail` about a hosted
//! session and for nothing else. A tool family with a reader of its own would
//! be a second answer to "what is running", free to disagree with the sessions
//! pane.
//!
//! **"This session" is which bearer token arrived** ([`Caller`]), resolved by
//! the listener. No tool takes a session id, so there is nothing to spoof: a
//! caller naming another session in an argument the schema does not declare is
//! answered for itself, because the answer never reads the argument. What a
//! pid does select is `session_detail`'s subject, a fact about the machine
//! rather than a claim about who is asking.

#[cfg(test)]
mod tests;

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};

use floti_protocol::channels::sessions::{LiveSession, SessionResources, SessionsOverview};
use serde_json::{Value, json};

use super::features::{ActivityHandle, ResourcesHandle};
use super::hosted::{Hosted, session_id};
use super::records;
use crate::agent::claude_code::parse_instant;
use crate::agent_tools::{
    CallToolResult, Caller, ContentBlock, JsonObject, Tool, ToolAnnotations, ToolFamily, ToolFuture,
};
use crate::session::describe::{
    HostedSessionFacts, SessionDetailInput, describe_session_detail, describe_session_gone,
    describe_session_listing, held_by,
};

/// The name the tools appear under in a session.
pub(crate) const SESSION_TOOLS_NAME: &str = "floti-sessions";

/// Its route on the listener.
pub(crate) const SESSION_TOOLS_ROUTE: &str = "/mcp/sessions";

/// What a session is told when it connects: the one place a model reliably
/// reads, and the sentence it has to read is "awareness, not coordination".
pub(crate) const SESSION_TOOLS_INSTRUCTIONS: &str = "These tools tell you what other Claude Code sessions are running on this machine, so you can stay out of their way - two agents in one working tree is the thing they exist to prevent. They are read-only and there is no way to send another session anything through them: nothing here starts, stops, waits on, or messages a session, and no tool will ever return any part of another session’s conversation. Check sessions_list before starting long work in a directory.";

const SESSIONS_LIST: &str = "sessions_list";
const SESSION_DETAIL: &str = "session_detail";

/// The answer while the host is still assembling what the tools read. A
/// sentence rather than a failure that sticks: the session's tools work once
/// the listing is ready.
const STILL_STARTING: &str =
    "Floti cannot answer that right now - it is still starting up. Try again in a moment.";

/// The answer to `session_detail` with no pid from a token with no live
/// session behind it.
const NO_LIVE_SESSION: &str = "Floti has no live session for this token, which should not happen while your session is running. Call sessions_list to see what it does have.";

/// What one processes-and-ports pass answers, as a future the world can box.
pub(crate) type PassFuture<'a> = Pin<Box<dyn Future<Output = Vec<SessionResources>> + Send + 'a>>;

/// What the tools read, from what the host already knows.
pub(crate) trait SessionsWorld: Send + Sync + 'static {
    /// The machine-wide listing, read now. `None` while the host cannot
    /// read it, such as while it is stopping. Blocking: it reads each
    /// backend's records and the store.
    fn overview(&self) -> Option<SessionsOverview>;

    /// The host's own facts for one of its sessions, built field by field
    /// with no argv and no conversation id. Blocking: it reads the store.
    fn facts_for(&self, host_session_id: u64) -> Option<HostedSessionFacts>;

    /// One processes-and-ports pass, taken for this call and no longer.
    fn measure(&self) -> PassFuture<'_>;
}

/// The family: its switch, the `sessionMcp` setting as last written, and
/// the world, once the host has built what it reads.
pub(crate) struct SessionTools {
    on: AtomicBool,
    world: OnceLock<Arc<dyn SessionsWorld>>,
}

impl SessionTools {
    /// Off, with no world: the host switches it as its settings say once it
    /// has read them.
    pub fn new() -> Self {
        Self {
            on: AtomicBool::new(false),
            world: OnceLock::new(),
        }
    }

    /// Switches it on or off; a request reads it, so it takes effect at once.
    pub fn switch(&self, on: bool) {
        self.on.store(on, Ordering::SeqCst);
    }

    /// What it reads from now on. Only the first world given is kept.
    pub fn answer_from(&self, world: Arc<dyn SessionsWorld>) {
        let _ = self.world.set(world);
    }

    fn world(&self) -> Option<Arc<dyn SessionsWorld>> {
        self.world.get().cloned()
    }
}

impl ToolFamily for SessionTools {
    fn name(&self) -> &str {
        SESSION_TOOLS_NAME
    }

    fn route(&self) -> &str {
        SESSION_TOOLS_ROUTE
    }

    fn instructions(&self) -> &str {
        SESSION_TOOLS_INSTRUCTIONS
    }

    fn is_on(&self) -> bool {
        self.on.load(Ordering::SeqCst)
    }

    fn tools(&self) -> Vec<Tool> {
        vec![
            Tool::new(
                SESSIONS_LIST,
                "Every Claude Code session running on this machine right now - what it is called, which directory it is working in, whether it is busy, idle or waiting on the user, and how long it has been that way. Sessions started outside Floti are listed too, because one of those holds a working tree exactly as hard as a Floti session does. Read-only: this tells you what is happening and gives you no way to affect it, and it never returns any part of another session’s conversation. Worth calling before you start long work in a directory somebody else may already be in.",
                schema(json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false,
                })),
            )
            .with_annotations(ToolAnnotations::new().read_only(true)),
            Tool::new(
                SESSION_DETAIL,
                "What one session is working in and what it is holding: its working directory, the branch it started on, the profile it was launched from, the processes running under it and the ports those are listening on. Pass a pid from sessions_list, or no pid at all for your own session. For a session Floti did not start there is nothing beyond what sessions_list already showed, and it says so. Read-only, and it never returns any part of another session’s conversation - not its transcript, not its prompts, not its output, and not the arguments it was launched with.",
                schema(json!({
                    "type": "object",
                    "properties": {
                        "pid": {
                            "type": "number",
                            "description": "The pid from sessions_list. Omit it for your own session - which one that is comes from the token this session was given, never from anything you pass.",
                        },
                    },
                    "additionalProperties": false,
                })),
            )
            .with_annotations(ToolAnnotations::new().read_only(true)),
        ]
    }

    fn call<'a>(&'a self, caller: Caller, name: &'a str, arguments: JsonObject) -> ToolFuture<'a> {
        Box::pin(async move {
            let Some(world) = self.world() else {
                return problem(STILL_STARTING);
            };
            let me = caller
                .session
                .and_then(|session| u64::try_from(session.0).ok());
            match name {
                SESSIONS_LIST => list(world, me).await,
                SESSION_DETAIL => detail(world, me, &arguments).await,
                other => problem(&format!("{SESSION_TOOLS_NAME} has no tool named {other}.")),
            }
        })
    }
}

/// `sessions_list`: the listing as of now, the caller marked by its token.
async fn list(world: Arc<dyn SessionsWorld>, me: Option<u64>) -> CallToolResult {
    match overview(&world).await {
        Some(overview) => text(describe_session_listing(&overview, me)),
        None => problem(STILL_STARTING),
    }
}

/// `session_detail`: the session under the pid asked for, or the caller's
/// own with none.
async fn detail(
    world: Arc<dyn SessionsWorld>,
    me: Option<u64>,
    arguments: &JsonObject,
) -> CallToolResult {
    let asked = match arguments.get("pid") {
        Some(Value::Number(number)) => {
            match number.as_u64().and_then(|pid| u32::try_from(pid).ok()) {
                Some(pid) => Some(pid),
                None => return problem("A pid is a whole number, as sessions_list prints it."),
            }
        }
        // Anything that is not a number is no pid: the caller's own session.
        _ => None,
    };
    let find = |overview: &SessionsOverview| -> Option<LiveSession> {
        overview
            .sessions
            .iter()
            .find(|session| match asked {
                Some(pid) => session.pid == pid,
                None => me.is_some() && session.host_session_id == me,
            })
            .cloned()
    };

    let Some(mut overview) = overview(&world).await else {
        return problem(STILL_STARTING);
    };
    let mut target = find(&overview);

    // The machine is asked only about a session the host runs, and the
    // listing is read again after the pass: a session the host did not start
    // has no tree it could report, and a pass takes long enough for the
    // target to end inside it, so the answer is about the session as it is
    // once the pass is in.
    let mut measured = Vec::new();
    if target
        .as_ref()
        .is_some_and(|session| session.host_session_id.is_some())
    {
        measured = world.measure().await;
        let Some(after) = self::overview(&world).await else {
            return problem(STILL_STARTING);
        };
        overview = after;
        target = find(&overview);
    }

    let Some(target) = target else {
        return match asked {
            Some(pid) => problem(&describe_session_gone(pid)),
            None => problem(NO_LIVE_SESSION),
        };
    };

    let hosted = match target.host_session_id {
        Some(id) => {
            let world = Arc::clone(&world);
            tokio::task::spawn_blocking(move || world.facts_for(id))
                .await
                .ok()
                .flatten()
        }
        None => None,
    };
    // No tree for a session the host did not start: it has no pid for one
    // that it did not read out of somebody else's record. `held_by` is where
    // the command lines are dropped, and the only way a pass reaches the
    // shaping.
    let holding = target
        .host_session_id
        .and_then(|id| measured.iter().find(|entry| entry.id == id))
        .map(held_by);
    text(describe_session_detail(SessionDetailInput {
        session: &target,
        hosted: hosted.as_ref(),
        holding: holding.as_ref(),
        read_at_ms: overview.read_at_ms,
        is_caller: me.is_some() && target.host_session_id == me,
    }))
}

/// The listing, read now, off the runtime's workers.
async fn overview(world: &Arc<dyn SessionsWorld>) -> Option<SessionsOverview> {
    let world = Arc::clone(world);
    tokio::task::spawn_blocking(move || world.overview())
        .await
        .ok()
        .flatten()
}

fn text(body: String) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(body)])
}

fn problem(body: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(body.to_owned())])
}

fn schema(value: Value) -> JsonObject {
    match value {
        Value::Object(map) => map,
        _ => unreachable!("a tool's schema is an object"),
    }
}

/// The world the host answers from: its sessions, the activity pass and the
/// processes-and-ports pass. It holds the sessions weakly, so it keeps
/// nothing of the host's alive.
pub(crate) struct HostWorld {
    pub hosted: Weak<Hosted>,
    pub activity: ActivityHandle,
    pub resources: ResourcesHandle,
}

impl SessionsWorld for HostWorld {
    fn overview(&self) -> Option<SessionsOverview> {
        self.activity.read_now()
    }

    fn facts_for(&self, host_session_id: u64) -> Option<HostedSessionFacts> {
        let hosted = self.hosted.upgrade()?;
        let record = hosted.record(session_id(host_session_id)?).ok()?;
        // The profile may have been deleted since: a session is a record of
        // what happened and outlives the profile it came from.
        let profile = record.profile_id.and_then(|id| {
            records::read_profile(&hosted.ledger().store(), id)
                .ok()
                .flatten()
        });
        // Field by field, and argv and the conversation id are not fields:
        // see `HostedSessionFacts` for why each would hand over another
        // session's conversation or its token.
        Some(HostedSessionFacts {
            host_session_id: record.id,
            branch: record.branch,
            profile: profile.as_ref().map(|profile| profile.name.clone()),
            overlays: profile.map(|profile| profile.overlays).unwrap_or_default(),
            started_at_ms: parse_instant(&record.started_at),
        })
    }

    fn measure(&self) -> PassFuture<'_> {
        Box::pin(self.resources.one_pass())
    }
}
