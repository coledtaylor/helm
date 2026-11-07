//! Standing notices on the host: what it keeps for a person who is not
//! looking. A host whose sessions run the fake `claude`
//! (`test/fake-agents/claude-code.mjs`) and the other fake agent, never a real
//! agent. A session's agent tools are called over HTTP with the URL and bearer
//! token the session itself was given, so nothing here is more than the
//! session could do.
//!
//! No client is attached while a notice comes to stand: a client starts a
//! session and goes, and comes back only to type into a session, to read the
//! notices the way a window that connects does (the snapshot of
//! `notices:changed`) or to dismiss one. Each wait is on a condition the host
//! brings about, bounded by the shared patience.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::agent::claude_code::{ClaudeCodeBackend, ClaudeCodeSettings};
use floti_host::platform::process_tree::Native as NativeTree;
use floti_host::platform::socket::Endpoint;
use floti_host::roles::{FixedRoles, Role, RoleSource};
use floti_host::server::HostConfig;
use floti_host::testkit::{
    OtherAgent, OtherAgentBackend, PATIENCE, RunningHost, TestClient, TestDirs,
};
use floti_protocol::channel::from_payload;
use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    AllowMoreStarts, AllowMoreStartsRequest, CloseSessionRequest, DismissNotice,
    DismissNoticeRequest, NoticeKind, NoticeLimit, SessionClose, SessionList, SessionStart,
    StandingNotice, StartSessionRequest,
};
use floti_protocol::channels::workspace::{HostSettingsPatch, WriteSettings};
use floti_protocol::{BackendId, Message};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const TERMINAL: &[&str] = &["terminal"];

/// The backends the host has, by id: the fake `claude`, and the other fake
/// with its program missing (a child started on it fails to launch).
const CLAUDE: &str = "claude-code";
const MISSING: &str = OtherAgentBackend::MISSING_ID;

/// The agents family, as a session's tool file names it.
const FAMILY: &str = "floti-agents";

/// The channel the notices are sent on.
const NOTICES: &str = "notices:changed";

// ---------------------------------------------------------------------------
// A host with a fake agent
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
            Arc::new(self.other.backend_that_cannot_start()),
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

    /// A host that serves once this returns, with a role that can run on the
    /// backend that cannot start, and the workspace tracked.
    async fn host(&self) -> RunningHost {
        let mut ghostly = Role::new("ghostly", [BackendId::new(MISSING)]);
        ghostly.instructions = "Never runs.".to_owned();
        let source: Arc<dyn RoleSource> = Arc::new(FixedRoles(vec![ghostly]));
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
            self.db()
                .execute(
                    "INSERT INTO profiles (name, root, overlays, access, model, effort, \
                     permission_mode, agent, opening_prompt, session_agents) \
                     VALUES ('workspace', ?1, '[]', '[]', NULL, NULL, NULL, NULL, NULL, NULL)",
                    [text(&self.work)],
                )
                .expect("insert a profile");
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

    /// The notices standing on the host, as a window that connects is given
    /// them.
    async fn notices(&self) -> Vec<StandingNotice> {
        let mut client = self.client().await;
        match client.subscribe_on(1, NOTICES).await {
            Message::Snapshot(snapshot) => from_payload(&snapshot.state).expect("the notices"),
            other => panic!("no snapshot of the notices: {other:?}"),
        }
    }

    /// Waits until the standing notices have `wanted`'s shape, and answers
    /// them.
    async fn notices_where(
        &self,
        what: &str,
        wanted: impl Fn(&[StandingNotice]) -> bool,
    ) -> Vec<StandingNotice> {
        eventually(what, async || {
            let standing = self.notices().await;
            wanted(&standing).then_some(standing)
        })
        .await
    }

    // -- sessions -----------------------------------------------------------

    /// A session on the fake `claude` in `folder`, started by a client that is
    /// gone once the session is.
    async fn session(&self, folder: &Path, name: &str) -> Agent {
        let mut client = self.client().await;
        let record = client
            .request::<SessionStart>(&StartSessionRequest {
                cwd: text(folder),
                cols: 80,
                rows: 24,
                name: Some(name.to_owned()),
                backend: Some(BackendId::new(CLAUDE)),
                ..StartSessionRequest::default()
            })
            .await
            .expect("the session starts");
        drop(client);
        self.agent_of(record).await
    }

    /// The agent behind `record`, once its fake has logged its run.
    async fn agent_of(&self, record: SessionRecord) -> Agent {
        let conversation = record
            .conversation_id
            .clone()
            .expect("the session has a conversation");
        let servers = eventually("the agent to log its run", async || {
            self.claude_logs()
                .into_iter()
                .find(|log| log["sessionId"].as_str() == Some(conversation.as_str()))
                .map(|log| servers_of(&log))
        })
        .await;
        Agent { record, servers }
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

    /// What the fake `claude` logged of the lines it took, by conversation.
    fn received(&self, agent: &Agent) -> Vec<String> {
        let conversation = agent.record.conversation_id.as_deref();
        self.claude_logs()
            .iter()
            .filter(|log| log["sessionId"].as_str() == conversation)
            .flat_map(|log| strings(&log["received"]))
            .collect()
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

    /// Types `line` at `agent`'s prompt and waits until it took it.
    async fn type_line(&self, agent: &Agent, line: &str) {
        let mut client = self.client().await;
        client.attach(1, agent.id()).await;
        client.type_into(1, format!("{line}\r").as_bytes()).await;
        eventually("the agent to take the line", async || {
            self.received(agent)
                .iter()
                .any(|got| got == line)
                .then_some(())
        })
        .await;
    }

    /// Answers the fake `claude`'s permission prompt with `key` (`y`), and
    /// waits until its screen says it took the answer.
    async fn allow(&self, agent: &Agent) {
        let mut client = self.client().await;
        client.attach(1, agent.id()).await;
        client.type_into(1, b"y").await;
        client
            .read_stream_until(1, |screen| {
                String::from_utf8_lossy(screen).contains("Allowed.")
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

    async fn settings(&self, patch: HostSettingsPatch) {
        let mut client = self.client().await;
        client
            .request::<WriteSettings>(&patch)
            .await
            .expect("the settings are written");
    }

    /// `count` starts `parent` made that ended, as the host's record has them.
    fn ended_starts(&self, parent: &Agent, count: u32) {
        for number in 1..=count {
            self.db()
                .execute(
                    "INSERT INTO sessions (name, cwd, argv, claude_session_id, backend, \
                     parent_session_id, child_name, role, status) \
                     VALUES (?1, ?2, '[]', ?3, 'claude-code', ?4, ?1, 'agent', 'exited')",
                    rusqlite::params![
                        format!("old{number}"),
                        text(&self.work),
                        format!("old-conversation-{}-{number}", parent.id()),
                        i64::try_from(parent.id()).unwrap(),
                    ],
                )
                .expect("insert an exited child");
        }
    }

    /// Dismisses notice `id` as a client does.
    async fn dismiss(&self, id: &str) {
        let mut client = self.client().await;
        client
            .request::<DismissNotice>(&DismissNoticeRequest { id: id.to_owned() })
            .await
            .expect("the notice is dismissed");
    }

    /// Allows `parent` more starts as a client does, and answers how many.
    async fn allow_more(&self, parent: &Agent) -> u32 {
        let mut client = self.client().await;
        client
            .request::<AllowMoreStarts>(&AllowMoreStartsRequest {
                parent_id: parent.id(),
            })
            .await
            .expect("more starts are allowed")
            .added
    }
}

fn servers_of(log: &Value) -> BTreeMap<String, (String, String)> {
    log["mcpServers"]
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
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// A session, and the agents tools it calls
// ---------------------------------------------------------------------------

/// A session and the tool servers it was given.
struct Agent {
    record: SessionRecord,
    servers: BTreeMap<String, (String, String)>,
}

/// A tool's answer: whether it failed, and the blocks of text it gave.
#[derive(Debug)]
struct Called {
    failed: bool,
    blocks: Vec<String>,
}

impl Called {
    fn done(&self) {
        assert!(!self.failed, "the call was refused: {self:?}");
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

    async fn call(&self, tool: &str, arguments: Value) -> Called {
        let (url, token) = self.servers.get(FAMILY).expect("the agents family");
        called(url, token, tool, arguments).await
    }

    async fn start(&self, arguments: Value) -> Called {
        self.call("agents_start", arguments).await
    }

    async fn stop(&self, child: &str) -> Called {
        self.call("agents_stop", json!({ "child": child })).await
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

/// `http://<address><path>` split.
fn split_url(url: &str) -> (SocketAddr, String) {
    let rest = url.strip_prefix("http://").expect("an http URL");
    let (address, path) = rest.split_at(rest.find('/').expect("a path"));
    (address.parse().expect("an address"), path.to_owned())
}

/// One tool call over HTTP with `token`, answered whole.
async fn called(url: &str, token: &str, tool: &str, arguments: Value) -> Called {
    let (address, path) = split_url(url);
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": { "name": tool, "arguments": arguments },
    })
    .to_string();
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\
         Accept: application/json, text/event-stream\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nAuthorization: Bearer {token}\r\n\r\n",
        body.len()
    );
    let answer = tokio::time::timeout(PATIENCE, async {
        let mut stream = TcpStream::connect(address).await.expect("connect");
        stream.write_all(head.as_bytes()).await.expect("send");
        stream.write_all(body.as_bytes()).await.expect("send");
        let mut answer = Vec::new();
        stream.read_to_end(&mut answer).await.expect("read");
        answer
    })
    .await
    .expect("an answer within the patience");
    let result = parse_result(&answer);
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

/// The `result` of the JSON-RPC answer in `answer`, an HTTP reply that may be
/// chunked.
fn parse_result(answer: &[u8]) -> Value {
    let end = answer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("a head");
    let head = String::from_utf8_lossy(&answer[..end]).into_owned();
    assert!(head.split(' ').nth(1) == Some("200"), "{head}");
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
    let answer: Value = serde_json::from_slice(&body)
        .unwrap_or_else(|err| panic!("{err}: {}", String::from_utf8_lossy(&body)));
    assert!(answer.get("error").is_none(), "{answer}");
    answer["result"].clone()
}

fn of_kind(standing: &[StandingNotice], kind: NoticeKind) -> Vec<&StandingNotice> {
    standing
        .iter()
        .filter(|notice| notice.kind == kind)
        .collect()
}

// ---------------------------------------------------------------------------
// Needs you
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_child_waiting_on_a_person_stands_as_a_notice_until_it_stops_waiting_or_ends_with_no_client_attached()
 {
    let world = World::new();
    let host = world.host().await;
    let parent = world.session(&world.project("needs-you"), "parent").await;
    for name in ["asker", "other"] {
        parent
            .start(json!({ "task": "work", "name": name }))
            .await
            .done();
    }
    let asker = world.child_of(&parent, "asker").await;
    let other = world.child_of(&parent, "other").await;
    assert!(
        world.notices().await.is_empty(),
        "nothing waits on a person yet"
    );

    // The agent's own records say a permission prompt is up; a client that
    // connects now is given the notice.
    world.type_line(&asker, "/wait").await;
    let standing = world
        .notices_where("a needs-you notice to stand", |notices| {
            !of_kind(notices, NoticeKind::NeedsYou).is_empty()
        })
        .await;
    assert_eq!(standing.len(), 1, "{standing:?}");
    let notice = &standing[0];
    assert_eq!(notice.kind, NoticeKind::NeedsYou);
    assert_eq!(notice.parent_id, parent.id());
    assert_eq!(notice.parent_name, "parent");
    assert_eq!(notice.child_id, Some(asker.id()));
    assert_eq!(notice.child_name.as_deref(), Some("asker"));
    assert_eq!(notice.text, "permission prompt");

    // It stands while the child waits, and a second child waiting stands
    // beside it.
    world.type_line(&other, "/wait").await;
    let standing = world
        .notices_where("two needs-you notices to stand", |notices| {
            of_kind(notices, NoticeKind::NeedsYou).len() == 2
        })
        .await;
    assert_eq!(
        standing[0].since, notice.since,
        "the first notice began when its child began waiting, and has not begun again"
    );

    // It goes when the child stops waiting...
    world.allow(&asker).await;
    let standing = world
        .notices_where("the answered child's notice to go", |notices| {
            notices.len() == 1
        })
        .await;
    assert_eq!(standing[0].child_id, Some(other.id()));

    // ...and when the child that waits ends.
    parent.stop("other").await.done();
    world
        .notices_where("the ended child's notice to go", |notices| {
            notices.is_empty()
        })
        .await;
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Refused starts and errors
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_start_and_a_child_that_ended_in_error_stand_across_a_restart_until_dismissed_or_the_parent_ends()
 {
    let world = World::new();
    let first = world.host().await;
    let parent = world.session(&world.project("refused"), "parent").await;
    world
        .settings(HostSettingsPatch {
            agent_children_per_parent: Some(1),
            ..HostSettingsPatch::default()
        })
        .await;
    parent
        .start(json!({ "task": "work", "name": "one" }))
        .await
        .done();
    let one = world.child_of(&parent, "one").await;

    // A refusal by a limit leaves a notice, and a new refusal by the same
    // limit for the same parent replaces it.
    let sentence = parent.start(json!({ "task": "more" })).await;
    assert!(
        sentence.refused().contains("limit of 1 running agents"),
        "{sentence:?}"
    );
    let first_notice = world
        .notices_where("a limit notice to stand", |notices| {
            of_kind(notices, NoticeKind::Limit).len() == 1
        })
        .await
        .remove(0);
    let sentence = parent.start(json!({ "task": "again" })).await;
    sentence.refused();
    let standing = world
        .notices_where("the limit notice to be replaced", |notices| {
            of_kind(notices, NoticeKind::Limit)
                .iter()
                .all(|notice| notice.id != first_notice.id)
        })
        .await;
    let limits = of_kind(&standing, NoticeKind::Limit);
    assert_eq!(limits.len(), 1, "{standing:?}");
    assert_eq!(limits[0].limit, Some(NoticeLimit::Children));
    assert_eq!(limits[0].parent_id, parent.id());
    assert_eq!(limits[0].parent_name, "parent");
    assert_eq!(limits[0].child_id, None);
    assert!(
        limits[0].text.contains("limit of 1 running agents"),
        "{:?}",
        limits[0]
    );
    assert_eq!(
        limits[0].allow_more, None,
        "only the starts limit allows more"
    );

    // A child that ends in error leaves one.
    world.type_line(&one, "/crash").await;
    let standing = world
        .notices_where("an error notice to stand", |notices| {
            of_kind(notices, NoticeKind::Error).len() == 1
        })
        .await;
    let error = of_kind(&standing, NoticeKind::Error)[0].clone();
    assert_eq!(error.parent_id, parent.id());
    assert_eq!(error.child_id, Some(one.id()));
    assert_eq!(error.child_name.as_deref(), Some("one"));
    assert!(error.text.contains("code 3"), "{error:?}");
    let limit = of_kind(&standing, NoticeKind::Limit)[0].clone();

    // A launch that fails leaves one, naming the child that never ran.
    let failed = parent
        .start(json!({ "task": "work", "name": "ghost", "role": "ghostly", "backend": MISSING }))
        .await;
    failed.refused();
    let standing = world
        .notices_where("a launch failure to stand", |notices| {
            of_kind(notices, NoticeKind::Error).len() == 2
        })
        .await;
    let ghost = of_kind(&standing, NoticeKind::Error)
        .into_iter()
        .find(|notice| notice.child_name.as_deref() == Some("ghost"))
        .expect("a notice for the child that never ran")
        .clone();
    assert_eq!(ghost.child_id, None);
    assert!(ghost.text.contains("could not be started"), "{ghost:?}");

    // The host goes down and comes back with the sessions the keeper held:
    // the notices stand as they were.
    first.crash().await;
    let second = world.host().await;
    let standing = world.notices().await;
    assert_eq!(standing.len(), 3, "{standing:?}");
    for kept in [&limit, &error, &ghost] {
        assert!(
            standing.contains(kept),
            "{kept:?} did not survive the restart: {standing:?}"
        );
    }

    // A client that is attached sees another client's dismissal: it is for
    // every client.
    let mut watching = world.client().await;
    watching.subscribe_on(1, NOTICES).await;
    world.dismiss(&error.id).await;
    let remaining = watching
        .event_on::<Vec<StandingNotice>>(1, "the notices without the dismissed one", |list| {
            list.iter().all(|notice| notice.id != error.id)
        })
        .await;
    assert_eq!(remaining.len(), 2, "{remaining:?}");
    // A notice that is already gone, and an id that names nothing, are left
    // as they are.
    world.dismiss(&error.id).await;
    world.dismiss("needs-you-1").await;
    world.dismiss("not a notice").await;
    assert_eq!(world.notices().await.len(), 2);

    // The notices of a parent that ends go with it.
    world.close(&parent).await;
    world
        .notices_where("the ended parent's notices to go", |notices| {
            notices.is_empty()
        })
        .await;
    second.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_notice_left_under_a_parent_that_is_not_running_is_gone_when_the_host_starts() {
    let world = World::new();
    let first = world.host().await;
    let parent = world.session(&world.project("gone"), "parent").await;
    // Stopping the host ends the parent.
    first.stop(HostStopReason::Stop).await;

    // What a host that was killed while it ran the parent would have left,
    // and a notice under a session the record does not have.
    for under in [i64::try_from(parent.id()).unwrap(), 999_999] {
        world
            .db()
            .execute(
                "INSERT INTO notices (kind, parent_session_id, parent_name, text, limit_kind) \
                 VALUES ('limit', ?1, 'parent', 'A limit held.', 'children')",
                [under],
            )
            .expect("leave a notice");
    }
    let second = world.host().await;
    assert!(world.notices().await.is_empty());
    second.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// Allow more starts
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn allowing_a_parent_more_starts_adds_the_starts_setting_to_that_parent_alone_and_removes_its_notice()
 {
    let world = World::new();
    let host = world.host().await;
    world
        .settings(HostSettingsPatch {
            agent_starts_per_parent: Some(2),
            ..HostSettingsPatch::default()
        })
        .await;
    let refused = world.session(&world.project("refused"), "refused").await;
    let other = world.session(&world.project("other"), "other").await;
    for parent in [&refused, &other] {
        world.ended_starts(parent, 2);
        let sentence = parent.start(json!({ "task": "one too many" })).await;
        assert!(
            sentence.refused().contains("limit of 2 starts per parent"),
            "{sentence:?}"
        );
    }
    let standing = world
        .notices_where("both starts notices to stand", |notices| {
            of_kind(notices, NoticeKind::Limit).len() == 2
        })
        .await;
    for notice in &standing {
        assert_eq!(notice.limit, Some(NoticeLimit::Starts), "{notice:?}");
        assert_eq!(
            notice.allow_more,
            Some(2),
            "the notice says how many more Allow adds: the starts setting"
        );
    }

    // A client allows the one parent more starts, and is gone.
    assert_eq!(world.allow_more(&refused).await, 2);
    let standing = world
        .notices_where("the allowed parent's notice to go", |notices| {
            notices.len() == 1
        })
        .await;
    assert_eq!(standing[0].parent_id, other.id(), "no other notice changes");

    // The parent starts as many more as the setting says, with no client
    // attached, and is then refused again at the new count.
    for name in ["extra-1", "extra-2"] {
        refused
            .start(json!({ "task": "work", "name": name }))
            .await
            .done();
        refused.stop(name).await.done();
    }
    let sentence = refused.start(json!({ "task": "one too many" })).await;
    assert!(
        sentence.refused().contains("limit of 4 starts per parent"),
        "{sentence:?}"
    );
    let standing = world
        .notices_where("a new starts notice for the allowed parent", |notices| {
            notices.len() == 2
        })
        .await;
    assert!(
        standing
            .iter()
            .all(|notice| notice.limit == Some(NoticeLimit::Starts))
    );

    // The other parent's limit did not move.
    let sentence = other.start(json!({ "task": "still refused" })).await;
    assert!(
        sentence.refused().contains("limit of 2 starts per parent"),
        "{sentence:?}"
    );

    // With no starts notice standing, allowing adds nothing: two clients
    // pressing Allow together add the starts once.
    let once = world.allow_more(&other).await;
    assert_eq!(once, 2);
    assert_eq!(world.allow_more(&other).await, 0);
    other
        .start(json!({ "task": "work", "name": "after" }))
        .await
        .done();
    other
        .start(json!({ "task": "work", "name": "after-2" }))
        .await
        .done();
    let sentence = other.start(json!({ "task": "one too many" })).await;
    assert!(
        sentence.refused().contains("limit of 4 starts per parent"),
        "{sentence:?}"
    );
    host.stop(HostStopReason::Stop).await;
}
