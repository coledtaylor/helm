//! Roles: the files an agent starts its children in, read from the host's
//! config folder. A host whose sessions run the fake `claude`
//! (`test/fake-agents/claude-code.mjs`) and the other fake agent
//! (`test/fake-agents/other-agent.mjs`), never a real agent. A session's agent
//! tools are called over HTTP with the URL and bearer token the session itself
//! was given, and `floti agent` runs its own code against the same route.
//!
//! No client is attached while a session works: a client starts the session
//! and goes, and comes back only to restore sessions after the host restarts.
//! The roles folder is under the test's own run root, so no test reads or
//! writes a real one.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::agent::claude_code::{ClaudeCodeBackend, ClaudeCodeSettings};
use floti_host::agent_cli::{
    self, Command as Subcommand, Start as StartCommand, Stop as StopCommand,
};
use floti_host::platform::process_tree::Native as NativeTree;
use floti_host::platform::socket::Endpoint;
use floti_host::server::HostConfig;
use floti_host::testkit::{
    GitRepo, OtherAgent, OtherAgentRecord, PATIENCE, RunningHost, TestClient, TestDirs,
};
use floti_protocol::BackendId;
use floti_protocol::channels::common::{PermissionMode, SessionRecord};
use floti_protocol::channels::host::{HostStop, HostStopReason, HostStopRequest};
use floti_protocol::channels::sessions::{
    RestoreSessionsRequest, SessionList, SessionRestore, SessionStart, SessionToRestore,
    StartSessionRequest,
};
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
// A host with two backends and a roles folder of its own
// ---------------------------------------------------------------------------

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
        ];
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

    /// The roles folder the host reads: `roles` in its config folder.
    fn roles_dir(&self) -> PathBuf {
        self.dirs.config.join("roles")
    }

    /// Writes the role file `<name>.md`. Making the folder is what keeps the
    /// host from seeding it.
    fn role(&self, name: &str, content: &str) {
        std::fs::create_dir_all(self.roles_dir()).expect("make the roles folder");
        std::fs::write(self.roles_dir().join(format!("{name}.md")), content)
            .expect("write a role file");
    }

    fn remove_role(&self, name: &str) {
        std::fs::remove_file(self.roles_dir().join(format!("{name}.md"))).expect("delete a role");
    }

    /// A host that serves once this returns, reading the roles folder as the
    /// installed host does, with the workspace tracked.
    async fn host(&self) -> RunningHost {
        let host = RunningHost::start(self.config());
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
            self.profile("workspace", &self.work, None, None, None);
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

    /// A git repository in the workspace with one commit, for the roles that
    /// work in a worktree.
    fn repository(&self, name: &str) -> PathBuf {
        let repo = GitRepo::init(self.project(name));
        repo.write("README.md", "hello\n");
        repo.commit_all("first");
        resolved(repo.path())
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
    fn profile(
        &self,
        name: &str,
        root: &Path,
        model: Option<&str>,
        effort: Option<&str>,
        mode: Option<&str>,
    ) -> i64 {
        let db = self.db();
        db.execute(
            "INSERT INTO profiles (name, root, overlays, access, model, effort, permission_mode, \
             agent, opening_prompt, session_agents) \
             VALUES (?1, ?2, '[]', '[]', ?3, ?4, ?5, NULL, NULL, NULL)",
            rusqlite::params![name, text(root), model, effort, mode],
        )
        .expect("insert a profile");
        db.last_insert_rowid()
    }

    // -- sessions -----------------------------------------------------------

    /// A session on `backend` in `folder`, started by a client that is gone
    /// once the session is.
    async fn session(&self, backend: &str, folder: &Path, name: &str) -> Agent {
        self.session_as(request(folder, name, backend)).await
    }

    /// As [`Self::session`], in a permission mode.
    async fn session_in(
        &self,
        backend: &str,
        folder: &Path,
        name: &str,
        mode: PermissionMode,
    ) -> Agent {
        let mut asked = request(folder, name, backend);
        asked.permission_mode = Some(mode);
        self.session_as(asked).await
    }

    async fn session_as(&self, request: StartSessionRequest) -> Agent {
        let mut client = self.client().await;
        let record = client
            .request::<SessionStart>(&request)
            .await
            .expect("the session starts");
        drop(client);
        self.agent_of(record, &[]).await
    }

    /// The agent behind `record`, once its fake has logged a run other than
    /// the ones with a pid in `seen`.
    async fn agent_of(&self, record: SessionRecord, seen: &[u32]) -> Agent {
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

    /// Types `line` into `agent` and waits for the fake to take it. The fake
    /// `claude` keeps a conversation to resume only once it has been typed to.
    async fn type_line(&self, agent: &Agent, line: &str) {
        let conversation = agent
            .record
            .conversation_id
            .clone()
            .expect("the session has a conversation");
        let mut client = self.client().await;
        client.attach(1, agent.id()).await;
        client.type_into(1, format!("{line}\r").as_bytes()).await;
        eventually("the agent to take the line", async || {
            self.runs_of(&conversation)
                .into_iter()
                .find(|run| run.pid == agent.run.pid)
                .filter(|run| run.received.iter().any(|got| got == line))
                .map(|_| ())
        })
        .await;
        drop(client);
    }

    /// The child `parent` started under `name`.
    async fn child_of(&self, parent: &Agent, name: &str) -> Agent {
        let id = self
            .child_id(parent.id(), name)
            .unwrap_or_else(|| panic!("{} has no child named {name}", parent.name()));
        let record = self.record(id).await;
        self.agent_of(record, &[]).await
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

    /// One column of session `id`'s row.
    fn column<T: rusqlite::types::FromSql>(&self, id: u64, column: &str) -> T {
        self.db()
            .query_row(
                &format!("SELECT {column} FROM sessions WHERE id = ?1"),
                [i64::try_from(id).unwrap()],
                |row| row.get(0),
            )
            .unwrap_or_else(|err| panic!("read {column} of session {id}: {err}"))
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

    /// Every run of either fake: one more than before means a process started.
    fn run_count(&self) -> usize {
        self.claude_logs().len() + self.other.records().len()
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
    /// The instructions it loaded from the launch's own file, when it did.
    instructions: Option<String>,
    /// The tool servers it loaded, by name: URL and bearer token.
    servers: BTreeMap<String, (String, String)>,
    received: Vec<String>,
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
            instructions: log["composedInstructions"].as_str().map(str::to_owned),
            servers,
            received: strings(&log["received"]),
        }
    }

    fn of_other(record: &OtherAgentRecord) -> Self {
        Self {
            pid: record.pid,
            argv: record.argv.clone(),
            opening_prompt: record.opening_prompt.clone(),
            instructions: record.instructions.clone(),
            servers: record
                .mcp_servers
                .iter()
                .map(|(name, server)| (name.clone(), (server.url.clone(), server.bearer.clone())))
                .collect(),
            received: record.received.clone(),
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

    fn model(&self) -> Option<&str> {
        value_of(&self.argv, "--model")
    }

    fn effort(&self) -> Option<&str> {
        value_of(&self.argv, "--effort")
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

    /// The agents family's URL and the session's token.
    fn route(&self) -> (String, String) {
        self.run
            .servers
            .get(FAMILY)
            .cloned()
            .expect("the session was given the agents family")
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

    async fn roles(&self) -> Called {
        self.call("agents_roles", json!({})).await
    }

    /// Each role `agents_roles` lists, by name: its JSON entry.
    async fn role_entries(&self) -> BTreeMap<String, Value> {
        self.roles().await.done()["roles"]
            .as_array()
            .expect("a list of roles")
            .iter()
            .map(|role| {
                (
                    role["name"].as_str().expect("a name").to_owned(),
                    role.clone(),
                )
            })
            .collect()
    }

    /// The names `agents_roles` lists, in the order it lists them.
    async fn role_names(&self) -> Vec<String> {
        self.roles().await.done()["roles"]
            .as_array()
            .expect("a list of roles")
            .iter()
            .map(|role| role["name"].as_str().expect("a name").to_owned())
            .collect()
    }
}

/// The backends of one `agents_roles` entry.
fn backends_of(role: &Value) -> Vec<String> {
    strings(&role["backends"])
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

/// The argument after the first `flag`.
fn value_of<'a>(argv: &'a [String], flag: &str) -> Option<&'a str> {
    argv.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].as_str())
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

// ---------------------------------------------------------------------------
// The role files these tests write
// ---------------------------------------------------------------------------

/// A role on both fakes with a body, a model for each and an effort for the
/// first.
const TUNED: &str = "---\n\
description: Tuned for each backend.\n\
backend: claude-code, other-agent\n\
model:\n  claude-code: opus\n  other-agent: small\n\
effort:\n  claude-code: high\n\
---\n\
Work carefully.\n";

// ---------------------------------------------------------------------------
// S1: agents_roles lists what there is
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s1_agents_roles_lists_each_role_with_what_it_is_and_the_backends_it_can_run_on() {
    let world = World::new();
    world.role(
        "scout",
        "---\ndescription: Looks around.\nbackend: claude-code\nclass: heavy\nworktree: yes\ncan_start: yes\n---\nLook.\n",
    );
    world.role("plain-reader", "---\ndescription: Reads.\n---\n");
    world.role("codex-only", "---\nbackend: codex\n---\n");
    let host = world.host().await;
    let folder = world.project("listing");

    for backend in [CLAUDE, OTHER] {
        let parent = world
            .session(backend, &folder, &format!("parent {backend}"))
            .await;
        let asked = parent.roles().await;
        let listed = asked.done();

        // The default role comes first, then the roles by name.
        let names = parent.role_names().await;
        assert_eq!(
            names,
            ["agent", "codex-only", "plain-reader", "scout"],
            "{backend}"
        );
        assert!(listed["bad"].as_array().unwrap().is_empty(), "{listed}");

        let roles = parent.role_entries().await;
        let scout = &roles["scout"];
        assert_eq!(scout["description"], "Looks around.");
        assert_eq!(scout["class"], "heavy");
        assert_eq!(scout["worktree"], true);
        assert_eq!(scout["canStart"], true);
        assert_eq!(backends_of(scout), [CLAUDE]);

        // No backend named: every installed agent backend, in the host's order.
        let reader = &roles["plain-reader"];
        assert_eq!(reader["class"], "light");
        assert_eq!(reader["worktree"], false);
        assert_eq!(reader["canStart"], false);
        assert_eq!(backends_of(reader), [CLAUDE, OTHER]);
        assert_eq!(backends_of(&roles["agent"]), [CLAUDE, OTHER]);

        // A backend that is not installed here runs nothing.
        assert!(backends_of(&roles["codex-only"]).is_empty());

        // The text a model reads names each role and what it is.
        let text = asked.text();
        for word in [
            "scout",
            "Looks around.",
            "class heavy",
            "plain-reader",
            "codex-only",
        ] {
            assert!(text.contains(word), "{word} in {text}");
        }
    }
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S2: every call reads the folder afresh
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s2_a_role_file_added_edited_or_deleted_is_seen_by_the_next_listing_and_start() {
    let world = World::new();
    world.role("existing", "---\n---\n");
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("fresh"), "parent")
        .await;
    assert_eq!(parent.role_names().await, ["agent", "existing"]);

    // Added: listed and started in at once, with no restart.
    world.role("added", "---\ndescription: One.\n---\nFirst words.\n");
    assert_eq!(parent.role_names().await, ["agent", "added", "existing"]);
    parent
        .start(json!({ "task": "go", "role": "added", "name": "first" }))
        .await
        .done();
    let first = world.child_of(&parent, "first").await;
    assert!(
        first
            .run
            .instructions
            .as_deref()
            .unwrap()
            .contains("First words.")
    );

    // Edited: the listing and the next start have the new text.
    world.role("added", "---\ndescription: Two.\n---\nSecond words.\n");
    assert_eq!(parent.role_entries().await["added"]["description"], "Two.");
    parent
        .start(json!({ "task": "go", "role": "added", "name": "second" }))
        .await
        .done();
    let second = world.child_of(&parent, "second").await;
    let composed = second.run.instructions.as_deref().unwrap();
    assert!(
        composed.contains("Second words.") && !composed.contains("First words."),
        "{composed}"
    );

    // Deleted: gone from the listing, and a start naming it is refused.
    world.remove_role("added");
    assert_eq!(parent.role_names().await, ["agent", "existing"]);
    let refused = parent.start(json!({ "task": "go", "role": "added" })).await;
    assert!(
        refused.refused().contains("no role named added"),
        "{refused:?}"
    );
    assert!(
        refused.refused().contains("existing"),
        "the roles are listed: {refused:?}"
    );

    // agent.md replaces the built-in default role.
    world.role(
        "agent",
        "---\ndescription: Mine.\ncan_start: yes\n---\nBe brief.\n",
    );
    assert_eq!(parent.role_entries().await["agent"]["description"], "Mine.");
    parent
        .start(json!({ "task": "go", "name": "default" }))
        .await
        .done();
    let default = world.child_of(&parent, "default").await;
    assert!(
        default
            .run
            .instructions
            .as_deref()
            .unwrap()
            .contains("Be brief.")
    );
    assert!(world.column::<bool>(default.id(), "can_start"));
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S3: a file that is not a role
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s3_a_bad_role_file_is_skipped_and_named_and_a_start_naming_it_is_refused() {
    let world = World::new();
    world.role("fine", "---\ndescription: Fine.\n---\n");
    world.role("typo", "---\ndisalowed_tools: Edit\n---\nbody\n");
    world.role("broken", "---\ndescription: [unclosed\n---\n");
    world.role(
        "odd",
        "---\nclass: medium\neffort:\n  claude-code: loud\n---\n",
    );
    world.role("naked", "no front matter at all\n");
    let host = world.host().await;
    let parent = world.session(CLAUDE, &world.project("bad"), "parent").await;

    let asked = parent.roles().await;
    let listed = asked.done();
    assert_eq!(parent.role_names().await, ["agent", "fine"]);
    let bad: BTreeMap<String, String> = listed["bad"]
        .as_array()
        .unwrap()
        .iter()
        .map(|bad| {
            (
                bad["file"].as_str().unwrap().to_owned(),
                bad["problem"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        bad.keys().map(String::as_str).collect::<Vec<_>>(),
        ["broken.md", "naked.md", "odd.md", "typo.md"]
    );
    assert!(bad["typo.md"].contains("disalowed_tools"), "{bad:?}");
    assert!(bad["broken.md"].contains("does not parse"), "{bad:?}");
    assert!(bad["naked.md"].contains("no front matter"), "{bad:?}");
    assert!(
        bad["odd.md"].contains("class must be light or heavy")
            && bad["odd.md"].contains("effort for claude-code"),
        "every problem is named: {bad:?}"
    );
    // The text names each bad file and its problem too.
    for file in ["typo.md", "broken.md", "naked.md", "odd.md"] {
        assert!(asked.text().contains(file), "{file} in {}", asked.text());
    }
    assert!(asked.text().contains("disalowed_tools"));

    // A start naming one is refused, naming the file and the problem.
    let runs = world.run_count();
    let refused = parent.start(json!({ "task": "go", "role": "typo" })).await;
    let sentence = refused.refused();
    assert!(
        sentence.contains("typo.md") && sentence.contains("disalowed_tools"),
        "{sentence}"
    );
    assert!(sentence.contains("no agent was started"), "{sentence}");
    assert!(
        parent
            .start(json!({ "task": "go", "role": "Naked" }))
            .await
            .refused()
            .contains("naked.md")
    );
    assert_eq!(world.children_made(), 0);
    assert_eq!(world.run_count(), runs, "no process started for a refusal");

    // A file that is fine still starts, and so does the default role.
    parent
        .start(json!({ "task": "go", "role": "fine", "name": "ok" }))
        .await
        .done();
    parent
        .start(json!({ "task": "go", "name": "default" }))
        .await
        .done();
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s3_a_bad_agent_md_refuses_a_start_with_no_role_and_does_not_fall_back_to_the_built_in() {
    let world = World::new();
    world.role("agent", "---\nclass: medium\n---\n");
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("bad default"), "parent")
        .await;

    let refused = parent.start(json!({ "task": "go" })).await;
    assert!(refused.refused().contains("agent.md"), "{refused:?}");
    assert!(
        parent.role_names().await.is_empty(),
        "no role to list but the bad file"
    );
    assert!(
        parent.roles().await.done()["bad"][0]["file"] == "agent.md",
        "the bad file is named"
    );
    assert_eq!(world.children_made(), 0);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S4: the body is instructions, never typed
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_roles_body_reaches_the_child_as_instructions_on_either_backend_and_is_never_typed() {
    let world = World::new();
    world.role(
        "briefed",
        "---\ndescription: Has a brief.\n---\nCheck the notes before you answer.\n",
    );
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("brief"), "parent")
        .await;

    for backend in [CLAUDE, OTHER] {
        let name = format!("kid-{backend}");
        parent
            .start(json!({ "task": "do the thing", "role": "briefed", "backend": backend, "name": name }))
            .await
            .done();
        let child = world.child_of(&parent, &name).await;
        // The project has no overlays: the instructions are the role's alone.
        let loaded = child
            .run
            .instructions
            .as_deref()
            .expect("instructions loaded");
        assert!(loaded.contains("# Role: briefed"), "{backend}: {loaded}");
        assert!(
            loaded.contains("Check the notes before you answer."),
            "{backend}: {loaded}"
        );
        // The task is the only thing typed, and the body is never sent.
        assert_eq!(child.run.opening_prompt.as_deref(), Some("do the thing"));
        assert!(
            child.run.received.is_empty(),
            "{backend}: {:?}",
            child.run.received
        );
        assert!(
            !child
                .run
                .argv
                .iter()
                .any(|arg| arg.contains("Check the notes")),
            "{backend}: the body is not an argument: {:?}",
            child.run.argv
        );
    }

    // A role with no body adds no instructions.
    world.role("bare", "---\ndescription: No brief.\n---\n");
    parent
        .start(json!({ "task": "x", "role": "bare", "name": "bare-kid" }))
        .await
        .done();
    let bare = world.child_of(&parent, "bare-kid").await;
    // Only what Floti adds to every child: the two sections it composes.
    let told = bare.run.instructions.as_deref().unwrap_or_default();
    let headings: Vec<&str> = told.lines().filter(|line| line.starts_with("# ")).collect();
    assert_eq!(
        headings,
        [
            "# Started by another session",
            "# Starting and waiting on agents from your shell"
        ],
        "{told}"
    );
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S5, S6: model and effort for the backend a child runs on
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s5_a_roles_model_and_effort_for_the_chosen_backend_replace_the_profiles() {
    let world = World::new();
    world.role("tuned", TUNED);
    let host = world.host().await;
    let folder = world.project("tuned");
    world.profile("tuned", &folder, Some("profile-model"), Some("low"), None);
    let parent = world
        .session(CLAUDE, &world.project("elsewhere"), "parent")
        .await;
    let request = |backend: &str, name: &str| json!({ "task": "go", "role": "tuned", "backend": backend, "name": name, "folder": text(&folder) });

    parent.start(request(CLAUDE, "on-claude")).await.done();
    let on_claude = world.child_of(&parent, "on-claude").await;
    assert_eq!(on_claude.run.model(), Some("opus"));
    assert_eq!(on_claude.run.effort(), Some("high"));

    // The other backend gets its own model and no effort at all.
    parent.start(request(OTHER, "on-other")).await.done();
    let on_other = world.child_of(&parent, "on-other").await;
    assert_eq!(on_other.run.model(), Some("small"));
    assert_eq!(on_other.run.effort(), None);

    // A role that gives neither leaves the profile's choices as they are.
    world.role("quiet", "---\nbackend: claude-code\n---\n");
    parent
        .start(
            json!({ "task": "go", "role": "quiet", "name": "quiet-kid", "folder": text(&folder) }),
        )
        .await
        .done();
    let quiet = world.child_of(&parent, "quiet-kid").await;
    assert_eq!(quiet.run.model(), Some("profile-model"));
    assert_eq!(quiet.run.effort(), Some("low"));
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s6_an_effort_for_a_backend_with_no_effort_setting_refuses_the_start_naming_both() {
    let world = World::new();
    world.role(
        "efforty",
        "---\nbackend: other-agent\neffort:\n  other-agent: high\n---\n",
    );
    world.role(
        "either",
        "---\nbackend: other-agent, claude-code\neffort:\n  other-agent: high\n---\n",
    );
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("efforts"), "parent")
        .await;
    let runs = world.run_count();

    let refused = parent
        .start(json!({ "task": "go", "role": "efforty" }))
        .await;
    let sentence = refused.refused();
    assert!(
        sentence.contains("effort") && sentence.contains(OTHER),
        "{sentence}"
    );
    assert!(sentence.contains("no agent was started"), "{sentence}");
    // The same when the backend is asked for by name.
    let refused = parent
        .start(json!({ "task": "go", "role": "either", "backend": OTHER }))
        .await;
    let sentence = refused.refused();
    assert!(
        sentence.contains("effort") && sentence.contains(OTHER),
        "{sentence}"
    );
    assert_eq!(world.children_made(), 0);
    assert_eq!(world.run_count(), runs, "no process started for a refusal");

    // With no backend asked for, the first one that can run the role is used,
    // and the listing shows the same.
    assert!(backends_of(&parent.role_entries().await["efforty"]).is_empty());
    assert_eq!(
        backends_of(&parent.role_entries().await["either"]),
        [CLAUDE]
    );
    parent
        .start(json!({ "task": "go", "role": "either", "name": "picked" }))
        .await
        .done();
    let picked = world.child_of(&parent, "picked").await;
    assert_eq!(picked.record.backend, BackendId::new(CLAUDE));
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S7: permission, capped at the parent's
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s7_a_roles_permission_replaces_the_profiles_and_is_capped_at_the_parents() {
    let world = World::new();
    world.role(
        "ceiling",
        "---\nbackend: claude-code\npermission: bypass-permissions\n---\n",
    );
    world.role("calm", "---\nbackend: claude-code\npermission: plan\n---\n");
    world.role("silent", "---\nbackend: claude-code\n---\n");
    let host = world.host().await;
    let plain = world.project("plain");
    let profiled = world.project("profiled");
    world.profile("profiled", &profiled, None, None, Some("acceptEdits"));

    let mode_of = |child: &Agent| world.column::<Option<String>>(child.id(), "permission_mode");

    // A parent in plan: the role asks for bypass, and the child plans.
    let planner = world
        .session_in(CLAUDE, &plain, "planner", PermissionMode::Plan)
        .await;
    planner
        .start(json!({ "task": "go", "role": "ceiling", "name": "capped" }))
        .await
        .done();
    let capped = world.child_of(&planner, "capped").await;
    assert_eq!(mode_of(&capped).as_deref(), Some("plan"));
    assert_eq!(
        value_of(&capped.run.argv, "--permission-mode"),
        Some("plan")
    );

    // A parent in manual caps it to manual.
    let manual = world
        .session_in(CLAUDE, &plain, "manual parent", PermissionMode::Manual)
        .await;
    manual
        .start(json!({ "task": "go", "role": "ceiling", "name": "manual-kid" }))
        .await
        .done();
    assert_eq!(
        mode_of(&world.child_of(&manual, "manual-kid").await).as_deref(),
        Some("manual")
    );

    // A parent in bypass keeps what the role asks for: nothing is above it.
    let bypasser = world
        .session_in(
            CLAUDE,
            &plain,
            "bypasser",
            PermissionMode::BypassPermissions,
        )
        .await;
    bypasser
        .start(json!({ "task": "go", "role": "ceiling", "name": "free" }))
        .await
        .done();
    assert_eq!(
        mode_of(&world.child_of(&bypasser, "free").await).as_deref(),
        Some("bypassPermissions")
    );

    // The role's permission replaces the profile's, then the cap applies.
    bypasser
        .start(
            json!({ "task": "go", "role": "calm", "name": "replaced", "folder": text(&profiled) }),
        )
        .await
        .done();
    assert_eq!(
        mode_of(&world.child_of(&bypasser, "replaced").await).as_deref(),
        Some("plan")
    );
    // A role that says nothing leaves the profile's permission.
    bypasser
        .start(json!({ "task": "go", "role": "silent", "name": "kept", "folder": text(&profiled) }))
        .await
        .done();
    assert_eq!(
        mode_of(&world.child_of(&bypasser, "kept").await).as_deref(),
        Some("acceptEdits")
    );
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S8: may the child start children
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s8_can_start_comes_from_the_role_unless_the_start_says_otherwise_and_depth_still_holds() {
    let world = World::new();
    world.role("boss", "---\nbackend: claude-code\ncan_start: yes\n---\n");
    world.role("pawn", "---\nbackend: claude-code\n---\n");
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("depth"), "parent")
        .await;

    parent
        .start(json!({ "task": "lead", "role": "boss", "name": "boss" }))
        .await
        .done();
    parent
        .start(json!({ "task": "work", "role": "pawn", "name": "pawn" }))
        .await
        .done();
    parent
        .start(json!({ "task": "lead", "role": "boss", "name": "muzzled", "can_start": false }))
        .await
        .done();
    parent
        .start(json!({ "task": "work", "role": "pawn", "name": "promoted", "can_start": true }))
        .await
        .done();
    let boss = world.child_of(&parent, "boss").await;
    let pawn = world.child_of(&parent, "pawn").await;
    let muzzled = world.child_of(&parent, "muzzled").await;
    let promoted = world.child_of(&parent, "promoted").await;
    assert!(world.column::<bool>(boss.id(), "can_start"));
    assert!(!world.column::<bool>(pawn.id(), "can_start"));
    assert!(!world.column::<bool>(muzzled.id(), "can_start"));
    assert!(world.column::<bool>(promoted.id(), "can_start"));

    // A child that may not start agents is told so by the same limit as ever.
    let refused = pawn.start(json!({ "task": "more" })).await;
    assert!(
        refused.refused().contains("without can_start"),
        "{refused:?}"
    );
    let refused = muzzled.start(json!({ "task": "more" })).await;
    assert!(
        refused.refused().contains("without can_start"),
        "{refused:?}"
    );
    // One that may, starts its own.
    boss.start(json!({ "task": "help", "role": "pawn", "name": "grandchild" }))
        .await
        .done();
    promoted
        .start(json!({ "task": "help", "role": "pawn", "name": "grandchild" }))
        .await
        .done();
    assert_eq!(
        world.child_of(&boss, "grandchild").await.record.parent_id,
        Some(boss.id())
    );

    // The depth limit holds for a role that says it may start agents.
    let grandchild = world.child_of(&boss, "grandchild").await;
    let refused = grandchild.start(json!({ "task": "deeper" })).await;
    assert!(refused.refused().contains("depth limit"), "{refused:?}");
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S9: class and worktree
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s9_class_and_worktree_are_kept_on_the_childs_row_and_shown_by_agents_list() {
    let world = World::new();
    world.role(
        "bulk",
        "---\nbackend: claude-code\nclass: heavy\nworktree: yes\n---\n",
    );
    world.role("nimble", "---\nbackend: claude-code\n---\n");
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.repository("classes"), "parent")
        .await;

    parent
        .start(json!({ "task": "build", "role": "bulk", "name": "bulk-kid" }))
        .await
        .done();
    parent
        .start(json!({ "task": "look", "role": "nimble", "name": "nimble-kid" }))
        .await
        .done();
    let bulk = world.child_of(&parent, "bulk-kid").await;
    let nimble = world.child_of(&parent, "nimble-kid").await;

    // Kept on the row beside the role.
    assert_eq!(world.column::<String>(bulk.id(), "child_class"), "heavy");
    assert!(world.column::<bool>(bulk.id(), "child_worktree"));
    assert_eq!(world.column::<String>(bulk.id(), "role"), "bulk");
    assert_eq!(world.column::<String>(nimble.id(), "child_class"), "light");
    assert!(!world.column::<bool>(nimble.id(), "child_worktree"));

    // Shown by agents_list, in the text and the JSON.
    let listed = parent.list().await;
    let json = listed.done();
    let children = json["children"].as_array().unwrap();
    let find = |name: &str| children.iter().find(|child| child["name"] == name).unwrap();
    assert_eq!(find("bulk-kid")["class"], "heavy");
    assert_eq!(find("bulk-kid")["worktree"], true);
    assert_eq!(find("nimble-kid")["class"], "light");
    assert_eq!(find("nimble-kid")["worktree"], false);
    assert!(listed.text().contains("class heavy"), "{}", listed.text());
    assert!(listed.text().contains("class light"), "{}", listed.text());
    // The role's worktree is named after the child; a light role without one
    // runs in the folder it was given.
    let expected = Path::new(&parent.record.cwd).join(".floti/worktrees/bulk-kid");
    assert_eq!(Path::new(&bulk.record.cwd), expected.as_path());
    assert_eq!(bulk.record.branch.as_deref(), Some("agent/bulk-kid"));
    assert_eq!(nimble.record.cwd, parent.record.cwd);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S10: tool rules, on both backends
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s10_allowed_tools_become_each_backends_own_allow_form_beside_the_families() {
    let world = World::new();
    world.role(
        "gated",
        "---\nbackend: claude-code, other-agent\nallowed_tools: Read, Bash(git status:*)\n---\n",
    );
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("allow"), "parent")
        .await;

    parent
        .start(json!({ "task": "go", "role": "gated", "backend": CLAUDE, "name": "on-claude" }))
        .await
        .done();
    let on_claude = world.child_of(&parent, "on-claude").await;
    let allowed = on_claude.run.allowed();
    for rule in [
        "Read",
        "Bash(git status:*)",
        "mcp__floti-agents__agents_start",
    ] {
        assert!(
            allowed.iter().any(|got| got == rule),
            "{rule} in {allowed:?}"
        );
    }

    parent
        .start(json!({ "task": "go", "role": "gated", "backend": OTHER, "name": "on-other" }))
        .await
        .done();
    let on_other = world.child_of(&parent, "on-other").await;
    let allowed = on_other.run.allowed();
    for rule in ["read", "git status", "floti-agents.agents_start"] {
        assert!(
            allowed.iter().any(|got| got == rule),
            "{rule} in {allowed:?}"
        );
    }
    assert_eq!(
        on_other
            .run
            .argv
            .iter()
            .filter(|arg| *arg == "--allow-shell")
            .count(),
        // The role's `git status`, and floti agent start, send, wait, read
        // and stop.
        6
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s10_disallowed_tools_are_passed_to_claude_and_refuse_a_backend_that_cannot_enforce_them() {
    let world = World::new();
    world.role(
        "locked-down",
        "---\nbackend: claude-code\ndisallowed_tools: Edit, Write\n---\n",
    );
    world.role(
        "either-way",
        "---\nbackend: other-agent, claude-code\ndisallowed_tools: Bash(rm:*)\n---\n",
    );
    world.role(
        "other-only",
        "---\nbackend: other-agent\ndisallowed_tools: Edit\n---\n",
    );
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("deny"), "parent")
        .await;
    let runs = world.run_count();

    parent
        .start(json!({ "task": "go", "role": "locked-down", "name": "denied" }))
        .await
        .done();
    let denied = world.child_of(&parent, "denied").await;
    assert_eq!(denied.run.disallowed(), ["Edit", "Write"]);

    // The other backend has no flag that disallows a tool: refused, naming it
    // and the rule, with nothing started.
    let refused = parent
        .start(json!({ "task": "go", "role": "other-only" }))
        .await;
    let sentence = refused.refused();
    assert!(
        sentence.contains(OTHER) && sentence.contains("disallowed_tools rule Edit"),
        "{sentence}"
    );
    let refused = parent
        .start(json!({ "task": "go", "role": "either-way", "backend": OTHER }))
        .await;
    assert!(
        refused
            .refused()
            .contains("disallowed_tools rule Bash(rm:*)"),
        "{refused:?}"
    );
    assert_eq!(world.run_count(), runs + 1, "only the allowed one started");

    // With no backend asked for, the first that can enforce it runs it, and
    // the listing shows only that one.
    let roles = parent.role_entries().await;
    assert_eq!(backends_of(&roles["either-way"]), [CLAUDE]);
    assert!(backends_of(&roles["other-only"]).is_empty());
    parent
        .start(json!({ "task": "go", "role": "either-way", "name": "picked" }))
        .await
        .done();
    let picked = world.child_of(&parent, "picked").await;
    assert_eq!(picked.record.backend, BackendId::new(CLAUDE));
    assert_eq!(picked.run.disallowed(), ["Bash(rm:*)"]);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S11, S12: the folder is seeded once
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s11_a_host_started_with_no_roles_folder_writes_the_shipped_roles_and_lists_them() {
    let world = World::new();
    assert!(!world.roles_dir().exists());
    let host = world.host().await;

    let mut files: Vec<String> = std::fs::read_dir(world.roles_dir())
        .expect("the roles folder was made")
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    files.sort();
    assert_eq!(files, ["lead.md", "reviewer.md", "worker.md"]);

    let parent = world
        .session(CLAUDE, &world.project("seeded"), "parent")
        .await;
    assert_eq!(
        parent.role_names().await,
        ["agent", "lead", "reviewer", "worker"]
    );
    let roles = parent.role_entries().await;
    assert_eq!(roles["lead"]["canStart"], true);
    assert_eq!(roles["worker"]["worktree"], true);
    assert_eq!(roles["reviewer"]["canStart"], false);
    for name in ["lead", "reviewer", "worker"] {
        assert_eq!(backends_of(&roles[name]), [CLAUDE], "{name}");
    }
    assert!(
        parent.roles().await.done()["bad"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s12_a_later_start_never_rewrites_the_folder_an_edit_a_delete_and_an_empty_folder_stay() {
    let world = World::new();
    let host = world.host().await;
    host.stop(HostStopReason::Stop).await;

    // Edited stays edited, deleted stays deleted, and nothing new appears.
    let edited = "---\ndescription: Mine.\n---\nMy own words.\n";
    std::fs::write(world.roles_dir().join("worker.md"), edited).unwrap();
    world.remove_role("lead");
    let host = world.host().await;
    assert_eq!(
        std::fs::read_to_string(world.roles_dir().join("worker.md")).unwrap(),
        edited
    );
    assert!(!world.roles_dir().join("lead.md").exists());
    assert!(world.roles_dir().join("reviewer.md").exists());
    host.stop(HostStopReason::Stop).await;

    // An emptied folder stays empty.
    for name in ["worker", "reviewer"] {
        world.remove_role(name);
    }
    let host = world.host().await;
    assert_eq!(std::fs::read_dir(world.roles_dir()).unwrap().count(), 0);
    let parent = world
        .session(CLAUDE, &world.project("emptied"), "parent")
        .await;
    assert_eq!(parent.role_names().await, ["agent"]);
    host.stop(HostStopReason::Stop).await;

    // Deleting the folder brings the originals back at the next start.
    std::fs::remove_dir_all(world.roles_dir()).unwrap();
    let host = world.host().await;
    assert!(world.roles_dir().join("lead.md").exists());
    assert_eq!(
        std::fs::read_dir(world.roles_dir()).unwrap().count(),
        3,
        "the three shipped roles"
    );
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S13, S14: the shipped lead and worker
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s13_the_shipped_lead_starts_agents_cannot_edit_and_carries_its_voice_and_trackr_rules() {
    let world = World::new();
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.repository("lead"), "parent")
        .await;

    parent
        .start(json!({ "task": "run the board", "role": "lead", "name": "lead" }))
        .await
        .done();
    let lead = world.child_of(&parent, "lead").await;
    assert!(world.column::<bool>(lead.id(), "can_start"));
    assert!(!world.column::<bool>(lead.id(), "child_worktree"));
    assert_eq!(lead.run.disallowed(), ["Edit", "Write", "NotebookEdit"]);
    // No permission of its own: the agent's default.
    assert_eq!(value_of(&lead.run.argv, "--permission-mode"), None);
    let instructions = lead
        .run
        .instructions
        .as_deref()
        .expect("the lead's instructions");
    for part in ["# Role: lead", "## Keeping Trackr", "## Voice", "ABC-12"] {
        assert!(instructions.contains(part), "{part} in {instructions}");
    }
    assert_eq!(lead.run.opening_prompt.as_deref(), Some("run the board"));
    assert!(lead.run.received.is_empty());

    // It starts a worker of its own, which is what it is for.
    lead.start(json!({ "task": "do ABC-12", "role": "worker", "name": "helper" }))
        .await
        .done();
    assert_eq!(
        world.child_of(&lead, "helper").await.record.parent_id,
        Some(lead.id())
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s14_the_shipped_worker_edits_in_a_worktree_cannot_start_agents_or_create_items() {
    let world = World::new();
    let host = world.host().await;
    // Edits are accepted by the worker only where its parent accepts them too.
    let parent = world
        .session_in(
            CLAUDE,
            &world.repository("worker"),
            "parent",
            PermissionMode::AcceptEdits,
        )
        .await;

    parent
        .start(json!({ "task": "do ABC-12", "role": "worker", "name": "worker" }))
        .await
        .done();
    let worker = world.child_of(&parent, "worker").await;
    assert!(world.column::<bool>(worker.id(), "child_worktree"));
    assert_eq!(
        Path::new(&worker.record.cwd),
        Path::new(&parent.record.cwd)
            .join(".floti/worktrees/worker")
            .as_path()
    );
    assert_eq!(worker.record.branch.as_deref(), Some("agent/worker"));
    assert_eq!(world.column::<String>(worker.id(), "child_class"), "light");
    assert!(!world.column::<bool>(worker.id(), "can_start"));
    assert_eq!(
        value_of(&worker.run.argv, "--permission-mode"),
        Some("acceptEdits")
    );
    assert_eq!(worker.run.disallowed(), ["mcp__helm-plugin-trackr__create"]);
    let instructions = worker
        .run
        .instructions
        .as_deref()
        .expect("the worker's instructions");
    for part in [
        "# Role: worker",
        "Touch only your own item",
        "Also fixed:",
        "Found:",
    ] {
        assert!(instructions.contains(part), "{part} in {instructions}");
    }
    assert_eq!(worker.run.opening_prompt.as_deref(), Some("do ABC-12"));

    // It may not start agents of its own.
    let refused = worker.start(json!({ "task": "more" })).await;
    assert!(
        refused.refused().contains("without can_start"),
        "{refused:?}"
    );

    // The parent's view of it.
    let listed = parent.list().await.done();
    assert_eq!(listed["children"][0]["worktree"], true);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S16: allowed up front, and a deny rule still wins
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s16_agents_roles_is_allowed_up_front_with_the_other_tools_and_a_deny_rule_still_wins() {
    let world = World::new();
    world.role(
        "no-roles",
        "---\nbackend: claude-code\ndisallowed_tools: mcp__floti-agents__agents_roles\n---\n",
    );
    let host = world.host().await;
    let folder = world.project("up front");

    for (backend, rule) in [
        (CLAUDE, "mcp__floti-agents__agents_roles"),
        (OTHER, "floti-agents.agents_roles"),
    ] {
        let parent = world
            .session(backend, &folder, &format!("parent {backend}"))
            .await;
        let allowed = parent.run.allowed();
        assert!(
            allowed.iter().any(|got| got == rule),
            "{backend}: {rule} in {allowed:?}"
        );
        // It is a tool and not a command: no `floti agent roles`.
        assert!(
            !allowed.iter().any(|got| got.contains("agent roles")),
            "{backend}: {allowed:?}"
        );
        // Nothing is allowed by a wildcard over the family.
        assert!(
            !allowed.iter().any(|got| got.ends_with("floti-agents__*")),
            "{allowed:?}"
        );
        assert_eq!(parent.run.disallowed(), Vec::<String>::new());
        let (url, token) = parent.route();
        let tools = rpc(&url, Some(&token), "tools/list", json!({}))
            .await
            .result();
        let names: Vec<&str> = tools["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"agents_roles"), "{names:?}");
    }

    // A deny rule of a role stays beside the allow rule.
    let parent = world.session(CLAUDE, &folder, "parent").await;
    parent
        .start(json!({ "task": "go", "role": "no-roles", "name": "denied" }))
        .await
        .done();
    let denied = world.child_of(&parent, "denied").await;
    assert_eq!(denied.run.disallowed(), ["mcp__floti-agents__agents_roles"]);
    assert!(
        denied
            .run
            .allowed()
            .iter()
            .any(|got| got == "mcp__floti-agents__agents_roles")
    );

    // The subcommand set has no roles command.
    assert!(agent_cli::parse(&["roles".to_owned()]).is_err());
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S17: only the backends that are installed and can run it
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s17_a_role_runs_on_the_installed_backends_it_lists_and_a_start_says_when_there_are_none() {
    let world = World::new();
    world.role("codex-first", "---\nbackend: codex, claude-code\n---\n");
    world.role("gone", "---\nbackend: codex\n---\n");
    let host = world.host().await;
    let parent = world
        .session(OTHER, &world.project("installed"), "parent")
        .await;

    let roles = parent.role_entries().await;
    assert_eq!(backends_of(&roles["codex-first"]), [CLAUDE]);
    assert!(backends_of(&roles["gone"]).is_empty());

    // The first one the role lists that is installed.
    parent
        .start(json!({ "task": "go", "role": "codex-first", "name": "first" }))
        .await
        .done();
    assert_eq!(
        world.child_of(&parent, "first").await.record.backend,
        BackendId::new(CLAUDE)
    );

    // One that is listed and not installed.
    let refused = parent
        .start(json!({ "task": "go", "role": "codex-first", "backend": "codex" }))
        .await;
    assert!(
        refused.refused().contains("codex") && refused.refused().contains("allows: claude-code."),
        "{refused:?}"
    );
    // One that is installed and not listed.
    let refused = parent
        .start(json!({ "task": "go", "role": "codex-first", "backend": OTHER }))
        .await;
    assert!(refused.refused().contains(OTHER), "{refused:?}");
    // A role none of whose backends is here.
    let refused = parent.start(json!({ "task": "go", "role": "gone" })).await;
    assert!(
        refused
            .refused()
            .contains("None of the backends the role gone lists"),
        "{refused:?}"
    );
    assert_eq!(world.children_made(), 1);

    // A role that lists no backend is for every installed agent backend.
    world.role("anywhere", "---\n---\n");
    assert_eq!(
        backends_of(&parent.role_entries().await["anywhere"]),
        [CLAUDE, OTHER]
    );
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S18: the role's profile
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s18_a_role_names_the_profile_its_children_run_under_and_a_missing_one_refuses_the_start() {
    let world = World::new();
    world.role(
        "profiled",
        "---\nbackend: claude-code\nprofile: Roleprof\n---\n",
    );
    world.role(
        "lost",
        "---\nbackend: claude-code\nprofile: Nonesuch\n---\n",
    );
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("profiles"), "parent")
        .await;
    let elsewhere = world.project("profile root");
    let profile = world.profile(
        "Roleprof",
        &elsewhere,
        Some("profile-model"),
        None,
        Some("plan"),
    );
    world.profile(
        "Asked",
        &world.project("asked root"),
        Some("asked-model"),
        None,
        None,
    );

    // The role's profile, even though the folder is another profile's.
    parent
        .start(json!({ "task": "go", "role": "profiled", "name": "by-role" }))
        .await
        .done();
    let by_role = world.child_of(&parent, "by-role").await;
    assert_eq!(world.column::<i64>(by_role.id(), "profile_id"), profile);
    assert_eq!(by_role.run.model(), Some("profile-model"));
    assert_eq!(
        value_of(&by_role.run.argv, "--permission-mode"),
        Some("plan")
    );

    // A profile named in the start wins over the role's.
    parent
        .start(json!({ "task": "go", "role": "profiled", "name": "by-ask", "profile": "Asked" }))
        .await
        .done();
    let by_ask = world.child_of(&parent, "by-ask").await;
    assert_eq!(by_ask.run.model(), Some("asked-model"));

    // A profile that is not there refuses the start, naming file and profile.
    let runs = world.run_count();
    let refused = parent.start(json!({ "task": "go", "role": "lost" })).await;
    let sentence = refused.refused();
    assert!(
        sentence.contains("lost.md") && sentence.contains("Nonesuch"),
        "{sentence}"
    );
    assert!(sentence.contains("No agent was started"), "{sentence}");
    assert_eq!(world.run_count(), runs);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Both backends, floti agent, and a child reopened
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn floti_agent_start_and_stop_take_a_role_and_agents_roles_is_called_from_either_backend() {
    let world = World::new();
    world.role(
        "briefed",
        "---\ndescription: Has a brief.\nbackend: claude-code, other-agent\n---\nBe thorough.\n",
    );
    let host = world.host().await;
    let folder = world.project("cli");

    for (backend, other) in [(CLAUDE, OTHER), (OTHER, CLAUDE)] {
        let parent = world
            .session(backend, &folder, &format!("parent {backend}"))
            .await;
        let (url, token) = parent.route();
        let started = subcommand(
            Subcommand::Start(StartCommand {
                task: "by the command".to_owned(),
                role: Some("briefed".to_owned()),
                backend: Some(other.to_owned()),
                name: Some("by-cli".to_owned()),
                ..StartCommand::default()
            }),
            url.clone(),
            token.clone(),
        )
        .await;
        assert_eq!(started.code, 0, "{started:?}");
        let child = world.child_of(&parent, "by-cli").await;
        assert_eq!(child.record.backend, BackendId::new(other));
        assert!(
            child
                .run
                .instructions
                .as_deref()
                .unwrap()
                .contains("Be thorough.")
        );
        assert_eq!(child.run.opening_prompt.as_deref(), Some("by the command"));

        // A role that does not exist is a refusal the command prints.
        let refused = subcommand(
            Subcommand::Start(StartCommand {
                task: "x".to_owned(),
                role: Some("wizard".to_owned()),
                ..StartCommand::default()
            }),
            url.clone(),
            token.clone(),
        )
        .await;
        assert_eq!(refused.code, 1, "{refused:?}");
        assert!(refused.err.unwrap().contains("no role named wizard"));

        // The roles, over the same route.
        assert!(parent.role_names().await.contains(&"briefed".to_owned()));

        let stopped = subcommand(
            Subcommand::Stop(StopCommand {
                child: "by-cli".to_owned(),
                json: false,
            }),
            url,
            token,
        )
        .await;
        assert_eq!(stopped.code, 0, "{stopped:?}");
        let id = child.id();
        eventually("the child to stop", async || {
            (world.column::<String>(id, "status") != "running").then_some(())
        })
        .await;
    }
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s2_a_lost_child_is_reopened_in_its_role_as_the_file_reads_when_it_comes_back() {
    let world = World::new();
    world.role("edited", "---\nbackend: claude-code\n---\nFirst version.\n");
    world.role(
        "broken",
        "---\nbackend: claude-code\n---\nWill be broken.\n",
    );
    world.role("gone", "---\nbackend: claude-code\n---\nWill be deleted.\n");
    let host = world.host().await;
    let parent = world
        .session(CLAUDE, &world.project("reopen"), "parent")
        .await;
    for role in ["edited", "broken", "gone"] {
        parent
            .start(json!({ "task": "work", "role": role, "name": role }))
            .await
            .done();
    }
    let mut kids = BTreeMap::new();
    for role in ["edited", "broken", "gone"] {
        kids.insert(role, world.child_of(&parent, role).await);
    }
    assert!(
        kids["edited"]
            .run
            .instructions
            .as_deref()
            .unwrap()
            .contains("First version.")
    );
    // Each has been worked with, so there is a conversation to resume.
    for kid in kids.values() {
        world.type_line(kid, "carry on").await;
    }

    // The host stops for an update: every row is left for the next start.
    let mut client = world.client().await;
    client
        .request::<HostStop>(&HostStopRequest {
            reason: HostStopReason::Update,
        })
        .await
        .expect("the stop is taken");
    drop(client);
    assert_eq!(host.stopped().await, HostStopReason::Update);

    // The files change while it is down.
    world.role(
        "edited",
        "---\nbackend: claude-code\n---\nSecond version.\n",
    );
    world.role("broken", "---\nclass: medium\n---\nStill here.\n");
    world.remove_role("gone");

    let host = world.host().await;
    let mut client = world.client().await;
    let result = client
        .request::<SessionRestore>(&RestoreSessionsRequest {
            sessions: ["edited", "broken", "gone"]
                .iter()
                .map(|role| SessionToRestore {
                    id: kids[role].id(),
                    cols: 80,
                    rows: 24,
                })
                .collect(),
        })
        .await
        .expect("the restore is taken");
    drop(client);

    // The edited role composes the reopened child again, as it reads now.
    assert_eq!(result.restored.len(), 2, "{result:?}");
    let edited = result
        .restored
        .iter()
        .find(|restored| restored.from == kids["edited"].id())
        .expect("the edited child came back");
    let again = world
        .agent_of(edited.launched.session.clone(), &[kids["edited"].run.pid])
        .await;
    let composed = again
        .run
        .instructions
        .as_deref()
        .expect("the role's instructions");
    assert!(composed.contains("Second version."), "{composed}");
    assert!(!composed.contains("First version."), "{composed}");
    assert!(
        again.run.argv.iter().any(|arg| arg == "--resume"),
        "{:?}",
        again.run.argv
    );

    // A role whose file cannot be used refuses the reopen, naming the file.
    assert_eq!(result.failed.len(), 1, "{result:?}");
    assert_eq!(result.failed[0].id, kids["broken"].id());
    assert!(
        result.failed[0].reason.contains("broken.md"),
        "{:?}",
        result.failed[0]
    );
    assert!(
        result.failed[0]
            .reason
            .contains("class must be light or heavy")
    );

    // A role that is gone reopens without it, and says so.
    let gone = result
        .restored
        .iter()
        .find(|restored| restored.from == kids["gone"].id())
        .expect("the child of the deleted role came back");
    assert!(
        gone.launched
            .warnings
            .iter()
            .any(|warning| warning.contains("no longer exists")),
        "{:?}",
        gone.launched.warnings
    );
    let reopened = world
        .agent_of(gone.launched.session.clone(), &[kids["gone"].run.pid])
        .await;
    // Floti's own guide is all it is given: nothing of the deleted role's body.
    let told = reopened.run.instructions.as_deref().unwrap_or_default();
    assert!(!told.contains("Will be deleted."), "{told}");
    host.stop(HostStopReason::Stop).await;
}
