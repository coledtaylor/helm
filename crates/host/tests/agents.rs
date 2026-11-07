//! Agents that start, list and stop their own children on the host: a host
//! whose sessions run the fake `claude` (`test/fake-agents/claude-code.mjs`)
//! and the other fake agent (`test/fake-agents/other-agent.mjs`), never a real
//! agent. A session's agent tools are called over HTTP with the URL and bearer
//! token the session itself was given, and `floti agent` is run from a
//! session's own shell, so nothing here is more than the session could do.
//!
//! No client is attached while a session works: a client starts the session
//! and goes, and comes back only to type into a session or to quit.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use floti_host::agent::claude_code::{ClaudeCodeBackend, ClaudeCodeSettings};
use floti_host::agent::{AgentBackend, PlainCommandBackend};
use floti_host::agent_cli::{
    self, Command as Subcommand, ReadScreen as ReadCommand, Run as RunCommand,
    SendText as SendCommand, Start as StartCommand, Stop as StopCommand,
};
use floti_host::platform::links::{FolderLinks, Native as NativeLinks};
use floti_host::platform::process_tree::{Native as NativeTree, ProcessTree};
use floti_host::platform::socket::Endpoint;
use floti_host::roles::{FixedRoles, Role, RoleClass, RoleSource};
use floti_host::server::HostConfig;
use floti_host::testkit::{
    GitRepo, OtherAgent, OtherAgentRecord, PATIENCE, RunningHost, ShellRun, TestClient, TestDirs,
    link_folder,
};
use floti_protocol::channel::EventChannel;
use floti_protocol::channels::common::{PermissionMode, SessionRecord};
use floti_protocol::channels::host::{HostQuit, HostQuitRequest, HostStopReason};
use floti_protocol::channels::sessions::{
    CloseSessionRequest, HistoryRefresh, HistoryResume, ResumeSessionRequest, SessionClose,
    SessionExit, SessionList, SessionStart, StartSessionRequest,
};
use floti_protocol::channels::workspace::{HostSettingsPatch, WriteSettings};
use floti_protocol::{BackendId, Knowable};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const TERMINAL: &[&str] = &["terminal"];

/// The two backends the host has, by id: the fake `claude` and the other fake.
const CLAUDE: &str = "claude-code";
const OTHER: &str = "other-agent";

/// The agents family, as a session's tool file names it.
const FAMILY: &str = "floti-agents";

// ---------------------------------------------------------------------------
// The roles the host is given
// ---------------------------------------------------------------------------

fn roles() -> Vec<Role> {
    let mut builder = Role::new("builder", [BackendId::new(CLAUDE)]);
    builder.permission = Some(PermissionMode::BypassPermissions);
    // One backend the host lacks, then one it has.
    let reviewer = Role::new(
        "reviewer",
        [BackendId::new("missing-agent"), BackendId::new(OTHER)],
    );
    // Rules the other fake cannot enforce.
    let mut locked = Role::new("locked", [BackendId::new(OTHER)]);
    locked.disallowed_tools = vec!["Bash(rm:*)".to_owned()];
    let mut automatic = Role::new("automatic", [BackendId::new(OTHER)]);
    automatic.permission = Some(PermissionMode::Auto);
    let mut reader = Role::new("reader", [BackendId::new(OTHER)]);
    reader.allowed_tools = vec!["WebFetch".to_owned()];
    // A rule the user denies, which stays denied beside what is allowed.
    let mut careful = Role::new("careful", [BackendId::new(CLAUDE)]);
    careful.disallowed_tools = vec!["Bash(floti agent stop:*)".to_owned()];
    // A body its backends are given as instructions on every launch.
    let mut briefed = Role::new("briefed", [BackendId::new(CLAUDE), BackendId::new(OTHER)]);
    briefed.instructions = "Answer in one line.".to_owned();
    // Roles for work that holds the host's heavy slot.
    let mut emulator = Role::new("emulator", [BackendId::new(CLAUDE)]);
    emulator.class = RoleClass::Heavy;
    let mut suite = Role::new("suite", [BackendId::new(CLAUDE), BackendId::new(OTHER)]);
    suite.class = RoleClass::Heavy;
    vec![
        builder, reviewer, locked, automatic, reader, careful, briefed, emulator, suite,
    ]
}

// ---------------------------------------------------------------------------
// A host with two backends
// ---------------------------------------------------------------------------

/// A host on the fake `claude` and the other fake, with a workspace profile
/// whose folder holds the projects the tests start sessions in.
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

    /// The host's configuration with `extra` backends after the two fakes.
    fn config_with(&self, extra: Vec<Arc<dyn AgentBackend>>) -> HostConfig {
        let claude = ClaudeCodeSettings {
            search_first: Vec::new(),
            program: "node".into(),
            leading_args: vec![fake_claude().into_os_string()],
            config_dir: self.claude.clone(),
            pass_config_dir: true,
            api_key_set: false,
        };
        let mut backends: Vec<Arc<dyn AgentBackend>> = vec![
            Arc::new(ClaudeCodeBackend::new(claude, Arc::new(NativeTree))),
            Arc::new(self.other.backend()),
        ];
        backends.extend(extra);
        HostConfig {
            run: Default::default(),
            folders: self.dirs.folders(),
            endpoint: self.endpoint.clone(),
            backends,
            inherited_env: std::env::vars_os()
                .filter(|(key, _)| {
                    !["SHELL", "HOME", "USERPROFILE"].contains(&&*key.to_string_lossy())
                })
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
                ])
                .collect(),
        }
    }

    /// A host that serves once this returns, with the roles above, and the
    /// workspace tracked.
    async fn host(&self) -> RunningHost {
        self.host_with(Vec::new()).await
    }

    /// As [`Self::host`], with `extra` backends after the two fakes.
    async fn host_with(&self, extra: Vec<Arc<dyn AgentBackend>>) -> RunningHost {
        let source: Arc<dyn RoleSource> = Arc::new(FixedRoles(roles()));
        let (host, ()) =
            RunningHost::start_with(self.config_with(extra), move |host| host.use_roles(source));
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
            self.profile("workspace", &self.work, None, None);
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

    /// A folder outside everything Floti tracks.
    fn outside(&self, name: &str) -> PathBuf {
        resolved(&self.dirs.folder(name))
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
    fn profile(&self, name: &str, root: &Path, mode: Option<&str>, agents: Option<bool>) -> u64 {
        let db = self.db();
        db.execute(
            "INSERT INTO profiles (name, root, overlays, access, model, effort, permission_mode, \
             agent, opening_prompt, session_agents) \
             VALUES (?1, ?2, '[]', '[]', NULL, NULL, ?3, NULL, NULL, ?4)",
            rusqlite::params![name, text(root), mode, agents],
        )
        .expect("insert a profile");
        u64::try_from(db.last_insert_rowid()).unwrap()
    }

    // -- sessions -----------------------------------------------------------

    /// A session on `backend` in `folder`, started by a client that is gone
    /// once the session is.
    async fn session(&self, backend: &str, folder: &Path, name: &str) -> Agent {
        self.session_as(request(folder, name, backend)).await
    }

    async fn session_as(&self, request: StartSessionRequest) -> Agent {
        let mut client = self.client().await;
        let record = client
            .request::<SessionStart>(&request)
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

    /// The newest row `parent` started under `name`: a resume adds a row
    /// under the same name.
    fn newest_child_id(&self, parent: u64, name: &str) -> Option<u64> {
        self.db()
            .query_row(
                "SELECT id FROM sessions WHERE parent_session_id = ?1 AND child_name = ?2 \
                 ORDER BY id DESC LIMIT 1",
                rusqlite::params![i64::try_from(parent).unwrap(), name],
                |row| row.get::<_, i64>(0),
            )
            .ok()
            .and_then(|id| u64::try_from(id).ok())
    }

    /// What column `column` of session `id`'s row holds, as text.
    fn row_text(&self, id: u64, column: &str) -> Option<String> {
        self.db()
            .query_row(
                &format!("SELECT CAST({column} AS TEXT) FROM sessions WHERE id = ?1"),
                [i64::try_from(id).unwrap()],
                |row| row.get(0),
            )
            .unwrap_or_else(|err| panic!("read {column} of session {id}: {err}"))
    }

    /// A child of `parent` that has said something, so its conversation is on
    /// record, and has then been stopped and is gone. `arguments` start it and
    /// name it.
    async fn ended_child(&self, parent: &Agent, arguments: Value) -> Agent {
        let name = arguments["name"].as_str().expect("a name").to_owned();
        parent.start(arguments).await.done();
        let child = self.child_of(parent, &name).await;
        self.type_line(&child, "remember this").await;
        parent.stop(&name).await.done();
        self.ended("the child to end", &[child.id()]).await;
        self.gone("its process to end", &[&child]).await;
        child
    }

    /// The run `parent` has under `name` now, which is not `before`'s.
    async fn resumed(&self, parent: &Agent, name: &str, before: &Agent) -> Agent {
        let id = self
            .newest_child_id(parent.id(), name)
            .unwrap_or_else(|| panic!("{} has no child named {name}", parent.name()));
        assert_ne!(id, before.id(), "a resume is a row of its own");
        let record = self.record(id).await;
        self.agent_after(record, &[before.run.pid]).await
    }

    /// Every session the host has a row for.
    async fn sessions(&self) -> Vec<SessionRecord> {
        let mut client = self.client().await;
        client
            .request::<SessionList>(&())
            .await
            .expect("the sessions are listed")
    }

    async fn record(&self, id: u64) -> SessionRecord {
        self.sessions()
            .await
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

    fn mode_of(&self, id: u64) -> Option<String> {
        self.db()
            .query_row(
                "SELECT permission_mode FROM sessions WHERE id = ?1",
                [i64::try_from(id).unwrap()],
                |row| row.get(0),
            )
            .expect("read a session's mode")
    }

    /// Every row's id, status and place in a chain, as one text: what a call
    /// that reached a session it was not to would have changed.
    fn fingerprint(&self) -> String {
        let db = self.db();
        let mut select = db
            .prepare(
                "SELECT id, status, coalesce(child_name, ''), coalesce(parent_session_id, 0) \
                 FROM sessions ORDER BY id",
            )
            .expect("prepare");
        select
            .query_map([], |row| {
                Ok(format!(
                    "{}:{}:{}:{}",
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?
                ))
            })
            .expect("query")
            .map(|row| row.expect("a row"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// How many rows were started by an agent tool.
    fn children_made(&self) -> i64 {
        self.db()
            .query_row(
                "SELECT count(*) FROM sessions WHERE child_name IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("count the children")
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

    /// Waits until every process of `agents` is gone.
    async fn gone(&self, what: &str, agents: &[&Agent]) {
        eventually(what, async || {
            agents
                .iter()
                .all(|agent| !alive(agent.run.pid))
                .then_some(())
        })
        .await;
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
                serde_json::from_slice(&std::fs::read(path).ok()?).ok()
            })
            .collect()
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

    /// Every run of either fake: one more than before means a process started.
    fn run_count(&self) -> usize {
        self.claude_logs().len() + self.other.records().len()
    }

    // -- a client at work ----------------------------------------------------

    async fn settings(&self, patch: HostSettingsPatch) {
        let mut client = self.client().await;
        client
            .request::<WriteSettings>(&patch)
            .await
            .expect("the settings are written");
    }

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

    /// A client quits, and the sessions its device started end with it when
    /// `end` says so.
    async fn quit(&self, end: bool) {
        let mut client = self.client().await;
        client
            .request::<HostQuit>(&HostQuitRequest { end })
            .await
            .expect("the quit is taken");
    }

    /// Types `line` at `agent`'s prompt and waits until it took it.
    async fn type_line(&self, agent: &Agent, line: &str) {
        // A line typed before is taken again only when it is counted again.
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
            &format!("the shell command {command:?} to finish"),
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
}

fn request(folder: &Path, name: &str, backend: &str) -> StartSessionRequest {
    StartSessionRequest {
        cwd: text(folder),
        cols: 80,
        rows: 24,
        name: Some(name.to_owned()),
        backend: Some(BackendId::new(backend)),
        ..StartSessionRequest::default()
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
    opening_prompt: Option<String>,
    /// Whether it reopened a conversation.
    resumed: bool,
    /// The instructions it was given to add to its own, when it was given any.
    instructions: Option<String>,
    /// The tool servers it loaded, by name: URL and bearer token.
    servers: BTreeMap<String, (String, String)>,
    received: Vec<String>,
    shell: Vec<ShellRun>,
    /// Each bracketed paste it took as one block: the text, and whether the
    /// submit key arrived in the same read.
    pastes: Vec<(String, bool)>,
    /// The key that submitted each of `received`.
    submit_keys: Vec<String>,
    /// Each line it took as a turn, in the order the turns ran.
    prompts: Vec<String>,
    /// Each line typed while a turn was running.
    queued: Vec<String>,
    /// How many times its stop key ended a turn.
    interrupts: u64,
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
            opening_prompt: log["openingPrompt"].as_str().map(str::to_owned),
            resumed: log["resumed"].as_bool().unwrap_or(false),
            instructions: log["composedInstructions"].as_str().map(str::to_owned),
            servers,
            received: strings(&log["received"]),
            shell: serde_json::from_value(log["shell"].clone()).unwrap_or_default(),
            pastes: log["pastes"]
                .as_array()
                .map(|pastes| {
                    pastes
                        .iter()
                        .map(|paste| {
                            (
                                paste["text"].as_str().unwrap_or_default().to_owned(),
                                paste["withSubmit"].as_bool().unwrap_or(false),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default(),
            submit_keys: strings(&log["submitKeys"]),
            prompts: strings(&log["prompts"]),
            queued: strings(&log["queued"]),
            interrupts: log["interrupts"].as_u64().unwrap_or(0),
        }
    }

    fn of_other(record: &OtherAgentRecord) -> Self {
        Self {
            pid: record.pid,
            argv: record.argv.clone(),
            opening_prompt: record.opening_prompt.clone(),
            resumed: record.resumed,
            instructions: record.instructions.clone(),
            servers: record
                .mcp_servers
                .iter()
                .map(|(name, server)| (name.clone(), (server.url.clone(), server.bearer.clone())))
                .collect(),
            received: record.received.clone(),
            shell: record.shell.clone(),
            pastes: record
                .pastes
                .iter()
                .map(|paste| (paste.text.clone(), paste.with_submit))
                .collect(),
            submit_keys: record.submit_keys.clone(),
            prompts: record.prompts.clone(),
            queued: record.queued.clone(),
            interrupts: u64::from(record.interrupts),
        }
    }

    /// The tools and commands its argv lets it use without asking.
    fn allowed(&self) -> Vec<String> {
        let mut allowed = values_after(&self.argv, "--allowedTools");
        allowed.extend(every_value_of(&self.argv, "--allow-tool"));
        allowed.extend(every_value_of(&self.argv, "--allow-shell"));
        allowed
    }

    /// The tools its argv never lets it use.
    fn disallowed(&self) -> Vec<String> {
        values_after(&self.argv, "--disallowedTools")
    }

    /// The tool servers it was given, sorted.
    fn server_names(&self) -> Vec<String> {
        self.servers.keys().cloned().collect()
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

impl Agent {
    fn id(&self) -> u64 {
        self.record.id
    }

    fn name(&self) -> &str {
        &self.record.name
    }

    /// The agents family's URL and the session's token. A session without the
    /// family has the route all the same, at the address of its other tools,
    /// and only its token to try there.
    fn route(&self) -> (String, String) {
        if let Some((url, token)) = self.run.servers.get(FAMILY) {
            return (url.clone(), token.clone());
        }
        let (url, token) = self
            .run
            .servers
            .values()
            .next()
            .expect("the session was given some tool server");
        let (base, _) = url.rsplit_once("/mcp").expect("a route");
        (format!("{base}/mcp/agents"), token.clone())
    }

    /// The HTTP status of `method` at the agents route with this token.
    async fn status_of(&self, method: &str) -> u16 {
        let (url, token) = self.route();
        rpc(&url, Some(&token), method, json!({})).await.status
    }

    async fn call(&self, tool: &str, arguments: Value) -> Called {
        let (url, token) = self.route();
        called(&url, &token, tool, arguments).await
    }

    async fn start(&self, arguments: Value) -> Called {
        self.call("agents_start", arguments).await
    }

    async fn list(&self) -> Called {
        self.call("agents_list", json!({})).await
    }

    async fn stop(&self, child: &str) -> Called {
        self.call("agents_stop", json!({ "child": child })).await
    }

    /// The names of its running children, as `agents_list` shows them.
    async fn children(&self) -> Vec<String> {
        self.list().await.done()["children"]
            .as_array()
            .expect("a list")
            .iter()
            .map(|child| child["name"].as_str().expect("a name").to_owned())
            .collect()
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

fn same_folder(a: &Path, b: &Path) -> bool {
    a == b || resolved(a) == resolved(b)
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

/// The argument after the first `flag`.
fn value_of<'a>(argv: &'a [String], flag: &str) -> Option<&'a str> {
    argv.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].as_str())
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
    fn result(&self) -> Value {
        assert_eq!(self.status, 200, "{self:?}");
        // A call that may wait answers as an event stream: one `data:` line
        // holds the JSON-RPC answer.
        let text = String::from_utf8_lossy(&self.body);
        let json = text
            .lines()
            .rev()
            .find_map(|line| line.strip_prefix("data:"))
            .map_or(text.as_ref(), str::trim);
        let answer: Value =
            serde_json::from_str(json).unwrap_or_else(|err| panic!("{err}: {text}"));
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

/// One POST of `body` to `url`, carrying `token` when there is one.
async fn post(url: &str, token: Option<&str>, body: &Value) -> Reply {
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
    head.push_str("\r\n");
    tokio::time::timeout(PATIENCE, async {
        let mut stream = TcpStream::connect(address).await.expect("connect");
        stream.write_all(head.as_bytes()).await.expect("send");
        stream.write_all(body.as_bytes()).await.expect("send");
        let mut answer = Vec::new();
        stream.read_to_end(&mut answer).await.expect("read");
        parse_reply(&answer)
    })
    .await
    .expect("an answer within the patience")
}

fn parse_reply(answer: &[u8]) -> Reply {
    let end = answer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("a head");
    let head = String::from_utf8_lossy(&answer[..end]).into_owned();
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|code| code.parse().ok())
        .expect("a status");
    let chunked = head.lines().any(|line| {
        line.to_ascii_lowercase()
            .starts_with("transfer-encoding: chunked")
    });
    let mut body = answer[end + 4..].to_vec();
    if chunked {
        let mut plain = Vec::new();
        let mut rest = body.as_slice();
        while let Some(at) = rest.windows(2).position(|window| window == b"\r\n") {
            let size = usize::from_str_radix(std::str::from_utf8(&rest[..at]).unwrap().trim(), 16)
                .expect("a chunk size");
            if size == 0 {
                break;
            }
            plain.extend_from_slice(&rest[at + 2..at + 2 + size]);
            rest = &rest[at + 2 + size + 2..];
        }
        body = plain;
    }
    Reply { status, body }
}

async fn rpc(url: &str, token: Option<&str>, method: &str, params: Value) -> Reply {
    post(
        url,
        token,
        &json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }),
    )
    .await
}

async fn called(url: &str, token: &str, tool: &str, arguments: Value) -> Called {
    let result = rpc(
        url,
        Some(token),
        "tools/call",
        json!({ "name": tool, "arguments": arguments }),
    )
    .await
    .result();
    Called {
        failed: result["isError"].as_bool().unwrap_or(false),
        blocks: result["content"]
            .as_array()
            .expect("content")
            .iter()
            .filter_map(|block| block["text"].as_str().map(str::to_owned))
            .collect(),
    }
}

/// `floti agent`'s own code, run against the agents route with a token, off
/// the test's runtime: it speaks blocking HTTP, as the program does.
async fn subcommand(command: Subcommand, url: String, token: String) -> agent_cli::Outcome {
    tokio::task::spawn_blocking(move || agent_cli::execute(&command, &url, &token))
        .await
        .expect("the subcommand ran")
}

fn cli_start(task: &str) -> StartCommand {
    StartCommand {
        task: task.to_owned(),
        ..StartCommand::default()
    }
}

fn cli_send(child: &str, text: &str, interrupt: bool) -> SendCommand {
    SendCommand {
        child: child.to_owned(),
        text: text.to_owned(),
        interrupt,
        wait: false,
        json: false,
    }
}

fn cli_stop(child: &str) -> StopCommand {
    StopCommand {
        child: child.to_owned(),
        json: false,
    }
}

// ---------------------------------------------------------------------------
// The family a session is given
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s1_a_session_on_either_backend_gets_a_floti_agents_entry_and_lists_its_seven_tools() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("alpha");

    for (backend, name) in [(CLAUDE, "one"), (OTHER, "two")] {
        let agent = world.session(backend, &folder, name).await;
        assert!(
            agent.run.server_names().contains(&FAMILY.to_owned()),
            "{backend}: {:?}",
            agent.run.server_names()
        );
        // A session a person started has no parent, so no `agents_report`.
        assert_eq!(
            agent.tool_names().await,
            [
                "agents_list",
                "agents_read",
                "agents_roles",
                "agents_send",
                "agents_start",
                "agents_stop",
                "agents_wait"
            ],
            "{backend}"
        );
        let (url, token) = agent.route();
        assert!(url.ends_with("/mcp/agents"), "{url}");
        let initialised = rpc(
            &url,
            Some(&token),
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "test", "version": "1" },
            }),
        )
        .await
        .result();
        assert_eq!(initialised["serverInfo"]["name"], FAMILY);
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s2_with_the_setting_off_or_the_profile_off_a_session_has_no_entry_no_tool_and_a_404_at_the_route()
 {
    let world = World::new();
    let host = world.host().await;
    let quiet_folder = world.project("quiet");
    let quiet = world.profile("quiet", &quiet_folder, None, Some(false));

    // The setting on, the profile off.
    for backend in [CLAUDE, OTHER] {
        let mut asked = request(&quiet_folder, &format!("quiet {backend}"), backend);
        asked.profile_id = Some(quiet);
        let agent = world.session_as(asked).await;
        assert!(
            !agent.run.server_names().contains(&FAMILY.to_owned()),
            "{backend}: {:?}",
            agent.run.server_names()
        );
        assert!(
            agent
                .run
                .allowed()
                .iter()
                .all(|rule| !rule.contains("floti")),
            "{backend}: {:?}",
            agent.run.allowed()
        );
        assert_eq!(agent.status_of("tools/list").await, 404, "{backend}");
        assert_eq!(agent.status_of("tools/call").await, 404, "{backend}");
    }

    // The profile off reaches a child too: it runs in that folder, under that
    // profile, and is given nothing.
    let parent = world.session(CLAUDE, &world.project("loud"), "loud").await;
    parent
        .start(json!({ "task": "work quietly", "folder": text(&quiet_folder), "name": "mouse" }))
        .await
        .done();
    let mouse = world.child_of(&parent, "mouse").await;
    assert!(!mouse.run.server_names().contains(&FAMILY.to_owned()));
    assert_eq!(mouse.status_of("tools/call").await, 404);

    // The setting off.
    world
        .settings(HostSettingsPatch {
            session_agents: Some(false),
            ..HostSettingsPatch::default()
        })
        .await;
    for backend in [CLAUDE, OTHER] {
        let agent = world
            .session(backend, &world.project("loud"), &format!("off {backend}"))
            .await;
        assert!(
            !agent.run.server_names().contains(&FAMILY.to_owned()),
            "{backend}: {:?}",
            agent.run.server_names()
        );
        assert_eq!(agent.status_of("tools/list").await, 404, "{backend}");
    }
    // A session that had the family loses its route at once, and has it back
    // with the setting.
    assert_eq!(parent.status_of("tools/list").await, 404);
    world
        .settings(HostSettingsPatch {
            session_agents: Some(true),
            ..HostSettingsPatch::default()
        })
        .await;
    assert_eq!(parent.status_of("tools/list").await, 200);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Starting a child
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_child_starts_in_its_parents_folder_with_the_task_as_its_prompt_under_the_profile_holding_it()
 {
    let world = World::new();
    let host = world.host().await;
    let inner_root = world.project("inner");
    let inner = world.profile("inner", &inner_root, None, None);
    let folder = resolved(&world.dirs.folder("workspace/inner/src"));

    for (parent_backend, child_backend) in [(CLAUDE, OTHER), (OTHER, CLAUDE)] {
        let parent = world
            .session(parent_backend, &folder, &format!("parent {parent_backend}"))
            .await;
        let task = format!("write the release notes for {child_backend}");
        let started = parent
            .start(json!({ "task": task, "backend": child_backend }))
            .await;
        let answer = started.done();
        assert_eq!(answer["name"], "agent", "{answer}");
        assert_eq!(answer["backend"], child_backend);
        assert!(started.text().starts_with("Started agent."), "{started:?}");
        assert!(same_folder(
            Path::new(answer["folder"].as_str().unwrap()),
            &folder
        ));

        let child = world.child_of(&parent, "agent").await;
        assert!(same_folder(Path::new(&child.record.cwd), &folder));
        assert_eq!(child.record.backend, BackendId::new(child_backend));
        assert_eq!(
            child.record.profile_id,
            Some(inner),
            "the profile holding it"
        );
        assert_eq!(child.record.parent_id, Some(parent.id()));
        assert_eq!(child.record.role.as_deref(), Some("agent"));
        assert_eq!(child.run.opening_prompt.as_deref(), Some(task.as_str()));
        assert!(child.run.argv.contains(&task), "{:?}", child.run.argv);

        // A second child of the same name is numbered.
        let again = parent.start(json!({ "task": "again" })).await.done();
        assert_eq!(again["name"], "agent-2");
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s5_a_folder_outside_everything_tracked_is_refused_by_name_by_dots_and_by_a_link_out() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("proj");
    let outside = world.outside("outside");
    let link = folder.join("escape");
    link_folder(&outside, &link);
    let parent = world.session(CLAUDE, &folder, "parent").await;
    let runs = world.run_count();

    let outside_text = text(&outside);
    let tries: [(&str, String); 6] = [
        ("named directly", outside_text.clone()),
        ("through ..", "../../outside".to_owned()),
        ("through a link", "escape".to_owned()),
        ("below a link", "escape/not-made-yet".to_owned()),
        ("through .. after a link", "escape/../proj".to_owned()),
        ("a link spelled absolute", text(&link)),
    ];
    for (how, folder_asked) in tries {
        let refused = parent
            .start(json!({ "task": "go there", "folder": folder_asked }))
            .await;
        assert!(
            refused.refused().contains("not a folder Floti tracks"),
            "{how}: {refused:?}"
        );
    }
    assert_eq!(world.children_made(), 0, "no session started");
    assert_eq!(world.run_count(), runs, "no process started");

    // A folder inside the project is tracked.
    resolved(&world.dirs.folder("workspace/proj/sub"));
    let started = parent
        .start(json!({ "task": "go there", "folder": "sub" }))
        .await
        .done();
    assert!(same_folder(
        Path::new(started["folder"].as_str().unwrap()),
        &folder.join("sub")
    ));

    // The link goes before the folders around it do.
    NativeLinks.unlink_folder(&link).expect("unlink");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s6_a_child_never_runs_with_more_permission_than_its_parent() {
    let world = World::new();
    let host = world.host().await;
    let bypassy = world.project("bypassy");
    world.profile("bypassy", &bypassy, Some("bypassPermissions"), None);
    let manual = world.project("manual");
    world.profile("manual", &manual, Some("manual"), None);
    let plain = world.project("plain");

    let in_mode = |folder: &Path, mode: PermissionMode, name: &str| {
        let mut asked = request(folder, name, CLAUDE);
        asked.permission_mode = Some(mode);
        asked
    };

    // A parent in plan: the role asks for bypass, and the child plans.
    let planner = world
        .session_as(in_mode(&plain, PermissionMode::Plan, "planner"))
        .await;
    planner
        .start(json!({ "task": "build", "role": "builder", "name": "by-role" }))
        .await
        .done();
    let by_role = world.child_of(&planner, "by-role").await;
    assert_eq!(world.mode_of(by_role.id()).as_deref(), Some("plan"));
    assert_eq!(
        value_of(&by_role.run.argv, "--permission-mode"),
        Some("plan")
    );

    // A parent in plan: the child's profile asks for bypass, and the child plans.
    let planner = world
        .session_as(in_mode(&bypassy, PermissionMode::Plan, "planner 2"))
        .await;
    planner
        .start(json!({ "task": "build", "name": "by-profile" }))
        .await
        .done();
    let by_profile = world.child_of(&planner, "by-profile").await;
    assert_eq!(world.mode_of(by_profile.id()).as_deref(), Some("plan"));

    // A parent in bypass whose child's profile says manual: manual.
    let bypasser = world
        .session_as(in_mode(
            &manual,
            PermissionMode::BypassPermissions,
            "bypasser",
        ))
        .await;
    bypasser
        .start(json!({ "task": "build", "name": "stricter" }))
        .await
        .done();
    let stricter = world.child_of(&bypasser, "stricter").await;
    assert_eq!(world.mode_of(stricter.id()).as_deref(), Some("manual"));
    assert_eq!(
        value_of(&stricter.run.argv, "--permission-mode"),
        Some("manual")
    );

    // A parent in bypass keeps what the role asks for: nothing is above it.
    bypasser
        .start(
            json!({ "task": "build", "role": "builder", "name": "equal", "folder": text(&plain) }),
        )
        .await
        .done();
    let equal = world.child_of(&bypasser, "equal").await;
    assert_eq!(
        world.mode_of(equal.id()).as_deref(),
        Some("bypassPermissions")
    );
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// A parent ends
// ---------------------------------------------------------------------------

/// A parent on the first backend, its child on the second with `can_start`,
/// and that child's own child on the first.
struct Chain {
    parent: Agent,
    child: Agent,
    grandchild: Agent,
}

async fn chain(world: &World, folder: &Path) -> Chain {
    let parent = world.session(CLAUDE, folder, "parent").await;
    parent
        .start(json!({ "task": "lead", "backend": OTHER, "can_start": true, "name": "middle" }))
        .await
        .done();
    let child = world.child_of(&parent, "middle").await;
    child
        .start(json!({ "task": "do the work", "backend": CLAUDE, "name": "leaf" }))
        .await
        .done();
    let grandchild = world.child_of(&child, "leaf").await;
    Chain {
        parent,
        child,
        grandchild,
    }
}

impl Chain {
    /// The child and grandchild end, processes included.
    async fn below_end(&self, world: &World) {
        world
            .ended(
                "the child and grandchild to end",
                &[self.child.id(), self.grandchild.id()],
            )
            .await;
        world
            .gone(
                "the child and grandchild processes to end",
                &[&self.child, &self.grandchild],
            )
            .await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn s7_when_a_parent_exits_on_its_own_its_child_and_grandchild_end_with_it() {
    let world = World::new();
    let host = world.host().await;
    let chain = chain(&world, &world.project("exit")).await;
    world.type_line(&chain.parent, "/exit").await;
    chain.below_end(&world).await;
    assert_ne!(world.status(chain.parent.id()), "running");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s7_when_a_parent_stops_a_child_the_agents_below_it_end_and_the_parent_runs_on() {
    let world = World::new();
    let host = world.host().await;
    let chain = chain(&world, &world.project("stop")).await;
    let stopped = chain.parent.stop("middle").await;
    let answer = stopped.done();
    assert_eq!(answer["stopped"], "middle");
    assert_eq!(answer["also"], json!(["leaf"]));
    assert!(stopped.text().contains("leaf"), "{stopped:?}");
    chain.below_end(&world).await;
    assert_eq!(world.status(chain.parent.id()), "running");
    assert!(chain.parent.children().await.is_empty());
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s7_when_floti_ends_a_parent_its_child_and_grandchild_end_with_it() {
    let world = World::new();
    let host = world.host().await;
    let chain = chain(&world, &world.project("end")).await;
    world.close(&chain.parent).await;
    chain.below_end(&world).await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s7_when_a_client_quits_ending_its_sessions_the_parents_child_and_grandchild_end_too() {
    let world = World::new();
    let host = world.host().await;
    let chain = chain(&world, &world.project("quit")).await;
    world.quit(true).await;
    world.ended("the parent to end", &[chain.parent.id()]).await;
    chain.below_end(&world).await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s8_an_outliving_child_runs_on_names_its_parent_and_is_the_resumed_parents_to_list_and_stop()
 {
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
        .start(json!({ "task": "short job", "name": "sibling" }))
        .await
        .done();
    let keeper = world.child_of(&parent, "keeper").await;
    let sibling = world.child_of(&parent, "sibling").await;
    let listed = parent.list().await.done();
    assert_eq!(listed["children"][0]["outlive"], true, "{listed}");

    world.type_line(&parent, "/exit").await;
    // The sibling ended with the parent: whatever was to end has ended.
    world
        .ended(
            "the parent and its sibling to end",
            &[parent.id(), sibling.id()],
        )
        .await;
    assert_eq!(world.status(keeper.id()), "running");
    assert!(alive(keeper.run.pid));
    assert_eq!(
        world.record(keeper.id()).await.parent_id,
        Some(parent.id()),
        "it still names its parent"
    );

    // The parent's conversation reopened in Floti.
    let conversation = parent.record.conversation_id.clone().unwrap();
    let mut client = world.client().await;
    client
        .request::<HistoryRefresh>(&())
        .await
        .expect("the history is read");
    let resumed = client
        .request::<HistoryResume>(&ResumeSessionRequest {
            session_id: conversation.clone(),
            cols: 80,
            rows: 24,
        })
        .await
        .expect("the conversation resumes");
    drop(client);
    assert_eq!(
        resumed.session.conversation_id.as_deref(),
        Some(conversation.as_str())
    );
    let again = world.agent_after(resumed.session, &[parent.run.pid]).await;
    assert_eq!(again.children().await, ["keeper"]);
    let stopped = again.stop("keeper").await;
    assert_eq!(stopped.done()["stopped"], "keeper");
    world.ended("the child to stop", &[keeper.id()]).await;
    world.gone("the child process to end", &[&keeper]).await;
    assert!(again.children().await.is_empty());
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s9_after_a_host_restart_that_takes_its_sessions_back_the_children_are_still_the_parents_and_end_with_it()
 {
    let world = World::new();
    let first = world.host().await;
    let chain = chain(&world, &world.project("restart")).await;
    first.crash().await;
    assert!(alive(chain.parent.run.pid), "the sessions outlive the host");

    let second = world.host().await;
    // The parent's token is answered by the next host, which knows its
    // children for its own.
    assert_eq!(chain.parent.children().await, ["middle"]);
    assert_eq!(chain.child.children().await, ["leaf"]);
    world.close(&chain.parent).await;
    chain.below_end(&world).await;
    second.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s10_a_fifth_child_is_refused_naming_the_limit_of_four_per_parent_and_the_children_that_hold_it()
 {
    let world = World::new();
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("limits"), "parent")
        .await;
    for number in 1..=4 {
        parent
            .start(json!({ "task": "work", "name": format!("kid{number}") }))
            .await
            .done();
    }
    let refused = parent.start(json!({ "task": "one too many" })).await;
    let sentence = refused.refused();
    assert!(
        sentence.contains("limit of 4 running agents per parent"),
        "{sentence}"
    );
    for number in 1..=4 {
        assert!(sentence.contains(&format!("kid{number}")), "{sentence}");
    }
    assert_eq!(world.children_made(), 4);
    // Stopping one makes room.
    parent.stop("kid1").await.done();
    parent
        .start(json!({ "task": "now there is room", "name": "kid5" }))
        .await
        .done();
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s11_the_host_holds_eight_agent_sessions_whoever_started_them_and_people_start_any_number()
{
    let world = World::new();
    let host = world.host().await;
    let a = world.session(CLAUDE, &world.project("a"), "a").await;
    let b = world.session(OTHER, &world.project("b"), "b").await;
    let c = world.session(CLAUDE, &world.project("c"), "c").await;
    for number in 1..=4 {
        a.start(json!({ "task": "work", "name": format!("a{number}") }))
            .await
            .done();
    }
    for number in 1..=3 {
        b.start(json!({ "task": "work", "name": format!("b{number}") }))
            .await
            .done();
    }
    // Seven agents and three sessions of people are running: only the agents
    // count, so the eighth starts.
    c.start(json!({ "task": "work", "name": "c1" }))
        .await
        .done();

    for (who, parent) in [("b", &b), ("c", &c)] {
        let refused = parent.start(json!({ "task": "one too many" })).await;
        let sentence = refused.refused();
        assert!(
            sentence.contains("limit of 8 agent sessions running on this host"),
            "{who}: {sentence}"
        );
        // It says what the caller holds, and none of what is another's.
        assert!(!sentence.contains("a1"), "{who}: {sentence}");
    }
    assert_eq!(world.children_made(), 8);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s12_a_child_without_can_start_and_any_grandchild_is_refused_naming_the_depth_limit_of_two()
{
    let world = World::new();
    let host = world.host().await;
    let top = world.session(CLAUDE, &world.project("deep"), "top").await;

    top.start(json!({ "task": "plain", "name": "plain" }))
        .await
        .done();
    let plain = world.child_of(&top, "plain").await;
    let refused = plain.start(json!({ "task": "deeper" })).await;
    let sentence = refused.refused();
    assert!(sentence.contains("depth limit of 2"), "{sentence}");
    assert!(sentence.contains("without can_start"), "{sentence}");

    top.start(json!({ "task": "lead", "name": "lead", "can_start": true, "backend": OTHER }))
        .await
        .done();
    let lead = world.child_of(&top, "lead").await;
    lead.start(json!({ "task": "leaf", "name": "leaf", "can_start": true }))
        .await
        .done();
    let leaf = world.child_of(&lead, "leaf").await;
    let refused = leaf.start(json!({ "task": "deeper still" })).await;
    let sentence = refused.refused();
    assert!(sentence.contains("depth limit of 2"), "{sentence}");
    assert!(sentence.contains("depth 2"), "{sentence}");
    let limits = leaf.list().await.done()["limits"].clone();
    assert!(limits["cannotStart"].is_string(), "{limits}");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s13_the_sixteenth_start_in_a_parents_life_is_the_last_with_none_running() {
    let world = World::new();
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("lifetime"), "parent")
        .await;
    // Fifteen starts that ended, and one made now and stopped.
    for number in 1..=15 {
        world.db().execute(
            "INSERT INTO sessions (name, cwd, argv, claude_session_id, backend, parent_session_id, \
             child_name, role, status) VALUES (?1, ?2, '[]', ?3, 'claude-code', ?4, ?1, 'agent', 'exited')",
            rusqlite::params![
                format!("old{number}"),
                text(&world.work),
                format!("old-conversation-{number}"),
                i64::try_from(parent.id()).unwrap(),
            ],
        )
        .expect("insert an exited child");
    }
    let listed = parent.list().await;
    assert!(
        listed.text().contains("1 of 16 starts"),
        "{}",
        listed.text()
    );
    parent
        .start(json!({ "task": "the sixteenth", "name": "last" }))
        .await
        .done();
    parent.stop("last").await.done();
    assert!(parent.children().await.is_empty(), "fewer than four run");

    let refused = parent.start(json!({ "task": "the seventeenth" })).await;
    let sentence = refused.refused();
    assert!(
        sentence.contains("limit of 16 starts per parent"),
        "{sentence}"
    );
    assert!(sentence.contains("16 starts"), "{sentence}");
    assert!(
        parent.list().await.text().contains("0 of 16 starts"),
        "the listing says none is left"
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s14_a_limit_told_to_the_host_applies_to_the_next_start() {
    let world = World::new();
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("settings"), "parent")
        .await;
    parent
        .start(json!({ "task": "one", "name": "one" }))
        .await
        .done();
    parent
        .start(json!({ "task": "two", "name": "two" }))
        .await
        .done();

    let limit = |children: u32| HostSettingsPatch {
        agent_children_per_parent: Some(children),
        ..HostSettingsPatch::default()
    };
    // Lowered under what runs: the next start is refused and nothing ends.
    world.settings(limit(2)).await;
    let refused = parent.start(json!({ "task": "three" })).await;
    assert!(
        refused.refused().contains("limit of 2 running agents"),
        "{refused:?}"
    );
    assert_eq!(parent.children().await, ["one", "two"]);

    // Raised: the next start goes through.
    world.settings(limit(3)).await;
    parent
        .start(json!({ "task": "three", "name": "three" }))
        .await
        .done();
    let refused = parent.start(json!({ "task": "four" })).await;
    assert!(
        refused.refused().contains("limit of 3 running agents"),
        "{refused:?}"
    );

    // The other limits are told the same way.
    world
        .settings(HostSettingsPatch {
            agent_starts_per_parent: Some(3),
            ..limit(8)
        })
        .await;
    let refused = parent.start(json!({ "task": "four" })).await;
    assert!(
        refused.refused().contains("limit of 3 starts per parent"),
        "{refused:?}"
    );
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Whose children
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s17_a_parent_lists_and_stops_only_its_own_children_and_any_other_name_is_not_found() {
    let world = World::new();
    let host = world.host().await;
    let a = world
        .session(CLAUDE, &world.project("alpha"), "alpha")
        .await;
    let b = world.session(OTHER, &world.project("bravo"), "bravo").await;
    a.start(json!({ "task": "work", "name": "a-first" }))
        .await
        .done();
    a.start(json!({ "task": "work", "name": "a-second" }))
        .await
        .done();
    b.start(json!({ "task": "work", "name": "b-first" }))
        .await
        .done();
    let a_first = world.child_of(&a, "a-first").await;
    let a_second = world.child_of(&a, "a-second").await;
    let b_first = world.child_of(&b, "b-first").await;

    assert_eq!(a.children().await, ["a-first", "a-second"]);
    assert_eq!(b.children().await, ["b-first"]);

    let everyone = [a.id(), b.id(), a_first.id(), a_second.id(), b_first.id()];
    let still_running = |who: &str| {
        for id in everyone {
            assert_eq!(world.status(id), "running", "{who} stopped {id}");
        }
    };
    let before = world.fingerprint();
    // A names B's child, its own name, and a person's... B's name.
    for target in ["b-first", "alpha", "bravo", "B-FIRST "] {
        let refused = a.stop(target).await;
        let sentence = refused.refused();
        if target.trim().eq_ignore_ascii_case("b-first") {
            assert!(
                sentence.contains("No agent of yours is named"),
                "{sentence}"
            );
            assert!(!sentence.contains("b-first, "), "{sentence}");
        }
        assert!(sentence.contains("a-first"), "it lists its own: {sentence}");
        still_running(&format!("a naming {target}"));
    }
    // A child names its parent and its sibling.
    for (child, target) in [
        (&a_first, "alpha"),
        (&a_first, "a-second"),
        (&a_second, "a-first"),
        (&a_first, "b-first"),
        (&b_first, "a-first"),
        (&b_first, "bravo"),
    ] {
        let refused = child.stop(target).await;
        assert!(
            refused.refused().contains("No agent of yours is named"),
            "{target}: {refused:?}"
        );
        still_running(&format!("{} naming {target}", child.name()));
    }
    assert_eq!(world.fingerprint(), before, "nothing changed");
    assert_eq!(a.children().await, ["a-first", "a-second"]);
    assert_eq!(b.children().await, ["b-first"]);

    // Its own it stops.
    a.stop("a-second").await.done();
    world.ended("a-second to end", &[a_second.id()]).await;
    assert_eq!(a.children().await, ["a-first"]);
    assert_eq!(world.status(b_first.id()), "running");
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// No client attached
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s22_with_no_client_attached_a_session_starts_lists_and_stops_children_and_a_later_keep_quit_ends_none()
 {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("alone");
    for (backend, other) in [(CLAUDE, OTHER), (OTHER, CLAUDE)] {
        // The client that started the session is gone: nothing is attached.
        let parent = world
            .session(backend, &folder, &format!("parent {backend}"))
            .await;
        parent
            .start(json!({ "task": "work", "name": "first", "backend": backend }))
            .await
            .done();
        parent
            .start(json!({ "task": "work", "name": "second", "backend": other }))
            .await
            .done();
        assert_eq!(parent.children().await, ["first", "second"]);
        let first = world.child_of(&parent, "first").await;
        let second = world.child_of(&parent, "second").await;
        parent.stop("first").await.done();
        world.ended("first to stop", &[first.id()]).await;
        assert_eq!(parent.children().await, ["second"]);

        // A client quits choosing to keep its sessions running: none ends.
        world.quit(false).await;
        assert_eq!(world.status(parent.id()), "running");
        assert_eq!(world.status(second.id()), "running");
        assert_eq!(parent.children().await, ["second"]);

        // And choosing to end them: the parent ends, and the child with it.
        world.quit(true).await;
        world
            .ended("the parent and child to end", &[parent.id(), second.id()])
            .await;
    }
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// How a session ended
// ---------------------------------------------------------------------------

/// A client listening for sessions to end, which reads each end's record as
/// the host sent it.
struct Ends(TestClient);

impl Ends {
    async fn listen(world: &World) -> Self {
        let mut client = world.client().await;
        client.subscribe_quietly(1, SessionExit::NAME).await;
        Self(client)
    }

    /// The record sent when session `id` ended.
    async fn of(&mut self, what: &str, id: u64) -> SessionRecord {
        self.0
            .event_on::<SessionRecord>(1, what, |row| row.id == id)
            .await
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_child_its_parent_or_the_user_stops_is_recorded_stopped_and_one_that_exits_by_itself_is_not()
 {
    let world = World::new();
    let host = world.host().await;
    let mut ends = Ends::listen(&world).await;
    let folder = world.project("how it ended");
    for backend in [CLAUDE, OTHER] {
        let parent = world
            .session(CLAUDE, &folder, &format!("parent of {backend}"))
            .await;
        for name in ["stopper", "ended", "finisher", "running"] {
            parent
                .start(json!({ "task": "work", "name": name, "backend": backend }))
                .await
                .done();
        }
        let stopper = world.child_of(&parent, "stopper").await;
        let ended = world.child_of(&parent, "ended").await;
        let finisher = world.child_of(&parent, "finisher").await;
        let running = world.child_of(&parent, "running").await;

        parent.stop("stopper").await.done();
        // Stop on the child's own card is a close the user forces.
        world.close(&ended).await;
        world.type_line(&finisher, "/exit").await;

        let stopped = ends.of("the stopped child to end", stopper.id()).await;
        assert!(stopped.stopped, "{backend}: stopped by its parent");
        let closed = ends
            .of("the child the user stopped to end", ended.id())
            .await;
        assert!(closed.stopped, "{backend}: stopped by the user");
        let finished = ends.of("the finished child to end", finisher.id()).await;
        assert!(
            !finished.stopped,
            "{backend}: a child whose agent exited by itself"
        );
        assert_eq!(world.status(running.id()), "running");
        assert!(
            !world.record(running.id()).await.stopped,
            "{backend}: a child still running"
        );

        world.close(&parent).await;
        let last = ends.of("the last child to end", running.id()).await;
        assert!(last.stopped, "{backend}: ended with its parent");
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_the_user_ends_or_whose_parent_ends_is_recorded_stopped_and_one_that_exits_by_itself_is_not()
 {
    let world = World::new();
    let host = world.host().await;
    let mut ends = Ends::listen(&world).await;
    for backend in [CLAUDE, OTHER] {
        // End, on the session itself.
        let ended = world.session(backend, &world.project("end"), "ended").await;
        world.close(&ended).await;
        let record = ends.of("the ended session", ended.id()).await;
        assert!(record.stopped, "{backend}: End");

        // An agent that exits by itself.
        let done = world.session(backend, &world.project("done"), "done").await;
        world.type_line(&done, "/exit").await;
        let record = ends.of("the session that exited", done.id()).await;
        assert!(!record.stopped, "{backend}: /exit");

        // A parent that exits by itself is not stopped, and the child the host
        // ends with it is.
        let parent = world
            .session(backend, &world.project("parent exits"), "parent")
            .await;
        parent
            .start(json!({ "task": "work", "name": "below", "backend": backend }))
            .await
            .done();
        let below = world.child_of(&parent, "below").await;
        world.type_line(&parent, "/exit").await;
        let record = ends.of("the parent that exited", parent.id()).await;
        assert!(!record.stopped, "{backend}: a parent that exited by itself");
        let record = ends.of("its child", below.id()).await;
        assert!(record.stopped, "{backend}: the child that ended with it");

        // A parent the user ends takes its child with it, both stopped.
        let lead = world
            .session(backend, &world.project("parent ends"), "lead")
            .await;
        lead.start(json!({ "task": "work", "name": "below", "backend": backend }))
            .await
            .done();
        let under = world.child_of(&lead, "below").await;
        world.close(&lead).await;
        let record = ends.of("the parent that was ended", lead.id()).await;
        assert!(record.stopped, "{backend}: the parent");
        let record = ends.of("its child", under.id()).await;
        assert!(record.stopped, "{backend}: its child");
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_quit_that_ends_a_clients_sessions_records_them_and_their_children_stopped() {
    let world = World::new();
    let host = world.host().await;
    let mut ends = Ends::listen(&world).await;
    for backend in [CLAUDE, OTHER] {
        let parent = world
            .session(backend, &world.project("quit"), "quitting")
            .await;
        parent
            .start(json!({ "task": "work", "name": "below", "backend": backend }))
            .await
            .done();
        let below = world.child_of(&parent, "below").await;
        world.quit(true).await;
        let record = ends.of("the parent to end", parent.id()).await;
        assert!(record.stopped, "{backend}: the parent");
        let record = ends.of("its child to end", below.id()).await;
        assert!(record.stopped, "{backend}: its child");
    }
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Roles, backends and rules
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s23_a_role_listing_a_missing_backend_and_an_installed_one_runs_on_the_installed_one_and_refuses_others()
 {
    let world = World::new();
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("roles"), "parent")
        .await;

    // No backend: the first the role lists that is installed.
    parent
        .start(json!({ "task": "review", "role": "reviewer", "name": "reviewer" }))
        .await
        .done();
    let reviewer = world.child_of(&parent, "reviewer").await;
    assert_eq!(reviewer.record.backend, BackendId::new(OTHER));
    assert_eq!(reviewer.record.role.as_deref(), Some("reviewer"));

    // An installed backend the role does not list.
    let refused = parent
        .start(json!({ "task": "review", "role": "reviewer", "backend": CLAUDE }))
        .await;
    let sentence = refused.refused();
    assert!(sentence.contains("reviewer"), "{sentence}");
    assert!(sentence.contains(CLAUDE), "{sentence}");
    assert!(
        sentence.contains(&format!("allows: {OTHER}.")),
        "{sentence}"
    );
    // A backend the role lists and the host lacks.
    let refused = parent
        .start(json!({ "task": "review", "role": "reviewer", "backend": "missing-agent" }))
        .await;
    let sentence = refused.refused();
    assert!(sentence.contains("missing-agent"), "{sentence}");
    assert!(
        sentence.contains(&format!("allows: {OTHER}.")),
        "{sentence}"
    );
    // A backend nobody has, with no role.
    let refused = parent
        .start(json!({ "task": "review", "backend": "nonesuch" }))
        .await;
    let sentence = refused.refused();
    assert!(
        sentence.contains(CLAUDE) && sentence.contains(OTHER),
        "{sentence}"
    );
    // A role nobody wrote.
    let refused = parent
        .start(json!({ "task": "review", "role": "wizard" }))
        .await;
    assert!(
        refused.refused().contains("no role named wizard"),
        "{refused:?}"
    );

    assert_eq!(world.children_made(), 1, "only the first started");
    // Without a role, the default one runs on the first installed backend.
    parent
        .start(json!({ "task": "work", "name": "plain" }))
        .await
        .done();
    let plain = world.child_of(&parent, "plain").await;
    assert_eq!(plain.record.backend, BackendId::new(CLAUDE));
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s24_a_rule_the_chosen_backend_cannot_enforce_refuses_the_start_naming_the_rule_and_backend()
 {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("rules");
    let mut automatic = request(&folder, "automatic parent", CLAUDE);
    automatic.permission_mode = Some(PermissionMode::Auto);
    let auto_parent = world.session_as(automatic).await;
    let parent = world.session(CLAUDE, &folder, "parent").await;
    let runs = world.run_count();

    let refused = parent
        .start(json!({ "task": "tidy", "role": "locked" }))
        .await;
    let sentence = refused.refused();
    assert!(sentence.contains(OTHER), "{sentence}");
    assert!(
        sentence.contains("disallowed_tools rule Bash(rm:*)"),
        "{sentence}"
    );
    assert!(sentence.contains("no agent was started"), "{sentence}");

    let refused = parent
        .start(json!({ "task": "read", "role": "reader" }))
        .await;
    let sentence = refused.refused();
    assert!(sentence.contains(OTHER), "{sentence}");
    assert!(
        sentence.contains("allowed_tools rule WebFetch"),
        "{sentence}"
    );

    // The mode the role asks for, capped at the parent's, is the rule.
    let refused = auto_parent
        .start(json!({ "task": "decide", "role": "automatic" }))
        .await;
    let sentence = refused.refused();
    assert!(sentence.contains(OTHER), "{sentence}");
    assert!(sentence.contains("permission mode auto"), "{sentence}");
    // Under a parent in manual the same role is capped to a mode it has.
    parent
        .start(json!({ "task": "decide", "role": "automatic", "name": "capped" }))
        .await
        .done();
    // Its run is logged once it has booted: the one process that started.
    let capped = world.child_of(&parent, "capped").await;
    assert_eq!(capped.record.backend, BackendId::new(OTHER));

    assert_eq!(world.children_made(), 1, "only the capped one started");
    assert_eq!(
        world.run_count(),
        runs + 1,
        "no process started for a refusal"
    );
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Allowed up front
// ---------------------------------------------------------------------------

/// The rules a session is given for the agents family, as each backend spells
/// them: the seven tools every session has and the five commands, and, for a
/// child, `agents_report` beside them.
fn family_rules(backend: &str, child: bool) -> Vec<String> {
    let mut rules: Vec<String> = if backend == CLAUDE {
        [
            "mcp__floti-agents__agents_start",
            "mcp__floti-agents__agents_send",
            "mcp__floti-agents__agents_list",
            "mcp__floti-agents__agents_stop",
            "mcp__floti-agents__agents_roles",
            "mcp__floti-agents__agents_wait",
            "mcp__floti-agents__agents_read",
            "Bash(floti agent start:*)",
            "Bash(floti agent send:*)",
            "Bash(floti agent wait:*)",
            "Bash(floti agent read:*)",
            "Bash(floti agent stop:*)",
        ]
    } else {
        [
            "floti-agents.agents_start",
            "floti-agents.agents_send",
            "floti-agents.agents_list",
            "floti-agents.agents_stop",
            "floti-agents.agents_roles",
            "floti-agents.agents_wait",
            "floti-agents.agents_read",
            "floti agent start",
            "floti agent send",
            "floti agent wait",
            "floti agent read",
            "floti agent stop",
        ]
    }
    .map(str::to_owned)
    .to_vec();
    if child {
        rules.push(if backend == CLAUDE {
            "mcp__floti-agents__agents_report".to_owned()
        } else {
            "floti-agents.agents_report".to_owned()
        });
    }
    rules
}

fn assert_family_allowed(who: &str, backend: &str, agent: &Agent) {
    let mut about_the_family: Vec<String> = agent
        .run
        .allowed()
        .into_iter()
        .filter(|rule| rule.contains("floti"))
        .collect();
    about_the_family.sort();
    // No launch allows `run`, or a wildcard over the subcommands or the tools.
    for rule in &about_the_family {
        assert!(
            !rule.contains("floti agent run")
                && !rule.contains("floti agent:*")
                && !rule.contains("floti:*")
                && !rule.ends_with("*"),
            "{who} ({backend}) is allowed {rule}: {:?}",
            agent.run.argv
        );
    }
    let mut wanted = family_rules(backend, agent.record.parent_id.is_some());
    wanted.sort();
    assert_eq!(
        about_the_family, wanted,
        "{who} ({backend}): {:?}",
        agent.run.argv
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn s26_the_seven_tools_and_the_five_commands_are_allowed_up_front_never_run_or_a_wildcard_and_a_deny_stands()
 {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("allowed");
    for backend in [CLAUDE, OTHER] {
        let parent = world
            .session(backend, &folder, &format!("parent {backend}"))
            .await;
        assert_family_allowed("a session", backend, &parent);
        // A child is launched the same way, on either backend.
        for child_backend in [CLAUDE, OTHER] {
            let name = format!("{backend}-{child_backend}");
            parent
                .start(json!({ "task": "work", "name": name, "backend": child_backend }))
                .await
                .done();
            let child = world.child_of(&parent, &name).await;
            assert_family_allowed("a child", child_backend, &child);
        }
    }

    // A rule the user denies stays denied beside what is allowed.
    let parent = world.session(CLAUDE, &folder, "careful parent").await;
    parent
        .start(json!({ "task": "work", "name": "careful", "role": "careful" }))
        .await
        .done();
    let careful = world.child_of(&parent, "careful").await;
    assert_family_allowed("a careful child", CLAUDE, &careful);
    assert_eq!(careful.run.disallowed(), ["Bash(floti agent stop:*)"]);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// floti agent, from a session's own shell
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s27_floti_agent_start_and_stop_from_a_sessions_own_shell_act_as_that_session() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("shell");
    for (backend, other) in [(CLAUDE, OTHER), (OTHER, CLAUDE)] {
        let parent = world
            .session(backend, &folder, &format!("parent {backend}"))
            .await;
        let task = format!("write the notes on {backend}");
        let started = world
            .shell(&parent, &format!("floti agent start --task \"{task}\""))
            .await;
        assert_eq!(started.code, Some(0), "{started:?}");
        // The name alone, for a script to keep.
        let name = started.stdout.trim().to_owned();
        assert_eq!(name, "agent", "{started:?}");
        let child = world.child_of(&parent, &name).await;
        assert_eq!(
            child.record.parent_id,
            Some(parent.id()),
            "it acted as the session"
        );
        assert_eq!(child.run.opening_prompt.as_deref(), Some(task.as_str()));

        // With --json, the tool's own answer.
        let json_started = world
            .shell(
                &parent,
                &format!(
                    "floti agent start --task \"again\" --json --name second --backend {other}"
                ),
            )
            .await;
        assert_eq!(json_started.code, Some(0), "{json_started:?}");
        let answer: Value =
            serde_json::from_str(json_started.stdout.trim()).expect("the tool's JSON");
        assert_eq!(answer["name"], "second", "{answer}");
        assert_eq!(answer["backend"], other, "{answer}");

        let stopped = world
            .shell(&parent, &format!("floti agent stop {name}"))
            .await;
        assert_eq!(stopped.code, Some(0), "{stopped:?}");
        assert!(stopped.stdout.contains("Stopped agent"), "{stopped:?}");
        world.ended("the child to stop", &[child.id()]).await;
        let stopped = world.shell(&parent, "floti agent stop second --json").await;
        assert_eq!(stopped.code, Some(0), "{stopped:?}");
        let answer: Value = serde_json::from_str(stopped.stdout.trim()).expect("JSON");
        assert_eq!(answer["stopped"], "second", "{answer}");
        assert!(parent.children().await.is_empty());
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s28_a_refusal_is_printed_by_floti_agent_start_and_stop_which_exit_non_zero() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("refusals");
    let outside = world.outside("beyond");
    for backend in [CLAUDE, OTHER] {
        let parent = world
            .session(backend, &folder, &format!("parent {backend}"))
            .await;

        let untracked = world
            .shell(
                &parent,
                &format!(
                    "floti agent start --task go --folder \"{}\"",
                    text(&outside)
                ),
            )
            .await;
        assert_ne!(untracked.code, Some(0), "{untracked:?}");
        assert!(
            untracked.stderr.contains("not a folder Floti tracks"),
            "{untracked:?}"
        );
        assert!(untracked.stdout.trim().is_empty(), "{untracked:?}");

        let not_mine = world.shell(&parent, "floti agent stop nobody").await;
        assert_ne!(not_mine.code, Some(0), "{not_mine:?}");
        assert!(
            not_mine
                .stderr
                .contains("No agent of yours is named nobody"),
            "{not_mine:?}"
        );
        assert!(not_mine.stdout.trim().is_empty(), "{not_mine:?}");

        // A limit.
        world
            .settings(HostSettingsPatch {
                agent_children_per_parent: Some(1),
                ..HostSettingsPatch::default()
            })
            .await;
        let first = world
            .shell(&parent, "floti agent start --task one --name one")
            .await;
        assert_eq!(first.code, Some(0), "{first:?}");
        let second = world.shell(&parent, "floti agent start --task two").await;
        assert_ne!(second.code, Some(0), "{second:?}");
        assert!(
            second
                .stderr
                .contains("limit of 1 running agents per parent"),
            "{second:?}"
        );
        assert!(second.stdout.trim().is_empty(), "{second:?}");
        assert_eq!(parent.children().await, ["one"]);
        world
            .settings(HostSettingsPatch {
                agent_children_per_parent: Some(4),
                ..HostSettingsPatch::default()
            })
            .await;
        parent.stop("one").await.done();
    }
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Only the caller's own children
// ---------------------------------------------------------------------------

/// The ways a test can name `session`: the name, the child name, the row id,
/// the conversation, the process and the folder.
fn names_of(session: &Agent, child_name: Option<&str>) -> Vec<String> {
    let mut names = vec![
        session.record.name.clone(),
        session.id().to_string(),
        session.record.conversation_id.clone().unwrap_or_default(),
        session.run.pid.to_string(),
        session.record.cwd.clone(),
    ];
    names.extend(child_name.map(str::to_owned));
    names
}

#[tokio::test(flavor = "multi_thread")]
async fn s29_no_tool_or_subcommand_reaches_a_session_that_is_not_the_callers_child_and_an_ended_token_is_unauthorised()
 {
    let world = World::new();
    let host = world.host().await;
    let a = world
        .session(CLAUDE, &world.project("alpha"), "alpha")
        .await;
    let b = world.session(OTHER, &world.project("bravo"), "bravo").await;
    let x = world.session(CLAUDE, &world.project("xray"), "xray").await;
    a.start(json!({ "task": "work", "name": "a-kid" }))
        .await
        .done();
    b.start(json!({ "task": "work", "name": "b-kid", "backend": CLAUDE }))
        .await
        .done();
    let a_kid = world.child_of(&a, "a-kid").await;
    let b_kid = world.child_of(&b, "b-kid").await;

    // Everyone, with the child name where one has it and who it belongs to.
    let everyone: [(&Agent, Option<&str>, Option<u64>); 5] = [
        (&a, None, None),
        (&b, None, None),
        (&x, None, None),
        (&a_kid, Some("a-kid"), Some(a.id())),
        (&b_kid, Some("b-kid"), Some(b.id())),
    ];
    let mut calls = 0;
    for (caller, _, _) in everyone {
        for (other, child_name, owner) in everyone {
            // A session may name itself and its own children.
            if other.id() == caller.id() || owner == Some(caller.id()) {
                continue;
            }
            for target in names_of(other, child_name) {
                let before = world.fingerprint();
                let call = format!("{} naming {} as {target:?}", caller.name(), other.name());

                let stop = caller.stop(&target).await;
                assert!(
                    stop.refused().contains("No agent of yours is named"),
                    "agents_stop {call}: {stop:?}"
                );
                // The list ignores what it is not asked for, and holds no
                // session that is not the caller's child.
                let list = caller
                    .call(
                        "agents_list",
                        json!({ "child": target, "session": target, "id": target }),
                    )
                    .await;
                assert!(!list.failed, "agents_list {call}: {list:?}");
                if let Some(child_name) = child_name {
                    assert!(
                        !list.blocks.iter().any(|block| block.contains(child_name)),
                        "agents_list {call} showed {child_name}: {list:?}"
                    );
                }
                // A start naming it where a start can name anything is refused.
                for field in ["role", "profile", "backend"] {
                    let start = caller
                        .start(json!({ "task": "reach", field: target }))
                        .await;
                    start.refused();
                }
                // The same through the subcommands.
                let (url, token) = caller.route();
                let stop = subcommand(
                    Subcommand::Stop(cli_stop(&target)),
                    url.clone(),
                    token.clone(),
                )
                .await;
                assert_eq!(stop.code, 1, "floti agent stop {call}: {stop:?}");
                assert!(
                    stop.err
                        .as_deref()
                        .is_some_and(|err| err.contains("No agent of yours is named")),
                    "floti agent stop {call}: {stop:?}"
                );
                let mut start = cli_start("reach");
                start.role = Some(target.clone());
                let start = subcommand(Subcommand::Start(start), url, token).await;
                assert_eq!(start.code, 1, "floti agent start {call}: {start:?}");

                assert_eq!(
                    world.fingerprint(),
                    before,
                    "{call} reached a session: a call that is refused changed the host"
                );
                calls += 1;
            }
        }
    }
    assert!(calls > 50, "the reach test made {calls} rounds of calls");
    for id in [a.id(), b.id(), x.id(), a_kid.id(), b_kid.id()] {
        assert_eq!(world.status(id), "running", "a call reached session {id}");
    }
    assert_eq!(a.children().await, ["a-kid"]);
    assert_eq!(b.children().await, ["b-kid"]);
    assert!(x.children().await.is_empty());

    // An ended session's token is refused as unauthorised, by every tool and
    // every subcommand.
    world.close(&x).await;
    world.ended("x to end", &[x.id()]).await;
    let (url, token) = x.route();
    for (tool, arguments) in [
        ("agents_start", json!({ "task": "late" })),
        ("agents_list", json!({})),
        ("agents_stop", json!({ "child": "a-kid" })),
    ] {
        let reply = rpc(
            &url,
            Some(&token),
            "tools/call",
            json!({ "name": tool, "arguments": arguments }),
        )
        .await;
        assert_eq!(reply.status, 401, "{tool}: {reply:?}");
    }
    assert_eq!(x.status_of("tools/list").await, 401);
    for command in [
        Subcommand::Start(cli_start("late")),
        Subcommand::Stop(cli_stop("a-kid")),
    ] {
        let outcome = subcommand(command, url.clone(), token.clone()).await;
        assert_eq!(outcome.code, 1, "{outcome:?}");
        let err = outcome.err.expect("a sentence");
        assert!(
            err.contains("does not accept this session's token"),
            "{err}"
        );
        assert!(!err.contains(&token), "the token is never printed");
    }
    assert_eq!(
        world.status(a_kid.id()),
        "running",
        "the ended token reached a child"
    );
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Both backends, whichever is the parent
// ---------------------------------------------------------------------------

/// A parent on `first` starts, lists and stops children on both backends; a
/// child on `second` with `can_start` starts its own on `first`. Each is
/// launched, listed and stopped through its own backend's adapter.
async fn across_both_backends(first: &str, second: &str) {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("both");
    let parent = world.session(first, &folder, "parent").await;
    parent
        .start(json!({ "task": "same", "name": "same", "backend": first }))
        .await
        .done();
    parent
        .start(json!({ "task": "other", "name": "other", "backend": second, "can_start": true }))
        .await
        .done();
    let same = world.child_of(&parent, "same").await;
    let other = world.child_of(&parent, "other").await;
    other
        .start(json!({ "task": "below", "name": "below", "backend": first }))
        .await
        .done();
    let below = world.child_of(&other, "below").await;

    // Each was launched through its own adapter.
    for (agent, backend) in [(&same, first), (&other, second), (&below, first)] {
        assert_eq!(agent.record.backend, BackendId::new(backend));
        let argv = &agent.run.argv;
        if backend == CLAUDE {
            assert!(argv.iter().any(|arg| arg == "--session-id"), "{argv:?}");
            assert!(argv.iter().any(|arg| arg == "--mcp-config"), "{argv:?}");
        } else {
            assert!(argv.iter().any(|arg| arg == "--conversation"), "{argv:?}");
            assert!(argv.iter().any(|arg| arg == "--tools-config"), "{argv:?}");
        }
    }

    // Each is listed with its own backend.
    let listed = parent.list().await.done();
    let backends: BTreeMap<String, String> = listed["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|child| {
            (
                child["name"].as_str().unwrap().to_owned(),
                child["backend"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        backends,
        BTreeMap::from([
            ("same".to_owned(), first.to_owned()),
            ("other".to_owned(), second.to_owned()),
        ])
    );
    assert_eq!(other.children().await, ["below"]);

    // Each is stopped, the one with a child of its own taking it along.
    parent.stop("same").await.done();
    world
        .ended("the same-backend child to stop", &[same.id()])
        .await;
    world.gone("its process to end", &[&same]).await;
    let stopped = parent.stop("other").await;
    assert_eq!(stopped.done()["also"], json!(["below"]));
    world
        .ended(
            "the other-backend child and its child to stop",
            &[other.id(), below.id()],
        )
        .await;
    world
        .gone("their processes to end", &[&other, &below])
        .await;
    assert!(parent.children().await.is_empty());
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s25_a_claude_code_parent_starts_lists_and_stops_children_on_both_backends() {
    across_both_backends(CLAUDE, OTHER).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s25_an_other_agent_parent_starts_lists_and_stops_children_on_both_backends() {
    across_both_backends(OTHER, CLAUDE).await;
}

// ---------------------------------------------------------------------------
// Resuming an ended child
// ---------------------------------------------------------------------------

/// The flag each fake reopens a conversation with.
fn reopen_flag(backend: &str) -> &'static str {
    if backend == CLAUDE {
        "--resume"
    } else {
        "--continue"
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_parent_resumes_its_ended_child_under_its_name_with_the_task_as_its_next_turn_on_either_backend()
 {
    let world = World::new();
    let host = world.host().await;
    let project = world.project("resume");
    let parent = world.session(CLAUDE, &project, "parent").await;
    for backend in [CLAUDE, OTHER] {
        let name = format!("worker-{backend}");
        let ended = world
            .ended_child(
                &parent,
                json!({
                    "task": "first task", "name": name, "role": "briefed", "backend": backend,
                    "outlive": true, "can_start": true,
                }),
            )
            .await;
        assert!(parent.children().await.is_empty());

        let started = parent
            .start(json!({ "task": "second task", "resume": name }))
            .await
            .done();
        assert_eq!(started["name"], name.as_str());
        assert_eq!(started["backend"], backend);
        assert!(
            same_folder(Path::new(started["folder"].as_str().unwrap()), &project),
            "{started}"
        );

        let resumed = world.resumed(&parent, &name, &ended).await;
        // The backend's own reopen of the conversation it had, with the task
        // as the next turn.
        assert!(resumed.run.resumed, "{:?}", resumed.run.argv);
        assert_eq!(resumed.record.conversation_id, ended.record.conversation_id);
        assert_eq!(
            value_of(&resumed.run.argv, reopen_flag(backend)),
            ended.record.conversation_id.as_deref(),
            "{:?}",
            resumed.run.argv
        );
        assert_eq!(resumed.run.opening_prompt.as_deref(), Some("second task"));
        assert_eq!(
            ended.run.opening_prompt.as_deref(),
            Some("first task"),
            "the earlier run began with its own task"
        );
        // Its role's instructions are composed again for the new run.
        assert!(
            resumed
                .run
                .instructions
                .as_deref()
                .is_some_and(|text| text.contains("Answer in one line.")),
            "{:?}",
            resumed.run.instructions
        );
        // And it is told again which session started it and in what role.
        assert!(
            resumed
                .run
                .instructions
                .as_deref()
                .is_some_and(|text| text.contains(&format!(
                    "You were started by another session, {}, as briefed.",
                    parent.name()
                ))),
            "{:?}",
            resumed.run.instructions
        );
        // The same child: its name, its parent, its role, outlive and
        // can_start, and the mode it had.
        assert_eq!(resumed.record.parent_id, Some(parent.id()));
        let row = |id: u64, column: &str| world.row_text(id, column);
        assert_eq!(
            row(resumed.id(), "child_name").as_deref(),
            Some(name.as_str())
        );
        for column in ["role", "outlive", "can_start", "backend", "permission_mode"] {
            assert_eq!(
                row(resumed.id(), column),
                row(ended.id(), column),
                "{column}"
            );
        }
        assert_eq!(row(resumed.id(), "outlive").as_deref(), Some("1"));
        assert_eq!(row(resumed.id(), "can_start").as_deref(), Some("1"));

        // Every tool reaches it by that name.
        assert_eq!(parent.children().await, std::slice::from_ref(&name));
        parent.stop(&name).await.done();
        world
            .ended("the resumed child to stop", &[resumed.id()])
            .await;
        world.gone("its process to end", &[&resumed]).await;
        assert!(parent.children().await.is_empty());
    }
    // A name resumed is still a name taken.
    let next = parent
        .start(json!({ "task": "another", "name": format!("worker-{CLAUDE}") }))
        .await
        .done();
    assert_eq!(next["name"], format!("worker-{CLAUDE}-2"));
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resumed_child_returns_to_the_worktree_it_had_and_makes_no_new_one() {
    let world = World::new();
    let host = world.host().await;
    let repo = GitRepo::init(world.project("resume repo"));
    repo.write("README.md", "hello\n");
    repo.commit_all("first");
    let root = resolved(repo.path());
    let parent = world.session(CLAUDE, &root, "parent").await;
    for backend in [CLAUDE, OTHER] {
        let name = format!("tree-{backend}");
        let ended = world
            .ended_child(
                &parent,
                json!({ "task": "first", "name": name, "worktree": name, "backend": backend }),
            )
            .await;
        let tree = root.join(".floti").join("worktrees").join(&name);
        assert!(tree.is_dir(), "{}", tree.display());
        std::fs::write(tree.join("kept.txt"), "work\n").expect("leave some work");

        let started = parent
            .start(json!({ "task": "carry on", "resume": name }))
            .await
            .done();
        assert!(
            same_folder(Path::new(started["folder"].as_str().unwrap()), &tree),
            "{started}"
        );
        assert_eq!(started["branch"], format!("agent/{name}"), "{started}");
        assert_eq!(started["worktree"], name.as_str(), "{started}");
        let resumed = world.resumed(&parent, &name, &ended).await;
        assert!(resumed.run.resumed);
        assert!(same_folder(Path::new(&resumed.record.cwd), &tree));
        assert!(tree.join("kept.txt").is_file(), "its work is still there");
        parent.stop(&name).await.done();
        world
            .ended("the resumed child to stop", &[resumed.id()])
            .await;
        world.gone("its process to end", &[&resumed]).await;
    }
    // One worktree for each child, however many runs it had.
    let made = std::fs::read_dir(root.join(".floti").join("worktrees"))
        .unwrap()
        .count();
    assert_eq!(made, 2);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resume_of_a_child_that_still_runs_is_refused_and_nothing_starts() {
    let world = World::new();
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("running"), "parent")
        .await;
    parent
        .start(json!({ "task": "work", "name": "busy" }))
        .await
        .done();
    let (rows, runs) = (world.children_made(), world.run_count());
    let refused = parent
        .start(json!({ "task": "again", "resume": "busy" }))
        .await;
    let sentence = refused.refused();
    assert!(sentence.contains("busy is still running"), "{sentence}");
    assert_eq!(world.children_made(), rows);
    assert_eq!(world.run_count(), runs);
    assert_eq!(parent.children().await, ["busy"]);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resume_that_asks_for_more_than_the_task_is_refused_naming_what_else_it_gave() {
    let world = World::new();
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("keeps its own"), "parent")
        .await;
    world
        .ended_child(&parent, json!({ "task": "first", "name": "kept" }))
        .await;
    let (rows, runs) = (world.children_made(), world.run_count());
    for (key, value) in [
        ("role", "briefed"),
        ("backend", OTHER),
        ("folder", "."),
        ("profile", "workspace"),
        ("worktree", "mine"),
        ("name", "renamed"),
    ] {
        let refused = parent
            .start(json!({ "task": "again", "resume": "kept", key: value }))
            .await;
        let sentence = refused.refused();
        assert!(sentence.contains("keeps its own"), "{key}: {sentence}");
        assert!(sentence.contains(key), "{key}: {sentence}");
    }
    assert_eq!(world.children_made(), rows);
    assert_eq!(world.run_count(), runs);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resume_names_only_the_callers_own_children_and_any_other_name_is_not_found() {
    let world = World::new();
    let host = world.host().await;
    let mine = world.session(CLAUDE, &world.project("mine"), "mine").await;
    let theirs = world
        .session(OTHER, &world.project("theirs"), "theirs")
        .await;
    world
        .ended_child(&theirs, json!({ "task": "first", "name": "theirs-child" }))
        .await;
    world
        .ended_child(&mine, json!({ "task": "first", "name": "mine-child" }))
        .await;
    let (rows, runs) = (world.children_made(), world.run_count());

    for name in ["theirs-child", "nobody", "theirs", "mine"] {
        let refused = mine.start(json!({ "task": "again", "resume": name })).await;
        let sentence = refused.refused();
        assert!(
            sentence.contains(&format!("No agent of yours is named {name}")),
            "{name}: {sentence}"
        );
    }
    // Another session's child answers as every other tool answers it.
    let stop = mine.stop("theirs-child").await;
    let resume = mine
        .start(json!({ "task": "again", "resume": "theirs-child" }))
        .await;
    assert_eq!(
        stop.refused().split(". ").next(),
        resume.refused().split(". ").next()
    );
    assert_eq!(world.children_made(), rows);
    assert_eq!(world.run_count(), runs);
    host.stop(HostStopReason::Stop).await;
}

/// An ended child's row, as a host left it, for the cases a run cannot make.
fn insert_ended_child(
    world: &World,
    parent: &Agent,
    name: &str,
    backend: &str,
    folder: &Path,
    conversation: Option<&str>,
) {
    world
        .db()
        .execute(
            "INSERT INTO sessions (name, cwd, argv, claude_session_id, backend, parent_session_id, \
             child_name, role, status) VALUES (?1, ?2, '[]', ?3, ?4, ?5, ?1, 'agent', 'exited')",
            rusqlite::params![
                name,
                text(folder),
                conversation,
                backend,
                i64::try_from(parent.id()).unwrap(),
            ],
        )
        .expect("insert an exited child");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resume_is_refused_saying_which_when_the_folder_is_gone_is_not_tracked_or_the_conversation_is_unknown()
 {
    let world = World::new();
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("home"), "parent")
        .await;

    // Its folder is gone.
    let scratch = world.project("scratch");
    world
        .ended_child(
            &parent,
            json!({ "task": "first", "name": "lost", "folder": text(&scratch) }),
        )
        .await;
    std::fs::remove_dir_all(&scratch).expect("remove the folder");
    let (rows, runs) = (world.children_made(), world.run_count());
    let refused = parent
        .start(json!({ "task": "again", "resume": "lost" }))
        .await;
    let sentence = refused.refused();
    assert!(sentence.contains("no longer on disk"), "{sentence}");
    assert!(sentence.contains(&text(&scratch)), "{sentence}");

    // It has no conversation to reopen.
    insert_ended_child(&world, &parent, "blank", CLAUDE, &world.work, None);
    let (rows, runs) = (rows + 1, runs);
    let refused = parent
        .start(json!({ "task": "again", "resume": "blank" }))
        .await;
    let sentence = refused.refused();
    assert!(
        sentence.contains("which conversation blank had"),
        "{sentence}"
    );
    assert_eq!(world.children_made(), rows);
    assert_eq!(world.run_count(), runs);

    // Its folder is there, but Floti no longer tracks it.
    let elsewhere = world.project("elsewhere");
    world
        .ended_child(
            &parent,
            json!({ "task": "first", "name": "moved", "folder": text(&elsewhere) }),
        )
        .await;
    let (rows, runs) = (world.children_made(), world.run_count());
    world
        .db()
        .execute("DELETE FROM profiles", [])
        .expect("untrack the workspace");
    world
        .db()
        .execute("DELETE FROM projects", [])
        .expect("forget the projects");
    let refused = parent
        .start(json!({ "task": "again", "resume": "moved" }))
        .await;
    let sentence = refused.refused();
    assert!(sentence.contains("not a folder Floti tracks"), "{sentence}");
    assert_eq!(world.children_made(), rows);
    assert_eq!(world.run_count(), runs);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resume_is_refused_when_the_childs_backend_cannot_reopen_a_conversation() {
    let world = World::new();
    let plain: Arc<dyn AgentBackend> = Arc::new(PlainCommandBackend::new(
        BackendId::new("plain-cli"),
        "Plain CLI",
        "plain-cli",
        Vec::<OsString>::new(),
    ));
    let host = world.host_with(vec![plain]).await;
    let parent = world
        .session(CLAUDE, &world.project("plain"), "parent")
        .await;
    insert_ended_child(
        &world,
        &parent,
        "plain-child",
        "plain-cli",
        &world.work,
        Some("some-conversation"),
    );
    // A backend the host lacks is told apart from one that cannot reopen.
    insert_ended_child(
        &world,
        &parent,
        "gone-child",
        "missing-agent",
        &world.work,
        Some("some-conversation"),
    );
    let (rows, runs) = (world.children_made(), world.run_count());
    let refused = parent
        .start(json!({ "task": "again", "resume": "plain-child" }))
        .await;
    let sentence = refused.refused();
    assert!(
        sentence.contains("Plain CLI cannot reopen a conversation"),
        "{sentence}"
    );
    let refused = parent
        .start(json!({ "task": "again", "resume": "gone-child" }))
        .await;
    let sentence = refused.refused();
    assert!(sentence.contains("does not have"), "{sentence}");
    assert_eq!(world.children_made(), rows);
    assert_eq!(world.run_count(), runs);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resume_is_judged_against_every_limit_and_counts_as_a_start_and_a_running_child() {
    let world = World::new();
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("limits"), "parent")
        .await;
    let neighbour = world
        .session(OTHER, &world.project("neighbour"), "neighbour")
        .await;
    world
        .ended_child(&parent, json!({ "task": "first", "name": "ended" }))
        .await;

    // Running children at once: one runs and the limit is one.
    parent
        .start(json!({ "task": "busy", "name": "busy" }))
        .await
        .done();
    world
        .settings(HostSettingsPatch {
            agent_children_per_parent: Some(1),
            ..HostSettingsPatch::default()
        })
        .await;
    let refused = parent
        .start(json!({ "task": "again", "resume": "ended" }))
        .await;
    let sentence = refused.refused();
    assert!(
        sentence.contains("limit of 1 running agents per parent"),
        "{sentence}"
    );
    assert!(sentence.contains("busy"), "{sentence}");
    parent.stop("busy").await.done();
    let busy = world.newest_child_id(parent.id(), "busy").unwrap();
    world.ended("the busy child to stop", &[busy]).await;

    // The starts in the parent's life: two so far, and the limit is two.
    world
        .settings(HostSettingsPatch {
            agent_starts_per_parent: Some(2),
            ..HostSettingsPatch::default()
        })
        .await;
    let refused = parent
        .start(json!({ "task": "again", "resume": "ended" }))
        .await;
    let sentence = refused.refused();
    assert!(
        sentence.contains("limit of 2 starts per parent"),
        "{sentence}"
    );
    assert_eq!(world.children_made(), 2);

    // The host's agent sessions: another session's child holds the only slot.
    neighbour
        .start(json!({ "task": "holding", "name": "holder" }))
        .await
        .done();
    world
        .settings(HostSettingsPatch {
            agent_starts_per_parent: Some(16),
            agent_sessions_per_host: Some(1),
            ..HostSettingsPatch::default()
        })
        .await;
    let refused = parent
        .start(json!({ "task": "again", "resume": "ended" }))
        .await;
    let sentence = refused.refused();
    assert!(
        sentence.contains("limit of 1 agent sessions running on this host"),
        "{sentence}"
    );
    assert_eq!(world.children_made(), 3, "nothing started");

    // Within every limit it goes ahead, and is one more start and one more
    // running child.
    neighbour.stop("holder").await.done();
    let holder = world.newest_child_id(neighbour.id(), "holder").unwrap();
    world.ended("the holder to stop", &[holder]).await;
    let started = parent
        .start(json!({ "task": "again", "resume": "ended" }))
        .await
        .done();
    assert_eq!(started["name"], "ended");
    assert_eq!(world.children_made(), 4);
    let limits = parent.list().await.done()["limits"].clone();
    assert_eq!(limits["startsLeft"], 16 - 3, "{limits}");
    assert_eq!(limits["childrenLeft"], 0, "{limits}");
    assert_eq!(parent.children().await, ["ended"]);
    // It holds the parent's only running slot, as any child would.
    let refused = parent.start(json!({ "task": "one too many" })).await;
    let sentence = refused.refused();
    assert!(
        sentence.contains("limit of 1 running agents per parent"),
        "{sentence}"
    );
    assert!(sentence.contains("ended"), "{sentence}");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resume_by_an_agent_at_the_depth_limit_is_refused_naming_the_depth() {
    let world = World::new();
    let host = world.host().await;
    let top = world.session(CLAUDE, &world.project("depth"), "top").await;
    top.start(json!({ "task": "lead", "name": "lead", "can_start": true }))
        .await
        .done();
    let lead = world.child_of(&top, "lead").await;
    world
        .ended_child(&lead, json!({ "task": "first", "name": "leaf" }))
        .await;
    world
        .settings(HostSettingsPatch {
            agent_depth: Some(1),
            ..HostSettingsPatch::default()
        })
        .await;
    let rows = world.children_made();
    let refused = lead
        .start(json!({ "task": "again", "resume": "leaf" }))
        .await;
    let sentence = refused.refused();
    assert!(sentence.contains("depth limit of 1"), "{sentence}");
    assert_eq!(world.children_made(), rows);

    world
        .settings(HostSettingsPatch {
            agent_depth: Some(2),
            ..HostSettingsPatch::default()
        })
        .await;
    lead.start(json!({ "task": "again", "resume": "leaf" }))
        .await
        .done();
    assert_eq!(lead.children().await, ["leaf"]);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn floti_agent_start_resume_reopens_an_ended_child_from_the_parents_shell() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("shell resume");
    for (backend, child_backend) in [(CLAUDE, OTHER), (OTHER, CLAUDE)] {
        let parent = world
            .session(backend, &folder, &format!("parent {backend}"))
            .await;
        let name = format!("cli-{child_backend}");
        let ended = world
            .ended_child(
                &parent,
                json!({ "task": "first", "name": name, "backend": child_backend }),
            )
            .await;

        let resumed = world
            .shell(
                &parent,
                &format!("floti agent start --resume {name} --task \"carry on\""),
            )
            .await;
        assert_eq!(resumed.code, Some(0), "{resumed:?}");
        assert_eq!(resumed.stdout.trim(), name, "{resumed:?}");
        let run = world.resumed(&parent, &name, &ended).await;
        assert!(run.run.resumed);
        assert_eq!(run.run.opening_prompt.as_deref(), Some("carry on"));
        assert_eq!(
            run.record.parent_id,
            Some(parent.id()),
            "it acted as the session"
        );

        // Still running: refused, and the command exits non-zero.
        let again = world
            .shell(
                &parent,
                &format!("floti agent start --resume {name} --task again"),
            )
            .await;
        assert_ne!(again.code, Some(0), "{again:?}");
        assert!(again.stderr.contains("is still running"), "{again:?}");
        assert!(again.stdout.trim().is_empty(), "{again:?}");

        // Anything but the task is refused.
        let renamed = world
            .shell(
                &parent,
                &format!("floti agent start --resume {name} --task again --name other"),
            )
            .await;
        assert_ne!(renamed.code, Some(0), "{renamed:?}");
        assert!(renamed.stderr.contains("keeps its own"), "{renamed:?}");
        parent.stop(&name).await.done();
    }
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// The heavy slot
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_heavy_start_is_refused_while_a_heavy_child_runs_naming_the_limit_the_holder_and_who_started_it()
 {
    let world = World::new();
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("heavy"), "parent")
        .await;
    let neighbour = world
        .session(OTHER, &world.project("heavy neighbour"), "neighbour")
        .await;
    parent
        .start(json!({ "task": "boot the emulator", "name": "emu", "role": "emulator" }))
        .await
        .done();
    // Its run is logged before the runs are counted.
    world.child_of(&parent, "emu").await;

    // Any session is refused, the holder's own parent included.
    for (who, asker) in [("neighbour", &neighbour), ("parent", &parent)] {
        let rows = world.children_made();
        let runs = world.run_count();
        let refused = asker
            .start(json!({ "task": "run the suite", "role": "suite" }))
            .await;
        let sentence = refused.refused();
        assert!(sentence.contains("heavy limit of 1"), "{who}: {sentence}");
        assert!(
            sentence.contains("emu (started by parent)"),
            "{who}: {sentence}"
        );
        assert!(
            sentence.contains("Wait for news and start again"),
            "{who}: {sentence}"
        );
        assert_eq!(world.children_made(), rows, "{who}: nothing started");
        assert_eq!(world.run_count(), runs, "{who}: nothing ran");
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn light_starts_are_not_held_by_a_heavy_child_and_the_next_heavy_start_goes_ahead_once_it_ends()
 {
    let world = World::new();
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("light beside heavy"), "parent")
        .await;
    // A session a person started runs beside it and holds no heavy slot.
    let person = world
        .session(OTHER, &world.project("a person"), "a person")
        .await;
    parent
        .start(json!({ "task": "boot the emulator", "name": "emu", "role": "emulator" }))
        .await
        .done();

    parent
        .start(json!({ "task": "read a file", "name": "easy" }))
        .await
        .done();
    person
        .start(json!({ "task": "read another", "name": "other-easy" }))
        .await
        .done();
    let refused = person
        .start(json!({ "task": "run the suite", "role": "suite" }))
        .await;
    let sentence = refused.refused();
    // Only the one agent holds the slot: not the session a person started,
    // and not the light children.
    assert!(sentence.contains("1 heavy agent is running"), "{sentence}");
    assert!(!sentence.contains("easy"), "{sentence}");
    assert!(!sentence.contains("a person"), "{sentence}");

    // It ends, and the next heavy start goes ahead.
    let emu = world.newest_child_id(parent.id(), "emu").unwrap();
    parent.stop("emu").await.done();
    world.ended("the heavy child to stop", &[emu]).await;
    person
        .start(json!({ "task": "run the suite", "name": "suite", "role": "suite" }))
        .await
        .done();
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_resume_of_a_heavy_child_is_refused_naming_the_holder_as_a_start_is() {
    let world = World::new();
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("heavy resume"), "parent")
        .await;
    let neighbour = world
        .session(OTHER, &world.project("heavy resume neighbour"), "neighbour")
        .await;
    world
        .ended_child(
            &parent,
            json!({ "task": "first", "name": "ended-heavy", "role": "suite" }),
        )
        .await;
    neighbour
        .start(json!({ "task": "boot the emulator", "name": "emu", "role": "emulator" }))
        .await
        .done();
    // Its run is logged before the runs are counted.
    world.child_of(&neighbour, "emu").await;

    let rows = world.children_made();
    let runs = world.run_count();
    let refused = parent
        .start(json!({ "task": "again", "resume": "ended-heavy" }))
        .await;
    let sentence = refused.refused();
    assert!(sentence.contains("heavy limit of 1"), "{sentence}");
    assert!(
        sentence.contains("emu (started by neighbour)"),
        "{sentence}"
    );
    assert!(
        sentence.contains("Wait for news and start again"),
        "{sentence}"
    );
    assert_eq!(world.children_made(), rows, "nothing started");
    assert_eq!(world.run_count(), runs, "nothing ran");

    // The holder ends and the resume goes ahead, and now holds the slot.
    let emu = world.newest_child_id(neighbour.id(), "emu").unwrap();
    neighbour.stop("emu").await.done();
    world.ended("the heavy child to stop", &[emu]).await;
    parent
        .start(json!({ "task": "again", "resume": "ended-heavy" }))
        .await
        .done();
    let refused = neighbour
        .start(json!({ "task": "boot the emulator again", "role": "emulator" }))
        .await;
    assert!(
        refused
            .refused()
            .contains("ended-heavy (started by parent)"),
        "{}",
        refused.refused()
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_host_runs_one_heavy_child_until_a_heavy_limit_is_told_to_it_and_agents_list_shows_the_slots_left()
 {
    let world = World::new();
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("heavy limit"), "parent")
        .await;

    // Told nothing: one runs.
    let listed = parent.list().await;
    assert!(
        listed.text().contains("1 of 1 heavy on this host"),
        "{}",
        listed.text()
    );
    let limits = listed.done()["limits"].clone();
    assert_eq!(
        (&limits["heavyPerHost"], &limits["heavyLeft"]),
        (&json!(1), &json!(1))
    );
    parent
        .start(json!({ "task": "one", "name": "h1", "role": "emulator" }))
        .await
        .done();
    let listed = parent.list().await;
    assert!(
        listed.text().contains("0 of 1 heavy on this host"),
        "{}",
        listed.text()
    );
    let refused = parent
        .start(json!({ "task": "two", "name": "h2", "role": "emulator" }))
        .await;
    assert!(
        refused.refused().contains("heavy limit of 1"),
        "{}",
        refused.refused()
    );

    // Told 2: the second runs and the third is refused naming both holders.
    world
        .settings(HostSettingsPatch {
            agent_heavy_per_host: Some(2),
            ..HostSettingsPatch::default()
        })
        .await;
    let limits = parent.list().await.done()["limits"].clone();
    assert_eq!(
        (&limits["heavyPerHost"], &limits["heavyLeft"]),
        (&json!(2), &json!(1))
    );
    parent
        .start(json!({ "task": "two", "name": "h2", "role": "suite" }))
        .await
        .done();
    let limits = parent.list().await.done()["limits"].clone();
    assert_eq!(limits["heavyLeft"], 0, "{limits}");
    let rows = world.children_made();
    let refused = parent
        .start(json!({ "task": "three", "name": "h3", "role": "emulator" }))
        .await;
    let sentence = refused.refused();
    assert!(sentence.contains("heavy limit of 2"), "{sentence}");
    assert!(sentence.contains("h1 (started by parent)"), "{sentence}");
    assert!(sentence.contains("h2 (started by parent)"), "{sentence}");
    assert_eq!(world.children_made(), rows, "nothing started");

    // Lowered under what runs: nothing ends, and the next heavy start waits.
    world
        .settings(HostSettingsPatch {
            agent_heavy_per_host: Some(1),
            ..HostSettingsPatch::default()
        })
        .await;
    assert_eq!(parent.children().await, ["h1", "h2"]);
    let limits = parent.list().await.done()["limits"].clone();
    assert_eq!(limits["heavyLeft"], 0, "{limits}");
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Send: a parent gives its child a turn
// ---------------------------------------------------------------------------

/// The key each backend's adapter submits a paste with, as the fake logs it.
fn submit_key(backend: &str) -> &'static str {
    if backend == CLAUDE { "\r" } else { "\n" }
}

impl Agent {
    async fn send(&self, child: &str, text: &str) -> Called {
        self.call("agents_send", json!({ "child": child, "text": text }))
            .await
    }
}

impl World {
    /// A parent and its running child on `backend`, in a folder with a space
    /// in its name.
    async fn family(&self, backend: &str, name: &str) -> (Agent, Agent) {
        let folder = self.project(&format!("send to {name}"));
        let parent = self
            .session(CLAUDE, &folder, &format!("parent of {name}"))
            .await;
        parent
            .start(json!({ "task": "wait for me", "name": name, "backend": backend }))
            .await
            .done();
        let child = self.child_of(&parent, name).await;
        (parent, child)
    }

    /// Has `parent` give its child `name` a turn that runs until `/idle`. A
    /// person typing it would be a person typing, which a send refuses after.
    async fn give_a_held_turn(&self, parent: &Agent, child: &Agent, name: &str) {
        parent.send(name, "/busy hold").await.done();
        eventually("the child to begin the held turn", async || {
            self.reread(child)
                .received
                .iter()
                .any(|line| line == "/busy hold")
                .then_some(())
        })
        .await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_text_sent_to_an_idle_child_arrives_as_one_paste_then_the_submit_key_and_is_taken_as_one_turn()
 {
    let world = World::new();
    let host = world.host().await;
    let text = "first line\nsecond line\n\nfourth line";
    for backend in [CLAUDE, OTHER] {
        // By the tool, and by `floti agent send`.
        for by_command in [false, true] {
            let name = format!("{backend}-{}", if by_command { "command" } else { "tool" });
            let (parent, child) = world.family(backend, &name).await;
            if by_command {
                let (url, token) = parent.route();
                let outcome =
                    subcommand(Subcommand::Send(cli_send(&name, text, false)), url, token).await;
                assert_eq!(outcome.code, 0, "{backend}: {outcome:?}");
            } else {
                parent.send(&name, text).await.done();
            }
            let run = eventually("the child to take the turn", async || {
                let run = world.reread(&child);
                run.prompts
                    .iter()
                    .any(|prompt| prompt == text)
                    .then_some(run)
            })
            .await;
            // One paste, whole, with its newlines; the submit key came apart
            // from it, and is the adapter's own.
            assert_eq!(
                run.pastes,
                [(text.to_owned(), false)],
                "{backend} by_command={by_command}"
            );
            assert_eq!(
                run.submit_keys.last().map(String::as_str),
                Some(submit_key(backend)),
                "{backend}"
            );
            assert_eq!(run.interrupts, 0);
        }
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_text_sent_to_a_working_child_is_accepted_and_is_its_next_turn_once_the_current_one_ends()
{
    let world = World::new();
    let host = world.host().await;
    for backend in [CLAUDE, OTHER] {
        let name = format!("busy-{backend}");
        let (parent, child) = world.family(backend, &name).await;
        world.give_a_held_turn(&parent, &child, &name).await;

        let sent = parent.send(&name, "next task\nin two lines").await.done();
        assert_eq!(sent["sent"], name.as_str(), "{backend}");
        let run = eventually("the child to queue the text", async || {
            let run = world.reread(&child);
            run.queued
                .iter()
                .any(|line| line == "next task\nin two lines")
                .then_some(run)
        })
        .await;
        assert!(
            !run.prompts.iter().any(|line| line.starts_with("next task")),
            "{backend} took it while its turn ran: {:?}",
            run.prompts
        );

        world.type_line(&child, "/idle").await;
        eventually("the queued text to be the next turn", async || {
            world
                .reread(&child)
                .prompts
                .last()
                .is_some_and(|line| line == "next task\nin two lines")
                .then_some(())
        })
        .await;
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_send_that_interrupts_presses_the_stop_key_first_and_the_child_takes_the_text_as_its_next_turn()
 {
    let world = World::new();
    let host = world.host().await;
    for backend in [CLAUDE, OTHER] {
        for by_command in [false, true] {
            let name = format!(
                "stop-{backend}-{}",
                if by_command { "command" } else { "tool" }
            );
            let (parent, child) = world.family(backend, &name).await;
            world.give_a_held_turn(&parent, &child, &name).await;

            if by_command {
                let (url, token) = parent.route();
                let outcome = subcommand(
                    Subcommand::Send(cli_send(&name, "do this instead", true)),
                    url,
                    token,
                )
                .await;
                assert_eq!(outcome.code, 0, "{backend}: {outcome:?}");
            } else {
                let sent = parent
                    .call(
                        "agents_send",
                        json!({ "child": name, "text": "do this instead", "interrupt": true }),
                    )
                    .await
                    .done();
                assert_eq!(sent["interrupted"], true, "{backend}");
            }
            let run = eventually("the child to take the text after the stop", async || {
                let run = world.reread(&child);
                run.prompts
                    .last()
                    .is_some_and(|line| line == "do this instead")
                    .then_some(run)
            })
            .await;
            assert_eq!(run.interrupts, 1, "{backend} by_command={by_command}");
            // The turn was ended before the text came, so nothing was queued.
            assert!(
                !run.queued.iter().any(|line| line == "do this instead"),
                "{backend}: {:?}",
                run.queued
            );
        }
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn floti_agent_send_from_a_sessions_own_shell_types_the_text_into_that_sessions_child() {
    let world = World::new();
    let host = world.host().await;
    let (parent, child) = world.family(OTHER, "shelled").await;
    let ran = world
        .shell(&parent, "floti agent send shelled \"look at the tests\"")
        .await;
    assert_eq!(ran.code, Some(0), "{ran:?}");
    assert!(ran.stdout.contains("Sent to shelled"), "{ran:?}");
    eventually("the child to take the turn", async || {
        world
            .reread(&child)
            .prompts
            .iter()
            .any(|line| line == "look at the tests")
            .then_some(())
    })
    .await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_send_reaches_only_the_callers_own_running_children() {
    let world = World::new();
    let host = world.host().await;
    let (parent, child) = world.family(OTHER, "mine").await;
    let (_other_parent, other_child) = world.family(OTHER, "theirs").await;

    // A name that is no child of the caller's is not found, whoever has it.
    let refused = parent.send("theirs", "hello").await;
    assert!(
        refused
            .refused()
            .contains("No agent of yours is named theirs"),
        "{refused:?}"
    );
    let refused = parent.send("ghost", "hello").await;
    assert!(refused.refused().contains("ghost"), "{refused:?}");
    // Blank text and a missing name are refused before anything is typed.
    assert!(parent.send("mine", "   ").await.failed);
    assert!(
        parent
            .call("agents_send", json!({ "text": "x" }))
            .await
            .failed
    );

    // A child that has ended takes nothing.
    parent.stop("mine").await.done();
    world.ended("the child to stop", &[child.id()]).await;
    let refused = parent.send("mine", "hello").await;
    assert!(refused.refused().contains("mine has ended"), "{refused:?}");

    // None of that typed anything into any child.
    for run in [world.reread(&other_child), world.reread(&child)] {
        assert!(!run.received.iter().any(|line| line.contains("hello")));
        assert!(run.pastes.is_empty(), "{:?}", run.pastes);
    }
    host.stop(HostStopReason::Stop).await;
}

/// What a run has been typed, as the fake logged it: every line it took, every
/// paste and every turn.
fn typed_into(run: &Run) -> (Vec<String>, Vec<(String, bool)>, Vec<String>) {
    (
        run.received.clone(),
        run.pastes.clone(),
        run.prompts.clone(),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn a_send_names_only_the_callers_own_children_and_nothing_else_is_typed_into_any_session() {
    let world = World::new();
    let host = world.host().await;
    // A parent with two children (so each is the other's sibling), another
    // family on the other backends, and a session nobody started with a tool.
    let a = world
        .session(CLAUDE, &world.project("alpha"), "alpha")
        .await;
    let b = world.session(OTHER, &world.project("bravo"), "bravo").await;
    let x = world.session(OTHER, &world.project("xray"), "xray").await;
    for (parent, kid, backend) in [
        (&a, "a-one", OTHER),
        (&a, "a-two", CLAUDE),
        (&b, "b-one", CLAUDE),
    ] {
        parent
            .start(json!({ "task": "work", "name": kid, "backend": backend }))
            .await
            .done();
    }
    let a_one = world.child_of(&a, "a-one").await;
    let a_two = world.child_of(&a, "a-two").await;
    let b_one = world.child_of(&b, "b-one").await;

    let everyone: [(&Agent, Option<&str>, Option<u64>); 6] = [
        (&a, None, None),
        (&b, None, None),
        (&x, None, None),
        (&a_one, Some("a-one"), Some(a.id())),
        (&a_two, Some("a-two"), Some(a.id())),
        (&b_one, Some("b-one"), Some(b.id())),
    ];
    let before: Vec<_> = everyone
        .iter()
        .map(|(agent, _, _)| typed_into(&world.reread(agent)))
        .collect();

    const MARKER: &str = "TYPED-WHERE-IT-MUST-NOT-BE";
    let mut calls = 0;
    for (caller, _, _) in everyone {
        for (other, child_name, owner) in everyone {
            // The caller's own children are what a send is for.
            if owner == Some(caller.id()) {
                continue;
            }
            // Its parent, itself, a sibling or a session it did not start: by
            // name, id, conversation, process and folder.
            for target in names_of(other, child_name)
                .into_iter()
                .filter(|target| !target.trim().is_empty())
            {
                let call = format!("{} naming {} as {target:?}", caller.name(), other.name());
                let sent = caller.send(&target, MARKER).await;
                assert!(
                    sent.refused().contains("No agent of yours is named"),
                    "agents_send {call}: {sent:?}"
                );
                let (url, token) = caller.route();
                let by_command = subcommand(
                    Subcommand::Send(cli_send(&target, MARKER, true)),
                    url,
                    token,
                )
                .await;
                assert_eq!(
                    by_command.code, 1,
                    "floti agent send {call}: {by_command:?}"
                );
                assert!(
                    by_command
                        .err
                        .as_deref()
                        .is_some_and(|err| err.contains("No agent of yours is named")),
                    "floti agent send {call}: {by_command:?}"
                );
                calls += 1;
            }
        }
    }
    assert!(calls > 60, "the reach test made {calls} rounds of calls");

    for ((agent, _, _), before) in everyone.iter().zip(&before) {
        let run = world.reread(agent);
        assert_eq!(
            &typed_into(&run),
            before,
            "something was typed into {}",
            agent.name()
        );
        assert!(
            !run.received.iter().any(|line| line.contains(MARKER)),
            "{} took the text",
            agent.name()
        );
        assert_eq!(run.interrupts, 0, "{} was interrupted", agent.name());
        assert_eq!(world.status(agent.id()), "running");
    }
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Command children: floti agent run
// ---------------------------------------------------------------------------

/// The program a command child runs: it records where it runs, prints
/// `--count` lines, then exits with `--code` or, with `--hold`, stays until it
/// is ended.
const COMMAND_SCRIPT: &str = r#"import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at < 0 ? fallback : args[at + 1];
};
const record = option('record', '');
if (record) {
  writeFileSync(record, JSON.stringify({ cwd: process.cwd(), pid: process.pid }));
}
for (let line = 1; line <= Number(option('count', '0')); line += 1) {
  console.log(`line ${line}`);
}
if (args.includes('--hold')) {
  setInterval(() => {}, 100000);
} else {
  process.exitCode = Number(option('code', '0'));
}
"#;

/// The script, in a folder whose name has a space.
fn command_script(world: &World) -> PathBuf {
    let path = world.outside("command scripts").join("emit lines.mjs");
    std::fs::write(&path, COMMAND_SCRIPT).expect("write the script");
    path
}

/// A file the script records itself in, in a folder with a space.
fn record_file(world: &World, name: &str) -> PathBuf {
    world
        .outside("command records")
        .join(format!("{name}.json"))
}

/// What a parent types in its shell: `floti agent run` with `before` ahead of
/// the `--`, then the script with `options`.
fn run_script(before: &str, script: &Path, options: &str) -> String {
    format!(
        "floti agent run {before} -- node \"{}\" {options}",
        text(script)
    )
}

/// Where and as what the script ran, once it has said.
async fn recorded(path: &Path) -> Value {
    eventually("the command to record where it runs", async || {
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    })
    .await
}

/// The pid a recorded script ran as.
fn pid_of(ran: &Value) -> u32 {
    u32::try_from(ran["pid"].as_u64().expect("a pid")).unwrap()
}

/// The row of the command child `parent` started under `name`.
async fn command_child(world: &World, parent: &Agent, name: &str) -> SessionRecord {
    let id = eventually("the command child's row", async || {
        world.newest_child_id(parent.id(), name)
    })
    .await;
    world.record(id).await
}

/// How a session ended, as its row says.
#[derive(Debug)]
struct Ending {
    exit_code: Option<i32>,
    stopped: bool,
}

/// The row of `id` once it has ended.
async fn ended_row(world: &World, id: u64) -> Ending {
    world.ended("the command to end", &[id]).await;
    Ending {
        exit_code: world
            .row_text(id, "exit_code")
            .and_then(|code| code.parse().ok()),
        stopped: world.row_text(id, "stopped").as_deref() == Some("1"),
    }
}

/// Waits until none of `pids` is a process any more.
async fn gone_pids(what: &str, pids: &[u32]) {
    eventually(what, async || {
        pids.iter().all(|pid| !alive(*pid)).then_some(())
    })
    .await;
}

/// The news of `name`'s exit, as `floti agent wait <name> --json` gives it
/// from the parent's shell.
async fn exit_news(world: &World, parent: &Agent, name: &str) -> Value {
    eventually("the command's exit to reach its parent", async || {
        let waited = world
            .shell(parent, &format!("floti agent wait {name} --json"))
            .await;
        let answer: Value = serde_json::from_str(waited.stdout.trim()).ok()?;
        answer["news"].as_array()?.first().cloned()
    })
    .await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_command_child_runs_in_the_callers_folder_through_the_users_shell_with_no_agent_in_it() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("run folder");
    let script = command_script(&world);
    for backend in [CLAUDE, OTHER] {
        let parent = world
            .session(backend, &folder, &format!("parent {backend}"))
            .await;
        let runs = world.run_count();
        let record = record_file(&world, backend);
        let started = world
            .shell(
                &parent,
                &run_script(
                    "--name tests",
                    &script,
                    &format!("--count 3 --hold --record \"{}\"", text(&record)),
                ),
            )
            .await;
        assert_eq!(started.code, Some(0), "{started:?}");
        // The name alone, for a script to keep.
        assert_eq!(started.stdout.trim(), "tests", "{started:?}");

        let child = command_child(&world, &parent, "tests").await;
        assert_eq!(child.backend, BackendId::new("shell"), "{child:?}");
        assert_eq!(child.parent_id, Some(parent.id()), "{child:?}");
        assert_eq!(child.role, None, "no role: {child:?}");
        assert!(same_folder(Path::new(&child.cwd), &folder), "{child:?}");
        let line = child.command.clone().expect("the command line");
        assert!(
            line.contains("emit lines.mjs") && line.contains("--count 3"),
            "{line}"
        );
        // The user's shell was given the line, with its own flags first.
        assert!(child.argv.len() >= 2, "{child:?}");
        assert!(child.argv[0].starts_with('-'), "{child:?}");
        assert!(
            child
                .argv
                .last()
                .is_some_and(|last| last.contains("emit lines.mjs")),
            "{child:?}"
        );

        // It ran in the caller's folder, as a process of its own.
        let ran = recorded(&record).await;
        assert!(
            same_folder(Path::new(ran["cwd"].as_str().expect("a folder")), &folder),
            "{ran}"
        );
        assert!(alive(pid_of(&ran)));

        // No agent: no run of a fake, no token and no tools in its row.
        assert_eq!(world.run_count(), runs, "a command is not an agent");
        assert_eq!(world.row_text(child.id, "agent_tools"), None);
        assert_eq!(world.status(child.id), "running");
        parent.stop("tests").await.done();
        ended_row(&world, child.id).await;
        gone_pids("the command's process to end", &[pid_of(&ran)]).await;
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_command_without_a_name_is_named_after_its_program_and_made_unique_among_all_children() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("names");
    let script = command_script(&world);
    let parent = world.session(CLAUDE, &folder, "parent").await;

    let mut ids = Vec::new();
    for expected in ["node", "node-2", "node-3"] {
        let started = world
            .shell(&parent, &run_script("", &script, "--hold"))
            .await;
        assert_eq!(started.code, Some(0), "{started:?}");
        assert_eq!(started.stdout.trim(), expected, "{started:?}");
        ids.push(command_child(&world, &parent, expected).await.id);
    }

    // An agent child's name is taken as well.
    parent
        .start(json!({ "task": "work", "name": "tests" }))
        .await
        .done();
    let started = world
        .shell(&parent, &run_script("--name tests", &script, "--hold"))
        .await;
    assert_eq!(started.stdout.trim(), "tests-2", "{started:?}");
    ids.push(command_child(&world, &parent, "tests-2").await.id);

    // The caller's own children are the only ones its names are among.
    let other = world.session(OTHER, &folder, "other").await;
    let started = world
        .shell(&other, &run_script("", &script, "--hold"))
        .await;
    assert_eq!(started.stdout.trim(), "node", "{started:?}");
    ids.push(command_child(&world, &other, "node").await.id);

    world.close(&parent).await;
    world.close(&other).await;
    world
        .ended("the command children to end with their parents", &ids)
        .await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_command_child_ends_with_its_exit_code_and_its_parent_is_told_the_last_40_lines() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("exits");
    let script = command_script(&world);
    for backend in [CLAUDE, OTHER] {
        let parent = world
            .session(backend, &folder, &format!("parent {backend}"))
            .await;
        let started = world
            .shell(
                &parent,
                &run_script("--name tests", &script, "--count 60 --code 3"),
            )
            .await;
        assert_eq!(started.code, Some(0), "{started:?}");
        let child = command_child(&world, &parent, "tests").await;
        let ended = ended_row(&world, child.id).await;
        assert_eq!(ended.exit_code, Some(3), "{ended:?}");
        assert!(!ended.stopped, "it exited on its own: {ended:?}");

        // Its parent's wait gives the code and the last 40 lines, no more.
        let news = exit_news(&world, &parent, "tests").await;
        assert_eq!(news["event"], "ended", "{news}");
        assert_eq!(news["child"], "tests", "{news}");
        assert_eq!(news["exitCode"], 3, "{news}");
        let lines = strings(&news["lastLines"]);
        assert_eq!(lines.len(), 40, "{lines:?}");
        assert_eq!(lines.first().map(String::as_str), Some("line 21"));
        assert_eq!(lines.last().map(String::as_str), Some("line 60"));

        // As text, what a model reads.
        let quiet = world
            .shell(
                &parent,
                &run_script("--name quiet", &script, "--count 3 --code 0"),
            )
            .await;
        assert_eq!(quiet.code, Some(0), "{quiet:?}");
        let told = eventually("the command's exit to reach its parent", async || {
            let waited = world.shell(&parent, "floti agent wait quiet").await;
            waited
                .stdout
                .contains("quiet ended with exit code 0.")
                .then_some(waited.stdout)
        })
        .await;
        assert!(told.contains("Its last lines:"), "{told}");
        assert!(told.contains("line 3"), "{told}");
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn run_wait_returns_the_name_exit_code_and_lines_and_exits_with_the_commands_code() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("waits");
    let script = command_script(&world);
    for backend in [CLAUDE, OTHER] {
        let parent = world
            .session(backend, &folder, &format!("parent {backend}"))
            .await;

        let passed = world
            .shell(
                &parent,
                &run_script("--wait --name quick", &script, "--count 3 --code 0"),
            )
            .await;
        assert_eq!(passed.code, Some(0), "{passed:?}");
        assert_eq!(passed.stdout.lines().next(), Some("quick"), "{passed:?}");
        assert!(
            passed.stdout.contains("quick ended with exit code 0."),
            "{passed:?}"
        );
        assert!(passed.stdout.contains("line 3"), "{passed:?}");

        let failed = world
            .shell(
                &parent,
                &run_script("--wait --name failing", &script, "--count 2 --code 7"),
            )
            .await;
        assert_eq!(failed.code, Some(7), "{failed:?}");
        assert_eq!(failed.stdout.lines().next(), Some("failing"), "{failed:?}");
        assert!(
            failed.stdout.contains("failing ended with exit code 7."),
            "{failed:?}"
        );
        assert!(failed.stdout.contains("line 2"), "{failed:?}");

        // --json is the tool's own answer, and the status is still the code.
        let as_json = world
            .shell(
                &parent,
                &run_script("--wait --json --name shaped", &script, "--count 2 --code 2"),
            )
            .await;
        assert_eq!(as_json.code, Some(2), "{as_json:?}");
        let answer: Value = serde_json::from_str(as_json.stdout.trim()).expect("the tool's JSON");
        assert_eq!(answer["name"], "shaped", "{answer}");
        assert_eq!(answer["news"][0]["exitCode"], 2, "{answer}");
        let lines = strings(&answer["news"][0]["lastLines"]);
        assert!(
            lines.ends_with(&["line 1".to_owned(), "line 2".to_owned()]),
            "{lines:?}"
        );

        // The same through the subcommand's own code, with no shell between.
        let (url, token) = parent.route();
        let outcome = subcommand(
            Subcommand::Run(RunCommand {
                command: vec![
                    "node".to_owned(),
                    text(&script),
                    "--code".to_owned(),
                    "4".to_owned(),
                ],
                name: Some("direct".to_owned()),
                wait: true,
                json: false,
            }),
            url,
            token,
        )
        .await;
        assert_eq!(outcome.code, 4, "{outcome:?}");
        assert!(
            outcome
                .out
                .as_deref()
                .is_some_and(|out| out.starts_with("direct\n")),
            "{outcome:?}"
        );
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_command_child_takes_no_turns_so_a_send_to_it_is_refused() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("turns");
    let script = command_script(&world);
    for backend in [CLAUDE, OTHER] {
        let parent = world
            .session(backend, &folder, &format!("parent {backend}"))
            .await;
        let record = record_file(&world, &format!("turns {backend}"));
        let started = world
            .shell(
                &parent,
                &run_script(
                    "--name server",
                    &script,
                    &format!("--hold --record \"{}\"", text(&record)),
                ),
            )
            .await;
        assert_eq!(started.code, Some(0), "{started:?}");
        recorded(&record).await;
        let child = command_child(&world, &parent, "server").await;

        let sent = parent.send("server", "hello").await;
        assert!(sent.refused().contains("takes no turns"), "{sent:?}");
        let interrupting = parent
            .call(
                "agents_send",
                json!({ "child": "server", "text": "hello", "interrupt": true }),
            )
            .await;
        assert!(
            interrupting.refused().contains("takes no turns"),
            "{interrupting:?}"
        );
        let by_command = world.shell(&parent, "floti agent send server hello").await;
        assert_ne!(by_command.code, Some(0), "{by_command:?}");
        assert!(
            by_command.stderr.contains("takes no turns"),
            "{by_command:?}"
        );
        assert!(by_command.stdout.trim().is_empty(), "{by_command:?}");
        assert_eq!(world.status(child.id), "running");

        parent.stop("server").await.done();
        ended_row(&world, child.id).await;
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_command_child_ends_with_its_parent_or_when_its_parent_stops_it_and_no_one_elses_does() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("endings");
    let script = command_script(&world);
    let parent = world.session(CLAUDE, &folder, "parent").await;
    let stranger = world.session(OTHER, &folder, "stranger").await;

    let mut pids = Vec::new();
    for name in ["first", "second"] {
        let record = record_file(&world, name);
        let started = world
            .shell(
                &parent,
                &run_script(
                    &format!("--name {name}"),
                    &script,
                    &format!("--hold --record \"{}\"", text(&record)),
                ),
            )
            .await;
        assert_eq!(started.code, Some(0), "{started:?}");
        pids.push(pid_of(&recorded(&record).await));
    }
    let first = command_child(&world, &parent, "first").await;
    let second = command_child(&world, &parent, "second").await;

    // Another session reaches neither by its name.
    let refused = stranger.stop("first").await;
    assert!(
        refused.refused().contains("No agent of yours is named"),
        "{refused:?}"
    );
    let waited = stranger
        .call("agents_wait", json!({ "children": ["first"] }))
        .await;
    assert!(waited.failed, "{waited:?}");
    assert_eq!(world.status(first.id), "running");
    assert!(alive(pids[0]));

    // Its parent ends one sooner, from its shell.
    let stopped = world.shell(&parent, "floti agent stop first").await;
    assert_eq!(stopped.code, Some(0), "{stopped:?}");
    let ended = ended_row(&world, first.id).await;
    assert!(ended.stopped, "{ended:?}");
    gone_pids("the stopped command's process to end", &pids[..1]).await;
    assert_eq!(world.status(second.id), "running");
    assert!(alive(pids[1]));

    // The other ends with its parent.
    world.close(&parent).await;
    ended_row(&world, second.id).await;
    gone_pids("the command's process to end with its parent", &pids[1..]).await;
    assert_eq!(world.status(stranger.id()), "running");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn run_is_no_tool_in_the_family_and_a_plain_tool_call_cannot_reach_it() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("no tool");
    for backend in [CLAUDE, OTHER] {
        let parent = world
            .session(backend, &folder, &format!("parent {backend}"))
            .await;
        let tools = parent.tool_names().await;
        assert!(!tools.iter().any(|tool| tool.contains("run")), "{tools:?}");

        // Not from a client that is no shell: it is not a tool there.
        let called = parent
            .call(
                "agents_run",
                json!({ "command": ["node", "-v"], "name": "sneaky" }),
            )
            .await;
        assert!(
            called.refused().contains("has no tool named agents_run"),
            "{called:?}"
        );
        assert_eq!(world.children_made(), 0, "nothing started");
    }

    // A shell is told what to give.
    let parent = world.session(CLAUDE, &folder, "shell parent").await;
    let empty = world.shell(&parent, "floti agent run --name nothing").await;
    assert_ne!(empty.code, Some(0), "{empty:?}");
    assert!(
        empty.stderr.contains("Give the command after --"),
        "{empty:?}"
    );
    assert_eq!(world.children_made(), 0, "nothing started");
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Read: a parent sees its child's screen
// ---------------------------------------------------------------------------

impl Agent {
    /// `agents_read` of `child`, with `lines` above the screen when given.
    async fn read(&self, child: &str, lines: Option<u64>) -> Called {
        let mut arguments = json!({ "child": child });
        if let Some(lines) = lines {
            arguments["lines"] = json!(lines);
        }
        self.call("agents_read", arguments).await
    }
}

/// The lines an `agents_read` answer holds, from its JSON block.
fn read_lines(read: &Called) -> Vec<String> {
    strings(&read.done()["lines"])
}

/// What a shell printed, with the line breaks of every OS as `\n` and the
/// last one dropped.
fn printed(run: &ShellRun) -> String {
    run.stdout
        .replace("\r\n", "\n")
        .trim_end_matches('\n')
        .to_owned()
}

/// The numbered lines of `lines`, in the order they were printed.
fn numbered(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .filter(|line| line.starts_with("line "))
        .cloned()
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_parent_reads_the_screen_and_up_to_200_lines_above_it_of_a_child_as_plain_text_on_either_backend()
 {
    let world = World::new();
    let host = world.host().await;
    for backend in [CLAUDE, OTHER] {
        let (parent, child) = world.family(backend, "worker").await;
        // More than a screen (32 rows) and more than 200 lines of output.
        parent.send("worker", "/flood 400").await.done();
        let full = eventually("the flood to reach the child's screen", async || {
            let read = parent.read("worker", None).await;
            (!read.failed && read.text().contains("flood done")).then_some(read)
        })
        .await;
        let typed_before = typed_into(&world.reread(&child));

        // The screen and 200 lines above it, as text.
        let default = read_lines(&full);
        let screen = read_lines(&parent.read("worker", Some(0)).await);
        assert!(
            (1..=32).contains(&screen.len()),
            "{backend}: the screen is {} lines",
            screen.len()
        );
        assert_eq!(default.len(), screen.len() + 200, "{backend}");
        assert!(
            default[0].starts_with("flood "),
            "{backend}: the first line above the screen: {:?}",
            default[0]
        );
        assert!(
            default.iter().any(|line| line.contains("flood done")),
            "{backend}"
        );
        assert!(
            !full.text().contains('\u{1b}') && !default.iter().any(|line| line.contains('\u{1b}')),
            "{backend}: an escape sequence in the text"
        );
        assert_eq!(full.text(), default.join("\n"), "{backend}");
        assert_eq!(
            default[200..],
            screen[..],
            "{backend}: the screen is the end of the text"
        );

        // With lines, at most that many above the screen; never more than 200.
        let five = read_lines(&parent.read("worker", Some(5)).await);
        assert_eq!(five.len(), screen.len() + 5, "{backend}");
        assert_eq!(five[5..], screen[..], "{backend}");
        let many = read_lines(&parent.read("worker", Some(5000)).await);
        assert_eq!(many, default, "{backend}: never more than 200 above");

        // The same from the parent's shell.
        let by_command = world
            .shell(&parent, "floti agent read worker --lines 5")
            .await;
        assert_eq!(by_command.code, Some(0), "{by_command:?}");
        assert_eq!(printed(&by_command), five.join("\n"), "{backend}");
        let json = world
            .shell(&parent, "floti agent read worker --lines 0 --json")
            .await;
        assert_eq!(json.code, Some(0), "{json:?}");
        let answer: Value = serde_json::from_str(json.stdout.trim()).expect("JSON");
        assert_eq!(strings(&answer["lines"]), screen, "{backend}");
        assert_eq!(answer["name"], "worker");
        assert_eq!(answer["command"], false);

        // A number that is no number of lines is refused, naming lines.
        for lines in [json!(-1), json!("many"), json!(1.5)] {
            let refused = parent
                .call("agents_read", json!({ "child": "worker", "lines": lines }))
                .await;
            assert!(refused.refused().contains("lines is a whole number"));
        }

        // Reading typed nothing into the child, and it still runs.
        assert_eq!(typed_into(&world.reread(&child)), typed_before, "{backend}");
        assert_eq!(world.status(child.id()), "running");
        parent.stop("worker").await.done();
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_child_that_has_ended_has_no_screen_to_read_and_the_answer_says_so() {
    let world = World::new();
    let host = world.host().await;
    let (parent, child) = world.family(OTHER, "done").await;
    parent.send("done", "/exit").await.done();
    world.ended("the child to exit", &[child.id()]).await;
    let read = parent.read("done", None).await;
    assert!(read.refused().contains("has ended"), "{read:?}");
    assert!(read.text().contains("no screen"), "{read:?}");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_parent_reads_a_command_childs_recent_output_while_it_runs_and_its_last_lines_once_it_has_exited()
 {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("read commands");
    let script = command_script(&world);
    for backend in [CLAUDE, OTHER] {
        let parent = world
            .session(backend, &folder, &format!("parent {backend}"))
            .await;

        // Running: 60 lines printed, the command still alive.
        let started = world
            .shell(
                &parent,
                &run_script("--name serving", &script, "--count 60 --hold"),
            )
            .await;
        assert_eq!(started.code, Some(0), "{started:?}");
        let serving = command_child(&world, &parent, "serving").await;
        let running = eventually("the command's output on its screen", async || {
            let read = parent.read("serving", None).await;
            (!read.failed && read.text().contains("line 60")).then_some(read)
        })
        .await;
        let body = running.done();
        assert_eq!(body["command"], true, "{body}");
        assert_eq!(body["ended"], false, "{body}");
        let lines = strings(&body["lines"]);
        assert!(!running.text().contains('\u{1b}'), "{backend}");
        assert_eq!(
            numbered(&lines),
            (1..=60).map(|n| format!("line {n}")).collect::<Vec<_>>(),
            "{backend}: {lines:?}"
        );
        // Only the screen: the 32 rows of a child's terminal, the last 60
        // lines' end among them.
        let screen = read_lines(&parent.read("serving", Some(0)).await);
        assert!(screen.len() <= 32, "{backend}: {screen:?}");
        assert_eq!(screen.last().map(String::as_str), Some("line 60"));
        let by_command = world.shell(&parent, "floti agent read serving").await;
        assert_eq!(by_command.code, Some(0), "{by_command:?}");
        assert_eq!(printed(&by_command), running.text(), "{backend}");

        // Exited: 60 lines and exit code 3; the last 40 are what is kept.
        let ran = world
            .shell(
                &parent,
                &run_script("--name finished", &script, "--count 60 --code 3"),
            )
            .await;
        assert_eq!(ran.code, Some(0), "{ran:?}");
        let finished = command_child(&world, &parent, "finished").await;
        assert_eq!(ended_row(&world, finished.id).await.exit_code, Some(3));
        let after = parent.read("finished", None).await;
        let body = after.done();
        assert_eq!(body["command"], true, "{body}");
        assert_eq!(body["ended"], true, "{body}");
        let kept = strings(&body["lines"]);
        assert_eq!(kept.len(), 40, "{backend}: {kept:?}");
        assert_eq!(kept.first().map(String::as_str), Some("line 21"));
        assert_eq!(kept.last().map(String::as_str), Some("line 60"));
        assert!(!after.text().contains('\u{1b}'), "{backend}");
        // The same lines the parent is told with the exit, and from its shell.
        let news = exit_news(&world, &parent, "finished").await;
        assert_eq!(strings(&news["lastLines"]), kept, "{backend}");
        let by_command = world.shell(&parent, "floti agent read finished").await;
        assert_eq!(printed(&by_command), kept.join("\n"), "{backend}");

        parent.stop("serving").await.done();
        ended_row(&world, serving.id).await;
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_names_only_the_callers_own_children_and_nothing_is_typed_into_any_session() {
    let world = World::new();
    let host = world.host().await;
    let a = world
        .session(CLAUDE, &world.project("alpha read"), "alpha")
        .await;
    let b = world
        .session(OTHER, &world.project("bravo read"), "bravo")
        .await;
    let x = world
        .session(OTHER, &world.project("xray read"), "xray")
        .await;
    for (parent, kid, backend) in [
        (&a, "a-one", OTHER),
        (&a, "a-two", CLAUDE),
        (&b, "b-one", CLAUDE),
    ] {
        parent
            .start(json!({ "task": "work", "name": kid, "backend": backend }))
            .await
            .done();
    }
    let a_one = world.child_of(&a, "a-one").await;
    let a_two = world.child_of(&a, "a-two").await;
    let b_one = world.child_of(&b, "b-one").await;

    let everyone: [(&Agent, Option<&str>, Option<u64>); 6] = [
        (&a, None, None),
        (&b, None, None),
        (&x, None, None),
        (&a_one, Some("a-one"), Some(a.id())),
        (&a_two, Some("a-two"), Some(a.id())),
        (&b_one, Some("b-one"), Some(b.id())),
    ];
    let before: Vec<_> = everyone
        .iter()
        .map(|(agent, _, _)| typed_into(&world.reread(agent)))
        .collect();

    let mut calls = 0;
    for (caller, _, _) in everyone {
        for (other, child_name, owner) in everyone {
            // The caller's own children are what a read is for.
            if owner == Some(caller.id()) {
                continue;
            }
            // Its parent, itself, a sibling or a session it did not start: by
            // name, id, conversation, process and folder.
            for target in names_of(other, child_name)
                .into_iter()
                .filter(|target| !target.trim().is_empty())
            {
                let call = format!("{} naming {} as {target:?}", caller.name(), other.name());
                let read = caller.read(&target, Some(200)).await;
                assert!(
                    read.refused().contains("No agent of yours is named"),
                    "agents_read {call}: {read:?}"
                );
                let (url, token) = caller.route();
                let by_command =
                    subcommand(Subcommand::Read(cli_read(&target, Some(200))), url, token).await;
                assert_eq!(
                    by_command.code, 1,
                    "floti agent read {call}: {by_command:?}"
                );
                assert!(
                    by_command
                        .err
                        .as_deref()
                        .is_some_and(|err| err.contains("No agent of yours is named")),
                    "floti agent read {call}: {by_command:?}"
                );
                assert!(by_command.out.is_none(), "{call}: {by_command:?}");
                calls += 1;
            }
        }
    }
    assert!(calls > 60, "the reach test made {calls} rounds of calls");

    for ((agent, _, _), before) in everyone.iter().zip(&before) {
        assert_eq!(
            &typed_into(&world.reread(agent)),
            before,
            "something was typed into {}",
            agent.name()
        );
        assert_eq!(world.status(agent.id()), "running");
    }
    host.stop(HostStopReason::Stop).await;
}

fn cli_read(child: &str, lines: Option<u32>) -> ReadCommand {
    ReadCommand {
        child: child.to_owned(),
        lines,
        json: false,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn only_a_command_childs_own_parent_waits_on_reads_or_stops_it() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("reach");
    let script = command_script(&world);
    // A grandparent, its child (the command child's parent) and that child's
    // sibling; another family; and a session nobody started.
    let grandparent = world.session(CLAUDE, &folder, "grandparent").await;
    for name in ["mid", "sibling"] {
        grandparent
            .start(json!({ "task": "work", "name": name, "can_start": true }))
            .await
            .done();
    }
    let parent = world.child_of(&grandparent, "mid").await;
    let sibling = world.child_of(&grandparent, "sibling").await;
    let other_parent = world.session(OTHER, &folder, "other parent").await;
    let loner = world.session(CLAUDE, &folder, "loner").await;

    let record = record_file(&world, "reach");
    let started = world
        .shell(
            &parent,
            &run_script(
                "--name tests",
                &script,
                &format!("--count 3 --hold --record \"{}\"", text(&record)),
            ),
        )
        .await;
    assert_eq!(started.code, Some(0), "{started:?}");
    let pid = pid_of(&recorded(&record).await);
    let tests = command_child(&world, &parent, "tests").await;
    eventually("the command's lines on its screen", async || {
        parent
            .read("tests", None)
            .await
            .text()
            .contains("line 3")
            .then_some(())
    })
    .await;

    // A sibling, another parent, the grandparent and a session nobody started
    // are all told there is no such child, by every route.
    for stranger in [&sibling, &other_parent, &grandparent, &loner] {
        let who = stranger.name();
        let waited = stranger
            .call("agents_wait", json!({ "children": ["tests"] }))
            .await;
        assert!(
            waited.refused().contains("tests is not one of your agents"),
            "{who} waiting: {waited:?}"
        );
        let read = stranger.read("tests", None).await;
        assert!(
            read.refused().contains("No agent of yours is named tests"),
            "{who} reading: {read:?}"
        );
        let stopped = stranger.stop("tests").await;
        assert!(
            stopped
                .refused()
                .contains("No agent of yours is named tests"),
            "{who} stopping: {stopped:?}"
        );
        let sent = stranger.send("tests", "hello").await;
        assert!(
            sent.refused().contains("No agent of yours is named tests"),
            "{who} sending: {sent:?}"
        );
        for command in [
            "floti agent wait tests",
            "floti agent read tests",
            "floti agent stop tests",
        ] {
            let ran = world.shell(stranger, command).await;
            assert_ne!(ran.code, Some(0), "{who}: {command}: {ran:?}");
            assert!(ran.stdout.trim().is_empty(), "{who}: {command}: {ran:?}");
        }
    }
    // Nothing of that reached it.
    assert_eq!(world.status(tests.id), "running");
    assert!(alive(pid));

    // Its parent reaches it: reads it, then stops it.
    let own = world.shell(&parent, "floti agent read tests").await;
    assert_eq!(own.code, Some(0), "{own:?}");
    assert!(printed(&own).contains("line 3"), "{own:?}");
    parent.stop("tests").await.done();
    assert!(ended_row(&world, tests.id).await.stopped);
    gone_pids("the stopped command's process to end", &[pid]).await;
    host.stop(HostStopReason::Stop).await;
}

/// Runs a command child called `name` that stays until it is ended.
async fn run_held(world: &World, parent: &Agent, script: &Path, name: &str) -> ShellRun {
    world
        .shell(
            parent,
            &run_script(&format!("--name {name}"), script, "--hold"),
        )
        .await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_fifth_command_child_is_refused_naming_the_limit_and_what_holds_it() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("fifth");
    let script = command_script(&world);
    let parent = world.session(CLAUDE, &folder, "parent").await;

    let mut ids = Vec::new();
    for name in ["one", "two", "three", "four"] {
        let started = run_held(&world, &parent, &script, name).await;
        assert_eq!(started.code, Some(0), "{started:?}");
        ids.push(command_child(&world, &parent, name).await.id);
    }
    let fifth = run_held(&world, &parent, &script, "five").await;
    assert_ne!(fifth.code, Some(0), "{fifth:?}");
    assert!(
        fifth
            .stderr
            .contains("The command-children limit of 4 per parent holds"),
        "{fifth:?}"
    );
    for holder in ["one", "two", "three", "four"] {
        assert!(fifth.stderr.contains(holder), "{fifth:?}");
    }
    assert!(fifth.stderr.contains("emit lines.mjs"), "{fifth:?}");
    assert!(fifth.stderr.contains("Wait for news and run again"));
    assert!(fifth.stdout.trim().is_empty(), "{fifth:?}");
    assert_eq!(world.newest_child_id(parent.id(), "five"), None);

    // A command that ends makes room for the next.
    parent.stop("one").await.done();
    ended_row(&world, ids[0]).await;
    let again = run_held(&world, &parent, &script, "five").await;
    assert_eq!(again.code, Some(0), "{again:?}");
    command_child(&world, &parent, "five").await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn command_children_are_counted_apart_from_every_agent_limit() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("apart");
    let script = command_script(&world);

    // Every agent slot taken: the parent still runs a command.
    let full = world.session(CLAUDE, &folder, "full of agents").await;
    for name in ["a1", "a2", "a3", "a4"] {
        full.start(json!({ "task": "work", "name": name, "backend": OTHER }))
            .await
            .done();
    }
    let refused = full.start(json!({ "task": "one more" })).await;
    assert!(refused.refused().contains("limit of 4 running agents"));
    let started = run_held(&world, &full, &script, "tests").await;
    assert_eq!(started.code, Some(0), "{started:?}");
    command_child(&world, &full, "tests").await;
    let limits = full.list().await.done()["limits"].clone();
    assert_eq!(limits["childrenLeft"], 0, "{limits}");
    assert_eq!(limits["commandsLeft"], 3, "{limits}");
    assert_eq!(limits["commandsPerParent"], 4, "{limits}");

    // Every command slot taken: the parent still starts an agent, and the
    // agent limits, the host's eight among them, are as they were.
    let busy = world.session(OTHER, &folder, "full of commands").await;
    for name in ["c1", "c2", "c3", "c4"] {
        let started = run_held(&world, &busy, &script, name).await;
        assert_eq!(started.code, Some(0), "{started:?}");
        command_child(&world, &busy, name).await;
    }
    let before = busy.list().await.done()["limits"].clone();
    assert_eq!(before["commandsLeft"], 0, "{before}");
    assert_eq!(before["childrenLeft"], 4, "{before}");
    assert_eq!(before["startsLeft"], 16, "{before}");
    assert_eq!(before["hostLeft"], 4, "{before}");
    busy.start(json!({ "task": "work", "name": "agent-after" }))
        .await
        .done();
    let after = busy.list().await.done()["limits"].clone();
    assert_eq!(after["childrenLeft"], 3, "{after}");
    assert_eq!(after["startsLeft"], 15, "{after}");
    assert_eq!(after["hostLeft"], 3, "{after}");
    assert_eq!(after["commandsLeft"], 0, "{after}");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn the_command_children_limit_is_read_afresh_from_the_settings_on_every_run() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("settings run");
    let script = command_script(&world);
    let parent = world.session(CLAUDE, &folder, "parent").await;
    let limit = |commands: u32| HostSettingsPatch {
        agent_commands_per_parent: Some(commands),
        ..HostSettingsPatch::default()
    };

    world.settings(limit(1)).await;
    let first = run_held(&world, &parent, &script, "first").await;
    assert_eq!(first.code, Some(0), "{first:?}");
    command_child(&world, &parent, "first").await;
    let refused = run_held(&world, &parent, &script, "second").await;
    assert!(
        refused
            .stderr
            .contains("The command-children limit of 1 per parent holds"),
        "{refused:?}"
    );

    // Raised: the next run goes through.
    world.settings(limit(2)).await;
    let second = run_held(&world, &parent, &script, "second").await;
    assert_eq!(second.code, Some(0), "{second:?}");
    command_child(&world, &parent, "second").await;
    let refused = run_held(&world, &parent, &script, "third").await;
    assert!(
        refused
            .stderr
            .contains("The command-children limit of 2 per parent holds"),
        "{refused:?}"
    );

    // Lowered under what runs: nothing ends and the next run is refused.
    world.settings(limit(1)).await;
    let refused = run_held(&world, &parent, &script, "third").await;
    assert!(
        refused.stderr.contains("limit of 1 per parent"),
        "{refused:?}"
    );
    let listed = parent.list().await.done();
    assert_eq!(listed["children"].as_array().map(Vec::len), Some(2));
    assert_eq!(listed["limits"]["commandsPerParent"], 1, "{listed}");
    assert_eq!(listed["limits"]["commandsLeft"], 0, "{listed}");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn agents_list_shows_a_command_child_with_its_command_and_how_many_command_children_are_left()
{
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("listing");
    let script = command_script(&world);
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "reviewer-1", "backend": OTHER }))
        .await
        .done();
    let started = run_held(&world, &parent, &script, "tests").await;
    assert_eq!(started.code, Some(0), "{started:?}");
    command_child(&world, &parent, "tests").await;

    let listed = parent.list().await;
    let body = listed.done();
    let children = body["children"].as_array().expect("children");
    assert_eq!(children.len(), 2, "{body}");
    let agent = children
        .iter()
        .find(|child| child["name"] == "reviewer-1")
        .expect("the agent");
    let command = children
        .iter()
        .find(|child| child["name"] == "tests")
        .expect("the command child");
    // The agent has its role and no command; the command child its command
    // where the role would be.
    assert_eq!(agent["command"], Value::Null, "{agent}");
    assert!(agent["role"].is_string(), "{agent}");
    assert_eq!(command["role"], Value::Null, "{command}");
    assert_eq!(command["class"], Value::Null, "{command}");
    assert_eq!(command["backend"], "shell", "{command}");
    let line = command["command"].as_str().expect("a command");
    assert!(line.contains("emit lines.mjs") && line.contains("--hold"));
    assert_eq!(body["limits"]["commandsLeft"], 3, "{body}");
    assert_eq!(body["limits"]["commandsPerParent"], 4, "{body}");
    // An agent's slots do not count the command child.
    assert_eq!(body["limits"]["childrenLeft"], 3, "{body}");
    assert_eq!(body["limits"]["startsLeft"], 15, "{body}");

    // The text a model reads says it as well.
    let text = listed.text();
    assert!(
        text.contains(&format!("tests  command {line}")),
        "the command child's line: {text}"
    );
    assert!(text.contains("reviewer-1  role "), "{text}");
    assert!(
        text.contains("3 of 4 command children running at once"),
        "{text}"
    );
    host.stop(HostStopReason::Stop).await;
}
