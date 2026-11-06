//! floti-agents: start, list, wait on and stop an agent's own children, list
//! the roles they can be started in, and (for a child) report to its parent,
//! served to the host's sessions on the agent tools listener at `/mcp/agents`
//! (`floti_agents.json`).
//!
//! **Only the host serves it, and only to a session's own children.** Which
//! session is calling is which bearer token arrived ([`Caller`]); no tool
//! takes a session id, every name a tool is given is resolved among the
//! caller's own children, and anything else is not found. The work is
//! `Hosted`'s (`hosted/children.rs`): this module is the tool surface over it,
//! so that the tools and `floti agent` (which calls these same tools) answer
//! one way.
//!
//! **Nothing here needs a client.** A call is answered by the host alone, with
//! nobody attached: a child is started, listed and stopped whether or not a
//! window is open.
//!
//! **News comes through a wait.** What a child tells its parent (its report,
//! that it needs a person, that its turn ended, that it ended, an error) is
//! kept in the parent's inbox (`hosted/children/inbox.rs`) and returned by
//! `agents_wait`, or by `agents_start` with `wait`, in order, naming the child
//! and the event. A wait holds, answering as a stream that says it is still
//! there, only where the caller's agent can wait in the background: its own
//! tool call for one that moves long calls to the background, a command in its
//! shell (`floti agent wait`, marked by the shell header) for one that wakes
//! on a finished background command. Any other agent's wait answers at once.
//! What a wait returns is marked heard only once the answer has reached its
//! caller ([`Delivery`]), so a dropped wait loses nothing.
//!
//! **`agents_report` is a child's.** It is listed and allowed, per caller, only
//! for a session that has a parent; anyone else is told the family has no such
//! tool.
//!
//! **Every tool answers in two blocks.** The first is the text a model reads;
//! the second is the same answer as JSON, which `floti agent --json` prints.
//! A refusal is one block of text, marked as an error.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, OnceLock, Weak};

use serde::Deserialize;
use serde_json::{Value, json};

use super::hosted::{
    ChildEntry, ChildStopped, ChildrenListed, Hosted, RoleEntry, RolesListed, StartChild, WaitEnd,
    WaitFor, WaitRequest, Waited,
};
use crate::agent_tools::{
    CallToolResult, Caller, ContentBlock, Delivery, GrantScope, JsonObject, Tool, ToolFamily,
    ToolFuture,
};
use crate::session::SessionId;

/// The family as the table gives it: its name, route, instructions and each
/// tool's name, description and input schema.
#[derive(Debug, Deserialize)]
struct Table {
    name: String,
    path: String,
    instructions: String,
    tools: Vec<Spec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spec {
    name: String,
    description: String,
    input_schema: JsonObject,
}

static TABLE: LazyLock<Table> = LazyLock::new(|| {
    serde_json::from_str(include_str!("floti_agents.json"))
        .expect("floti_agents.json is the agents family's table")
});

/// The family's name, as an agent's permission rules name it.
pub(crate) const FAMILY: &str = "floti-agents";

const AGENTS_START: &str = "agents_start";
const AGENTS_LIST: &str = "agents_list";
const AGENTS_STOP: &str = "agents_stop";
const AGENTS_ROLES: &str = "agents_roles";
const AGENTS_WAIT: &str = "agents_wait";
const AGENTS_REPORT: &str = "agents_report";

/// The most characters of a report's text. A longer answer is written to a
/// file, and the report gives its path.
pub(crate) const MAX_REPORT_CHARS: usize = 4000;

/// The shell commands a launch runs without asking beside the tools, each
/// named on its own: never `floti agent` as a prefix, which would allow its
/// siblings with it, and never `floti agent run`.
const COMMANDS: &[&str] = &["floti agent start", "floti agent stop", "floti agent wait"];

/// The answer while the host is still assembling what the tools act on.
const STILL_STARTING: &str =
    "Floti cannot answer that right now - it is still starting up. Try again in a moment.";

/// The answer to a call from a token whose session the host has not yet
/// started: a token is minted before its session is.
const NOT_YET_RUNNING: &str = "Your session has not finished starting. Try again in a moment.";

/// The family: its switch (the `sessionAgents` setting as last written) and
/// the host it acts through, once the host has built one.
pub(crate) struct FlotiAgents {
    on: AtomicBool,
    hosted: OnceLock<Weak<Hosted>>,
}

impl FlotiAgents {
    /// Off, acting through nothing: the host switches it as its settings say
    /// once it has read them.
    pub fn new() -> Self {
        Self {
            on: AtomicBool::new(false),
            hosted: OnceLock::new(),
        }
    }

    /// Switches it on or off; a request reads it, so it takes effect at once.
    pub fn switch(&self, on: bool) {
        self.on.store(on, Ordering::SeqCst);
    }

    /// What it acts through from now on. Only the first given is kept.
    pub fn act_through(&self, hosted: Weak<Hosted>) {
        let _ = self.hosted.set(hosted);
    }

    fn hosted(&self) -> Option<Arc<Hosted>> {
        self.hosted.get().and_then(Weak::upgrade)
    }

    /// Whether `caller` is a session that has a parent to report to.
    fn reports_to_parent(&self, caller: Caller) -> bool {
        caller
            .session
            .zip(self.hosted())
            .is_some_and(|(session, hosted)| hosted.reports_to_parent(session))
    }
}

impl ToolFamily for FlotiAgents {
    fn name(&self) -> &str {
        &TABLE.name
    }

    fn route(&self) -> &str {
        &TABLE.path
    }

    fn instructions(&self) -> &str {
        &TABLE.instructions
    }

    fn is_on(&self) -> bool {
        self.on.load(Ordering::SeqCst)
    }

    fn tools(&self) -> Vec<Tool> {
        TABLE
            .tools
            .iter()
            .map(|spec| {
                Tool::new(
                    spec.name.clone(),
                    spec.description.clone(),
                    spec.input_schema.clone(),
                )
            })
            .collect()
    }

    /// Every tool but `agents_report` for a caller with no parent.
    fn tools_for(&self, caller: Caller) -> Vec<Tool> {
        let reports = self.reports_to_parent(caller);
        self.tools()
            .into_iter()
            .filter(|tool| reports || tool.name != AGENTS_REPORT)
            .collect()
    }

    /// Every tool: each acts only on the caller's own children or its own
    /// parent, so none needs asking about.
    fn allowed_tools(&self) -> Vec<String> {
        TABLE.tools.iter().map(|spec| spec.name.clone()).collect()
    }

    fn allowed_tools_in(&self, scope: GrantScope) -> Vec<String> {
        TABLE
            .tools
            .iter()
            .filter(|spec| scope.reports_to_parent || spec.name != AGENTS_REPORT)
            .map(|spec| spec.name.clone())
            .collect()
    }

    /// A wait, or a start that waits, holds where the caller's agent can wait
    /// in the background (`Hosted::waits_hold`).
    fn holds(&self, caller: Caller, name: &str, arguments: &JsonObject) -> bool {
        let waits = match name {
            AGENTS_WAIT => true,
            AGENTS_START => matches!(arguments.get("wait"), Some(Value::Bool(true))),
            _ => false,
        };
        waits
            && caller
                .session
                .zip(self.hosted())
                .is_some_and(|(session, hosted)| hosted.waits_hold(session, caller.shell))
    }

    fn allowed_commands(&self) -> Vec<String> {
        COMMANDS
            .iter()
            .map(|command| (*command).to_owned())
            .collect()
    }

    fn call<'a>(&'a self, caller: Caller, name: &'a str, arguments: JsonObject) -> ToolFuture<'a> {
        self.call_with(caller, name, arguments, Delivery::default())
    }

    fn call_with<'a>(
        &'a self,
        caller: Caller,
        name: &'a str,
        arguments: JsonObject,
        delivery: Delivery,
    ) -> ToolFuture<'a> {
        Box::pin(async move {
            let Some(hosted) = self.hosted() else {
                return problem(STILL_STARTING);
            };
            let Some(me) = caller.session else {
                return problem(NOT_YET_RUNNING);
            };
            let from = Waiter {
                hosted: &hosted,
                me,
                shell: caller.shell,
                delivery: &delivery,
            };
            match name {
                AGENTS_START => start(&from, &arguments).await,
                AGENTS_WAIT => wait(&from, &arguments).await,
                AGENTS_REPORT => report(Arc::clone(&hosted), me, &arguments).await,
                AGENTS_LIST => list(hosted, me).await,
                AGENTS_STOP => stop(hosted, me, &arguments).await,
                AGENTS_ROLES => roles(hosted, me).await,
                other => problem(&format!("{} has no tool named {other}.", TABLE.name)),
            }
        })
    }
}

/// A call that may wait: who is calling, how, and where to say what it
/// returned once it has been delivered.
struct Waiter<'a> {
    hosted: &'a Arc<Hosted>,
    me: SessionId,
    /// The call came from `floti agent` in the caller's shell.
    shell: bool,
    delivery: &'a Delivery,
}

impl Waiter<'_> {
    /// Waits for the caller's news as asked, holding where its agent can, and
    /// says the news returned is heard once the answer has been delivered.
    async fn wait(&self, wait_for: WaitFor, children: Vec<String>) -> Result<Waited, String> {
        let hold = self.hosted.waits_hold(self.me, self.shell);
        let waited = self
            .hosted
            .wait_for_news(
                self.me,
                WaitRequest {
                    wait_for,
                    children,
                    hold,
                },
            )
            .await?;
        self.delivery.on_delivered(waited.confirm(self.hosted));
        Ok(waited)
    }
}

/// `agents_start`: a child of the caller, started on the task given; with
/// `wait`, then the child's next news.
async fn start(from: &Waiter<'_>, arguments: &JsonObject) -> CallToolResult {
    let asked = start_request(arguments).and_then(|request| {
        let wait = flag(arguments, "wait")?.unwrap_or(false);
        Ok((request, wait))
    });
    let (request, wait) = match asked {
        Ok(asked) => asked,
        Err(refusal) => return problem(&refusal),
    };
    let resumed = request.resume.is_some();
    let (hosted, me) = (Arc::clone(from.hosted), from.me);
    let started = match blocking(move || hosted.start_child(me, request)).await {
        Ok(started) => started,
        Err(refusal) => return problem(&refusal),
    };
    let branch = started.branch.as_deref().unwrap_or("none");
    let verb = if resumed { "Resumed" } else { "Started" };
    let mut text = format!(
        "{verb} {name}.
name: {name}
backend: {backend}
folder: {folder}
branch: {branch}",
        name = started.name,
        backend = started.backend,
        folder = started.folder,
    );
    if let Some(worktree) = &started.worktree {
        text.push_str(&format!("
worktree: {worktree}"));
    }
    let mut body = json!({
        "name": started.name,
        "backend": started.backend,
        "folder": started.folder,
        "branch": started.branch,
        "worktree": started.worktree,
    });
    if wait {
        // Only that child's news: the rest stays in the inbox for a wait.
        match from.wait(WaitFor::Any, vec![started.name.clone()]).await {
            Ok(waited) => {
                text.push_str("

");
                text.push_str(&waited_text(&waited));
                if let (Some(body), Value::Object(news)) =
                    (body.as_object_mut(), waited_json(&waited))
                {
                    body.extend(news);
                }
            }
            Err(refusal) => {
                text.push_str(&format!(
                    "

It is running, but waiting on it failed: {refusal}"
                ));
            }
        }
    }
    answer(text, body)
}

/// `agents_wait`: the caller's unseen news, holding where its agent can.
async fn wait(from: &Waiter<'_>, arguments: &JsonObject) -> CallToolResult {
    let (wait_for, children) = match wait_request(arguments) {
        Ok(asked) => asked,
        Err(refusal) => return problem(&refusal),
    };
    match from.wait(wait_for, children).await {
        Ok(waited) => answer(waited_text(&waited), waited_json(&waited)),
        Err(refusal) => problem(&refusal),
    }
}

/// `agents_report`: the caller, a child, tells its parent where it is.
async fn report(hosted: Arc<Hosted>, me: SessionId, arguments: &JsonObject) -> CallToolResult {
    let (state, text) = match report_request(arguments) {
        Ok(told) => told,
        Err(refusal) => return problem(&refusal),
    };
    let reported = state.clone();
    match blocking(move || hosted.child_reported(me, &state, &text)).await {
        Ok(()) => answer(
            format!("Reported {reported} to the agent that started you."),
            json!({ "reported": reported }),
        ),
        Err(refusal) => problem(&refusal),
    }
}

/// `agents_list`: `me`'s running children and what is left of its limits.
async fn list(hosted: Arc<Hosted>, me: SessionId) -> CallToolResult {
    match blocking(move || hosted.list_children(me)).await {
        Ok(listed) => {
            let text = listing_text(&listed);
            answer(text, listing_json(&listed))
        }
        Err(refusal) => problem(&refusal),
    }
}

/// `agents_roles`: the roles there are now, and the files that are not roles.
async fn roles(hosted: Arc<Hosted>, me: SessionId) -> CallToolResult {
    match blocking(move || hosted.list_roles(me)).await {
        Ok(listed) => {
            let text = roles_text(&listed);
            answer(text, roles_json(&listed))
        }
        Err(refusal) => problem(&refusal),
    }
}

/// `agents_stop`: one of `me`'s children, and the agents it started.
async fn stop(hosted: Arc<Hosted>, me: SessionId, arguments: &JsonObject) -> CallToolResult {
    let Some(child) = text_argument(arguments, "child") else {
        return problem("Name the agent to stop, as agents_start answered it: child.");
    };
    match blocking(move || hosted.stop_child(me, &child)).await {
        Ok(stopped) => stopped_answer(&stopped),
        Err(refusal) => problem(&refusal),
    }
}

fn stopped_answer(stopped: &ChildStopped) -> CallToolResult {
    let mut text = format!("Stopped {}.", stopped.name);
    if !stopped.also.is_empty() {
        text.push_str(&format!(
            " Its agents ended with it: {}.",
            stopped.also.join(", ")
        ));
    }
    answer(
        text,
        json!({ "stopped": stopped.name, "also": stopped.also }),
    )
}

/// Runs `work`, which reads the store and starts processes, off the runtime's
/// workers. A panic in it is a refusal, never a hung call.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|_| Err("Floti could not finish that. Try again.".to_owned()))
}

/// What `agents_start` was asked for. A text argument of the wrong kind is a
/// refusal naming it; an argument the schema does not declare is ignored.
fn start_request(arguments: &JsonObject) -> Result<StartChild, String> {
    let task = text_argument(arguments, "task")
        .ok_or_else(|| "Give the agent its task: task is what it is to do.".to_owned())?;
    for key in [
        "role", "backend", "folder", "profile", "name", "worktree", "resume",
    ] {
        if !matches!(
            arguments.get(key),
            None | Some(Value::Null | Value::String(_))
        ) {
            return Err(format!("{key} is text."));
        }
    }
    Ok(StartChild {
        task,
        role: text_argument(arguments, "role"),
        backend: text_argument(arguments, "backend"),
        folder: text_argument(arguments, "folder"),
        profile: text_argument(arguments, "profile"),
        name: text_argument(arguments, "name"),
        worktree: text_argument(arguments, "worktree"),
        outlive: flag(arguments, "outlive")?.unwrap_or(false),
        can_start: flag(arguments, "can_start")?,
        resume: text_argument(arguments, "resume"),
    })
}

/// A true-or-false argument; none when it is left out.
fn flag(arguments: &JsonObject, key: &str) -> Result<Option<bool>, String> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(format!("{key} is true or false.")),
    }
}

/// What `agents_wait` was asked: what to wait for and which children, none
/// for all of them. A name given alone is the same as a list of one.
fn wait_request(arguments: &JsonObject) -> Result<(WaitFor, Vec<String>), String> {
    let wait_for = match arguments.get("for") {
        None | Some(Value::Null) => WaitFor::Any,
        Some(Value::String(word)) => match word.trim().to_ascii_lowercase().as_str() {
            "any" => WaitFor::Any,
            "all" => WaitFor::All,
            _ => return Err("for is any or all.".to_owned()),
        },
        Some(_) => return Err("for is any or all.".to_owned()),
    };
    let names = match arguments.get("children") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::String(name)) => vec![name.clone()],
        Some(Value::Array(names)) => names
            .iter()
            .map(|name| {
                name.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "children is a list of names.".to_owned())
            })
            .collect::<Result<_, _>>()?,
        Some(_) => return Err("children is a list of names.".to_owned()),
    };
    let children = names
        .into_iter()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .collect();
    Ok((wait_for, children))
}

/// What `agents_report` was told: its state, and its text if it is not too
/// long to be one. The refusal says what to do instead.
fn report_request(arguments: &JsonObject) -> Result<(String, String), String> {
    let state = match arguments.get("state").and_then(Value::as_str) {
        Some(word) => match word.trim().to_ascii_lowercase().as_str() {
            state @ ("done" | "stuck" | "note") => state.to_owned(),
            _ => return Err("state is done, stuck or note.".to_owned()),
        },
        None => return Err("Say how you are reporting: state is done, stuck or note.".to_owned()),
    };
    let text = text_argument(arguments, "text").ok_or_else(|| {
        "Say what you are reporting: text is what to tell the agent that started you.".to_owned()
    })?;
    let length = text.chars().count();
    if length > MAX_REPORT_CHARS {
        return Err(format!(
            "That report is {length} characters and a report is at most {MAX_REPORT_CHARS}. Put the longer answer in a file and report its path."
        ));
    }
    Ok((state, text))
}

/// A non-blank text argument, trimmed.
fn text_argument(arguments: &JsonObject, key: &str) -> Option<String> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

fn listing_text(listed: &ChildrenListed) -> String {
    let mut out = String::new();
    if listed.children.is_empty() {
        out.push_str("You have no running agents.\n");
    } else {
        for child in &listed.children {
            out.push_str(&child_text(child));
            out.push('\n');
        }
    }
    let limits = &listed.limits;
    out.push_str(&format!(
        "Limits left: {} of {} running at once, {} of {} starts, {} of {} on this host, {} of {} heavy on this host.",
        limits.children_left,
        limits.children_per_parent,
        limits.starts_left,
        limits.starts_per_parent,
        limits.host_left,
        limits.sessions_per_host,
        limits.heavy_left,
        limits.heavy_per_host,
    ));
    if let Some(reason) = &limits.cannot_start {
        out.push_str(&format!(" {reason}"));
    }
    out
}

fn child_text(child: &ChildEntry) -> String {
    let branch = child.branch.as_deref().unwrap_or("none");
    let role = child.role.as_deref().unwrap_or("none");
    let mut line = format!(
        "{name}  role {role}  class {class}  {backend}  {state} since {since}  {folder}  branch {branch}",
        name = child.name,
        class = child.class.as_str(),
        backend = child.backend,
        state = child.state,
        since = child.since,
        folder = child.folder,
    );
    if child.worktree {
        line.push_str("  works in a worktree");
    }
    if child.outlive {
        line.push_str("  outlives you");
    }
    if child.can_start {
        line.push_str("  may start agents");
    }
    line
}

fn listing_json(listed: &ChildrenListed) -> Value {
    let limits = &listed.limits;
    json!({
        "children": listed.children.iter().map(|child| json!({
            "name": child.name,
            "role": child.role,
            "class": child.class.as_str(),
            "worktree": child.worktree,
            "backend": child.backend,
            "state": child.state,
            "since": child.since,
            "folder": child.folder,
            "branch": child.branch,
            "outlive": child.outlive,
            "canStart": child.can_start,
        })).collect::<Vec<_>>(),
        "limits": {
            "childrenPerParent": limits.children_per_parent,
            "childrenLeft": limits.children_left,
            "startsPerParent": limits.starts_per_parent,
            "startsLeft": limits.starts_left,
            "sessionsPerHost": limits.sessions_per_host,
            "hostLeft": limits.host_left,
            "heavyPerHost": limits.heavy_per_host,
            "heavyLeft": limits.heavy_left,
            "depth": limits.depth,
            "cannotStart": limits.cannot_start,
        },
    })
}

fn roles_text(listed: &RolesListed) -> String {
    let mut out = String::new();
    for role in &listed.roles {
        out.push_str(&role_text(role));
        out.push('\n');
    }
    if !listed.bad.is_empty() {
        out.push_str("Role files that cannot be used:\n");
        for bad in &listed.bad {
            out.push_str(&format!("{}: {}\n", bad.file, bad.problem));
        }
    }
    out.trim_end().to_owned()
}

fn role_text(role: &RoleEntry) -> String {
    let yes_no = |flag: bool| if flag { "yes" } else { "no" };
    let backends = if role.backends.is_empty() {
        "none installed here can run it".to_owned()
    } else {
        role.backends.join(", ")
    };
    let mut text = format!(
        "{name}  class {class}  worktree {worktree}  may start agents {can_start}  runs on {backends}",
        name = role.name,
        class = role.class.as_str(),
        worktree = yes_no(role.worktree),
        can_start = yes_no(role.can_start),
    );
    if !role.description.is_empty() {
        text.push_str(&format!("\n  {}", role.description));
    }
    text
}

fn roles_json(listed: &RolesListed) -> Value {
    json!({
        "roles": listed.roles.iter().map(|role| json!({
            "name": role.name,
            "description": role.description,
            "class": role.class.as_str(),
            "worktree": role.worktree,
            "canStart": role.can_start,
            "backends": role.backends,
        })).collect::<Vec<_>>(),
        "bad": listed.bad.iter().map(|bad| json!({
            "file": bad.file,
            "problem": bad.problem,
        })).collect::<Vec<_>>(),
    })
}

/// What a wait answers, as a model reads it: each item of news on its own
/// line, then who is still working and why the wait ended early, if it did.
fn waited_text(waited: &Waited) -> String {
    let mut lines: Vec<String> = waited.news.iter().map(|news| news.line()).collect();
    if lines.is_empty() {
        lines.push(
            match waited.end {
                WaitEnd::CallerEnded => "Your session has ended.",
                _ if waited.working.is_empty() => {
                    "Nothing new, and none of those agents is working."
                }
                // A wait that does not hold says when to ask again.
                WaitEnd::NothingNew => "Nothing new yet. Wait again after your next piece of work.",
                _ => "Nothing new yet.",
            }
            .to_owned(),
        );
    }
    if !waited.working.is_empty() {
        lines.push(format!("Still working: {}.", waited.working.join(", ")));
    }
    if waited.end == WaitEnd::Typed {
        lines.push(
            "Someone typed into your terminal, so this wait ended early. Wait again when you are ready."
                .to_owned(),
        );
    }
    lines.join("\n")
}

/// The same, for `floti agent wait --json` to print.
fn waited_json(waited: &Waited) -> Value {
    let ended = match waited.end {
        WaitEnd::News => "news",
        WaitEnd::Idle => "idle",
        WaitEnd::NothingNew => "nothingNew",
        WaitEnd::Typed => "typed",
        WaitEnd::CallerEnded => "callerEnded",
    };
    json!({
        "news": waited.news.iter().map(|news| news.json()).collect::<Vec<_>>(),
        "working": waited.working,
        "ended": ended,
    })
}

/// A success: the text, then the same answer as JSON.
fn answer(text: String, json: Value) -> CallToolResult {
    CallToolResult::success(vec![
        ContentBlock::text(text),
        ContentBlock::text(json.to_string()),
    ])
}

/// A refusal the model can read.
fn problem(message: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(message.to_owned())])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roles::{BadRole, RoleClass};
    use crate::server::hosted::{EventKind, Facts, News};

    fn arguments(value: Value) -> JsonObject {
        value.as_object().expect("an object").clone()
    }

    #[test]
    fn the_table_names_the_six_tools_and_the_route() {
        let family = FlotiAgents::new();
        assert_eq!(family.name(), "floti-agents");
        assert_eq!(family.route(), "/mcp/agents");
        let names: Vec<String> = family
            .tools()
            .into_iter()
            .map(|tool| tool.name.to_string())
            .collect();
        assert_eq!(
            names,
            [
                "agents_start",
                "agents_list",
                "agents_stop",
                "agents_roles",
                "agents_wait",
                "agents_report"
            ]
        );
        assert_eq!(family.allowed_tools(), names);
        // Each command on its own: never `floti agent` as a prefix, never run.
        assert_eq!(
            family.allowed_commands(),
            ["floti agent start", "floti agent stop", "floti agent wait"]
        );
        assert!(!family.is_on());
        family.switch(true);
        assert!(family.is_on());
    }

    #[test]
    fn the_instructions_say_what_the_tools_do_and_that_they_reach_only_the_callers_own_agents() {
        let family = FlotiAgents::new();
        let instructions = family.instructions();
        for word in [
            "agents_start",
            "agents_list",
            "agents_stop",
            "agents_roles",
            "agents_wait",
            "call it again",
            "You can reach only the sessions you started",
        ] {
            assert!(instructions.contains(word), "{word} in {instructions}");
        }
        assert!(
            !instructions.contains("agents_send"),
            "no tool that does not exist yet"
        );
    }

    #[test]
    fn a_launch_of_a_child_is_allowed_agents_report_and_any_other_launch_is_not() {
        let family = FlotiAgents::new();
        let child = family.allowed_tools_in(GrantScope {
            reports_to_parent: true,
        });
        let plain = family.allowed_tools_in(GrantScope::default());
        assert!(child.iter().any(|name| name == "agents_report"));
        assert!(!plain.iter().any(|name| name == "agents_report"));
        for name in ["agents_start", "agents_wait", "agents_list", "agents_stop"] {
            assert!(plain.iter().any(|tool| tool == name), "{name}");
            assert!(child.iter().any(|tool| tool == name), "{name}");
        }
    }

    #[test]
    fn a_wait_is_for_any_unless_it_says_all_and_names_children_as_a_list_or_one_name() {
        assert_eq!(
            wait_request(&arguments(json!({}))),
            Ok((WaitFor::Any, vec![]))
        );
        assert_eq!(
            wait_request(&arguments(
                json!({ "for": "ALL", "children": [" a ", "b", " "] })
            )),
            Ok((WaitFor::All, vec!["a".to_owned(), "b".to_owned()]))
        );
        assert_eq!(
            wait_request(&arguments(json!({ "for": null, "children": "solo" }))),
            Ok((WaitFor::Any, vec!["solo".to_owned()]))
        );
        for bad in [
            json!({ "for": "some" }),
            json!({ "for": 3 }),
            json!({ "children": 3 }),
            json!({ "children": ["a", 3] }),
        ] {
            assert!(wait_request(&arguments(bad.clone())).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_report_is_done_stuck_or_note_with_text_of_at_most_4000_characters() {
        assert_eq!(
            report_request(&arguments(
                json!({ "state": " Done ", "text": " all fixed " })
            )),
            Ok(("done".to_owned(), "all fixed".to_owned()))
        );
        for state in ["done", "stuck", "note"] {
            assert!(report_request(&arguments(json!({ "state": state, "text": "x" }))).is_ok());
        }
        assert!(
            report_request(&arguments(json!({ "state": "finished", "text": "x" })))
                .unwrap_err()
                .contains("done, stuck or note")
        );
        assert!(report_request(&arguments(json!({ "text": "x" }))).is_err());
        assert!(report_request(&arguments(json!({ "state": "done", "text": "  " }))).is_err());
        assert!(report_request(&arguments(json!({ "state": "done" }))).is_err());

        // Exactly the cap is a report; one more is refused with the reason and
        // what to do instead. Characters are counted, not bytes.
        let at_cap = "é".repeat(MAX_REPORT_CHARS);
        assert!(report_request(&arguments(json!({ "state": "done", "text": at_cap }))).is_ok());
        let over = "x".repeat(MAX_REPORT_CHARS + 1);
        let refusal =
            report_request(&arguments(json!({ "state": "done", "text": over }))).unwrap_err();
        assert!(refusal.contains("4001"), "{refusal}");
        assert!(refusal.contains("at most 4000"), "{refusal}");
        assert!(refusal.contains("file"), "{refusal}");
    }

    fn news(child: &str, event: EventKind, state: Option<&str>) -> News {
        News {
            id: 1,
            child: child.to_owned(),
            event,
            facts: Facts {
                state: state.map(str::to_owned),
                detail: Some("all fixed".to_owned()),
                exit_code: None,
            },
            at: "2026-11-06T10:00:00.000Z".to_owned(),
        }
    }

    #[test]
    fn a_wait_answers_with_each_item_on_a_line_who_is_still_working_and_why_it_ended() {
        let waited = Waited {
            news: vec![
                news("reviewer", EventKind::Report, Some("done")),
                news("worker", EventKind::TurnEnded, None),
            ],
            working: vec!["scout".to_owned()],
            end: WaitEnd::News,
        };
        assert_eq!(
            waited_text(&waited),
            "reviewer reported done: all fixed\nworker ended its turn without reporting.\nStill working: scout."
        );
        let body = waited_json(&waited);
        assert_eq!(body["ended"], "news");
        assert_eq!(body["working"], json!(["scout"]));
        assert_eq!(body["news"][0]["child"], "reviewer");
        assert_eq!(body["news"][0]["event"], "report");
        assert_eq!(body["news"][1]["event"], "turn_ended");

        let nothing = Waited {
            news: vec![],
            working: vec!["scout".to_owned()],
            end: WaitEnd::NothingNew,
        };
        assert_eq!(
            waited_text(&nothing),
            "Nothing new yet. Wait again after your next piece of work.\nStill working: scout."
        );
        let idle = Waited {
            news: vec![],
            working: vec![],
            end: WaitEnd::Idle,
        };
        assert_eq!(
            waited_text(&idle),
            "Nothing new, and none of those agents is working."
        );
        let typed = Waited {
            news: vec![],
            working: vec!["scout".to_owned()],
            end: WaitEnd::Typed,
        };
        assert!(waited_text(&typed).contains("typed into your terminal"));
        assert_eq!(waited_json(&typed)["ended"], "typed");
    }

    #[test]
    fn a_start_needs_a_task_and_reads_each_choice_it_is_given() {
        assert!(start_request(&arguments(json!({}))).is_err());
        assert!(start_request(&arguments(json!({ "task": "  " }))).is_err());
        let request = start_request(&arguments(json!({
            "task": " review it ",
            "role": "reviewer",
            "backend": "other-agent",
            "folder": "src",
            "profile": "Acme",
            "name": "r",
            "outlive": true,
            "can_start": false,
            "session": 3,
        })))
        .expect("a request");
        assert_eq!(request.task, "review it");
        assert_eq!(request.role.as_deref(), Some("reviewer"));
        assert_eq!(request.backend.as_deref(), Some("other-agent"));
        assert_eq!(request.folder.as_deref(), Some("src"));
        assert_eq!(request.profile.as_deref(), Some("Acme"));
        assert_eq!(request.name.as_deref(), Some("r"));
        assert!(request.outlive);
        assert_eq!(request.can_start, Some(false));
    }

    #[test]
    fn a_start_reads_wait_as_true_or_false_and_refuses_anything_else() {
        assert_eq!(
            flag(&arguments(json!({ "wait": true })), "wait"),
            Ok(Some(true))
        );
        assert_eq!(flag(&arguments(json!({})), "wait"), Ok(None));
        assert!(flag(&arguments(json!({ "wait": "yes" })), "wait").is_err());
    }

    fn listed_roles() -> RolesListed {
        RolesListed {
            roles: vec![
                RoleEntry {
                    name: "agent".into(),
                    description: String::new(),
                    class: RoleClass::Light,
                    worktree: false,
                    can_start: false,
                    backends: vec!["claude-code".into(), "other-agent".into()],
                },
                RoleEntry {
                    name: "scout".into(),
                    description: "Looks around.".into(),
                    class: RoleClass::Heavy,
                    worktree: true,
                    can_start: true,
                    backends: vec![],
                },
            ],
            bad: vec![BadRole {
                file: "typo.md".into(),
                problem: "the key disalowed_tools is not a role field".into(),
            }],
        }
    }

    #[test]
    fn the_roles_answer_names_each_role_what_it_is_and_the_backends_that_can_run_it() {
        let text = roles_text(&listed_roles());
        assert_eq!(
            text,
            "agent  class light  worktree no  may start agents no  runs on claude-code, other-agent\n\
             scout  class heavy  worktree yes  may start agents yes  runs on none installed here can run it\n  Looks around.\n\
             Role files that cannot be used:\n\
             typo.md: the key disalowed_tools is not a role field"
        );
        assert_eq!(
            roles_json(&listed_roles()),
            json!({
                "roles": [
                    {
                        "name": "agent",
                        "description": "",
                        "class": "light",
                        "worktree": false,
                        "canStart": false,
                        "backends": ["claude-code", "other-agent"],
                    },
                    {
                        "name": "scout",
                        "description": "Looks around.",
                        "class": "heavy",
                        "worktree": true,
                        "canStart": true,
                        "backends": [],
                    },
                ],
                "bad": [
                    { "file": "typo.md", "problem": "the key disalowed_tools is not a role field" },
                ],
            })
        );
    }

    #[test]
    fn a_listing_with_no_bad_file_says_nothing_of_them() {
        let mut listed = listed_roles();
        listed.bad.clear();
        assert!(!roles_text(&listed).contains("cannot be used"));
        assert_eq!(roles_json(&listed)["bad"], json!([]));
    }

    #[test]
    fn a_choice_of_the_wrong_kind_is_refused_naming_it() {
        let wrong = start_request(&arguments(json!({ "task": "t", "outlive": "yes" })))
            .expect_err("a refusal");
        assert!(wrong.contains("outlive"), "{wrong}");
        let wrong =
            start_request(&arguments(json!({ "task": "t", "folder": 4 }))).expect_err("a refusal");
        assert!(wrong.contains("folder"), "{wrong}");
    }
}
