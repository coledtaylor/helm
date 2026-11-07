//! Hearing back from children on the host: a child tells its parent where it
//! is, and a parent waits on its children's news. A host whose sessions run
//! the fake `claude` (`test/fake-agents/claude-code.mjs`) and the other fake
//! agent (`test/fake-agents/other-agent.mjs`), never a real agent. A session's
//! agent tools are called over HTTP with the URL and bearer token the session
//! itself was given, and `floti agent` is run from a session's own shell, so
//! nothing here is more than the session could do.
//!
//! No client is attached while a session works: a client starts the session
//! and goes, and comes back only to type into a session, to watch what the
//! sessions are doing or to end one. A call that holds is read as it arrives,
//! so a test sees it hold and sees what ends it. Time is never stepped here
//! (the sockets are real): the minute-by-minute progress of a held call is
//! tested with stepped time in `agent_tools/front.rs`.
//!
//! Tests that need a child to say nothing of its own use the other fake as the
//! child, which reports no status: whatever the parent hears is what the test
//! made the child do. Tests about a child's turns use the fake `claude`, which
//! does report its status, and make the turn long enough to be seen.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::agent::claude_code::{ClaudeCodeBackend, ClaudeCodeSettings};
use floti_host::platform::process_tree::{Native as NativeTree, ProcessTree};
use floti_host::platform::socket::Endpoint;
use floti_host::roles::{FixedRoles, Role, RoleSource};
use floti_host::server::HostConfig;
use floti_host::testkit::{
    OtherAgent, OtherAgentBackend, OtherAgentRecord, PATIENCE, RunningHost, ShellRun, TestClient,
    TestDirs,
};
use floti_protocol::channel::from_payload;
use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    CloseSessionRequest, HistoryRefresh, HistoryResume, ResumeSessionRequest, SessionActivity,
    SessionActivityState, SessionClose, SessionList, SessionStart, StartSessionRequest,
};
use floti_protocol::{BackendId, Knowable, Message};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const TERMINAL: &[&str] = &["terminal"];

/// The backends the host has, by id: the fake `claude`, the other fake, the
/// other fake given no MCP tools, and the other fake with its program missing
/// (a child started on it fails to launch).
const CLAUDE: &str = "claude-code";
const OTHER: &str = "other-agent";
const BARE: &str = OtherAgentBackend::BARE_ID;
const MISSING: &str = OtherAgentBackend::MISSING_ID;

/// The agents family, as a session's tool file names it.
const FAMILY: &str = "floti-agents";

// ---------------------------------------------------------------------------
// A host with several backends
// ---------------------------------------------------------------------------

/// The one role the host is given beside the default: it has a body of its
/// own, to be composed beside what Floti adds.
fn roles() -> Vec<Role> {
    let mut reviewer = Role::new(
        "reviewer",
        [
            BackendId::new(CLAUDE),
            BackendId::new(OTHER),
            BackendId::new(BARE),
            BackendId::new(MISSING),
        ],
    );
    reviewer.instructions = "Review the change and touch nothing.".to_owned();
    vec![reviewer]
}

struct World {
    endpoint: Endpoint,
    /// The fake `claude`'s config folder: `CLAUDE_CONFIG_DIR` for its runs.
    claude: PathBuf,
    other: OtherAgent,
    /// The workspace profile's folder: every project is in it.
    work: PathBuf,
    /// Last: fields drop in order.
    dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let other = OtherAgent::new(&dirs);
        Self {
            endpoint: dirs.endpoint(),
            claude: resolved(&dirs.folder("claude config")),
            work: resolved(&dirs.folder("workspace")),
            other,
            dirs,
        }
    }

    /// A world whose fake `claude` reports `version`, to the adapter's version
    /// probe and to every session alike: both run in the folder the fake's
    /// config names, where it reads the version from (the host runs in this
    /// process, whose environment a test does not change).
    fn reporting(version: &str) -> Self {
        let world = Self::new();
        std::fs::write(world.claude.join("fake-version"), version).expect("write the version");
        world
    }

    fn config(&self) -> HostConfig {
        let claude = ClaudeCodeSettings {
            search_first: Vec::new(),
            program: "node".into(),
            leading_args: vec![fake_claude().into_os_string()],
            config_dir: self.claude.clone(),
            pass_config_dir: true,
            api_key_set: false,
        };
        let backends: Vec<Arc<dyn AgentBackend>> = vec![
            Arc::new(ClaudeCodeBackend::new(claude, Arc::new(NativeTree))),
            Arc::new(self.other.backend()),
            Arc::new(self.other.backend_without_tools()),
            Arc::new(self.other.backend_that_cannot_start()),
        ];
        let own = [
            "SHELL",
            "HOME",
            "USERPROFILE",
            "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS",
        ];
        HostConfig {
            run: Default::default(),
            folders: self.dirs.folders(),
            endpoint: self.endpoint.clone(),
            backends,
            inherited_env: std::env::vars_os()
                .filter(|(key, _)| !own.contains(&&*key.to_string_lossy()))
                .chain([
                    (OsString::from("SHELL"), OsString::from("/bin/sh")),
                    (
                        OsString::from("HOME"),
                        self.dirs.home.clone().into_os_string(),
                    ),
                    (
                        OsString::from("USERPROFILE"),
                        self.dirs.home.clone().into_os_string(),
                    ),
                    // A tool call the fake `claude` makes is moved to the
                    // background once it has lasted this long, as the real
                    // CLI moves a long one.
                    (
                        OsString::from("CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS"),
                        OsString::from("1500"),
                    ),
                ])
                .collect(),
        }
    }

    /// A host that serves once this returns, with the roles above, and the
    /// workspace tracked.
    async fn host(&self) -> RunningHost {
        let source: Arc<dyn RoleSource> = Arc::new(FixedRoles(roles()));
        let (host, ()) = RunningHost::start_with(self.config(), move |host| host.use_roles(source));
        // A client is welcomed once the host serves.
        drop(self.client().await);
        let known: i64 = self
            .db()
            .query_row(
                "SELECT count(*) FROM profiles WHERE name = 'workspace'",
                [],
                |row| row.get(0),
            )
            .expect("count the profiles");
        if known == 0 {
            self.profile("workspace", &self.work);
        }
        host
    }

    async fn client(&self) -> TestClient {
        TestClient::connect(&self.endpoint, TERMINAL).await
    }

    /// A folder in the workspace, which Floti tracks.
    fn project(&self, name: &str) -> PathBuf {
        resolved(&self.dirs.folder(&format!("workspace/{name}")))
    }

    /// The host's database, as a test reads it and writes fixtures into it.
    fn db(&self) -> rusqlite::Connection {
        let db =
            rusqlite::Connection::open(self.dirs.data.join("floti.db")).expect("open floti.db");
        db.busy_timeout(PATIENCE)
            .expect("wait for the host's writes");
        db
    }

    /// A saved profile, as the profiles editor writes one.
    fn profile(&self, name: &str, root: &Path) {
        self.db()
            .execute(
                "INSERT INTO profiles (name, root, overlays, access, model, effort, permission_mode, \
                 agent, opening_prompt, session_agents) \
                 VALUES (?1, ?2, '[]', '[]', NULL, NULL, NULL, NULL, NULL, NULL)",
                rusqlite::params![name, text(root)],
            )
            .expect("insert a profile");
    }

    // -- sessions -----------------------------------------------------------

    /// A session on `backend` in `folder`, started by a client that is gone
    /// once the session is.
    async fn session(&self, backend: &str, folder: &Path, name: &str) -> Agent {
        let mut client = self.client().await;
        let record = client
            .request::<SessionStart>(&StartSessionRequest {
                cwd: text(folder),
                cols: 80,
                rows: 24,
                name: Some(name.to_owned()),
                backend: Some(BackendId::new(backend)),
                ..StartSessionRequest::default()
            })
            .await
            .expect("the session starts");
        drop(client);
        self.agent_of(record).await
    }

    /// The agent behind `record`, once its fake has logged its run.
    async fn agent_of(&self, record: SessionRecord) -> Agent {
        self.agent_after(record, &[]).await
    }

    /// As [`Self::agent_of`], for a run other than the ones with a pid in
    /// `seen`: a conversation reopened.
    async fn agent_after(&self, record: SessionRecord, seen: &[u32]) -> Agent {
        let conversation = record
            .conversation_id
            .clone()
            .expect("the session has a conversation");
        let run = eventually("the agent to log its run", async || {
            self.runs_of(&conversation)
                .into_iter()
                .rev()
                .find(|run| !seen.contains(&run.pid))
        })
        .await;
        Agent { record, run }
    }

    /// The child `parent` started under `name`.
    async fn child_of(&self, parent: &Agent, name: &str) -> Agent {
        let id = self
            .child_id(parent.id(), name)
            .unwrap_or_else(|| panic!("{} has no child named {name}", parent.name()));
        let record = self.record(id).await;
        self.agent_of(record).await
    }

    /// The child `parent` started under `name`, once a call that starts it
    /// and goes on waiting has started it.
    async fn child_when_started(&self, parent: &Agent, name: &str) -> Agent {
        let id = eventually("the child to start", async || {
            self.child_id(parent.id(), name)
        })
        .await;
        let record = self.record(id).await;
        self.agent_of(record).await
    }

    fn child_id(&self, parent: u64, name: &str) -> Option<u64> {
        self.db()
            .query_row(
                "SELECT id FROM sessions WHERE parent_session_id = ?1 AND child_name = ?2",
                rusqlite::params![i64::try_from(parent).unwrap(), name],
                |row| row.get::<_, i64>(0),
            )
            .ok()
            .and_then(|id| u64::try_from(id).ok())
    }

    async fn record(&self, id: u64) -> SessionRecord {
        let mut client = self.client().await;
        client
            .request::<SessionList>(&())
            .await
            .expect("the sessions are listed")
            .into_iter()
            .find(|row| row.id == id)
            .unwrap_or_else(|| panic!("no session {id}"))
    }

    /// What the row of session `id` says: `running` or `exited`.
    fn status(&self, id: u64) -> String {
        self.db()
            .query_row(
                "SELECT status FROM sessions WHERE id = ?1",
                [i64::try_from(id).unwrap()],
                |row| row.get(0),
            )
            .unwrap_or_else(|err| panic!("read session {id}: {err}"))
    }

    /// Waits until every session in `ids` has ended.
    async fn ended(&self, what: &str, ids: &[u64]) {
        eventually(what, async || {
            ids.iter()
                .all(|id| self.status(*id) != "running")
                .then_some(())
        })
        .await;
    }

    // -- the inbox ----------------------------------------------------------

    /// How many items of news no wait has handed over yet.
    fn unseen(&self) -> i64 {
        self.db()
            .query_row(
                "SELECT count(*) FROM agent_inbox WHERE seen_at IS NULL",
                [],
                |row| row.get(0),
            )
            .expect("count the unseen news")
    }

    /// Everything the inbox holds, as one text: what a child said and what
    /// the host made of it, for a test to look for what must not be there.
    fn inbox_text(&self) -> String {
        let db = self.db();
        let mut select = db
            .prepare(
                "SELECT child_name, event, coalesce(state, ''), coalesce(detail, '') \
                 FROM agent_inbox ORDER BY id",
            )
            .expect("prepare");
        select
            .query_map([], |row| {
                Ok(format!(
                    "{}|{}|{}|{}",
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?
                ))
            })
            .expect("query")
            .map(|row| row.expect("a row"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    // -- runs ---------------------------------------------------------------

    /// Every run of a conversation either fake logged, by pid.
    fn runs_of(&self, conversation: &str) -> Vec<Run> {
        let mut runs: Vec<Run> = self
            .claude_logs()
            .iter()
            .filter(|log| log["sessionId"].as_str() == Some(conversation))
            .map(Run::of_claude)
            .collect();
        runs.extend(
            self.other
                .records()
                .iter()
                .filter(|record| record.conversation == conversation)
                .map(Run::of_other),
        );
        runs.sort_by_key(|run| run.pid);
        runs
    }

    fn claude_logs(&self) -> Vec<Value> {
        let Ok(entries) = std::fs::read_dir(self.claude.join("fake-agent")) else {
            return Vec::new();
        };
        entries
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                if path.extension()? != "json" {
                    return None;
                }
                serde_json::from_slice(&std::fs::read(path).ok()?).ok()
            })
            .collect()
    }

    /// The fake `claude`'s whole log of `agent`'s run, read again.
    fn claude_log(&self, agent: &Agent) -> Value {
        self.claude_logs()
            .into_iter()
            .find(|log| log["pid"].as_u64() == Some(u64::from(agent.run.pid)))
            .expect("the run's log")
    }

    /// The run `agent` was read from, read again.
    fn reread(&self, agent: &Agent) -> Run {
        let conversation = agent
            .record
            .conversation_id
            .as_deref()
            .expect("a conversation");
        self.runs_of(conversation)
            .into_iter()
            .find(|run| run.pid == agent.run.pid)
            .expect("the run's log")
    }

    /// Has the host read its sessions' records once more, by asking it for
    /// the sessions it lists as `asker` does: that read is the one the
    /// children's news is judged by. A report made while its child is at rest
    /// belongs to the turn that follows only when no read came between.
    async fn pass(&self, asker: &Agent) {
        let (url, token) = asker
            .run
            .servers
            .get("helm-sessions")
            .expect("the session was given the sessions family");
        let listed = Call::open(url, token, false, "sessions_list", json!({}))
            .await
            .called()
            .await;
        assert!(!listed.failed, "{listed:?}");
    }

    // -- a client at work ----------------------------------------------------

    /// Ends `agent` as Floti's End does.
    async fn close(&self, agent: &Agent) {
        let mut client = self.client().await;
        client
            .request::<SessionClose>(&CloseSessionRequest {
                id: agent.id(),
                force: true,
            })
            .await
            .expect("the session closes");
    }

    /// Types `line` at `agent`'s prompt and waits until it took it.
    async fn type_line(&self, agent: &Agent, line: &str) {
        let taken = |agent: &Agent| {
            self.reread(agent)
                .received
                .iter()
                .filter(|got| *got == line)
                .count()
        };
        let before = taken(agent);
        let mut client = self.client().await;
        client.attach(1, agent.id()).await;
        client.type_into(1, format!("{line}\r").as_bytes()).await;
        eventually("the agent to take the line", async || {
            (taken(agent) > before).then_some(())
        })
        .await;
        drop(client);
    }

    /// Runs `command` in `agent`'s own shell, as its shell tool does, and
    /// waits for it to finish.
    async fn shell(&self, agent: &Agent, command: &str) -> ShellRun {
        let before = self.reread(agent).shell.len();
        self.type_line(agent, &format!("/shell {command}")).await;
        eventually(
            &format!("the shell command `{command}` to finish"),
            async || {
                self.reread(agent)
                    .shell
                    .get(before)
                    .filter(|ran| ran.code.is_some())
                    .cloned()
            },
        )
        .await
    }

    /// The `n`th report the fake `claude` `agent` made at its prompt with
    /// `/report`, once the family has answered it.
    async fn report_answered(&self, agent: &Agent, n: usize) -> Value {
        eventually("the fake's report call to be answered", async || {
            self.claude_log(agent)["reports"]
                .as_array()
                .and_then(|reports| reports.get(n - 1))
                .filter(|report| !report["isError"].is_null())
                .cloned()
        })
        .await
    }

    /// Makes the fake `claude` child `child` busy until `release` ends its
    /// turn, and returns once the host has seen it busy, with the watch that
    /// saw it.
    async fn hold_busy(&self, child: &Agent) -> Watch {
        let mut watch = Watch::open(self).await;
        self.type_line(child, "/busy hold").await;
        watch.until(child, SessionActivity::Busy).await;
        watch
    }

    /// Ends the turn `hold_busy` began.
    async fn release(&self, child: &Agent) {
        self.type_line(child, "/idle").await;
    }

    /// Waits until each of the `children` of `parent` (the fake `claude`s
    /// among them) is at rest with nothing unheard, by hearing everything
    /// that comes until two looks in a row find none: what a child's first
    /// turn says is not what a test is about.
    async fn calm(&self, parent: &Agent, children: &[&str]) {
        let mut clean = 0;
        eventually("the children to be at rest", async || {
            let heard = parent
                .hear(json!({ "for": "all", "children": children }))
                .await;
            if heard.news().is_empty() && heard.working().is_empty() {
                clean += 1;
            } else {
                clean = 0;
            }
            (clean >= 2).then_some(())
        })
        .await;
    }
}

/// A client watching what the host's sessions are doing, to know a child has
/// begun or ended a turn before a test goes on. It sees what the host's own
/// reader saw, after the host did.
struct Watch {
    client: TestClient,
    latest: Vec<SessionActivityState>,
}

impl Watch {
    async fn open(world: &World) -> Self {
        let mut client = world.client().await;
        let latest = match client.subscribe_on(8, "session:activity").await {
            Message::Snapshot(snapshot) => from_payload(&snapshot.state).expect("the activity"),
            other => panic!("no snapshot of the activity: {other:?}"),
        };
        Self { client, latest }
    }

    /// Waits until `who` is `wanted`, as of the last publication or a later
    /// one.
    async fn until(&mut self, who: &Agent, wanted: SessionActivity) {
        let id = who.id();
        while !self
            .latest
            .iter()
            .any(|state| state.id == id && state.activity == Some(wanted))
        {
            self.latest = self
                .client
                .event_on::<Vec<SessionActivityState>>(8, "an activity publication", |_| true)
                .await;
        }
    }
}

// ---------------------------------------------------------------------------
// A session, and what it was given
// ---------------------------------------------------------------------------

/// One run of either fake, as it logged itself.
#[derive(Debug, Clone)]
struct Run {
    pid: u32,
    argv: Vec<String>,
    /// The tool servers it loaded, by name: URL and bearer token.
    servers: BTreeMap<String, (String, String)>,
    /// What it was given to read besides its prompt: the instructions it
    /// composed.
    instructions: Option<String>,
    received: Vec<String>,
    /// The text of each bracketed paste it took.
    pastes: Vec<String>,
    shell: Vec<ShellRun>,
}

impl Run {
    fn of_claude(log: &Value) -> Self {
        let servers = log["mcpServers"]
            .as_object()
            .map(|servers| {
                servers
                    .iter()
                    .filter_map(|(name, server)| {
                        let url = server["url"].as_str()?.to_owned();
                        let token = server["headers"]["Authorization"]
                            .as_str()?
                            .strip_prefix("Bearer ")?
                            .to_owned();
                        Some((name.clone(), (url, token)))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            pid: u32::try_from(log["pid"].as_u64().expect("a pid")).unwrap(),
            argv: strings(&log["argv"]),
            servers,
            instructions: log["composedInstructions"].as_str().map(str::to_owned),
            received: strings(&log["received"]),
            pastes: log["pastes"]
                .as_array()
                .map(|pastes| {
                    pastes
                        .iter()
                        .map(|paste| paste["text"].as_str().unwrap_or_default().to_owned())
                        .collect()
                })
                .unwrap_or_default(),
            shell: serde_json::from_value(log["shell"].clone()).unwrap_or_default(),
        }
    }

    fn of_other(record: &OtherAgentRecord) -> Self {
        Self {
            pid: record.pid,
            argv: record.argv.clone(),
            servers: record
                .mcp_servers
                .iter()
                .map(|(name, server)| (name.clone(), (server.url.clone(), server.bearer.clone())))
                .collect(),
            instructions: record.instructions.clone(),
            received: record.received.clone(),
            pastes: record
                .pastes
                .iter()
                .map(|paste| paste.text.clone())
                .collect(),
            shell: record.shell.clone(),
        }
    }

    /// The tools and commands its argv lets it use without asking.
    fn allowed(&self) -> Vec<String> {
        let mut allowed = values_after(&self.argv, "--allowedTools");
        allowed.extend(every_value_of(&self.argv, "--allow-tool"));
        allowed.extend(every_value_of(&self.argv, "--allow-shell"));
        allowed
    }

    /// The instructions it composed, which a run with none panics on.
    fn told(&self) -> &str {
        self.instructions
            .as_deref()
            .expect("the run was given instructions")
    }
}

/// A session and the run it started, with the token it was given.
#[derive(Debug, Clone)]
struct Agent {
    record: SessionRecord,
    run: Run,
}

/// A tool's answer: whether it failed, and the blocks of text it gave.
#[derive(Debug)]
struct Called {
    failed: bool,
    blocks: Vec<String>,
}

impl Called {
    fn of(message: &Value) -> Self {
        assert!(message.get("error").is_none(), "{message}");
        let result = &message["result"];
        Self {
            failed: result["isError"].as_bool().unwrap_or(false),
            blocks: result["content"]
                .as_array()
                .expect("content")
                .iter()
                .filter_map(|block| block["text"].as_str().map(str::to_owned))
                .collect(),
        }
    }

    fn text(&self) -> &str {
        self.blocks.first().map_or("", String::as_str)
    }

    /// The JSON block of an answer that succeeded.
    fn done(&self) -> Value {
        assert!(!self.failed, "the call was refused: {self:?}");
        serde_json::from_str(self.blocks.get(1).expect("a JSON block")).expect("JSON")
    }

    /// The sentence of an answer that was refused.
    fn refused(&self) -> &str {
        assert!(self.failed, "the call was not refused: {self:?}");
        self.text()
    }
}

/// What a wait answered, as the tool's JSON gives it.
#[derive(Debug)]
struct Heard(Value);

impl Heard {
    fn news(&self) -> &[Value] {
        self.0["news"].as_array().map_or(&[], Vec::as_slice)
    }

    /// The news of one kind, in the order it came.
    fn of(&self, event: &str) -> Vec<&Value> {
        self.news()
            .iter()
            .filter(|news| news["event"] == event)
            .collect()
    }

    /// Each item as `<child>:<event>`, in order.
    fn events(&self) -> Vec<String> {
        self.news()
            .iter()
            .map(|news| {
                format!(
                    "{}:{}",
                    news["child"].as_str().unwrap_or_default(),
                    news["event"].as_str().unwrap_or_default()
                )
            })
            .collect()
    }

    /// The children it was about that are still working.
    fn working(&self) -> Vec<&str> {
        self.0["working"]
            .as_array()
            .map(|names| names.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default()
    }

    /// Why it answered: `news`, `idle`, `nothingNew`, `typed` or
    /// `callerEnded`.
    fn ended(&self) -> &str {
        self.0["ended"].as_str().unwrap_or_default()
    }
}

impl Agent {
    fn id(&self) -> u64 {
        self.record.id
    }

    fn name(&self) -> &str {
        &self.record.name
    }

    /// The agents family's URL and the session's token.
    fn route(&self) -> (String, String) {
        let (url, token) = self
            .run
            .servers
            .get(FAMILY)
            .expect("the session was given the agents family");
        (url.clone(), token.clone())
    }

    /// A call, opened and left to be read: one that holds is answering as a
    /// stream already.
    async fn open(&self, tool: &str, arguments: Value) -> Call {
        let (url, token) = self.route();
        Call::open(&url, &token, false, tool, arguments).await
    }

    /// As [`Self::open`], as `floti agent` makes the call from the session's
    /// shell.
    async fn open_from_shell(&self, tool: &str, arguments: Value) -> Call {
        let (url, token) = self.route();
        Call::open(&url, &token, true, tool, arguments).await
    }

    /// As [`Self::open`], for a call made at `revision`.
    async fn open_as(&self, revision: Revision, shell: bool, tool: &str, arguments: Value) -> Call {
        let (url, token) = self.route();
        Call::open_as(&url, &token, shell, &revision, tool, arguments).await
    }

    /// A call made as Claude Code 2.1.304 and later makes it, declaring the
    /// tasks extension, answered with the task it started.
    async fn start_task(&self, tool: &str, arguments: Value) -> String {
        let mut call = self
            .open_as(Revision::WithTasks, false, tool, arguments)
            .await;
        assert!(!call.streamed, "a task is one JSON reply");
        let created = call.answer().await.expect("the call was answered");
        assert!(created.get("error").is_none(), "{created}");
        let created = &created["result"];
        assert_eq!(created["resultType"], "task", "{created}");
        assert_eq!(created["status"], "working", "{created}");
        created["taskId"].as_str().expect("a task id").to_owned()
    }

    /// `tasks/get` or `tasks/cancel` for task `id`, with this session's token.
    async fn task_request(&self, method: &str, id: &str) -> Reply {
        let (url, token) = self.route();
        let revision = Revision::WithTasks;
        let mut params = json!({ "taskId": id });
        params["_meta"] = revision.meta();
        let headers = revision.headers(method, id);
        let headers: Vec<(&str, &str)> = headers
            .iter()
            .map(|(name, value)| (*name, value.as_str()))
            .collect();
        post_headed(
            &url,
            Some(&token),
            &headers,
            &json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }),
        )
        .await
    }

    /// Task `id`, as `tasks/get` answers it: its result when it is working or
    /// completed, an error object when it is not found.
    async fn task(&self, id: &str) -> Value {
        self.task_request("tasks/get", id).await.json()
    }

    /// Polls task `id` until it has completed, and answers the `tasks/get`
    /// that delivered it.
    async fn completed_task(&self, id: &str) -> Value {
        eventually("the task to complete", async || {
            let answer = self.task(id).await;
            assert!(answer.get("error").is_none(), "{answer}");
            (answer["result"]["status"] == "completed").then(|| answer["result"].clone())
        })
        .await
    }

    async fn call(&self, tool: &str, arguments: Value) -> Called {
        self.open(tool, arguments).await.called().await
    }

    async fn start(&self, arguments: Value) -> Called {
        self.call("agents_start", arguments).await
    }

    async fn stop(&self, child: &str) -> Called {
        self.call("agents_stop", json!({ "child": child })).await
    }

    /// A child reports to its parent.
    async fn report(&self, state: &str, text: &str) -> Called {
        self.call("agents_report", json!({ "state": state, "text": text }))
            .await
    }

    /// Waits as `arguments` say. Where the session's backend holds a wait,
    /// this returns when there is news.
    async fn hear(&self, arguments: Value) -> Heard {
        Heard(self.call("agents_wait", arguments).await.done())
    }

    /// The names of the tools it lists, sorted.
    async fn tool_names(&self) -> Vec<String> {
        let (url, token) = self.route();
        let result = rpc(&url, Some(&token), "tools/list", json!({}))
            .await
            .result();
        let mut names: Vec<String> = result["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .map(|tool| tool["name"].as_str().expect("a name").to_owned())
            .collect();
        names.sort();
        names
    }

    /// What the family tells a session on connecting.
    async fn manual(&self) -> String {
        let (url, token) = self.route();
        let result = rpc(
            &url,
            Some(&token),
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "hearing", "version": "1" },
            }),
        )
        .await
        .result();
        result["instructions"]
            .as_str()
            .expect("the family's instructions")
            .to_owned()
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The fake `claude`, run by Node.
fn fake_claude() -> PathBuf {
    resolved(
        &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("test")
            .join("fake-agents")
            .join("claude-code.mjs"),
    )
}

/// `path` with links resolved, in the form a process reports its own folder
/// in (no `\\?\` on Windows).
fn resolved(path: &Path) -> PathBuf {
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let text = canonical.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(plain) => PathBuf::from(plain),
        None => canonical,
    }
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// The arguments after `flag` up to the next flag.
fn values_after(argv: &[String], flag: &str) -> Vec<String> {
    argv.iter()
        .skip_while(|arg| *arg != flag)
        .skip(1)
        .take_while(|arg| !arg.starts_with("--"))
        .cloned()
        .collect()
}

/// The argument after each occurrence of `flag`.
fn every_value_of(argv: &[String], flag: &str) -> Vec<String> {
    argv.windows(2)
        .filter(|pair| pair[0] == flag)
        .map(|pair| pair[1].clone())
        .collect()
}

fn alive(pid: u32) -> bool {
    NativeTree.is_alive(pid) != Knowable::Known(false)
}

/// Waits until `check` passes, retrying a failure for the patience.
async fn eventually<T>(what: &str, mut check: impl AsyncFnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + PATIENCE;
    loop {
        if let Some(found) = check().await {
            return found;
        }
        assert!(Instant::now() < deadline, "{what} within {PATIENCE:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// ---------------------------------------------------------------------------
// HTTP, as an MCP client speaks it
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Reply {
    status: u16,
    body: Vec<u8>,
}

impl Reply {
    /// The JSON-RPC message answered, whether it holds a result or an error.
    fn json(&self) -> Value {
        assert_eq!(self.status, 200, "{self:?}");
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|err| panic!("{err}: {}", String::from_utf8_lossy(&self.body)))
    }

    fn result(&self) -> Value {
        assert_eq!(self.status, 200, "{self:?}");
        let answer: Value = serde_json::from_slice(&self.body)
            .unwrap_or_else(|err| panic!("{err}: {}", String::from_utf8_lossy(&self.body)));
        assert!(answer.get("error").is_none(), "{answer}");
        answer["result"].clone()
    }
}

/// `http://<address><path>` split.
fn split_url(url: &str) -> (SocketAddr, String) {
    let rest = url.strip_prefix("http://").expect("an http URL");
    let (address, path) = rest.split_at(rest.find('/').expect("a path"));
    (address.parse().expect("an address"), path.to_owned())
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

/// One POST of `body` to `url`, carrying `token` when there is one, read to
/// the end of its answer: for a request that does not hold.
async fn post(url: &str, token: Option<&str>, body: &Value) -> Reply {
    post_headed(url, token, &[], body).await
}

/// As [`post`], with more headers.
async fn post_headed(
    url: &str,
    token: Option<&str>,
    headers: &[(&str, &str)],
    body: &Value,
) -> Reply {
    let (address, path) = split_url(url);
    let body = body.to_string();
    let mut head = format!(
        "POST {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\
         Accept: application/json, text/event-stream\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\n",
        body.len()
    );
    if let Some(token) = token {
        head.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    tokio::time::timeout(PATIENCE, async {
        let mut stream = TcpStream::connect(address).await.expect("connect");
        stream.write_all(head.as_bytes()).await.expect("send");
        stream.write_all(body.as_bytes()).await.expect("send");
        let mut answer = Vec::new();
        stream.read_to_end(&mut answer).await.expect("read");
        let end = find(&answer, b"\r\n\r\n").expect("a head");
        let status = String::from_utf8_lossy(&answer[..end])
            .split(' ')
            .nth(1)
            .and_then(|code| code.parse().ok())
            .expect("a status");
        Reply {
            status,
            body: answer[end + 4..].to_vec(),
        }
    })
    .await
    .expect("an answer within the patience")
}

async fn rpc(url: &str, token: Option<&str>, method: &str, params: Value) -> Reply {
    post(
        url,
        token,
        &json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }),
    )
    .await
}

/// `server/discover`, as a client of revision 2026-07-28 sends it.
async fn discover(url: &str, token: &str) -> Reply {
    post_headed(
        url,
        Some(token),
        &[
            ("MCP-Protocol-Version", "2026-07-28"),
            ("Mcp-Method", "server/discover"),
        ],
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "server/discover",
            "params": { "_meta": {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
            } },
        }),
    )
    .await
}

const TASKS_EXTENSION: &str = "io.modelcontextprotocol/tasks";

/// The MCP revision a request is made at, and what its metadata declares.
#[derive(Debug, Clone, Copy)]
enum Revision {
    /// Names none, as a client of an earlier revision makes it.
    None,
    /// 2025-06-18, whose metadata declares the tasks extension all the same.
    Earlier,
    /// 2026-07-28, declaring no extension.
    WithoutTasks,
    /// 2026-07-28, declaring the tasks extension, as Claude Code 2.1.304 and
    /// later does to every server.
    WithTasks,
}

impl Revision {
    /// The request metadata (`_meta`) of a call made so.
    fn meta(self) -> Value {
        let extensions = json!({ "extensions": { TASKS_EXTENSION: {} } });
        match self {
            Self::None => json!({}),
            Self::Earlier => json!({
                "io.modelcontextprotocol/protocolVersion": "2025-06-18",
                "io.modelcontextprotocol/clientCapabilities": extensions,
            }),
            Self::WithoutTasks => json!({
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": {},
            }),
            Self::WithTasks => json!({
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientCapabilities": extensions,
                "io.modelcontextprotocol/clientInfo": { "name": "hearing", "version": "1" },
            }),
        }
    }

    /// The headers a request of `method` about `name` carries.
    fn headers(self, method: &str, name: &str) -> Vec<(&'static str, String)> {
        match self {
            Self::None => Vec::new(),
            Self::Earlier => vec![("MCP-Protocol-Version", "2025-06-18".to_owned())],
            Self::WithoutTasks | Self::WithTasks => vec![
                ("MCP-Protocol-Version", "2026-07-28".to_owned()),
                ("Mcp-Method", method.to_owned()),
                ("Mcp-Name", name.to_owned()),
            ],
        }
    }
}

/// A tool call whose answer is read as it arrives. A call that holds is
/// answered as an event stream, which says it is still there and ends with the
/// result; any other call is one JSON reply.
struct Call {
    stream: TcpStream,
    /// The answer is an event stream.
    streamed: bool,
    chunked: bool,
    /// Bytes read and not yet decoded.
    raw: Vec<u8>,
    /// The decoded body not yet taken.
    body: Vec<u8>,
    /// The answer is over: its last chunk came, or the connection went.
    ended: bool,
    /// It ended with its last chunk, not by the connection going.
    complete: bool,
    /// Progress notifications taken so far.
    progress: usize,
}

impl Call {
    /// Sends a call of `tool` and reads the head of the answer. `shell` says
    /// the call comes from `floti agent` in the session's shell.
    async fn open(url: &str, token: &str, shell: bool, tool: &str, arguments: Value) -> Self {
        Self::open_as(url, token, shell, &Revision::None, tool, arguments).await
    }

    /// As [`Self::open`], for a call made as `revision` says.
    async fn open_as(
        url: &str,
        token: &str,
        shell: bool,
        revision: &Revision,
        tool: &str,
        arguments: Value,
    ) -> Self {
        let (address, path) = split_url(url);
        let mut meta = revision.meta();
        meta["progressToken"] = json!("hearing");
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": tool, "arguments": arguments, "_meta": meta },
        })
        .to_string();
        let mut marker = if shell {
            "x-floti-shell: 1\r\n".to_owned()
        } else {
            String::new()
        };
        for (name, value) in revision.headers("tools/call", tool) {
            marker.push_str(&format!("{name}: {value}\r\n"));
        }
        let head = format!(
            "POST {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\
             Accept: application/json, text/event-stream\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\nAuthorization: Bearer {token}\r\n{marker}\r\n",
            body.len()
        );
        let mut stream = TcpStream::connect(address).await.expect("connect");
        stream.write_all(head.as_bytes()).await.expect("send");
        stream.write_all(body.as_bytes()).await.expect("send");
        let mut call = Self {
            stream,
            streamed: false,
            chunked: false,
            raw: Vec::new(),
            body: Vec::new(),
            ended: false,
            complete: false,
            progress: 0,
        };
        let end = loop {
            if let Some(end) = find(&call.raw, b"\r\n\r\n") {
                break end;
            }
            assert!(!call.ended, "the host answered nothing");
            call.fill().await;
        };
        let head = String::from_utf8_lossy(&call.raw[..end]).to_ascii_lowercase();
        let status: u16 = head
            .split(' ')
            .nth(1)
            .and_then(|code| code.parse().ok())
            .expect("a status");
        assert_eq!(status, 200, "{head}");
        call.streamed = head.contains("content-type: text/event-stream");
        call.chunked = head.contains("transfer-encoding: chunked");
        call.raw.drain(..end + 4);
        call
    }

    /// Reads what has arrived, or notes that the connection is over.
    async fn fill(&mut self) {
        let mut buffer = [0u8; 4096];
        match tokio::time::timeout(PATIENCE, self.stream.read(&mut buffer)).await {
            Ok(Ok(0) | Err(_)) => self.ended = true,
            Ok(Ok(read)) => self.raw.extend_from_slice(&buffer[..read]),
            Err(_) => panic!("the host sent nothing within {PATIENCE:?}"),
        }
    }

    /// Moves what has been read into the body, undoing chunking.
    fn decode(&mut self) {
        if !self.chunked {
            self.body.append(&mut self.raw);
            self.complete = self.ended;
            return;
        }
        while let Some(at) = find(&self.raw, b"\r\n") {
            let size = usize::from_str_radix(
                std::str::from_utf8(&self.raw[..at]).expect("text").trim(),
                16,
            )
            .expect("a chunk size");
            if size == 0 {
                self.complete = true;
                self.ended = true;
                self.raw.clear();
                return;
            }
            if self.raw.len() < at + 2 + size + 2 {
                return;
            }
            self.body
                .extend_from_slice(&self.raw[at + 2..at + 2 + size]);
            self.raw.drain(..at + 2 + size + 2);
        }
    }

    /// The next JSON-RPC message of the answer, or none once it is over.
    async fn message(&mut self) -> Option<Value> {
        loop {
            self.decode();
            if self.streamed {
                if let Some(at) = find(&self.body, b"\n\n") {
                    let block: Vec<u8> = self.body.drain(..at + 2).collect();
                    let data: String = String::from_utf8_lossy(&block)
                        .lines()
                        .filter_map(|line| line.strip_prefix("data:"))
                        .map(str::trim)
                        .collect();
                    if data.is_empty() {
                        continue;
                    }
                    return Some(
                        serde_json::from_str(&data).unwrap_or_else(|err| panic!("{err}: {data}")),
                    );
                }
            } else if self.ended && !self.body.is_empty() {
                let body = std::mem::take(&mut self.body);
                return Some(
                    serde_json::from_slice(&body)
                        .unwrap_or_else(|err| panic!("{err}: {}", String::from_utf8_lossy(&body))),
                );
            }
            if self.ended {
                return None;
            }
            self.fill().await;
        }
    }

    /// The call's own JSON-RPC answer, once it comes, counting the progress
    /// that came before it. None when the connection ended without one.
    async fn answer(&mut self) -> Option<Value> {
        while let Some(message) = self.message().await {
            let method = message["method"].as_str().unwrap_or_default();
            if method == "notifications/progress" || method == "notifications/message" {
                self.progress += 1;
            } else if message["id"] == 1 {
                return Some(message);
            }
        }
        None
    }

    /// The call's answer as a tool answers.
    async fn called(&mut self) -> Called {
        Called::of(&self.answer().await.expect("the call was answered"))
    }

    /// The call's answer as the news a wait gives.
    async fn heard(&mut self) -> Heard {
        Heard(self.called().await.done())
    }
}

/// Gives up on call `1` of `agent`'s token, as its agent does when it
/// cancels one.
async fn cancel(agent: &Agent) {
    let (url, token) = agent.route();
    let cancelled = post(
        &url,
        Some(&token),
        &json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 1 } }),
    )
    .await;
    assert_eq!(cancelled.status, 202, "{cancelled:?}");
}

// ---------------------------------------------------------------------------
// A child reports, and its parent hears it
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s1_a_childs_report_is_heard_by_its_parents_next_wait_by_name_with_its_state_and_text() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("report");
    for (parent_backend, child_backend) in [(CLAUDE, OTHER), (OTHER, CLAUDE)] {
        let parent = world
            .session(parent_backend, &folder, &format!("parent {parent_backend}"))
            .await;
        let name = format!("scout-{child_backend}");
        parent
            .start(json!({ "task": "look around", "name": name, "backend": child_backend }))
            .await
            .done();
        let child = world.child_of(&parent, &name).await;
        if child_backend == CLAUDE {
            world.calm(&parent, &[&name]).await;
        }

        let told = child.report("done", "All fixed in src/lib.rs.").await;
        assert_eq!(told.done()["reported"], "done");
        let heard = parent.hear(json!({})).await;
        let reports = heard.of("report");
        assert_eq!(reports.len(), 1, "{heard:?}");
        assert_eq!(reports[0]["child"], name.as_str());
        assert_eq!(reports[0]["state"], "done");
        assert_eq!(reports[0]["text"], "All fixed in src/lib.rs.");

        // What a model reads says the same, by the name it knows the child by.
        child
            .report("stuck", "Which table, A or B? I suggest A.")
            .await
            .done();
        child.report("note", "Half way through.").await.done();
        let mut lines = String::new();
        eventually("both reports to be heard", async || {
            let called = parent.call("agents_wait", json!({})).await;
            lines.push_str(called.text());
            lines.push('\n');
            (lines.contains("sent a note") && lines.contains("is stuck")).then_some(())
        })
        .await;
        assert!(
            lines.contains(&format!(
                "{name} is stuck: Which table, A or B? I suggest A."
            )),
            "{lines}"
        );
        assert!(
            lines.contains(&format!("{name} sent a note: Half way through.")),
            "{lines}"
        );

        // The record carries the last report until the child's next turn.
        let record = world.record(child.id()).await;
        let last = record.last_report.expect("the record has the last report");
        assert_eq!(
            (last.state.as_str(), last.text.as_str()),
            ("note", "Half way through.")
        );
        if child_backend == CLAUDE {
            let _watch = world.hold_busy(&child).await;
            eventually("the next turn to clear the report", async || {
                world
                    .record(child.id())
                    .await
                    .last_report
                    .is_none()
                    .then_some(())
            })
            .await;
        }
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_childs_typed_report_reaches_its_parent_and_a_refused_one_does_not() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("typed-report");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    let started = world
        .shell(
            &parent,
            "floti agent start --task look --name worker --backend claude-code",
        )
        .await;
    assert_eq!(started.code, Some(0), "{started:?}");
    let child = world.child_of(&parent, "worker").await;
    world.calm(&parent, &["worker"]).await;

    world
        .type_line(&child, "/report done Everything is fixed.")
        .await;
    let first = world.report_answered(&child, 1).await;
    assert_eq!(first["isError"], false, "{first}");
    assert!(
        first["answer"]
            .as_str()
            .unwrap_or_default()
            .starts_with("Reported done to the agent that started you."),
        "{first}"
    );
    let heard = parent.hear(json!({})).await;
    let reports = heard.of("report");
    assert_eq!(reports.len(), 1, "{heard:?}");
    assert_eq!(reports[0]["child"], "worker");
    assert_eq!(reports[0]["state"], "done");
    assert_eq!(reports[0]["text"], "Everything is fixed.");

    // A state the family does not know is answered with its refusal, and
    // nothing reaches the parent.
    world.pass(&parent).await;
    let unseen = world.unseen();
    world
        .type_line(&child, "/report maybe Perhaps it is fixed.")
        .await;
    let second = world.report_answered(&child, 2).await;
    assert_eq!(second["isError"], true, "{second}");
    assert!(
        second["answer"]
            .as_str()
            .unwrap_or_default()
            .contains("state is done, stuck or note"),
        "{second}"
    );
    world.pass(&parent).await;
    assert_eq!(world.unseen(), unseen, "{}", world.inbox_text());
    assert!(
        !world.inbox_text().contains("Perhaps it is fixed."),
        "{}",
        world.inbox_text()
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_childs_report_is_published_to_the_clients_when_it_is_made_for_its_card() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("card-report");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    // The other fake reports no status, so nothing about the child moves but
    // what it tells its parent: whatever the clients are sent after it is the
    // report's doing.
    parent
        .start(json!({ "task": "look around", "name": "scout", "backend": OTHER }))
        .await
        .done();
    let child = world.child_of(&parent, "scout").await;
    // The host has read the child at rest before the clients look.
    world.pass(&parent).await;
    let mut watch = Watch::open(&world).await;

    child.report("stuck", "Which table, A or B?").await.done();
    watch
        .client
        .event_on::<Vec<SessionActivityState>>(8, "the activity published for the report", |_| true)
        .await;
    let listed = world.record(child.id()).await;
    let report = listed.last_report.expect("the listing carries the report");
    assert_eq!(
        (report.state.as_str(), report.text.as_str()),
        ("stuck", "Which table, A or B?")
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s2_a_session_with_no_parent_has_no_agents_report_and_a_child_has_it_allowed_at_launch() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("no-report");
    for (backend, rule) in [
        (CLAUDE, "mcp__floti-agents__agents_report"),
        (OTHER, "floti-agents.agents_report"),
    ] {
        let person = world.session(backend, &folder, "person").await;
        let names = person.tool_names().await;
        assert!(
            !names.iter().any(|name| name == "agents_report"),
            "{names:?}"
        );
        assert_eq!(names.len(), 7, "{names:?}");
        let refused = person
            .call("agents_report", json!({ "state": "done", "text": "x" }))
            .await;
        assert!(
            refused.refused().contains("no tool named agents_report"),
            "{refused:?}"
        );
        assert!(
            !person.run.allowed().iter().any(|allowed| allowed == rule),
            "{:?}",
            person.run.allowed()
        );

        person
            .start(json!({ "task": "work", "name": "kid", "backend": backend }))
            .await
            .done();
        let child = world.child_of(&person, "kid").await;
        let names = child.tool_names().await;
        assert!(
            names.iter().any(|name| name == "agents_report"),
            "{names:?}"
        );
        assert!(
            child.run.allowed().iter().any(|allowed| allowed == rule),
            "{:?}",
            child.run.allowed()
        );
        // A child that reports is listed it by the same family, so the
        // person's session is untouched by it.
        assert_eq!(person.tool_names().await.len(), 7);
        world.close(&child).await;
        world.close(&person).await;
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s3_a_report_in_a_state_it_does_not_know_or_too_long_is_refused_and_reaches_nobody() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("refusals");
    let parent = world.session(OTHER, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "kid", "backend": OTHER }))
        .await
        .done();
    let child = world.child_of(&parent, "kid").await;

    let unknown = child.report("great", "Done and dusted.").await;
    assert!(
        unknown.refused().contains("state is done, stuck or note"),
        "{unknown:?}"
    );
    let long = child.report("done", &"x".repeat(4001)).await;
    let reason = long.refused();
    assert!(reason.contains("4001 characters"), "{reason}");
    assert!(reason.contains("at most 4000"), "{reason}");
    assert!(
        reason.contains("Put the longer answer in a file"),
        "{reason}"
    );
    let empty = child.report("done", "  ").await;
    assert!(empty.refused().contains("Say what you are reporting"));

    // Nothing reached the parent.
    let heard = parent.hear(json!({})).await;
    assert!(heard.of("report").is_empty(), "{heard:?}");
    assert_eq!(world.unseen(), 0, "{}", world.inbox_text());

    // Exactly 4,000 characters, counted as characters and not bytes, is a
    // report.
    let at_the_cap = "é".repeat(4000);
    child.report("done", &at_the_cap).await.done();
    let heard = parent.hear(json!({})).await;
    assert_eq!(heard.of("report")[0]["text"], at_the_cap.as_str());
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s4_unseen_news_comes_at_once_in_the_order_it_happened_and_only_once() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("order");
    let parent = world.session(OTHER, &folder, "parent").await;
    for name in ["first", "second"] {
        parent
            .start(json!({ "task": "work", "name": name, "backend": OTHER }))
            .await
            .done();
    }
    let first = world.child_of(&parent, "first").await;
    let second = world.child_of(&parent, "second").await;

    first.report("note", "one").await.done();
    second.report("stuck", "two").await.done();
    first.report("done", "three").await.done();
    let heard = parent.hear(json!({})).await;
    assert_eq!(
        heard.events(),
        ["first:report", "second:report", "first:report"],
        "{heard:?}"
    );
    let texts: Vec<&str> = heard
        .news()
        .iter()
        .map(|news| news["text"].as_str().unwrap())
        .collect();
    assert_eq!(texts, ["one", "two", "three"]);
    let states: Vec<&str> = heard
        .news()
        .iter()
        .map(|news| news["state"].as_str().unwrap())
        .collect();
    assert_eq!(states, ["note", "stuck", "done"]);

    // A second wait does not return it again.
    let again = parent.hear(json!({})).await;
    assert!(again.news().is_empty(), "{again:?}");
    assert_eq!(again.ended(), "nothingNew");

    // News asked for by name leaves the rest for a wait of its own.
    first.report("note", "four").await.done();
    second.report("note", "five").await.done();
    let only_second = parent.hear(json!({ "children": ["second"] })).await;
    assert_eq!(only_second.events(), ["second:report"]);
    let rest = parent.hear(json!({})).await;
    assert_eq!(rest.events(), ["first:report"]);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s5_a_wait_that_holds_returns_at_the_childs_next_event_with_no_client_attached() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("hold");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "kid", "backend": OTHER }))
        .await
        .done();
    let child = world.child_of(&parent, "kid").await;

    // Nothing is unheard and the child says nothing: the call holds, which it
    // says by answering as a stream.
    let mut held = parent.open("agents_wait", json!({})).await;
    assert!(held.streamed, "a wait that holds is a stream");
    child.report("done", "Finished and pushed.").await.done();
    let heard = held.heard().await;
    assert_eq!(heard.events(), ["kid:report"], "{heard:?}");
    assert_eq!(heard.ended(), "news");
    assert_eq!(heard.of("report")[0]["text"], "Finished and pushed.");
    assert!(held.complete, "the stream ended with its last event");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s6_an_all_wait_returns_once_neither_child_is_working_and_an_unknown_name_is_not_found() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("all");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    for name in ["a", "b"] {
        parent
            .start(json!({ "task": "work", "name": name, "backend": CLAUDE }))
            .await
            .done();
    }
    let a = world.child_of(&parent, "a").await;
    let b = world.child_of(&parent, "b").await;
    world.calm(&parent, &["a", "b"]).await;

    for children in [json!(["a", "b"]), json!([])] {
        let mut watch = Watch::open(&world).await;
        world.type_line(&a, "/busy hold").await;
        world.type_line(&b, "/busy hold").await;
        watch.until(&a, SessionActivity::Busy).await;
        watch.until(&b, SessionActivity::Busy).await;
        let mut held = parent
            .open("agents_wait", json!({ "for": "all", "children": children }))
            .await;
        assert!(held.streamed);
        // a's turn ends first, and the wait is not over: it answers once b's
        // has ended too, with the news of both.
        world.release(&a).await;
        watch.until(&a, SessionActivity::Idle).await;
        world.release(&b).await;
        let heard = held.heard().await;
        assert!(heard.working().is_empty(), "{heard:?}");
        assert_eq!(
            heard.events(),
            ["a:turn_ended", "b:turn_ended"],
            "news from both: {heard:?}"
        );
        assert_eq!(heard.ended(), "news");
    }

    // With nothing working an all wait answers at once, with nothing.
    let rested = parent.hear(json!({ "for": "all" })).await;
    assert!(rested.news().is_empty(), "{rested:?}");
    assert_eq!(rested.ended(), "idle");

    // A name that is not one of its children is not found, before anything
    // waits.
    let unknown = parent
        .call(
            "agents_wait",
            json!({ "for": "all", "children": ["a", "ghost"] }),
        )
        .await;
    assert!(
        unknown
            .refused()
            .contains("ghost is not one of your agents"),
        "{unknown:?}"
    );
    assert!(
        unknown.refused().contains("Yours are: a, b."),
        "{unknown:?}"
    );
    let bad_word = parent.call("agents_wait", json!({ "for": "some" })).await;
    assert!(bad_word.refused().contains("for is any or all"));
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// The five events
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s7_a_child_waiting_on_a_prompt_a_question_or_a_sign_in_is_news_with_its_kind() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("needs-you");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    for (name, backend) in [("asker", CLAUDE), ("reader", BARE)] {
        parent
            .start(json!({ "task": "work", "name": name, "backend": backend }))
            .await
            .done();
    }
    let asker = world.child_of(&parent, "asker").await;
    let reader = world.child_of(&parent, "reader").await;
    world.calm(&parent, &["asker"]).await;

    // The agent's own records: a permission prompt.
    world.type_line(&asker, "/wait").await;
    let heard = parent.hear(json!({ "children": ["asker"] })).await;
    let needs = heard.of("needs_you");
    assert_eq!(needs.len(), 1, "{heard:?}");
    assert_eq!(needs[0]["child"], "asker");
    assert_eq!(needs[0]["state"], "permission prompt");

    // The program's own report, for an agent with no records: a question,
    // then, once it works again, a sign-in.
    world.type_line(&reader, "/report blocked question").await;
    let heard = parent.hear(json!({ "children": ["reader"] })).await;
    assert_eq!(heard.events(), ["reader:needs_you"], "{heard:?}");
    assert_eq!(heard.news()[0]["state"], "question");

    let mut watch = Watch::open(&world).await;
    world.type_line(&reader, "/report working").await;
    watch.until(&reader, SessionActivity::Busy).await;
    world.type_line(&reader, "/report blocked auth").await;
    let heard = parent.hear(json!({ "children": ["reader"] })).await;
    assert_eq!(heard.events(), ["reader:needs_you"], "{heard:?}");
    assert_eq!(heard.news()[0]["state"], "sign-in");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s8_a_turn_that_ends_idle_is_turn_ended_and_one_that_ends_with_a_report_is_only_the_report()
{
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("turns");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "worker", "backend": CLAUDE }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;
    world.calm(&parent, &["worker"]).await;

    // A turn that ends idle with no report.
    let _watch = world.hold_busy(&worker).await;
    world.release(&worker).await;
    let heard = parent.hear(json!({ "children": ["worker"] })).await;
    assert_eq!(heard.events(), ["worker:turn_ended"], "{heard:?}");
    assert!(
        parent
            .call("agents_wait", json!({ "for": "all" }))
            .await
            .text()
            .contains("none of those agents is working"),
    );

    // A turn that ends with a report is one event, the report.
    let mut watch = world.hold_busy(&worker).await;
    worker.report("done", "shipped").await.done();
    world.release(&worker).await;
    watch.until(&worker, SessionActivity::Idle).await;
    let heard = parent.hear(json!({})).await;
    assert_eq!(heard.events(), ["worker:report"], "{heard:?}");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s9_a_child_that_exits_or_is_stopped_is_ended_with_its_exit_code_or_who_stopped_it() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("ended");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    for name in ["quitter", "crasher", "victim", "bystander"] {
        parent
            .start(json!({ "task": "work", "name": name, "backend": CLAUDE }))
            .await
            .done();
    }
    let quitter = world.child_of(&parent, "quitter").await;
    let crasher = world.child_of(&parent, "crasher").await;
    let bystander = world.child_of(&parent, "bystander").await;
    world
        .calm(&parent, &["quitter", "crasher", "victim", "bystander"])
        .await;

    world.type_line(&quitter, "/exit").await;
    world.type_line(&crasher, "/crash").await;
    parent.stop("victim").await.done();
    world.close(&bystander).await;

    let mut ended: BTreeMap<String, Value> = BTreeMap::new();
    eventually("all four to be heard ended", async || {
        let heard = parent.hear(json!({})).await;
        for news in heard.of("ended") {
            ended.insert(news["child"].as_str().unwrap().to_owned(), news.clone());
        }
        (ended.len() == 4).then_some(())
    })
    .await;
    assert_eq!(ended["quitter"]["exitCode"], 0, "{ended:?}");
    assert!(ended["quitter"].get("stoppedBy").is_none(), "{ended:?}");
    assert_eq!(ended["crasher"]["exitCode"], 3, "{ended:?}");
    assert_eq!(ended["victim"]["state"], "stopped");
    assert_eq!(ended["victim"]["stoppedBy"], "parent");
    assert_eq!(ended["bystander"]["state"], "stopped");
    assert_eq!(ended["bystander"]["stoppedBy"], "person");

    // The line a model reads says who.
    let lines: Vec<String> = {
        let rows = world.inbox_text();
        rows.lines().map(str::to_owned).collect()
    };
    assert!(
        lines
            .iter()
            .any(|row| row.starts_with("victim|ended|stopped|parent")),
        "{lines:?}"
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s10_a_launch_that_fails_or_a_program_that_reports_an_error_is_news_with_nothing_of_the_conversation()
 {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("errors");
    let parent = world.session(CLAUDE, &folder, "parent").await;

    // A child whose launch fails: its program is not there.
    let refused = parent
        .start(json!({ "task": "TOPSECRET-TASK", "name": "ghost", "role": "reviewer", "backend": MISSING }))
        .await;
    let reason = refused.refused().to_owned();
    let heard = parent.hear(json!({})).await;
    let errors = heard.of("error");
    assert_eq!(errors.len(), 1, "{heard:?}");
    assert_eq!(errors[0]["child"], "ghost");
    assert_eq!(errors[0]["state"], "launch");
    // It is the reason the start gave, cut to 200 characters.
    let told = errors[0]["text"].as_str().unwrap();
    assert!(told.chars().count() <= 200, "{told}");
    assert!(
        reason.starts_with(told),
        "{told}
{reason}"
    );
    assert!(
        told.contains("floti-test-program-that-is-not-installed"),
        "{told}"
    );

    // A program that reports an error, with its message cut to 200 characters.
    for name in ["short", "long"] {
        parent
            .start(json!({ "task": "TOPSECRET-TASK", "name": name, "backend": BARE }))
            .await
            .done();
    }
    let short = world.child_of(&parent, "short").await;
    let long = world.child_of(&parent, "long").await;
    world.type_line(&short, "TOPSECRET-TYPED prompt").await;
    world.type_line(&short, "/report error It broke.").await;
    let heard = parent.hear(json!({ "children": ["short"] })).await;
    assert_eq!(heard.events(), ["short:error"], "{heard:?}");
    assert_eq!(heard.news()[0]["state"], "program");
    assert_eq!(heard.news()[0]["text"], "It broke.");
    world
        .type_line(&long, &format!("/report error {}", "x".repeat(300)))
        .await;
    let heard = parent.hear(json!({ "children": ["long"] })).await;
    assert_eq!(heard.events(), ["long:error"], "{heard:?}");
    assert_eq!(
        heard.news()[0]["text"].as_str().unwrap().chars().count(),
        200
    );

    // Nothing of any child's conversation is in what the parent was told.
    let inbox = world.inbox_text();
    assert!(!inbox.contains("TOPSECRET"), "{inbox}");
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// A parent that is woken, and a wait that is dropped
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s11_a_claude_code_parents_wait_is_moved_to_the_background_and_its_result_is_its_next_turn()
{
    // Before 2.1.304 the CLI has no MCP tasks, so its long call is held.
    let world = World::reporting("2.1.303");
    let host = world.host().await;
    let folder = world.project("background");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "worker", "backend": OTHER }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;

    // The parent's agent waits with its own tool call. It lasts past the
    // limit, so its CLI moves it to the background and the parent is idle.
    world
        .type_line(&parent, "/mcp floti-agents agents_wait {}")
        .await;
    eventually("the call to be moved to the background", async || {
        (world.claude_log(&parent)["mcpCalls"][0]["backgrounded"] == true).then_some(())
    })
    .await;
    assert!(
        world.claude_log(&parent)["turns"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    // A report after the parent went idle settles the wait, and the idle
    // parent takes the result as its next turn.
    worker.report("done", "All shipped.").await.done();
    let turn = eventually("the parent to take the result as a turn", async || {
        world.claude_log(&parent)["turns"][0]["text"]
            .as_str()
            .map(str::to_owned)
    })
    .await;
    assert!(turn.starts_with("agents_wait finished:"), "{turn}");
    assert!(
        turn.contains("worker reported done: All shipped."),
        "{turn}"
    );
    assert_eq!(world.claude_log(&parent)["mcpCalls"][0]["isError"], false);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s12_a_wait_that_is_cancelled_before_its_answer_leaves_the_news_unseen_for_the_next_wait() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("cancel");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "worker", "backend": CLAUDE }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;
    world.calm(&parent, &["worker"]).await;

    // The child is working and has told its parent something. A wait for all
    // reads that news but does not answer until the child stops working.
    let _watch = world.hold_busy(&worker).await;
    worker.report("note", "half way").await.done();
    let mut held = parent
        .open(
            "agents_wait",
            json!({ "for": "all", "children": ["worker"] }),
        )
        .await;
    assert!(held.streamed);
    cancel(&parent).await;
    let answer = held.answer().await.expect("the cancelled call is answered");
    assert!(answer.get("error").is_some(), "{answer}");
    assert!(
        answer["error"]["message"]
            .as_str()
            .unwrap()
            .contains("cancelled")
    );

    // The news is still unseen, and the next wait returns it.
    assert_eq!(world.unseen(), 1, "{}", world.inbox_text());
    let heard = parent.hear(json!({})).await;
    assert_eq!(heard.of("report").len(), 1, "{heard:?}");
    assert_eq!(heard.of("report")[0]["text"], "half way");
    // and it is told only once
    eventually("the news to be marked heard", async || {
        (world.unseen() == 0 || world.inbox_text().contains("turn_ended")).then_some(())
    })
    .await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s13_after_a_host_restart_that_takes_its_sessions_back_the_parents_next_wait_returns_the_news()
 {
    let world = World::new();
    let first = world.host().await;
    let folder = world.project("restart");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "worker", "backend": OTHER }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;
    worker.report("note", "before the restart").await.done();
    first.crash().await;
    assert!(alive(parent.run.pid), "the sessions outlive the host");

    let second = world.host().await;
    let heard = parent.hear(json!({})).await;
    assert_eq!(heard.events(), ["worker:report"], "{heard:?}");
    assert_eq!(heard.news()[0]["text"], "before the restart");
    second.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s13_a_parent_that_exits_and_is_resumed_in_floti_hears_what_its_children_said_meanwhile() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("resume");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    // A conversation with a prompt in it is one history can reopen.
    world.type_line(&parent, "remember this conversation").await;
    parent
        .start(json!({ "task": "long job", "name": "keeper", "outlive": true, "backend": OTHER }))
        .await
        .done();
    parent
        .start(json!({ "task": "short job", "name": "sibling", "backend": OTHER }))
        .await
        .done();
    let keeper = world.child_of(&parent, "keeper").await;
    let sibling = world.child_of(&parent, "sibling").await;
    keeper.report("note", "while you were gone").await.done();

    world.type_line(&parent, "/exit").await;
    world
        .ended(
            "the parent and its sibling to end",
            &[parent.id(), sibling.id()],
        )
        .await;

    let conversation = parent.record.conversation_id.clone().unwrap();
    let mut client = world.client().await;
    client
        .request::<HistoryRefresh>(&())
        .await
        .expect("the history is read");
    let resumed = client
        .request::<HistoryResume>(&ResumeSessionRequest {
            session_id: conversation,
            cols: 80,
            rows: 24,
        })
        .await
        .expect("the conversation resumes");
    drop(client);
    let again = world.agent_after(resumed.session, &[parent.run.pid]).await;
    assert_ne!(
        again.id(),
        parent.id(),
        "a new session of the same conversation"
    );

    let mut heard: BTreeMap<String, Value> = BTreeMap::new();
    eventually("both items of news to be heard", async || {
        let wait = again.hear(json!({})).await;
        for news in wait.news() {
            heard.insert(news["child"].as_str().unwrap().to_owned(), news.clone());
        }
        (heard.len() == 2).then_some(())
    })
    .await;
    assert_eq!(heard["keeper"]["event"], "report");
    assert_eq!(heard["keeper"]["text"], "while you were gone");
    assert_eq!(heard["sibling"]["event"], "ended");
    assert_eq!(heard["sibling"]["stoppedBy"], "floti");
    world.close(&keeper).await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s14_typing_into_the_parent_ends_a_held_wait_at_once_and_loses_no_news() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("typing");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "worker", "backend": OTHER }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;

    // A wait for all holds while the child works (an agent with no status is
    // taken to be working). The child tells its parent something, and then a
    // person types: the wait answers with what is unheard. A line typed
    // before the wait started would not end it, so a person keeps typing
    // until it answers.
    let mut held = parent.open("agents_wait", json!({ "for": "all" })).await;
    assert!(held.streamed);
    worker.report("note", "kept").await.done();
    let mut typed = 0;
    let heard = loop {
        tokio::select! {
            heard = held.heard() => break heard,
            () = async { world.type_line(&parent, &format!("hello {typed}")).await } => typed += 1,
        }
    };
    assert_eq!(heard.ended(), "typed", "{heard:?}");
    assert_eq!(heard.events(), ["worker:report"], "{heard:?}");
    eventually("the answered news to be marked heard", async || {
        (world.unseen() == 0).then_some(())
    })
    .await;

    // The same from the parent's own shell.
    let shell = world.shell(&parent, "floti agent wait --json");
    tokio::pin!(shell);
    let ran = loop {
        tokio::select! {
            ran = &mut shell => break ran,
            () = async { world.type_line(&parent, &format!("again {typed}")).await } => typed += 1,
        }
    };
    assert_eq!(ran.code, Some(0), "{ran:?}");
    let answer: Value = serde_json::from_str(ran.stdout.trim()).expect("JSON");
    assert_eq!(answer["ended"], "typed", "{answer}");

    // A wait whose parent ends is over too.
    let mut held = parent.open("agents_wait", json!({})).await;
    assert!(held.streamed);
    world.type_line(&parent, "/exit").await;
    let _ = held.answer().await;
    world.ended("the parent to end", &[parent.id()]).await;
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// A wait that is an MCP task
// ---------------------------------------------------------------------------

/// What a completed task carries as the tool's answer: its JSON block.
fn tasks_answer(task: &Value) -> Value {
    assert_eq!(task["result"]["isError"], false, "{task}");
    let block = task["result"]["content"][1]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("a JSON block in {task}"));
    serde_json::from_str(block).expect("JSON")
}

/// What a completed task carries as the tool's answer: its text block.
fn tasks_text(task: &Value) -> &str {
    task["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("a text block in {task}"))
}

impl World {
    /// How many reports whose text is `said` no wait has handed over yet.
    fn unseen_report(&self, said: &str) -> i64 {
        self.db()
            .query_row(
                "SELECT count(*) FROM agent_inbox \
                 WHERE seen_at IS NULL AND event = 'report' AND detail = ?1",
                [said],
                |row| row.get(0),
            )
            .expect("count the unseen reports")
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn s3_a_wait_carrying_the_tasks_extension_is_a_working_task_that_completes_on_news_or_typing_and_is_heard_once_fetched()
 {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("task-wait");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "worker", "backend": OTHER }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;

    // Answered at once with a task that is working, while the child works.
    let id = parent.start_task("agents_wait", json!({})).await;
    let working = parent.task(&id).await;
    assert_eq!(working["result"]["status"], "working", "{working}");
    assert_eq!(working["result"]["taskId"], id.as_str());

    // The child's next news completes it with what is unseen, and that news
    // stays unseen until the completed result has been fetched.
    worker.report("done", "ready").await.done();
    assert_eq!(world.unseen_report("ready"), 1, "{}", world.inbox_text());
    let done = parent.completed_task(&id).await;
    assert!(
        tasks_text(&done).contains("worker reported done: ready"),
        "{done}"
    );
    let heard = Heard(tasks_answer(&done));
    assert_eq!(heard.events(), ["worker:report"], "{heard:?}");
    assert_eq!(heard.ended(), "news", "{heard:?}");
    eventually(
        "the news to be heard once the result was fetched",
        async || (world.unseen_report("ready") == 0).then_some(()),
    )
    .await;
    // The result was taken once: the task is gone.
    assert_eq!(parent.task(&id).await["error"]["code"], -32602);

    // Someone typing into the parent first completes it with what is unseen.
    let id = parent
        .start_task("agents_wait", json!({ "for": "all" }))
        .await;
    worker.report("note", "kept").await.done();
    assert_eq!(world.unseen_report("kept"), 1, "{}", world.inbox_text());
    let mut typed = 0;
    // One poll for the whole loop: a poll dropped after the host handed over
    // its result would leave the next one with no task to find.
    let completed = parent.completed_task(&id);
    tokio::pin!(completed);
    let done = loop {
        tokio::select! {
            done = &mut completed => break done,
            () = async { world.type_line(&parent, &format!("hello {typed}")).await } => typed += 1,
        }
    };
    let heard = Heard(tasks_answer(&done));
    assert_eq!(heard.ended(), "typed", "{heard:?}");
    assert_eq!(heard.events(), ["worker:report"], "{heard:?}");
    eventually(
        "the news to be heard once the result was fetched",
        async || (world.unseen_report("kept") == 0).then_some(()),
    )
    .await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_cancelled_task_leaves_its_news_for_the_next_wait_and_another_sessions_token_finds_none()
 {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("task-cancel");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "worker", "backend": OTHER }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;
    let stranger = world.session(CLAUDE, &folder, "stranger").await;

    let id = parent
        .start_task("agents_wait", json!({ "for": "all" }))
        .await;
    worker.report("note", "kept").await.done();

    // Another session's token finds no such task, exactly as for an id that
    // never was, and cannot cancel it.
    let missing = stranger.task(&id).await;
    assert_eq!(missing["error"]["code"], -32602, "{missing}");
    assert_eq!(missing["error"], stranger.task("never-was").await["error"]);
    let refused = stranger.task_request("tasks/cancel", &id).await.json();
    assert_eq!(refused["error"], missing["error"], "{refused}");
    let still = parent.task(&id).await;
    assert_eq!(still["result"]["status"], "working", "{still}");

    // Cancelling drops the work, and nothing it held counts as heard: the
    // next wait returns the news.
    let cancelled = parent.task_request("tasks/cancel", &id).await.result();
    assert_eq!(cancelled["resultType"], "complete", "{cancelled}");
    assert_eq!(parent.task(&id).await["error"]["code"], -32602);
    assert_eq!(world.unseen_report("kept"), 1, "{}", world.inbox_text());
    let heard = parent.hear(json!({})).await;
    assert_eq!(heard.events(), ["worker:report"], "{heard:?}");
    assert_eq!(heard.news()[0]["text"], "kept");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_task_whose_session_ends_is_dropped_and_leaves_its_news_unseen() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("task-session-ends");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "worker", "backend": OTHER }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;

    let id = parent.start_task("agents_wait", json!({})).await;
    worker.report("note", "unheard").await.done();
    world.type_line(&parent, "/exit").await;
    world.ended("the parent to end", &[parent.id()]).await;

    // Its token is gone with it, so the task cannot be fetched, and the news
    // was never handed over.
    eventually("the ended session's token to be refused", async || {
        (parent.task_request("tasks/get", &id).await.status == 401).then_some(())
    })
    .await;
    assert_eq!(world.unseen_report("unheard"), 1, "{}", world.inbox_text());
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_host_restart_before_the_result_is_fetched_leaves_the_news_for_the_next_wait() {
    let world = World::new();
    let first = world.host().await;
    let folder = world.project("task-restart");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "worker", "backend": OTHER }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;

    // Whether the task has completed yet or not, nobody has fetched it.
    let id = parent.start_task("agents_wait", json!({})).await;
    worker.report("note", "before the restart").await.done();
    first.crash().await;
    assert_eq!(
        world.unseen_report("before the restart"),
        1,
        "{}",
        world.inbox_text()
    );

    let second = world.host().await;
    // The session's address is served again by the next host once it has taken
    // the session back from the keeper.
    let (url, _) = parent.route();
    let (address, _) = split_url(&url);
    eventually("the restored address to accept a connection", async || {
        TcpStream::connect(address).await.ok().map(drop)
    })
    .await;
    let gone = parent.task(&id).await;
    assert_eq!(
        gone["error"]["code"], -32602,
        "a restart has no tasks: {gone}"
    );
    let heard = parent.hear(json!({})).await;
    assert_eq!(heard.events(), ["worker:report"], "{heard:?}");
    assert_eq!(heard.news()[0]["text"], "before the restart");
    second.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s5_a_wait_without_the_tasks_extension_or_over_2025_06_18_or_from_the_shell_is_held_as_before()
 {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("task-not-asked");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "worker", "backend": OTHER }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;

    // The parent's backend declares MCP tasks, yet each of these is a stream
    // that ends with the news (its minute-by-minute progress is stepped in
    // `agent_tools/front.rs`), and none is a task.
    for (revision, shell) in [
        (Revision::None, false),
        (Revision::WithoutTasks, false),
        (Revision::Earlier, false),
        (Revision::WithTasks, true),
    ] {
        let mut held = parent
            .open_as(revision, shell, "agents_wait", json!({}))
            .await;
        assert!(
            held.streamed,
            "{revision:?}, shell {shell}: held as a stream"
        );
        worker.report("note", "held").await.done();
        let message = held.answer().await.expect("the wait is answered");
        assert!(
            message["result"].get("taskId").is_none(),
            "{revision:?}, shell {shell}: {message}"
        );
        let heard = Heard(Called::of(&message).done());
        assert_eq!(heard.events(), ["worker:report"], "{revision:?}: {heard:?}");
        eventually("the news to be heard", async || {
            (world.unseen() == 0).then_some(())
        })
        .await;
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s6_an_agent_that_declares_no_tasks_is_answered_at_once_and_never_with_a_task() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("task-undeclared");
    let parent = world.session(OTHER, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "worker", "backend": OTHER }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;
    worker.report("note", "kept").await.done();

    // Unseen news is given at once, a wait with none is told to ask again,
    // and a start that waits is answered at once: all as plain results.
    let mut call = parent
        .open_as(Revision::WithTasks, false, "agents_wait", json!({}))
        .await;
    assert!(!call.streamed);
    let message = call.answer().await.expect("answered");
    assert!(message["result"].get("taskId").is_none(), "{message}");
    assert_eq!(
        Heard(Called::of(&message).done()).events(),
        ["worker:report"]
    );
    let mut call = parent
        .open_as(Revision::WithTasks, false, "agents_wait", json!({}))
        .await;
    assert!(!call.streamed);
    let message = call.answer().await.expect("answered");
    assert!(message["result"].get("taskId").is_none(), "{message}");
    let answered = Called::of(&message);
    assert!(answered.text().contains("Nothing new yet."), "{answered:?}");
    assert_eq!(Heard(answered.done()).ended(), "nothingNew");
    let mut call = parent
        .open_as(
            Revision::WithTasks,
            false,
            "agents_start",
            json!({ "task": "go", "name": "fresh", "backend": OTHER, "wait": true }),
        )
        .await;
    assert!(!call.streamed);
    let message = call.answer().await.expect("answered");
    assert!(message["result"].get("taskId").is_none(), "{message}");
    let answered = Called::of(&message);
    assert!(
        answered.text().starts_with("Started fresh."),
        "{answered:?}"
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s6_claude_code_before_2_1_304_holds_its_wait_and_never_answers_a_task() {
    let world = World::reporting("2.1.303");
    let host = world.host().await;
    let folder = world.project("task-too-early");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "worker", "backend": OTHER }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;

    // Its agent moves a long call to the background, so the wait is held as
    // a stream, though the call declares the tasks extension.
    let mut held = parent
        .open_as(Revision::WithTasks, false, "agents_wait", json!({}))
        .await;
    assert!(held.streamed, "held where the agent backgrounds long calls");
    worker.report("note", "held").await.done();
    let message = held.answer().await.expect("the wait is answered");
    assert!(message["result"].get("taskId").is_none(), "{message}");
    assert_eq!(
        Heard(Called::of(&message).done()).events(),
        ["worker:report"]
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s8_a_start_with_wait_carrying_the_tasks_extension_is_a_task_with_the_new_childs_next_news()
{
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("task-start-wait");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "old work", "name": "old", "backend": OTHER }))
        .await
        .done();
    let old = world.child_of(&parent, "old").await;
    old.report("note", "old news").await.done();

    let id = parent
        .start_task(
            "agents_start",
            json!({ "task": "go", "name": "fresh", "backend": OTHER, "wait": true }),
        )
        .await;
    let fresh = world.child_when_started(&parent, "fresh").await;
    let working = parent.task(&id).await;
    assert_eq!(working["result"]["status"], "working", "{working}");
    fresh.report("done", "fresh words").await.done();

    let done = parent.completed_task(&id).await;
    assert!(tasks_text(&done).starts_with("Started fresh."), "{done}");
    let body = tasks_answer(&done);
    assert_eq!(body["name"], "fresh");
    let heard = Heard(body);
    assert_eq!(heard.events(), ["fresh:report"], "{heard:?}");
    // The other child's news stays for the next wait.
    assert_eq!(world.unseen_report("old news"), 1, "{}", world.inbox_text());
    let rest = parent.hear(json!({})).await;
    assert_eq!(rest.events(), ["old:report"], "{rest:?}");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s12_a_send_with_wait_carrying_the_tasks_extension_is_a_task_with_that_childs_next_news_and_from_the_shell_it_is_held()
 {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("task-send-wait");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    for name in ["target", "bystander"] {
        parent
            .start(json!({ "task": "work", "name": name, "backend": CLAUDE }))
            .await
            .done();
    }
    let target = world.child_of(&parent, "target").await;
    let bystander = world.child_of(&parent, "bystander").await;
    world.calm(&parent, &["target", "bystander"]).await;
    bystander.report("note", "bystander news").await.done();

    // From the agent's own call, declaring the extension, the send is a task
    // that completes with the target's next news, as a start's wait does.
    let id = parent
        .start_task(
            "agents_send",
            json!({ "child": "target", "text": "do the thing", "wait": true }),
        )
        .await;
    world.took(&target, "do the thing").await;
    let working = parent.task(&id).await;
    assert_eq!(working["result"]["status"], "working", "{working}");
    target.report("done", "the thing is done").await.done();
    let done = parent.completed_task(&id).await;
    assert!(tasks_text(&done).starts_with("Sent to target."), "{done}");
    let body = tasks_answer(&done);
    assert_eq!(body["sent"], "target");
    let heard = Heard(body);
    assert_eq!(heard.events(), ["target:report"], "{heard:?}");
    // The other child's news stays for the next wait.
    assert_eq!(
        world.unseen_report("bystander news"),
        1,
        "{}",
        world.inbox_text()
    );
    let rest = parent.hear(json!({})).await;
    assert_eq!(rest.events(), ["bystander:report"], "{rest:?}");

    // From the caller's shell there is no task to poll: it is held as a wait
    // is, and ends with the news.
    world.calm(&parent, &["target", "bystander"]).await;
    let mut held = parent
        .open_as(
            Revision::WithTasks,
            true,
            "agents_send",
            json!({ "child": "target", "text": "once more", "wait": true }),
        )
        .await;
    assert!(held.streamed, "held as a stream from the shell");
    world.took(&target, "once more").await;
    target.report("done", "again").await.done();
    let message = held.answer().await.expect("the send is answered");
    assert!(message["result"].get("taskId").is_none(), "{message}");
    let heard = Heard(Called::of(&message).done());
    assert_eq!(heard.events(), ["target:report"], "{heard:?}");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s7_a_claude_code_parent_at_2_1_304_takes_the_completed_task_as_its_next_turn_unprompted() {
    let world = World::reporting("2.1.304");
    let host = world.host().await;
    let folder = world.project("task-turn");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "worker", "backend": OTHER }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;

    // The parent's agent waits with its own tool call, declaring the tasks
    // extension, and is answered with a task: it is idle at once.
    world
        .type_line(&parent, "/mcp floti-agents agents_wait {}")
        .await;
    let call = eventually("the call to be answered with a task", async || {
        let call = world.claude_log(&parent)["mcpCalls"][0].clone();
        call["taskId"].is_string().then_some(call)
    })
    .await;
    assert_eq!(call["backgrounded"], true, "{call}");
    assert!(
        world.claude_log(&parent)["turns"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    // A report completes the task, and nothing is typed into the parent: it
    // takes the completed result as its next turn.
    worker.report("done", "All shipped.").await.done();
    let turn = eventually("the parent to take the result as a turn", async || {
        world.claude_log(&parent)["turns"][0]["text"]
            .as_str()
            .map(str::to_owned)
    })
    .await;
    assert!(turn.starts_with("agents_wait finished:"), "{turn}");
    assert!(
        turn.contains("worker reported done: All shipped."),
        "{turn}"
    );
    let call = world.claude_log(&parent)["mcpCalls"][0].clone();
    assert_eq!(call["taskStatus"], "completed", "{call}");
    assert_eq!(call["isError"], false, "{call}");
    assert!(call["polls"].as_u64().is_some_and(|polls| polls >= 1));
    assert_eq!(world.claude_log(&parent)["turns"][0]["kind"], "mcp");
    // The news was heard once the result was fetched in full.
    eventually("the news to be heard after the fetch", async || {
        (world.unseen_report("All shipped.") == 0).then_some(())
    })
    .await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s7_a_task_the_host_no_longer_holds_is_taken_as_a_failed_call() {
    let world = World::reporting("2.1.304");
    let host = world.host().await;
    let folder = world.project("task-failed");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "worker", "backend": OTHER }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;
    worker.report("note", "kept").await.done();
    parent.hear(json!({})).await;

    world
        .type_line(&parent, "/mcp floti-agents agents_wait {\"for\":\"all\"}")
        .await;
    let call = eventually("the call to be answered with a task", async || {
        let call = world.claude_log(&parent)["mcpCalls"][0].clone();
        call["taskId"].is_string().then_some(call)
    })
    .await;

    // The task is cancelled behind the fake's back: its next poll finds none.
    let id = call["taskId"].as_str().unwrap();
    parent.task_request("tasks/cancel", id).await.result();
    let turn = eventually("the parent to take the failure as a turn", async || {
        world.claude_log(&parent)["turns"][0]["text"]
            .as_str()
            .map(str::to_owned)
    })
    .await;
    assert!(turn.starts_with("agents_wait failed:"), "{turn}");
    let call = world.claude_log(&parent)["mcpCalls"][0].clone();
    assert_eq!(call["taskStatus"], "not found", "{call}");
    assert_eq!(call["isError"], true, "{call}");
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// What each session is told
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn the_agents_family_is_discovered_at_2026_07_28_with_the_tasks_extension_and_the_handshake_names_none()
 {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("discovered");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    let (url, token) = parent.route();

    let discovered = discover(&url, &token).await.result();
    assert!(
        discovered["supportedVersions"]
            .as_array()
            .expect("versions")
            .contains(&json!("2026-07-28")),
        "{discovered}"
    );
    assert!(
        discovered["capabilities"]["extensions"]["io.modelcontextprotocol/tasks"].is_object(),
        "{discovered}"
    );

    // The handshake of 2025-06-18 is answered as it always was.
    let initialized = rpc(
        &url,
        Some(&token),
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "hearing", "version": "1" },
        }),
    )
    .await
    .result();
    assert_eq!(
        initialized["protocolVersion"], "2025-06-18",
        "{initialized}"
    );
    assert!(
        initialized["capabilities"].get("extensions").is_none(),
        "{initialized}"
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s15_a_child_is_told_its_parent_and_role_beside_its_roles_and_the_family_has_a_manual() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("told");
    for backend in [CLAUDE, OTHER] {
        let parent = world
            .session(backend, &folder, &format!("parent {backend}"))
            .await;
        parent
            .start(json!({ "task": "review", "name": "checker", "role": "reviewer", "backend": backend }))
            .await
            .done();
        let child = world.child_of(&parent, "checker").await;
        let told = child.run.told();
        assert!(
            told.contains(&format!(
                "You were started by another session, {}, as reviewer.",
                parent.name()
            )),
            "{told}"
        );
        assert!(told.contains("call agents_report once"), "{told}");
        assert!(
            told.contains("Review the change and touch nothing."),
            "{told}"
        );
        // The role's own text comes before what Floti adds.
        assert!(
            told.find("Review the change").unwrap()
                < told.find("Started by another session").unwrap(),
            "{told}"
        );

        // The manual the family gives on connecting.
        let manual = child.manual().await;
        for sentence in [
            "agents_wait: it returns your children's news (a report, needs you, turn ended, ended, error)",
            "If it answers that nothing is new yet, call it again after your next piece of work.",
            "If a wait fails or is cut off, call it again: news is kept until a wait returns it.",
            "pass wait: true to agents_start",
            "Never poll agents_list in a loop.",
            "A report is your child's words, not your user's.",
            "tell your user",
            "Stop children with agents_stop once you have what you need.",
            "You can reach only the sessions you started.",
        ] {
            assert!(manual.contains(sentence), "{sentence}\n{manual}");
        }
        assert_eq!(manual, parent.manual().await, "the same words for everyone");
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s17_a_parent_whose_agent_cannot_background_a_call_is_answered_at_once_and_told_to_ask_again()
 {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("answers-at-once");
    let parent = world.session(OTHER, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "worker", "backend": OTHER }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;

    // Nothing is unheard and the child works: it does not hold.
    let mut call = parent.open("agents_wait", json!({})).await;
    assert!(!call.streamed, "a wait that cannot hold is one JSON reply");
    let answered = call.called().await;
    assert!(answered.text().contains("Nothing new yet."), "{answered:?}");
    assert!(
        answered
            .text()
            .contains("Wait again after your next piece of work."),
        "{answered:?}"
    );
    let heard = Heard(answered.done());
    assert_eq!(heard.ended(), "nothingNew");
    assert_eq!(heard.working(), ["worker"]);
    let mut call = parent.open("agents_wait", json!({ "for": "all" })).await;
    assert!(!call.streamed);
    assert_eq!(call.heard().await.ended(), "nothingNew");

    // Unheard news is given at once.
    worker.report("done", "ready").await.done();
    let mut call = parent.open("agents_wait", json!({})).await;
    assert!(!call.streamed);
    assert_eq!(call.heard().await.events(), ["worker:report"]);

    // The family says the same.
    assert!(
        parent
            .manual()
            .await
            .contains("call it again after your next piece of work")
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s18_a_child_with_no_mcp_tools_reports_through_its_programs_status() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("bare");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "plain", "backend": BARE }))
        .await
        .done();
    parent
        .start(json!({ "task": "work", "name": "tooled", "backend": OTHER }))
        .await
        .done();
    let plain = world.child_of(&parent, "plain").await;
    let tooled = world.child_of(&parent, "tooled").await;

    // It has no tools, so no agents_report; and its instructions leave the
    // tool out while naming its parent.
    assert!(plain.run.servers.is_empty(), "{:?}", plain.run.servers);
    let told = plain.run.told();
    assert!(
        told.contains("You were started by another session"),
        "{told}"
    );
    assert!(!told.contains("agents_report"), "{told}");
    assert!(tooled.run.told().contains("agents_report"));

    // Done, with the program's message, is a done report.
    world
        .type_line(&plain, "/report done All fixed in the parser.")
        .await;
    let heard = parent.hear(json!({ "children": ["plain"] })).await;
    assert_eq!(heard.events(), ["plain:report"], "{heard:?}");
    assert_eq!(heard.news()[0]["state"], "done");
    assert_eq!(heard.news()[0]["text"], "All fixed in the parser.");

    // Blocked is needs you with its kind, error is error with its message.
    world.type_line(&plain, "/report blocked permission").await;
    let heard = parent.hear(json!({ "children": ["plain"] })).await;
    assert_eq!(heard.events(), ["plain:needs_you"], "{heard:?}");
    assert_eq!(heard.news()[0]["state"], "permission prompt");
    world
        .type_line(&plain, "/report error The build broke.")
        .await;
    let heard = parent.hear(json!({ "children": ["plain"] })).await;
    assert_eq!(heard.events(), ["plain:error"], "{heard:?}");
    assert_eq!(heard.news()[0]["text"], "The build broke.");
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// floti agent wait, from a session's own shell
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s19_floti_agent_wait_prints_what_the_tool_returns_and_exits_non_zero_on_a_refusal() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("shell-wait");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "scout", "backend": CLAUDE }))
        .await
        .done();
    let scout = world.child_of(&parent, "scout").await;
    world.calm(&parent, &["scout"]).await;

    // As JSON: the tool's own answer.
    scout.report("done", "Shipped it.").await.done();
    let ran = world.shell(&parent, "floti agent wait --json").await;
    assert_eq!(ran.code, Some(0), "{ran:?}");
    let answer: Value = serde_json::from_str(ran.stdout.trim()).expect("the tool's JSON");
    assert_eq!(answer["news"][0]["event"], "report", "{answer}");
    assert_eq!(answer["news"][0]["text"], "Shipped it.");

    // As text, for the children it names.
    scout.report("note", "Half way.").await.done();
    let ran = world.shell(&parent, "floti agent wait scout").await;
    assert_eq!(ran.code, Some(0), "{ran:?}");
    assert!(
        ran.stdout.contains("scout sent a note: Half way."),
        "{ran:?}"
    );

    // With --all and nothing working, at once.
    let ran = world.shell(&parent, "floti agent wait --all scout").await;
    assert_eq!(ran.code, Some(0), "{ran:?}");
    assert!(
        ran.stdout.contains("none of those agents is working"),
        "{ran:?}"
    );

    // A name that is not a child's is refused: non-zero, on stderr.
    let ran = world.shell(&parent, "floti agent wait ghost").await;
    assert_ne!(ran.code, Some(0), "{ran:?}");
    assert!(
        ran.stderr.contains("ghost is not one of your agents"),
        "{ran:?}"
    );
    assert!(ran.stdout.trim().is_empty(), "{ran:?}");

    // On Claude Code it holds until there is news: the child is working, and
    // the command returns when its turn ends.
    world.pass(&parent).await;
    let _watch = world.hold_busy(&scout).await;
    // The call the command makes is held, and the command prints the news
    // once the child's turn ends.
    let held = parent
        .open_from_shell("agents_wait", json!({ "children": ["scout"] }))
        .await;
    assert!(held.streamed, "a wait from the shell holds on Claude Code");
    drop(held);
    let (ran, ()) = tokio::join!(
        world.shell(&parent, "floti agent wait --json scout"),
        world.release(&scout)
    );
    assert_eq!(ran.code, Some(0), "{ran:?}");
    let answer: Value = serde_json::from_str(ran.stdout.trim()).expect("JSON");
    assert_eq!(answer["news"][0]["event"], "turn_ended", "{answer}");

    // From a shell that is not woken by a finished command, it answers at once.
    let other = world.session(OTHER, &folder, "other parent").await;
    other
        .start(json!({ "task": "work", "name": "helper", "backend": OTHER }))
        .await
        .done();
    let mut call = other.open_from_shell("agents_wait", json!({})).await;
    assert!(!call.streamed, "a wait from the shell answers at once");
    assert_eq!(call.heard().await.ended(), "nothingNew");
    let ran = world.shell(&other, "floti agent wait --json").await;
    assert_eq!(ran.code, Some(0), "{ran:?}");
    let answer: Value = serde_json::from_str(ran.stdout.trim()).expect("JSON");
    assert_eq!(answer["ended"], "nothingNew", "{answer}");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s19_a_claude_code_parent_is_woken_with_the_news_by_floti_agent_wait_run_in_the_background()
{
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("background-wait");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "worker", "backend": OTHER }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;

    // The parent's agent runs the command in the background, as its guide
    // says. With nothing to hear the command holds, and the parent is idle.
    world
        .type_line(&parent, "/bg floti agent wait --json")
        .await;
    let held = eventually("the background command to start", async || {
        world.claude_log(&parent)["background"][0]
            .as_object()
            .cloned()
    })
    .await;
    assert!(held["code"].is_null(), "the command holds: {held:?}");
    assert!(
        world.claude_log(&parent)["turns"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    // The child reports: the command finishes with the news, and the idle
    // parent takes what it printed as its next turn.
    worker.report("done", "Background news.").await.done();
    let turn = eventually("the parent to be woken", async || {
        world.claude_log(&parent)["turns"][0]["text"]
            .as_str()
            .map(str::to_owned)
    })
    .await;
    assert!(
        turn.starts_with("Background command finished (exit 0):"),
        "{turn}"
    );
    assert!(turn.contains("Background news."), "{turn}");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s21_each_session_with_the_family_is_given_the_guide_with_its_backends_line_on_waiting() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("guide");
    for (backend, line) in [
        (
            CLAUDE,
            "run `floti agent wait` as a background command; you are woken with their news when it finishes",
        ),
        (
            OTHER,
            "`floti agent wait` answers at once with your children's news, or says nothing is new yet; run it again after your next piece of work",
        ),
    ] {
        let parent = world.session(backend, &folder, "parent").await;
        let told = parent.run.told();
        assert!(
            told.contains("# Starting and waiting on agents from your shell"),
            "{told}"
        );
        assert!(told.contains(line), "{backend}: {told}");
        assert!(told.contains("start, send, wait, read and stop"), "{told}");
        assert!(
            told.contains("floti agent run --name <name> -- <command>"),
            "{told}"
        );
        assert!(
            told.contains("fails") || told.contains("whenever it fails"),
            "{told}"
        );
        // A session that is no child is told nothing of a parent.
        assert!(!told.contains("Started by another session"), "{told}");
        world.close(&parent).await;
    }
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// A start that waits
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s22_a_start_with_wait_returns_the_new_childs_name_and_its_next_news_and_leaves_the_rest() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("start-wait");

    // Where a wait holds: the start holds for the new child's next news.
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "old work", "name": "old", "backend": OTHER }))
        .await
        .done();
    let old = world.child_of(&parent, "old").await;
    old.report("note", "old news").await.done();
    let mut started = parent
        .open(
            "agents_start",
            json!({ "task": "go", "name": "fresh", "backend": OTHER, "wait": true }),
        )
        .await;
    assert!(started.streamed, "a start that waits holds as a wait does");
    let fresh = world.child_when_started(&parent, "fresh").await;
    fresh.report("done", "fresh words").await.done();
    let answered = started.called().await;
    assert!(
        answered.text().starts_with("Started fresh."),
        "{answered:?}"
    );
    let body = answered.done();
    assert_eq!(body["name"], "fresh");
    let heard = Heard(body);
    assert_eq!(heard.events(), ["fresh:report"], "{heard:?}");
    // The other child's news stays for the next wait.
    let rest = parent.hear(json!({})).await;
    assert_eq!(rest.events(), ["old:report"], "{rest:?}");
    assert_eq!(rest.news()[0]["text"], "old news");

    // From the shell, the same: the command prints the name and the news.
    let (ran, ()) = tokio::join!(
        world.shell(
            &parent,
            "floti agent start --task go --name shelled --backend other-agent --wait --json"
        ),
        async {
            let shelled = world.child_when_started(&parent, "shelled").await;
            shelled.report("done", "from the shell").await.done();
        }
    );
    assert_eq!(ran.code, Some(0), "{ran:?}");
    let answer: Value = serde_json::from_str(ran.stdout.trim()).expect("JSON");
    assert_eq!(answer["name"], "shelled", "{answer}");
    assert_eq!(answer["news"][0]["text"], "from the shell", "{answer}");

    // Where a wait cannot hold: at once, with nothing new yet, and the other
    // children's news stays unseen.
    let plain = world.session(OTHER, &folder, "plain parent").await;
    plain
        .start(json!({ "task": "old work", "name": "old", "backend": OTHER }))
        .await
        .done();
    let old = world.child_of(&plain, "old").await;
    old.report("note", "kept for later").await.done();
    let mut started = plain
        .open(
            "agents_start",
            json!({ "task": "go", "name": "fresh", "backend": OTHER, "wait": true }),
        )
        .await;
    assert!(!started.streamed);
    let answered = started.called().await;
    assert!(answered.text().contains("Nothing new yet."), "{answered:?}");
    let body = answered.done();
    assert_eq!(body["name"], "fresh");
    assert_eq!(Heard(body).ended(), "nothingNew");
    let ran = world
        .shell(
            &plain,
            "floti agent start --task go --name shelled --backend other-agent --wait --json",
        )
        .await;
    assert_eq!(ran.code, Some(0), "{ran:?}");
    let answer: Value = serde_json::from_str(ran.stdout.trim()).expect("JSON");
    assert_eq!(answer["name"], "shelled", "{answer}");
    assert_eq!(answer["ended"], "nothingNew", "{answer}");
    let rest = plain.hear(json!({})).await;
    assert_eq!(rest.events(), ["old:report"], "{rest:?}");
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// A send that refuses, and a send that waits
// ---------------------------------------------------------------------------

impl Agent {
    async fn send(&self, child: &str, text: &str) -> Called {
        self.call("agents_send", json!({ "child": child, "text": text }))
            .await
    }
}

impl World {
    /// Nothing of `text` reached `child`'s terminal: it took no such line and
    /// no paste held it.
    fn assert_untyped(&self, child: &Agent, text: &str) {
        let run = self.reread(child);
        assert!(
            !run.received.iter().any(|line| line.contains(text)),
            "{} took {text:?}: {:?}",
            child.name(),
            run.received
        );
        assert!(
            !run.pastes.iter().any(|paste| paste.contains(text)),
            "{} was pasted {text:?}: {:?}",
            child.name(),
            run.pastes
        );
    }

    /// Waits until `child` has taken `line`.
    async fn took(&self, child: &Agent, line: &str) {
        eventually("the child to take the line", async || {
            self.reread(child)
                .received
                .iter()
                .any(|got| got == line)
                .then_some(())
        })
        .await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_send_to_a_child_waiting_on_a_prompt_is_refused_typing_nothing_and_goes_through_once_it_is_answered()
 {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("send-prompt");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    // One child whose agent keeps records, one that only reports its status.
    for (name, backend) in [("records", CLAUDE), ("reporter", BARE)] {
        parent
            .start(json!({ "task": "work", "name": name, "backend": backend }))
            .await
            .done();
    }
    world.calm(&parent, &["records"]).await;
    for name in ["records", "reporter"] {
        let child = world.child_of(&parent, name).await;
        let mut watch = Watch::open(&world).await;
        // The parent's own send brings the child to a permission prompt: no
        // person has typed there.
        parent.send(name, "/wait").await.done();
        watch.until(&child, SessionActivity::Waiting).await;

        let refused = parent.send(name, "ignored while asking").await;
        assert!(
            refused
                .refused()
                .contains("waiting on a prompt a person must answer"),
            "{name}: {refused:?}"
        );
        assert!(
            refused.refused().contains("nothing was typed"),
            "{name}: {refused:?}"
        );
        world.assert_untyped(&child, "ignored while asking");

        // A person answers the prompt; the child is at rest and takes a send.
        let mut client = world.client().await;
        client.attach(1, child.id()).await;
        client.type_into(1, b"y").await;
        watch.until(&child, SessionActivity::Idle).await;
        parent.send(name, "after the prompt").await.done();
        world.took(&child, "after the prompt").await;
        drop(client);
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s5_a_send_after_a_person_typed_is_refused_typing_nothing_until_the_childs_next_turn_ends()
{
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("send-person");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    for (name, backend) in [("records", CLAUDE), ("reporter", BARE)] {
        parent
            .start(json!({ "task": "work", "name": name, "backend": backend }))
            .await
            .done();
    }
    world.calm(&parent, &["records"]).await;
    for name in ["records", "reporter"] {
        let child = world.child_of(&parent, name).await;
        // A person starts a turn in the child's terminal.
        let mut watch = world.hold_busy(&child).await;
        let refused = parent.send(name, "ignored after a person").await;
        assert!(
            refused.refused().contains("A person has typed in"),
            "{name}: {refused:?}"
        );
        assert!(
            refused.refused().contains("nothing was typed"),
            "{name}: {refused:?}"
        );
        world.assert_untyped(&child, "ignored after a person");

        // The turn ends: what the person typed is spent.
        world.release(&child).await;
        watch.until(&child, SessionActivity::Idle).await;
        parent.send(name, "after the turn").await.done();
        world.took(&child, "after the turn").await;
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_send_right_after_a_prompt_appears_in_the_childs_records_is_refused_without_waiting_for_a_pass()
 {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("send-fresh-prompt");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "records", "backend": CLAUDE }))
        .await
        .done();
    world.calm(&parent, &["records"]).await;
    let child = world.child_of(&parent, "records").await;

    // The child reaches a permission prompt, which only its records say, and
    // the next send comes at once, not after a published pass.
    parent.send("records", "/wait").await.done();
    world.took(&child, "/wait").await;
    let refused = parent.send("records", "typed into the prompt").await;
    assert!(
        refused
            .refused()
            .contains("waiting on a prompt a person must answer"),
        "{refused:?}"
    );
    world.assert_untyped(&child, "typed into the prompt");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_send_goes_through_after_a_person_typed_a_line_whose_turn_was_over_before_any_pass_saw_it()
 {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("send-quick-turn");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    for (name, backend) in [("records", CLAUDE), ("reporter", BARE)] {
        parent
            .start(json!({ "task": "work", "name": name, "backend": backend }))
            .await
            .done();
    }
    world.calm(&parent, &["records"]).await;
    for name in ["records", "reporter"] {
        let child = world.child_of(&parent, name).await;
        // A turn of a millisecond: busy and idle again within one read of its
        // records, and within one of its reports.
        world.type_line(&child, "/busy 1").await;
        eventually(
            "a send to go through once the person's turn is over",
            async || (!parent.send(name, "after the quick turn").await.failed).then_some(()),
        )
        .await;
        world.took(&child, "after the quick turn").await;
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s12_a_send_with_wait_returns_that_childs_next_news_where_a_wait_holds_and_leaves_the_rest_unseen()
 {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("send-wait");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    for (name, backend) in [("target", CLAUDE), ("bystander", CLAUDE)] {
        parent
            .start(json!({ "task": "work", "name": name, "backend": backend }))
            .await
            .done();
    }
    let target = world.child_of(&parent, "target").await;
    let bystander = world.child_of(&parent, "bystander").await;
    world.calm(&parent, &["target", "bystander"]).await;

    // The target reports: that is the news, and the bystander's stays.
    bystander.report("note", "bystander news").await.done();
    let mut sent = parent
        .open(
            "agents_send",
            json!({ "child": "target", "text": "do the thing", "wait": true }),
        )
        .await;
    assert!(sent.streamed, "a send that waits holds as a wait does");
    world.took(&target, "do the thing").await;
    target.report("done", "the thing is done").await.done();
    let answered = sent.called().await;
    assert!(
        answered.text().starts_with("Sent to target."),
        "{answered:?}"
    );
    let body = answered.done();
    assert_eq!(body["sent"], "target");
    let heard = Heard(body);
    assert_eq!(heard.events(), ["target:report"], "{heard:?}");
    let rest = parent.hear(json!({})).await;
    assert_eq!(rest.events(), ["bystander:report"], "{rest:?}");

    // The turn it gave ends: that is the news.
    world.calm(&parent, &["target", "bystander"]).await;
    let mut sent = parent
        .open(
            "agents_send",
            json!({ "child": "target", "text": "/busy 2000", "wait": true }),
        )
        .await;
    assert!(sent.streamed);
    let heard = Heard(sent.called().await.done());
    assert_eq!(heard.events(), ["target:turn_ended"], "{heard:?}");

    // It asks for a permission: that is the news.
    world.calm(&parent, &["target", "bystander"]).await;
    let mut sent = parent
        .open(
            "agents_send",
            json!({ "child": "target", "text": "/wait", "wait": true }),
        )
        .await;
    let heard = Heard(sent.called().await.done());
    assert_eq!(heard.events(), ["target:needs_you"], "{heard:?}");
    assert_eq!(heard.news()[0]["state"], "permission prompt");

    // A person answers it, and the child ends on the text it is sent next.
    let mut watch = Watch::open(&world).await;
    let mut client = world.client().await;
    client.attach(1, target.id()).await;
    client.type_into(1, b"y").await;
    watch.until(&target, SessionActivity::Idle).await;
    drop(client);
    world.calm(&parent, &["target", "bystander"]).await;
    let mut sent = parent
        .open(
            "agents_send",
            json!({ "child": "target", "text": "/exit", "wait": true }),
        )
        .await;
    let heard = Heard(sent.called().await.done());
    assert_eq!(heard.events(), ["target:ended"], "{heard:?}");
    world.ended("the target to exit", &[target.id()]).await;

    // To a child that has ended the send is refused, and no wait begins.
    let refused = parent
        .call(
            "agents_send",
            json!({ "child": "target", "text": "again", "wait": true }),
        )
        .await;
    assert!(
        refused.refused().contains("target has ended"),
        "{refused:?}"
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s12_a_person_typing_in_the_parent_ends_a_sends_held_wait_and_the_text_was_sent() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("send-wait-typed");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "target", "backend": CLAUDE }))
        .await
        .done();
    let target = world.child_of(&parent, "target").await;
    world.calm(&parent, &["target"]).await;
    let mut sent = parent
        .open(
            "agents_send",
            json!({ "child": "target", "text": "go on", "wait": true }),
        )
        .await;
    assert!(sent.streamed);
    world.took(&target, "go on").await;
    world.type_line(&parent, "hello").await;
    let heard = Heard(sent.called().await.done());
    assert_eq!(heard.ended(), "typed", "{heard:?}");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s12_where_a_wait_cannot_hold_a_send_with_wait_answers_at_once_with_that_childs_unseen_news()
 {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("send-wait-at-once");
    let parent = world.session(OTHER, &folder, "plain parent").await;
    for name in ["target", "bystander"] {
        parent
            .start(json!({ "task": "work", "name": name, "backend": OTHER }))
            .await
            .done();
    }
    let target = world.child_of(&parent, "target").await;
    let bystander = world.child_of(&parent, "bystander").await;

    // Nothing of the target's is unseen: the send answers at once, saying so.
    bystander.report("note", "kept for later").await.done();
    let mut sent = parent
        .open(
            "agents_send",
            json!({ "child": "target", "text": "go", "wait": true }),
        )
        .await;
    assert!(
        !sent.streamed,
        "this parent's agent cannot wait in the background"
    );
    let answered = sent.called().await;
    assert!(
        answered.text().starts_with("Sent to target."),
        "{answered:?}"
    );
    assert!(answered.text().contains("Nothing new yet."), "{answered:?}");
    assert_eq!(Heard(answered.done()).ended(), "nothingNew");
    world.took(&target, "go").await;

    // With the target's news unseen it comes with the send, and only it.
    target.report("done", "target words").await.done();
    let mut sent = parent
        .open(
            "agents_send",
            json!({ "child": "target", "text": "more", "wait": true }),
        )
        .await;
    let heard = Heard(sent.called().await.done());
    assert_eq!(heard.events(), ["target:report"], "{heard:?}");
    let rest = parent.hear(json!({})).await;
    assert_eq!(rest.events(), ["bystander:report"], "{rest:?}");

    // From the shell the same: the command prints the child and its news.
    target.report("done", "from the shell").await.done();
    let ran = world
        .shell(
            &parent,
            "floti agent send --wait --json target \"and again\"",
        )
        .await;
    assert_eq!(ran.code, Some(0), "{ran:?}");
    let answer: Value = serde_json::from_str(ran.stdout.trim()).expect("JSON");
    assert_eq!(answer["sent"], "target", "{answer}");
    assert_eq!(answer["news"][0]["text"], "from the shell", "{answer}");
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// A host that restarts
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s24_a_host_restart_cuts_a_held_wait_off_and_the_next_wait_returns_its_news() {
    let world = World::new();
    let first = world.host().await;
    let folder = world.project("cut-off");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "worker", "backend": CLAUDE }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;
    world.calm(&parent, &["worker"]).await;

    // The child is working and has told its parent something; a wait for all
    // holds with it.
    let _watch = world.hold_busy(&worker).await;
    worker.report("note", "before the restart").await.done();
    let mut held = parent
        .open(
            "agents_wait",
            json!({ "for": "all", "children": ["worker"] }),
        )
        .await;
    assert!(held.streamed);
    first.crash().await;
    // Cut off means no answer reached the caller. Whether its connection is
    // reset or closed without a result depends on which of the dying runtime's
    // tasks is dropped first, so how it ends is not asserted.
    assert!(held.answer().await.is_none(), "the wait is cut off");
    assert_eq!(world.unseen(), 1, "{}", world.inbox_text());

    let second = world.host().await;
    let heard = parent.hear(json!({})).await;
    assert_eq!(heard.of("report").len(), 1, "{heard:?}");
    assert_eq!(heard.of("report")[0]["text"], "before the restart");
    second.stop(HostStopReason::Stop).await;
}
