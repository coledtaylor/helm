//! Worktrees: a child started with a worktree, or in a role whose file says
//! worktree: yes, runs in `<repo>/.floti/worktrees/<name>` on `agent/<name>`,
//! which the host makes with git. Real git repositories under the run's root,
//! with spaces in their names, and a host whose sessions run the fake `claude`
//! (`test/fake-agents/claude-code.mjs`) and the other fake agent
//! (`test/fake-agents/other-agent.mjs`), never a real agent. A session's agent
//! tools are called over HTTP with the URL and bearer token the session itself
//! was given, and `floti agent` runs its own code against the same route.
//!
//! No client is attached while a session works: a client starts the session
//! and goes. The roles folder is under the test's own run root, so no test
//! reads or writes a real one.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::agent::claude_code::{ClaudeCodeBackend, ClaudeCodeSettings};
use floti_host::agent_cli::{self, Command as Subcommand, Start as StartCommand};
use floti_host::platform::process_tree::Native as NativeTree;
use floti_host::platform::socket::Endpoint;
use floti_host::server::HostConfig;
use floti_host::testkit::{
    GitRepo, OtherAgent, OtherAgentRecord, PATIENCE, RunningHost, TestClient, TestDirs,
};
use floti_protocol::BackendId;
use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    CloseSessionRequest, SessionClose, SessionList, SessionStart, StartSessionRequest,
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

/// The folder in a repository that holds the worktrees.
const WORKTREES: &str = ".floti/worktrees";

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

    /// Writes the role file `<name>.md`. Making the folder is what keeps the
    /// host from seeding it.
    fn role(&self, name: &str, content: &str) {
        let folder = self.dirs.config.join("roles");
        std::fs::create_dir_all(&folder).expect("make the roles folder");
        std::fs::write(folder.join(format!("{name}.md")), content).expect("write a role file");
    }

    /// A host that serves once this returns, with the workspace tracked.
    async fn host(&self) -> RunningHost {
        let host = RunningHost::start(self.config());
        // A client is welcomed once the host serves.
        drop(self.client().await);
        let db = self.db();
        db.execute(
            "INSERT INTO profiles (name, root, overlays, access, model, effort, permission_mode, \
             agent, opening_prompt, session_agents) \
             VALUES ('workspace', ?1, '[]', '[]', NULL, NULL, NULL, NULL, NULL, NULL)",
            [text(&self.work)],
        )
        .expect("insert a profile");
        host
    }

    async fn client(&self) -> TestClient {
        TestClient::connect(&self.endpoint, TERMINAL).await
    }

    /// A plain folder in the workspace, which Floti tracks.
    fn project(&self, name: &str) -> PathBuf {
        resolved(&self.dirs.folder(&format!("workspace/{name}")))
    }

    /// A git repository in the workspace with two commits, on a branch other
    /// than `main`: the commit a worktree is cut from is the checked-out one.
    fn repository(&self, name: &str) -> Repo {
        let repo = GitRepo::init(self.project(name));
        repo.write("README.md", "hello\n");
        repo.write("sub/inner.txt", "inner\n");
        repo.commit_all("first");
        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.write("README.md", "hello again\n");
        repo.commit_all("second");
        Repo {
            root: resolved(repo.path()),
            repo,
        }
    }

    /// The host's database, as a test reads it.
    fn db(&self) -> rusqlite::Connection {
        let db =
            rusqlite::Connection::open(self.dirs.data.join("floti.db")).expect("open floti.db");
        db.busy_timeout(PATIENCE)
            .expect("wait for the host's writes");
        db
    }

    // -- sessions -----------------------------------------------------------

    /// A session on `backend` in `folder`, started by a client that is gone
    /// once the session is.
    async fn session(&self, backend: &str, folder: &Path, name: &str) -> Agent {
        let mut client = self.client().await;
        let record = client
            .request::<SessionStart>(&request(folder, name, backend))
            .await
            .expect("the session starts");
        drop(client);
        self.agent_of(record).await
    }

    /// The agent behind `record`, once its fake has logged a run.
    async fn agent_of(&self, record: SessionRecord) -> Agent {
        let conversation = record
            .conversation_id
            .clone()
            .expect("the session has a conversation");
        let run = eventually("the agent to log its run", async || {
            self.runs_of(&conversation).into_iter().next_back()
        })
        .await;
        Agent { record, run }
    }

    /// The child `parent` started under `name`.
    async fn child_of(&self, parent: &Agent, name: &str) -> Agent {
        let id: i64 = self
            .db()
            .query_row(
                "SELECT id FROM sessions WHERE parent_session_id = ?1 AND child_name = ?2",
                rusqlite::params![i64::try_from(parent.id()).unwrap(), name],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| panic!("{} has no child named {name}", parent.record.name));
        let id = u64::try_from(id).unwrap();
        let record = self
            .sessions()
            .await
            .into_iter()
            .find(|row| row.id == id)
            .unwrap_or_else(|| panic!("no session {id}"));
        self.agent_of(record).await
    }

    async fn sessions(&self) -> Vec<SessionRecord> {
        let mut client = self.client().await;
        client
            .request::<SessionList>(&())
            .await
            .expect("the sessions are listed")
    }

    fn status(&self, id: u64) -> String {
        self.db()
            .query_row(
                "SELECT status FROM sessions WHERE id = ?1",
                [i64::try_from(id).unwrap()],
                |row| row.get(0),
            )
            .unwrap_or_else(|err| panic!("read session {id}: {err}"))
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

    /// Types `line` into `agent` and waits for the fake to take it.
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

/// A git repository the tests made, and where it really is.
struct Repo {
    root: PathBuf,
    repo: GitRepo,
}

impl Repo {
    /// Where the worktree called `name` is.
    fn worktree(&self, name: &str) -> PathBuf {
        self.root.join(WORKTREES).join(name)
    }

    /// The lines of the repository's `info/exclude`.
    fn exclude(&self) -> Vec<String> {
        std::fs::read_to_string(self.root.join(".git/info/exclude"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    /// The names of the folders under `.floti/worktrees`, sorted.
    fn worktree_names(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.root.join(WORKTREES))
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    /// The `agent/*` branches, sorted.
    fn agent_branches(&self) -> Vec<String> {
        let mut branches: Vec<String> = self
            .repo
            .git(&["branch", "--list", "--format=%(refname:short)", "agent/*"])
            .lines()
            .map(str::to_owned)
            .collect();
        branches.sort();
        branches
    }
}

/// `git` in a worktree, with a fixed author: what an agent at work there
/// would run.
fn git_in(folder: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args([
            "-c",
            "user.name=Agent",
            "-c",
            "user.email=agent@example.invalid",
        ])
        .args(["-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(folder)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdin(std::process::Stdio::null())
        .output()
        .expect("run git");
    assert!(
        output.status.success(),
        "git {} failed in {}: {}",
        args.join(" "),
        folder.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

// ---------------------------------------------------------------------------
// A session, and what it was given
// ---------------------------------------------------------------------------

/// One run of either fake, as it logged itself.
#[derive(Debug, Clone)]
struct Run {
    pid: u32,
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
            servers,
            received: log["received"]
                .as_array()
                .map(|lines| {
                    lines
                        .iter()
                        .filter_map(|line| line.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default(),
        }
    }

    fn of_other(record: &OtherAgentRecord) -> Self {
        Self {
            pid: record.pid,
            servers: record
                .mcp_servers
                .iter()
                .map(|(name, server)| (name.clone(), (server.url.clone(), server.bearer.clone())))
                .collect(),
            received: record.received.clone(),
        }
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
    /// The JSON block of an answer that succeeded.
    fn done(&self) -> Value {
        assert!(!self.failed, "the call was refused: {self:?}");
        serde_json::from_str(self.blocks.get(1).expect("a JSON block")).expect("JSON")
    }

    /// The sentence of an answer that was refused.
    fn refused(&self) -> &str {
        assert!(self.failed, "the call was not refused: {self:?}");
        self.blocks.first().map_or("", String::as_str)
    }
}

impl Agent {
    fn id(&self) -> u64 {
        self.record.id
    }

    /// The agents family's URL and the session's token.
    fn route(&self) -> (String, String) {
        self.run
            .servers
            .get(FAMILY)
            .cloned()
            .expect("the session was given the agents family")
    }

    async fn start(&self, arguments: Value) -> Called {
        let (url, token) = self.route();
        called(&url, &token, "agents_start", arguments).await
    }

    async fn stop(&self, child: &str) -> Called {
        let (url, token) = self.route();
        called(&url, &token, "agents_stop", json!({ "child": child })).await
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

/// One POST of `body` to `url`, carrying `token`.
async fn post(url: &str, token: &str, body: &Value) -> Reply {
    let (address, path) = split_url(url);
    let body = body.to_string();
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\
         Accept: application/json, text/event-stream\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nAuthorization: Bearer {token}\r\n\r\n",
        body.len()
    );
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

async fn called(url: &str, token: &str, tool: &str, arguments: Value) -> Called {
    let result = post(
        url,
        token,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": { "name": tool, "arguments": arguments }
        }),
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
// S1: a child's worktree
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s1_a_child_started_with_a_worktree_runs_in_it_on_a_new_branch_from_the_parents_commit() {
    let world = World::new();
    let host = world.host().await;
    let repo = world.repository("ledger repo");
    // The parent works in a folder below the repository's root.
    let parent = world
        .session(CLAUDE, &repo.root.join("sub"), "parent")
        .await;

    let started = parent
        .start(json!({ "task": "build it", "name": "builder", "worktree": "ledger-store" }))
        .await
        .done();

    let folder = repo.worktree("ledger-store");
    assert_eq!(Path::new(started["folder"].as_str().unwrap()), folder);
    assert_eq!(started["branch"], "agent/ledger-store");
    assert_eq!(started["worktree"], "ledger-store");
    let child = world.child_of(&parent, "builder").await;
    assert_eq!(Path::new(&child.record.cwd), folder);
    assert_eq!(child.record.branch.as_deref(), Some("agent/ledger-store"));
    // Cut from the commit the parent's folder has checked out: the second
    // commit on `feature`, not `main`'s.
    let head = repo.repo.git(&["rev-parse", "HEAD"]);
    assert_eq!(git_in(&folder, &["rev-parse", "HEAD"]), head.trim());
    assert_ne!(
        git_in(&folder, &["rev-parse", "HEAD"]),
        git_in(&folder, &["rev-parse", "main"])
    );
    assert_eq!(
        std::fs::read_to_string(folder.join("README.md")).unwrap(),
        "hello again\n"
    );
    assert_eq!(repo.agent_branches(), ["agent/ledger-store"]);
    // The repository's own branch is left where it was.
    assert_eq!(
        repo.repo.git(&["branch", "--show-current"]).trim(),
        "feature"
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s1_floti_agent_start_worktree_makes_one_for_a_child_on_the_other_backend() {
    let world = World::new();
    let host = world.host().await;
    let repo = world.repository("cli repo");
    let parent = world.session(OTHER, &repo.root, "parent").await;
    let (url, token) = parent.route();

    let outcome = subcommand(
        Subcommand::Start(StartCommand {
            task: "build it".to_owned(),
            backend: Some(OTHER.to_owned()),
            name: Some("cli-kid".to_owned()),
            worktree: Some("from-the-shell".to_owned()),
            json: true,
            ..StartCommand::default()
        }),
        url,
        token,
    )
    .await;

    assert_eq!(outcome.code, 0, "{outcome:?}");
    let started: Value = serde_json::from_str(&outcome.out.expect("an answer")).unwrap();
    assert_eq!(
        Path::new(started["folder"].as_str().unwrap()),
        repo.worktree("from-the-shell")
    );
    assert_eq!(started["branch"], "agent/from-the-shell");
    let child = world.child_of(&parent, "cli-kid").await;
    assert_eq!(
        Path::new(&child.record.cwd),
        repo.worktree("from-the-shell")
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s1_a_role_that_says_worktree_yes_gives_every_child_one_named_after_it_unless_one_is_named()
{
    let world = World::new();
    world.role("tree", "---\nworktree: yes\n---\nWork in your tree.\n");
    let host = world.host().await;
    let repo = world.repository("role repo");
    let parent = world.session(CLAUDE, &repo.root, "parent").await;

    // On each backend, named after the child; a second of the same name gets
    // a number, as its child name does.
    let first = parent
        .start(json!({ "task": "a", "role": "tree", "name": "kid" }))
        .await
        .done();
    let second = parent
        .start(json!({ "task": "b", "role": "tree", "name": "kid", "backend": OTHER }))
        .await
        .done();
    let named = parent
        .start(json!({ "task": "c", "role": "tree", "name": "third", "worktree": "chosen" }))
        .await
        .done();

    assert_eq!(first["name"], "kid");
    assert_eq!(first["worktree"], "kid");
    assert_eq!(
        Path::new(first["folder"].as_str().unwrap()),
        repo.worktree("kid")
    );
    assert_eq!(second["name"], "kid-2");
    assert_eq!(second["worktree"], "kid-2");
    assert_eq!(second["branch"], "agent/kid-2");
    assert_eq!(named["worktree"], "chosen");
    assert_eq!(repo.worktree_names(), ["chosen", "kid", "kid-2"]);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S2: .floti is kept out of git status
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s2_floti_is_added_to_the_exclude_file_once_with_its_other_lines_kept() {
    let world = World::new();
    let host = world.host().await;
    let repo = world.repository("exclude repo");
    let exclude = repo.root.join(".git/info/exclude");
    std::fs::create_dir_all(exclude.parent().unwrap()).unwrap();
    // A file whose last line has no newline: it must still be kept apart.
    std::fs::write(&exclude, "# mine\n*.scratch").unwrap();
    let parent = world.session(CLAUDE, &repo.root, "parent").await;
    assert!(!repo.exclude().contains(&"/.floti/".to_owned()));

    parent
        .start(json!({ "task": "one", "name": "one", "worktree": "one" }))
        .await
        .done();
    let after_one = repo.exclude();
    parent
        .start(json!({ "task": "two", "name": "two", "worktree": "two" }))
        .await
        .done();

    assert_eq!(after_one, ["# mine", "*.scratch", "/.floti/"]);
    assert_eq!(repo.exclude(), after_one, "no second line");
    // Nothing under .floti shows, and nothing else does either.
    assert_eq!(repo.repo.git(&["status", "--porcelain"]).trim(), "");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s2_a_repository_without_an_exclude_file_gets_one() {
    let world = World::new();
    let host = world.host().await;
    let repo = world.repository("no exclude");
    let exclude = repo.root.join(".git/info/exclude");
    std::fs::remove_file(&exclude).ok();
    let parent = world.session(CLAUDE, &repo.root, "parent").await;

    parent
        .start(json!({ "task": "one", "name": "one", "worktree": "one" }))
        .await
        .done();

    assert_eq!(repo.exclude(), ["/.floti/"]);
    assert_eq!(repo.repo.git(&["status", "--porcelain"]).trim(), "");
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S3: no two children share a checkout
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s3_a_second_child_with_the_same_worktree_name_gets_a_checkout_of_its_own() {
    let world = World::new();
    let host = world.host().await;
    let repo = world.repository("shared repo");
    let parent = world.session(CLAUDE, &repo.root, "parent").await;
    // Another parent, in the same repository, below its root.
    let other_parent = world.session(OTHER, &repo.root.join("sub"), "other").await;

    let first = parent
        .start(json!({ "task": "a", "name": "first", "worktree": "ledger-store" }))
        .await
        .done();
    let second = other_parent
        .start(json!({ "task": "b", "name": "second", "worktree": "ledger-store" }))
        .await
        .done();
    let third = parent
        .start(json!({ "task": "c", "name": "third", "worktree": "ledger-store" }))
        .await
        .done();

    assert_eq!(first["worktree"], "ledger-store");
    assert_eq!(second["worktree"], "ledger-store-2");
    assert_eq!(second["branch"], "agent/ledger-store-2");
    assert_eq!(
        Path::new(second["folder"].as_str().unwrap()),
        repo.worktree("ledger-store-2")
    );
    assert_eq!(third["worktree"], "ledger-store-3");
    assert_eq!(
        repo.agent_branches(),
        [
            "agent/ledger-store",
            "agent/ledger-store-2",
            "agent/ledger-store-3"
        ]
    );
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s3_a_branch_that_exists_without_its_folder_is_not_reused() {
    let world = World::new();
    let host = world.host().await;
    let repo = world.repository("branch repo");
    repo.repo.git(&["branch", "agent/kept", "main"]);
    let parent = world.session(CLAUDE, &repo.root, "parent").await;

    let started = parent
        .start(json!({ "task": "a", "name": "kid", "worktree": "kept" }))
        .await
        .done();

    assert_eq!(started["worktree"], "kept-2");
    assert_eq!(started["branch"], "agent/kept-2");
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S4: one agent to a worktree
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_start_inside_a_worktree_another_session_works_in_is_refused_naming_it() {
    let world = World::new();
    let host = world.host().await;
    let repo = world.repository("busy repo");
    let parent = world.session(CLAUDE, &repo.root, "parent").await;
    let bystander = world.session(OTHER, &repo.root, "bystander").await;
    parent
        .start(json!({
            "task": "work", "name": "tenant", "worktree": "ledger-store", "can_start": true
        }))
        .await
        .done();
    let tenant = world.child_of(&parent, "tenant").await;
    let folder = repo.worktree("ledger-store");
    let made = world.children_made();
    let runs = world.run_count();

    // Its parent and any other session are refused, in the worktree's root or
    // below it, with or without a worktree of their own.
    for who in [&parent, &bystander] {
        for arguments in [
            json!({ "task": "share", "folder": text(&folder) }),
            json!({ "task": "share", "folder": text(&folder.join("sub")) }),
            json!({ "task": "share", "folder": text(&folder), "worktree": "mine" }),
        ] {
            let refused = who.start(arguments).await;
            let sentence = refused.refused();
            assert!(sentence.contains("tenant"), "{sentence}");
            assert!(sentence.contains("ledger-store"), "{sentence}");
        }
    }
    assert_eq!(world.children_made(), made);
    assert_eq!(world.run_count(), runs);
    assert_eq!(repo.worktree_names(), ["ledger-store"]);

    // The agent that works there may start its own child in its own worktree,
    // made under the main repository, not inside its own.
    let started = tenant
        .start(json!({ "task": "help", "name": "helper", "worktree": "helper-tree" }))
        .await
        .done();
    assert_eq!(
        Path::new(started["folder"].as_str().unwrap()),
        repo.worktree("helper-tree")
    );
    assert_eq!(repo.worktree_names(), ["helper-tree", "ledger-store"]);
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_worktree_nobody_works_in_any_more_may_be_started_in() {
    let world = World::new();
    let host = world.host().await;
    let repo = world.repository("idle repo");
    let parent = world.session(CLAUDE, &repo.root, "parent").await;
    parent
        .start(json!({ "task": "work", "name": "tenant", "worktree": "ledger-store" }))
        .await
        .done();
    let tenant = world.child_of(&parent, "tenant").await;
    parent.stop("tenant").await.done();
    world.ended("the tenant to end", &[tenant.id()]).await;

    let started = parent
        .start(json!({ "task": "carry on", "name": "heir", "folder": text(&repo.worktree("ledger-store")) }))
        .await
        .done();

    assert_eq!(
        Path::new(started["folder"].as_str().unwrap()),
        repo.worktree("ledger-store")
    );
    assert_eq!(started["worktree"], Value::Null);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S5: outside a repository
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s5_a_folder_outside_a_repository_refuses_a_worktree_and_writes_nothing() {
    let world = World::new();
    world.role("tree", "---\nworktree: yes\n---\n");
    let host = world.host().await;
    let folder = world.project("plain folder");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    let made = world.children_made();
    let runs = world.run_count();

    for arguments in [
        json!({ "task": "a", "worktree": "ledger-store" }),
        json!({ "task": "b", "role": "tree" }),
    ] {
        let refused = parent.start(arguments).await;
        let sentence = refused.refused();
        assert!(sentence.contains("not in a git repository"), "{sentence}");
    }

    assert_eq!(world.children_made(), made);
    assert_eq!(world.run_count(), runs);
    assert!(!folder.join(".floti").exists());
    // A start with no worktree in the same folder is as it was.
    parent
        .start(json!({ "task": "d", "name": "plain" }))
        .await
        .done();
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s5_the_shipped_worker_is_refused_outside_a_repository_and_starts_inside_one() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("plain worker folder");
    let parent = world.session(CLAUDE, &folder, "parent").await;
    let runs = world.run_count();

    let refused = parent
        .start(json!({ "task": "do it", "role": "worker" }))
        .await;

    assert!(
        refused.refused().contains("not in a git repository"),
        "{refused:?}"
    );
    assert_eq!(world.run_count(), runs);
    assert!(!folder.join(".floti").exists());

    let repo = world.repository("worker repo");
    let inside = world.session(CLAUDE, &repo.root, "inside").await;
    let started = inside
        .start(json!({ "task": "do it", "role": "worker", "name": "worker" }))
        .await
        .done();
    assert_eq!(started["worktree"], "worker");
    assert_eq!(started["branch"], "agent/worker");
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s5_a_repository_with_no_commit_refuses_a_worktree_and_writes_nothing() {
    let world = World::new();
    let host = world.host().await;
    let folder = world.project("empty repo");
    let repo = GitRepo::init(&folder);
    let parent = world.session(CLAUDE, &folder, "parent").await;
    let runs = world.run_count();

    let refused = parent
        .start(json!({ "task": "a", "worktree": "ledger-store" }))
        .await;

    assert!(refused.refused().contains("no commit"), "{refused:?}");
    assert_eq!(world.run_count(), runs);
    assert!(!folder.join(".floti").exists());
    assert_eq!(repo.git(&["branch", "--list", "agent/*"]).trim(), "");
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S6: a worktree outlives its child
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s6_a_worktree_and_its_branch_stay_when_the_child_exits_is_stopped_or_ends_with_its_parent()
{
    let world = World::new();
    let host = world.host().await;
    let repo = world.repository("keep repo");
    let parent = world.session(CLAUDE, &repo.root, "parent").await;
    let mut kids = Vec::new();
    for name in ["exits", "stopped", "follows"] {
        parent
            .start(json!({ "task": "work", "name": name, "worktree": name }))
            .await
            .done();
        let kid = world.child_of(&parent, name).await;
        // Its work: a commit on its branch and a file it has not committed.
        let folder = repo.worktree(name);
        std::fs::write(folder.join("done.txt"), name).unwrap();
        git_in(&folder, &["add", "done.txt"]);
        git_in(&folder, &["commit", "-q", "-m", name]);
        std::fs::write(folder.join("unsaved.txt"), name).unwrap();
        kids.push(kid);
    }

    // It exits by itself, then it is stopped, then its parent ends.
    world.type_line(&kids[0], "/exit").await;
    world
        .ended("the first child to exit", &[kids[0].id()])
        .await;
    parent.stop("stopped").await.done();
    world
        .ended("the second child to stop", &[kids[1].id()])
        .await;
    world.close(&parent).await;
    world
        .ended("the third child to end with its parent", &[kids[2].id()])
        .await;

    for name in ["exits", "stopped", "follows"] {
        let folder = repo.worktree(name);
        assert!(folder.is_dir(), "{name}'s worktree is still there");
        assert_eq!(
            std::fs::read_to_string(folder.join("unsaved.txt")).unwrap(),
            name
        );
        assert_eq!(
            repo.repo
                .git(&["log", "-1", "--format=%s", &format!("agent/{name}")])
                .trim(),
            name
        );
    }
    assert_eq!(
        repo.agent_branches(),
        ["agent/exits", "agent/follows", "agent/stopped"]
    );
    host.stop(HostStopReason::Stop).await;
}
