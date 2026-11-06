//! floti-agents: start, list and stop an agent's own children, and list the
//! roles they can be started in, served to the
//! host's sessions on the agent tools listener at `/mcp/agents` (`floti_agents.json`).
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
//! **Every tool answers in two blocks.** The first is the text a model reads;
//! the second is the same answer as JSON, which `floti agent --json` prints.
//! A refusal is one block of text, marked as an error.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, OnceLock, Weak};

use serde::Deserialize;
use serde_json::{Value, json};

use super::hosted::{
    ChildEntry, ChildStopped, ChildrenListed, Hosted, RoleEntry, RolesListed, StartChild,
};
use crate::agent_tools::{
    CallToolResult, Caller, ContentBlock, JsonObject, Tool, ToolFamily, ToolFuture,
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

/// The shell commands a launch runs without asking beside the tools, each
/// named on its own: never `floti agent` as a prefix, which would allow its
/// siblings with it.
const COMMANDS: &[&str] = &["floti agent start", "floti agent stop"];

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

    /// Every tool: each acts only on the caller's own children, so none needs
    /// asking about.
    fn allowed_tools(&self) -> Vec<String> {
        TABLE.tools.iter().map(|spec| spec.name.clone()).collect()
    }

    fn allowed_commands(&self) -> Vec<String> {
        COMMANDS
            .iter()
            .map(|command| (*command).to_owned())
            .collect()
    }

    fn call<'a>(&'a self, caller: Caller, name: &'a str, arguments: JsonObject) -> ToolFuture<'a> {
        Box::pin(async move {
            let Some(hosted) = self.hosted.get().and_then(Weak::upgrade) else {
                return problem(STILL_STARTING);
            };
            let Some(me) = caller.session else {
                return problem(NOT_YET_RUNNING);
            };
            match name {
                AGENTS_START => start(hosted, me, &arguments).await,
                AGENTS_LIST => list(hosted, me).await,
                AGENTS_STOP => stop(hosted, me, &arguments).await,
                AGENTS_ROLES => roles(hosted, me).await,
                other => problem(&format!("{} has no tool named {other}.", TABLE.name)),
            }
        })
    }
}

/// `agents_start`: a child of `me`, started on the task given, or one of its
/// ended children reopened with the task as its next turn.
async fn start(
    hosted: std::sync::Arc<Hosted>,
    me: SessionId,
    arguments: &JsonObject,
) -> CallToolResult {
    let request = match start_request(arguments) {
        Ok(request) => request,
        Err(refusal) => return problem(&refusal),
    };
    let resumed = request.resume.is_some();
    match blocking(move || hosted.start_child(me, request)).await {
        Ok(started) => {
            let branch = started.branch.as_deref().unwrap_or("none");
            let verb = if resumed { "Resumed" } else { "Started" };
            let mut text = format!(
                "{verb} {name}.\nname: {name}\nbackend: {backend}\nfolder: {folder}\nbranch: {branch}",
                name = started.name,
                backend = started.backend,
                folder = started.folder,
            );
            if let Some(worktree) = &started.worktree {
                text.push_str(&format!("\nworktree: {worktree}"));
            }
            answer(
                text,
                json!({
                    "name": started.name,
                    "backend": started.backend,
                    "folder": started.folder,
                    "branch": started.branch,
                    "worktree": started.worktree,
                }),
            )
        }
        Err(refusal) => problem(&refusal),
    }
}

/// `agents_list`: `me`'s running children and what is left of its limits.
async fn list(hosted: std::sync::Arc<Hosted>, me: SessionId) -> CallToolResult {
    match blocking(move || hosted.list_children(me)).await {
        Ok(listed) => {
            let text = listing_text(&listed);
            answer(text, listing_json(&listed))
        }
        Err(refusal) => problem(&refusal),
    }
}

/// `agents_roles`: the roles there are now, and the files that are not roles.
async fn roles(hosted: std::sync::Arc<Hosted>, me: SessionId) -> CallToolResult {
    match blocking(move || hosted.list_roles(me)).await {
        Ok(listed) => {
            let text = roles_text(&listed);
            answer(text, roles_json(&listed))
        }
        Err(refusal) => problem(&refusal),
    }
}

/// `agents_stop`: one of `me`'s children, and the agents it started.
async fn stop(
    hosted: std::sync::Arc<Hosted>,
    me: SessionId,
    arguments: &JsonObject,
) -> CallToolResult {
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
    let flag = |key: &str| -> Result<Option<bool>, String> {
        match arguments.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Bool(value)) => Ok(Some(*value)),
            Some(_) => Err(format!("{key} is true or false.")),
        }
    };
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
        outlive: flag("outlive")?.unwrap_or(false),
        can_start: flag("can_start")?,
        resume: text_argument(arguments, "resume"),
    })
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
        "Limits left: {} of {} running at once, {} of {} starts, {} of {} on this host.",
        limits.children_left,
        limits.children_per_parent,
        limits.starts_left,
        limits.starts_per_parent,
        limits.host_left,
        limits.sessions_per_host,
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

    fn arguments(value: Value) -> JsonObject {
        value.as_object().expect("an object").clone()
    }

    #[test]
    fn the_table_names_the_four_tools_and_the_route() {
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
            ["agents_start", "agents_list", "agents_stop", "agents_roles"]
        );
        assert_eq!(family.allowed_tools(), names);
        assert_eq!(
            family.allowed_commands(),
            ["floti agent start", "floti agent stop"]
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
            "only the agents you started",
        ] {
            assert!(instructions.contains(word), "{word} in {instructions}");
        }
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
