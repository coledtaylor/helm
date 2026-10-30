//! The host's agent tools as a session reaches them: a host with real sessions
//! running the fake agent (which takes agent tools as Claude Code does) and
//! the fake `claude` (`test/fake-agents/claude-code.mjs`), never a real
//! agent. Every call is made over HTTP to the listener with the URL and
//! bearer token read from the session's own `--mcp-config` file, which is the
//! whole of who is asking.

use std::ffi::OsString;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use floti_host::agent::AgentBackend;
use floti_host::agent::claude_code::{ClaudeCodeBackend, ClaudeCodeSettings};
use floti_host::fake_agent;
use floti_host::platform::process_tree::{Native as NativeTree, ProcessTree};
use floti_host::platform::socket::Endpoint;
use floti_host::server::HostConfig;
use floti_host::testkit::{FakeAgent, GitRepo, PATIENCE, RunningHost, TestClient, TestDirs};
use floti_protocol::channel::{EventChannel, from_payload, to_payload};
use floti_protocol::channels::agent_browser::{
    AgentBrowserAnswer, AgentBrowserCalls, AgentBrowserOutcome, AgentBrowserToolAnswer,
    AgentBrowserToolCall,
};
use floti_protocol::channels::agent_plugin::{
    AgentPluginAnswer, AgentPluginCallCancel, AgentPluginCalls, AgentPluginCancels,
    AgentPluginOffer, AgentPluginOutcome, AgentPluginServer, AgentPluginServers, AgentPluginTool,
    AgentPluginToolAnswer, AgentPluginToolCall,
};
use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::sessions::{
    CloseSessionRequest, SessionClose, SessionList, SessionStart, StartSessionRequest,
};
use floti_protocol::channels::workspace::{HostSettingsPatch, WriteSettings};
use floti_protocol::message::{ErrorCode, ErrorReply};
use floti_protocol::{BackendId, Knowable, Message};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const TERMINAL: &[&str] = &["terminal"];

// ---------------------------------------------------------------------------
// A host whose sessions take agent tools
// ---------------------------------------------------------------------------

/// A host on the fake agent (the default, with a child listening on
/// 127.0.0.1) and Claude Code over the fake `claude`.
struct World {
    endpoint: Endpoint,
    agent: FakeAgent,
    /// The fake `claude`'s config folder: `CLAUDE_CONFIG_DIR` for its runs.
    claude: PathBuf,
    /// Last: fields drop in order.
    dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let agent = fake_agent!(&dirs);
        Self {
            endpoint: dirs.endpoint(),
            claude: resolved(&dirs.folder("claude config")),
            agent,
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
            Arc::new(self.agent.backend(["--fake-listen"]).with_agent_tools()),
            Arc::new(ClaudeCodeBackend::new(claude, Arc::new(NativeTree))),
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

    fn host(&self) -> RunningHost {
        RunningHost::start(self.config())
    }

    async fn client(&self) -> TestClient {
        TestClient::connect(&self.endpoint, TERMINAL).await
    }

    fn folder(&self, name: &str) -> PathBuf {
        resolved(&self.dirs.folder(name))
    }

    /// A fake agent session in `folder`, with the tools it was given.
    async fn fake_session(&self, client: &mut TestClient, folder: &Path, name: &str) -> Tooled {
        let record = start(client, folder, name, None, None).await;
        let run = self.agent_run_in(folder);
        let config = mcp_config_of(&run.argv);
        Tooled::new(record, run.pid, run.argv, config)
    }

    /// A Claude Code session in `folder`, with the tools it was given.
    async fn claude_session(
        &self,
        client: &mut TestClient,
        folder: &Path,
        name: &str,
        prompt: Option<&str>,
    ) -> Tooled {
        let record = start(client, folder, name, Some(BackendId::claude_code()), prompt).await;
        let run = self.claude_run(&record);
        let argv = strings(&run["argv"]);
        let config = mcp_config_of(&argv);
        let pid = u32::try_from(run["pid"].as_u64().expect("a pid")).unwrap();
        Tooled::new(record, pid, argv, config)
    }

    /// The fake agent's run in `folder`: the session's program, not its child.
    fn agent_run_in(&self, folder: &Path) -> floti_host::testkit::FakeAgentRecord {
        let deadline = Instant::now() + PATIENCE;
        loop {
            if let Some(run) = self.agent.records().into_iter().find(|run| {
                same_folder(Path::new(&run.cwd), folder)
                    && !run.argv.iter().any(|arg| arg.starts_with("--fake-serve"))
            }) {
                return run;
            }
            assert!(Instant::now() < deadline, "no run in {}", folder.display());
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Every run the fake `claude` logged.
    fn claude_runs(&self) -> Vec<Value> {
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

    /// The fake `claude`'s run for `record`, by the conversation the host
    /// gave it.
    fn claude_run(&self, record: &SessionRecord) -> Value {
        let deadline = Instant::now() + PATIENCE;
        loop {
            if let Some(run) = self
                .claude_runs()
                .into_iter()
                .find(|run| run["sessionId"].as_str() == record.conversation_id.as_deref())
            {
                return run;
            }
            assert!(
                Instant::now() < deadline,
                "no fake claude run for {record:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Switches helm-sessions, as the settings pane does.
    async fn session_tools(&self, client: &mut TestClient, on: bool) {
        client
            .request::<WriteSettings>(&HostSettingsPatch {
                session_mcp: Some(on),
                ..HostSettingsPatch::default()
            })
            .await
            .expect("the settings are written");
    }

    /// Every launch folder under the data folder.
    fn launch_folders(&self) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(self.dirs.data.join("launches")) else {
            return Vec::new();
        };
        entries.flatten().map(|entry| entry.path()).collect()
    }
}

/// A session and the tools its `--mcp-config` file names.
struct Tooled {
    record: SessionRecord,
    /// The pid the listing knows it by.
    pid: u32,
    argv: Vec<String>,
    /// Its tool configuration file.
    config: PathBuf,
    /// helm-sessions' URL, from the file.
    url: String,
    /// Its bearer token, from the file.
    token: String,
    /// helm-browser's URL and token, when the file names it.
    browser: Option<(String, String)>,
}

impl Tooled {
    fn new(record: SessionRecord, pid: u32, argv: Vec<String>, config: PathBuf) -> Self {
        let document: Value =
            serde_json::from_slice(&std::fs::read(&config).expect("read the tool file"))
                .expect("the tool file is JSON");
        let (url, token) = server_in(&document, "helm-sessions").expect("a helm-sessions entry");
        let browser = server_in(&document, "helm-browser");
        Self {
            record,
            pid,
            argv,
            config,
            url,
            token,
            browser,
        }
    }

    /// The names of the servers its tool file names, sorted.
    fn servers(&self) -> Vec<String> {
        let document: Value =
            serde_json::from_slice(&std::fs::read(&self.config).expect("read the tool file"))
                .expect("the tool file is JSON");
        let mut names: Vec<String> = document["mcpServers"]
            .as_object()
            .expect("a server map")
            .keys()
            .cloned()
            .collect();
        names.sort();
        names
    }

    /// helm-browser's URL and token.
    fn browser(&self) -> (&str, &str) {
        let (url, token) = self.browser.as_ref().expect("a helm-browser entry");
        (url, token)
    }

    /// One browser tool call, made while the test answers it elsewhere.
    fn call_browser(&self, tool: &'static str, arguments: Value) -> tokio::task::JoinHandle<Value> {
        let (url, token) = self.browser();
        let (url, token) = (url.to_owned(), token.to_owned());
        tokio::spawn(async move {
            rpc(
                &url,
                Some(&token),
                "tools/call",
                json!({ "name": tool, "arguments": arguments }),
            )
            .await
            .result()
        })
    }

    async fn list(&self) -> (bool, String) {
        call_tool(&self.url, &self.token, "sessions_list", json!({})).await
    }

    async fn detail(&self, arguments: Value) -> (bool, String) {
        call_tool(&self.url, &self.token, "session_detail", arguments).await
    }

    async fn tools_list(&self) -> Reply {
        rpc(&self.url, Some(&self.token), "tools/list", json!({})).await
    }
}

/// The URL and bearer token of the server named `name` in a tool file.
fn server_in(document: &Value, name: &str) -> Option<(String, String)> {
    let server = document["mcpServers"].get(name)?;
    let url = server["url"].as_str().expect("a server's URL").to_owned();
    let token = server["headers"]["Authorization"]
        .as_str()
        .and_then(|value| value.strip_prefix("Bearer "))
        .expect("a bearer token")
        .to_owned();
    Some((url, token))
}

async fn start(
    client: &mut TestClient,
    folder: &Path,
    name: &str,
    backend: Option<BackendId>,
    prompt: Option<&str>,
) -> SessionRecord {
    client
        .request::<SessionStart>(&StartSessionRequest {
            cwd: folder.to_string_lossy().into_owned(),
            cols: 80,
            rows: 24,
            name: Some(name.to_owned()),
            backend,
            opening_prompt: prompt.map(str::to_owned),
            ..StartSessionRequest::default()
        })
        .await
        .expect("the session starts")
}

async fn close(client: &mut TestClient, session: &SessionRecord) {
    client
        .request::<SessionClose>(&CloseSessionRequest {
            id: session.id,
            force: true,
        })
        .await
        .expect("the session closes");
}

/// The one `--mcp-config` file in `argv`.
fn mcp_config_of(argv: &[String]) -> PathBuf {
    let flags: Vec<usize> = argv
        .iter()
        .enumerate()
        .filter(|(_, arg)| *arg == "--mcp-config")
        .map(|(at, _)| at)
        .collect();
    assert_eq!(flags.len(), 1, "exactly one --mcp-config in {argv:?}");
    PathBuf::from(&argv[flags[0] + 1])
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
        .expect("a list")
        .iter()
        .map(|item| item.as_str().expect("a string").to_owned())
        .collect()
}

/// The block `sessions_list` printed for `pid`, or empty when there is none.
fn block_for(listing: &str, pid: u32) -> String {
    listing
        .split("\n\n")
        .find(|block| block.starts_with(&format!("#{pid}  ")))
        .unwrap_or_default()
        .to_owned()
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
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|err| panic!("{err}: {}", String::from_utf8_lossy(&self.body)))
    }

    fn result(&self) -> Value {
        assert_eq!(self.status, 200, "{self:?}");
        let answer = self.json();
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

/// A tool's answer: whether it failed, and its text.
async fn call_tool(url: &str, token: &str, tool: &str, arguments: Value) -> (bool, String) {
    let result = rpc(
        url,
        Some(token),
        "tools/call",
        json!({ "name": tool, "arguments": arguments }),
    )
    .await
    .result();
    let failed = result["isError"].as_bool().unwrap_or(false);
    let text = result["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    (failed, text)
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s10_a_launch_carries_one_mcp_config_in_its_own_launch_folder_naming_helm_sessions_with_its_token()
 {
    let world = World::new();
    let host = world.host();
    let mut client = world.client().await;
    let project = world.folder("a project");
    let home_before = files_under(&world.dirs.home);
    let alpha = world
        .claude_session(&mut client, &project, "alpha", None)
        .await;
    let beta = world
        .claude_session(&mut client, &project, "beta", None)
        .await;

    for session in [&alpha, &beta] {
        // In a launch folder of its own, under Floti's data folder.
        let folder = session.config.parent().expect("a launch folder");
        assert_eq!(session.config.file_name().unwrap(), "mcp.json");
        assert!(
            folder.starts_with(world.dirs.data.join("launches")),
            "{}",
            session.config.display()
        );
        let document: Value =
            serde_json::from_slice(&std::fs::read(&session.config).unwrap()).unwrap();
        let servers = document["mcpServers"].as_object().unwrap();
        assert_eq!(servers.keys().collect::<Vec<_>>(), ["helm-sessions"]);
        let (address, path) = split_url(&session.url);
        assert_eq!(address.ip().to_string(), "127.0.0.1");
        assert_ne!(address.port(), 0);
        assert_eq!(path, "/mcp/sessions");
        assert_eq!(
            servers["helm-sessions"],
            json!({
                "type": "http",
                "url": session.url,
                "headers": { "Authorization": format!("Bearer {}", session.token) },
            })
        );
        assert_eq!(session.token.len(), 64, "{}", session.token);
        // On no command line: not the one the agent ran with, not the row's.
        for arg in session.argv.iter().chain(&session.record.argv) {
            assert!(!arg.contains(&session.token), "{arg}");
        }
        // And it is the token the listener answers.
        assert_eq!(session.tools_list().await.status, 200);
    }
    assert_ne!(alpha.token, beta.token);
    assert_ne!(alpha.config, beta.config);
    assert_eq!(split_url(&alpha.url).0, split_url(&beta.url).0);

    // Nothing of the agent's own: no `claude mcp add-json`, no global or
    // project config, and no file of the agent's or the user's holding a
    // token. The fake's own run log is the test's record, not the agent's.
    for run in world.claude_runs() {
        assert_ne!(run["argv"][0], "mcp", "{run}");
    }
    for config in [
        world.claude.join(".claude.json"),
        world.dirs.home.join(".claude.json"),
        project.join(".mcp.json"),
    ] {
        assert!(!config.exists(), "{} was written", config.display());
    }
    for file in files_under(&world.claude) {
        if file.starts_with(world.claude.join("fake-agent")) {
            continue;
        }
        let bytes = std::fs::read(&file).unwrap_or_default();
        let text = String::from_utf8_lossy(&bytes);
        for token in [&alpha.token, &beta.token] {
            assert!(
                !text.contains(token.as_str()),
                "{} holds a token",
                file.display()
            );
        }
    }
    assert_eq!(files_under(&world.dirs.home), home_before);

    close(&mut client, &alpha.record).await;
    close(&mut client, &beta.record).await;
    host.stop(HostStopReason::Stop).await;
}

/// Every file under `root`, links not followed.
fn files_under(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut folders = vec![root.to_path_buf()];
    while let Some(folder) = folders.pop() {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match std::fs::symlink_metadata(&path) {
                Ok(meta) if meta.is_dir() => folders.push(path),
                Ok(_) => found.push(path),
                Err(_) => {}
            }
        }
    }
    found.sort();
    found
}

#[tokio::test(flavor = "multi_thread")]
async fn s5_s11_a_session_that_ends_takes_its_token_and_tool_file_with_it_and_the_others_still_work()
 {
    let world = World::new();
    let host = world.host();
    let mut client = world.client().await;
    let alpha = world
        .fake_session(&mut client, &world.folder("alpha"), "alpha")
        .await;
    let beta = world
        .fake_session(&mut client, &world.folder("beta"), "beta")
        .await;
    assert_eq!(alpha.tools_list().await.status, 200);
    assert_eq!(beta.tools_list().await.status, 200);
    let launch_folder = alpha.config.parent().unwrap().to_path_buf();
    assert!(alpha.config.is_file());

    close(&mut client, &alpha.record).await;

    // The file and the folder holding it go.
    eventually("alpha's launch folder is removed", async || {
        (!launch_folder.exists()).then_some(())
    })
    .await;
    assert!(!alpha.config.exists());
    // Its token is answered 401 from then on, whatever it asks.
    eventually("alpha's token is refused", async || {
        (alpha.tools_list().await.status == 401).then_some(())
    })
    .await;
    assert_eq!(
        rpc(&alpha.url, Some(&alpha.token), "initialize", json!({}))
            .await
            .status,
        401
    );
    // The other session's still works, on the same port.
    assert_eq!(beta.tools_list().await.status, 200);
    let (failed, listing) = beta.list().await;
    assert!(!failed, "{listing}");
    assert!(block_for(&listing, alpha.pid).is_empty(), "{listing}");
    assert!(beta.config.is_file());

    close(&mut client, &beta.record).await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s7_a_stopped_host_serves_no_tools_and_a_host_started_after_accepts_none_of_its_tokens() {
    let world = World::new();
    let host = world.host();
    let mut client = world.client().await;
    let alpha = world
        .fake_session(&mut client, &world.folder("alpha"), "alpha")
        .await;
    let beta = world
        .fake_session(&mut client, &world.folder("beta"), "beta")
        .await;
    let (old, _) = split_url(&alpha.url);
    assert_eq!(alpha.tools_list().await.status, 200);
    drop(client);

    // Watched through the stop: once a session's program has ended, the
    // listener must already be closed.
    let watching = std::thread::spawn({
        let pids = [alpha.pid, beta.pid];
        move || listener_closes_before_any_of(&pids, old)
    });
    host.stop(HostStopReason::Stop).await;
    let watched = watching.join().expect("watch the stop");
    assert_eq!(watched, Ok(()), "{watched:?}");

    // Its port accepts no connection.
    assert!(
        TcpStream::connect(old).await.is_err(),
        "the stopped host's listener still accepts on {old}"
    );

    // A host started afterwards knows none of the tokens handed out before.
    let host = world.host();
    let mut client = world.client().await;
    let gamma = world
        .fake_session(&mut client, &world.folder("gamma"), "gamma")
        .await;
    assert_eq!(gamma.tools_list().await.status, 200);
    for stale in [&alpha, &beta] {
        let reply = rpc(&gamma.url, Some(&stale.token), "tools/list", json!({})).await;
        assert_eq!(reply.status, 401, "{reply:?}");
    }
    close(&mut client, &gamma.record).await;
    host.stop(HostStopReason::Stop).await;
}

/// Samples `pids` and `address` until the address refuses a connection, and
/// fails if it ever accepted one after any of `pids` had ended. Each sample
/// looks at the processes first: a process seen ended before a connection
/// was accepted ended while the listener was still serving.
fn listener_closes_before_any_of(pids: &[u32], address: SocketAddr) -> Result<(), String> {
    let deadline = Instant::now() + PATIENCE * 2;
    while Instant::now() < deadline {
        let ended: Vec<u32> = pids
            .iter()
            .copied()
            .filter(|pid| NativeTree.is_alive(*pid) == Knowable::Known(false))
            .collect();
        match std::net::TcpStream::connect_timeout(&address, PATIENCE) {
            Ok(_) if !ended.is_empty() => {
                return Err(format!(
                    "{address} still accepted after {ended:?} had ended"
                ));
            }
            Ok(_) => std::thread::sleep(Duration::from_millis(2)),
            Err(_) => return Ok(()),
        }
    }
    Err(format!(
        "{address} was still accepting {:?} later",
        PATIENCE * 2
    ))
}

#[tokio::test(flavor = "multi_thread")]
async fn s8_with_every_family_off_a_launch_has_no_mcp_config_and_no_tool_file() {
    let world = World::new();
    let host = world.host();
    let mut client = world.client().await;
    world.session_tools(&mut client, false).await;

    let folder = world.folder("bare");
    let record = start(&mut client, &folder, "bare", None, None).await;
    let run = world.agent_run_in(&folder);
    assert!(
        !run.argv.iter().any(|arg| arg == "--mcp-config"),
        "{:?}",
        run.argv
    );
    assert!(!record.argv.iter().any(|arg| arg == "--mcp-config"));
    let folders = world.launch_folders();
    assert_eq!(folders.len(), 1, "{folders:?}");
    assert!(!folders[0].join("mcp.json").exists());

    let claude = start(
        &mut client,
        &world.folder("bare claude"),
        "bare claude",
        Some(BackendId::claude_code()),
        None,
    )
    .await;
    let run = world.claude_run(&claude);
    assert!(
        !strings(&run["argv"]).contains(&"--mcp-config".to_owned()),
        "{run}"
    );
    assert!(
        run["mcpServers"]
            .as_object()
            .is_none_or(|servers| servers.is_empty()),
        "{run}"
    );
    for folder in world.launch_folders() {
        assert!(!folder.join("mcp.json").exists(), "{}", folder.display());
    }

    close(&mut client, &record).await;
    close(&mut client, &claude).await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s9_switching_helm_sessions_off_takes_its_route_away_at_once_and_on_gives_it_back() {
    let world = World::new();
    let host = world.host();
    let mut client = world.client().await;
    let alpha = world
        .fake_session(&mut client, &world.folder("alpha"), "alpha")
        .await;
    assert_eq!(alpha.tools_list().await.status, 200);

    world.session_tools(&mut client, false).await;
    // At once: its route is 404, so it has no tools to list or call.
    let reply = alpha.tools_list().await;
    assert_eq!(reply.status, 404, "{reply:?}");
    assert_eq!(
        rpc(
            &alpha.url,
            Some(&alpha.token),
            "tools/call",
            json!({ "name": "sessions_list", "arguments": {} })
        )
        .await
        .status,
        404
    );
    // Still a token: without one it is 401, as on every path.
    assert_eq!(
        rpc(&alpha.url, None, "tools/list", json!({})).await.status,
        401
    );

    // A session launched now is given no helm-sessions entry, and with no
    // family left, no --mcp-config at all.
    let folder = world.folder("beta");
    let beta = start(&mut client, &folder, "beta", None, None).await;
    let run = world.agent_run_in(&folder);
    assert!(
        !run.argv.iter().any(|arg| arg == "--mcp-config"),
        "{:?}",
        run.argv
    );

    // Switched back on, the running session's route answers again.
    world.session_tools(&mut client, true).await;
    let result = alpha.tools_list().await.result();
    let names: Vec<&str> = result["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["sessions_list", "session_detail"]);

    close(&mut client, &alpha.record).await;
    close(&mut client, &beta).await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s12_a_starting_host_sweeps_only_the_launch_folders_whose_every_owner_is_provably_gone() {
    let world = World::new();
    let launches = world.dirs.data.join("launches");
    let left = |name: &str, owners: &str| {
        let folder = launches.join(name);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("owners.json"), owners).unwrap();
        std::fs::write(folder.join("mcp.json"), r#"{"mcpServers":{}}"#).unwrap();
        folder
    };
    let dead = ended_pid();
    let gone = left("launch-1-aaaaaa", &format!(r#"{{"pids":[{dead}]}}"#));
    let alive = left(
        "launch-2-bbbbbb",
        &format!(r#"{{"pids":[{dead},{}]}}"#, std::process::id()),
    );
    let unreadable = left("launch-3-cccccc", "not json");
    let not_ours = left("something else", &format!(r#"{{"pids":[{dead}]}}"#));

    let host = world.host();
    let _client = world.client().await;
    assert!(!gone.exists(), "{} was kept", gone.display());
    for kept in [&alive, &unreadable, &not_ours] {
        assert!(
            kept.join("mcp.json").is_file(),
            "{} was swept",
            kept.display()
        );
    }
    host.stop(HostStopReason::Stop).await;
}

/// A pid no process has: one that ran and has ended.
fn ended_pid() -> u32 {
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--list")
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let pid = child.id();
    child.wait().unwrap();
    pid
}

// ---------------------------------------------------------------------------
// helm-sessions
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s13_s2_the_server_names_itself_helm_sessions_negotiates_and_lists_todays_tools_from_the_shared_table()
 {
    let world = World::new();
    let host = world.host();
    let mut client = world.client().await;
    let alpha = world
        .fake_session(&mut client, &world.folder("alpha"), "alpha")
        .await;

    for version in ["2025-06-18", "2025-03-26", "2024-11-05"] {
        let result = rpc(
            &alpha.url,
            Some(&alpha.token),
            "initialize",
            json!({
                "protocolVersion": version,
                "capabilities": {},
                "clientInfo": { "name": "claude-code", "version": "2.1.300" },
            }),
        )
        .await
        .result();
        assert_eq!(result["protocolVersion"], version, "{result}");
        assert_eq!(result["serverInfo"]["name"], "helm-sessions", "{result}");
        let instructions = result["instructions"].as_str().unwrap();
        assert!(instructions.contains("read-only"), "{instructions}");
        assert!(instructions.contains("sessions_list"), "{instructions}");
    }

    let notified = post(
        &alpha.url,
        Some(&alpha.token),
        &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
    )
    .await;
    assert_eq!(notified.status, 202, "{notified:?}");
    assert!(notified.body.is_empty(), "{notified:?}");

    // Exactly today's tools and instructions, from the table the desktop's
    // own listener reads: so `mcp__helm-sessions__*` rules apply unchanged,
    // and none is allowed without asking on their account.
    let table = session_table();
    let initialized = rpc(
        &alpha.url,
        Some(&alpha.token),
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "claude-code", "version": "2.1.300" },
        }),
    )
    .await
    .result();
    assert_eq!(initialized["instructions"], table["instructions"]);
    let result = alpha.tools_list().await.result();
    assert_eq!(result["tools"], table["tools"]);
    assert!(
        !alpha.argv.iter().any(|arg| arg == "--allowedTools"),
        "{:?}",
        alpha.argv
    );

    close(&mut client, &alpha.record).await;
    host.stop(HostStopReason::Stop).await;
}

/// The session tools' table, as the desktop's listener reads it too.
fn session_table() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("server")
        .join("session_tools.json");
    serde_json::from_slice(&std::fs::read(path).expect("read the table")).expect("JSON")
}

/// The record a Claude Code session somebody started in a terminal writes.
fn outside_record(config: &Path, pid: u32, conversation: &str, cwd: &Path) {
    let sessions = config.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let record = json!({
        "pid": pid,
        "sessionId": conversation,
        "cwd": cwd.to_string_lossy(),
        "startedAt": now,
        "version": "2.1.300",
        "entrypoint": "cli",
        "name": "elsewhere",
        "status": "busy",
        "statusUpdatedAt": now,
    });
    std::fs::write(sessions.join(format!("{pid}.json")), record.to_string()).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn s14_s16_s19_s22_s23_sessions_see_every_live_session_and_nothing_of_another_conversation() {
    let world = World::new();
    let outside_conversation = "outside-conversation-d2c1";
    let outside_folder = world.folder("started elsewhere");
    outside_record(
        &world.claude,
        std::process::id(),
        outside_conversation,
        &outside_folder,
    );
    let host = world.host();
    let mut client = world.client().await;

    let opening_prompt = "opening-prompt-5e1a77";
    let first_message = "first-message-90b3c4";
    let alpha = world
        .claude_session(&mut client, &world.folder("alpha"), "alpha", None)
        .await;
    let beta = world
        .claude_session(
            &mut client,
            &world.folder("beta"),
            "beta",
            Some(opening_prompt),
        )
        .await;

    // Both joined to the records they write.
    let listing = eventually(
        "both hosted sessions are listed from their records",
        async || {
            let (_, listing) = alpha.list().await;
            [&alpha, &beta]
                .iter()
                .all(|session| {
                    let block = block_for(&listing, session.pid);
                    block.contains("hosted       yes") && !block.contains("status       unknown")
                })
                .then_some(listing)
        },
    )
    .await;

    // S14: every live session, with its name, folder and status; the one
    // started outside the host said so; only the caller marked.
    assert!(
        listing.starts_with(
            "3 Claude Code sessions running on this machine, 2 of them hosted by Helm."
        ),
        "{listing}"
    );
    for session in [&alpha, &beta] {
        let block = block_for(&listing, session.pid);
        assert!(
            block.contains(&format!("working in   {}", session.record.cwd)),
            "{block}"
        );
        assert!(block.contains("\n    status       "), "{block}");
        assert!(
            block.contains(&format!(
                "hosted       yes, in Helm tab {}",
                session.record.id
            )),
            "{block}"
        );
    }
    let elsewhere = block_for(&listing, std::process::id());
    assert!(elsewhere.contains("\"elsewhere\""), "{elsewhere}");
    assert!(
        elsewhere.contains(&format!("working in   {}", outside_folder.display())),
        "{elsewhere}"
    );
    assert!(elsewhere.contains("status       busy"), "{elsewhere}");
    assert!(
        elsewhere.contains("hosted       no - started somewhere else"),
        "{elsewhere}"
    );
    assert_eq!(listing.matches("(this session)").count(), 1, "{listing}");
    assert_eq!(
        block_for(&listing, alpha.pid).lines().next().unwrap(),
        format!("#{}  \"alpha\"  (this session)", alpha.pid)
    );
    let (_, as_beta) = beta.list().await;
    assert_eq!(as_beta.matches("(this session)").count(), 1, "{as_beta}");
    assert_eq!(
        block_for(&as_beta, beta.pid).lines().next().unwrap(),
        format!("#{}  \"beta\"  (this session)", beta.pid)
    );

    // S19: no pid, or arguments naming another session, is the caller.
    let own = format!("#{}  \"alpha\"  (this session)", alpha.pid);
    let (failed, detail) = alpha.detail(json!({})).await;
    assert!(!failed, "{detail}");
    assert_eq!(detail.lines().next().unwrap(), own);
    let (_, claimed) = alpha
        .detail(json!({
            "session": beta.record.id,
            "hostSessionId": beta.record.id,
            "sessionId": beta.record.conversation_id,
            "token": beta.token,
        }))
        .await;
    assert_eq!(claimed.lines().next().unwrap(), own);

    // Planted for S22: a first message, and a child whose command line is
    // the fake's script.
    client.attach(1, beta.record.id).await;
    client
        .type_into(1, format!("{first_message}\r").as_bytes())
        .await;
    client.attach(2, alpha.record.id).await;
    client.type_into(2, b"/child\r").await;
    client
        .read_stream_until(2, |screen| {
            String::from_utf8_lossy(screen).contains("child ")
        })
        .await;

    // S16: what a waiting session waits on, in its record's words.
    client.type_into(1, b"/wait\r").await;
    let waiting = "status       waiting on the user (permission prompt)";
    eventually("beta is listed as waiting", async || {
        let (_, listing) = alpha.list().await;
        block_for(&listing, beta.pid)
            .contains(waiting)
            .then_some(())
    })
    .await;
    let (_, detail) = alpha.detail(json!({ "pid": beta.pid })).await;
    assert!(detail.contains(waiting), "{detail}");
    client.type_into(1, b"y\r").await;

    // S22: nothing of another session's conversation or launch, in any
    // answer to any session.
    let history = std::fs::read_to_string(world.claude.join("history.jsonl")).unwrap_or_default();
    eventually("beta's first message is in its history", async || {
        let history =
            std::fs::read_to_string(world.claude.join("history.jsonl")).unwrap_or_default();
        history.contains(first_message).then_some(())
    })
    .await;
    drop(history);
    assert!(
        beta.argv.iter().any(|arg| arg == opening_prompt),
        "{:?}",
        beta.argv
    );
    let mut forbidden: Vec<String> = vec![
        opening_prompt.into(),
        first_message.into(),
        outside_conversation.into(),
        "setInterval".into(),
        "claude-code.mjs".into(),
        "--mcp-config".into(),
        "--session-id".into(),
    ];
    for session in [&alpha, &beta] {
        forbidden.push(session.token.clone());
        forbidden.push(session.config.to_string_lossy().into_owned());
        forbidden.push(
            session
                .record
                .conversation_id
                .clone()
                .expect("a conversation id"),
        );
    }
    let pids = [alpha.pid, beta.pid, std::process::id()];
    let mut answers = Vec::new();
    for caller in [&alpha, &beta] {
        answers.push(caller.list().await.1);
        answers.push(caller.detail(json!({})).await.1);
        for pid in pids {
            answers.push(caller.detail(json!({ "pid": pid })).await.1);
        }
    }
    assert_eq!(answers.len(), 2 * (2 + pids.len()));
    let alpha_detail = alpha.detail(json!({})).await.1;
    assert!(
        alpha_detail.contains("Holding      1 process under it"),
        "{alpha_detail}"
    );
    for answer in &answers {
        for secret in &forbidden {
            assert!(!answer.contains(secret.as_str()), "{secret} in {answer}");
        }
    }

    // S23: an ended session is not listed and its detail says it is gone.
    client.type_into(1, b"/exit\r").await;
    let listing = eventually("beta is gone from the listing", async || {
        let (_, listing) = alpha.list().await;
        block_for(&listing, beta.pid).is_empty().then_some(listing)
    })
    .await;
    assert!(
        listing.starts_with(
            "2 Claude Code sessions running on this machine, 1 of them hosted by Helm."
        ),
        "{listing}"
    );
    let (failed, gone) = alpha.detail(json!({ "pid": beta.pid })).await;
    assert!(failed, "{gone}");
    assert_eq!(
        gone.lines().next().unwrap(),
        format!(
            "No Claude Code session with pid {} is running on this machine.",
            beta.pid
        )
    );

    close(&mut client, &alpha.record).await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s17_another_hosted_session_is_detailed_as_itself_with_its_children_and_ports_from_a_pass_for_the_call()
 {
    let world = World::new();
    let host = world.host();
    let mut client = world.client().await;
    let overlay = world.folder("an overlay");
    let repo = GitRepo::init(world.folder("beta repo"));
    repo.write("readme.md", "beta");
    repo.commit_all("first");
    let profile = profile(&world, "reviewer", repo.path(), &overlay);

    let alpha = world
        .fake_session(&mut client, &world.folder("alpha"), "alpha")
        .await;
    let beta_record = client
        .request::<SessionStart>(&StartSessionRequest {
            cwd: repo.path().to_string_lossy().into_owned(),
            cols: 80,
            rows: 24,
            name: Some("beta".into()),
            profile_id: Some(profile),
            ..StartSessionRequest::default()
        })
        .await
        .unwrap();
    // The program saves its record before it starts its child, and again
    // once the child is running.
    let run = world.agent_run_in(repo.path());
    let run = world
        .agent
        .wait_for_record(run.pid, PATIENCE, |record| !record.children.is_empty());
    let child = run.children[0];
    // Checked out after the spawn: the detail still says the branch the
    // session started on, which the host read before it spawned.
    repo.git(&["checkout", "--quiet", "-b", "later"]);
    let port = world
        .agent
        .wait_for_record(child, PATIENCE, |record| record.listening.is_some())
        .listening
        .unwrap();

    // Nobody is watching the sessions pane: the pass is the call's own.
    let (failed, detail) = alpha.detail(json!({ "pid": run.pid })).await;
    assert!(!failed, "{detail}");
    let lines: Vec<&str> = detail.lines().collect();
    assert_eq!(lines[0], format!("#{}  \"beta\"", run.pid));
    assert!(
        detail.contains(&format!("working in   {}", beta_record.cwd)),
        "{detail}"
    );
    assert!(!detail.contains(&alpha.record.cwd), "{detail}");
    assert!(
        detail.contains(&format!("Helm tab     {}", beta_record.id)),
        "{detail}"
    );
    assert!(
        detail.contains("branch       main (the branch at spawn"),
        "{detail}"
    );
    assert!(detail.contains("profile      reviewer"), "{detail}");
    assert!(
        detail.contains(&format!("overlays     {}", overlay.display())),
        "{detail}"
    );
    assert!(
        detail.contains("Holding      1 process under it"),
        "{detail}"
    );
    assert!(
        detail.contains(&format!("#{child}  listening on {port}")),
        "{detail}"
    );
    assert!(
        detail.contains(&format!("    port {port}    "))
            && detail.contains(&format!("#{child} on 127.0.0.1")),
        "{detail}"
    );
    // The child's command line is not the tool's to hand over.
    assert!(!detail.contains("--fake-serve"), "{detail}");
    assert!(!detail.contains("--mcp-config"), "{detail}");

    close(&mut client, &alpha.record).await;
    close(&mut client, &beta_record).await;
    host.stop(HostStopReason::Stop).await;
}

/// A saved profile with one overlay, as the profiles editor writes one.
fn profile(world: &World, name: &str, root: &Path, overlay: &Path) -> u64 {
    let db = rusqlite::Connection::open(world.dirs.data.join("floti.db")).expect("open floti.db");
    db.busy_timeout(PATIENCE).unwrap();
    db.execute(
        "INSERT INTO profiles (name, root, overlays, access, model, effort, permission_mode, agent, opening_prompt) \
         VALUES (?1, ?2, ?3, '[]', NULL, NULL, NULL, NULL, NULL)",
        rusqlite::params![
            name,
            root.to_string_lossy(),
            json!([overlay.to_string_lossy()]).to_string(),
        ],
    )
    .expect("insert a profile");
    u64::try_from(db.last_insert_rowid()).unwrap()
}

// ---------------------------------------------------------------------------
// helm-browser: carried to the attached window with a browser pane
// ---------------------------------------------------------------------------

/// What Helm's window declares: a terminal and a browser pane.
const BROWSER: &[&str] = &["terminal", "browser"];

/// The subscription a browser client hears calls on.
const CALLS: u64 = 40;

impl World {
    /// A client with a browser pane listening for browser tool calls: Helm's
    /// window, as far as the host can tell.
    async fn browser_client(&self) -> TestClient {
        let mut client = TestClient::connect(&self.endpoint, BROWSER).await;
        client
            .subscribe_quietly(CALLS, AgentBrowserCalls::NAME)
            .await;
        // Messages are handled in order: once this is answered, the
        // subscription is in.
        client
            .request::<SessionList>(&())
            .await
            .expect("the sessions are listed");
        client
    }

    /// Switches helm-browser, as the settings pane does.
    async fn browser_tools(&self, client: &mut TestClient, on: bool) {
        client
            .request::<WriteSettings>(&HostSettingsPatch {
                browser_mcp: Some(on),
                ..HostSettingsPatch::default()
            })
            .await
            .expect("the settings are written");
    }
}

/// The browser tools' table, as the desktop's listener reads it too.
fn browser_table() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("server")
        .join("browser_tools.json");
    serde_json::from_slice(&std::fs::read(path).expect("read the table")).expect("JSON")
}

/// The next browser tool call `client` is sent.
async fn next_call(client: &mut TestClient) -> AgentBrowserToolCall {
    loop {
        match client.next(PATIENCE).await {
            Some(Message::Event(event)) if event.subscription == CALLS => {
                return from_payload(&event.payload).expect("a browser tool call");
            }
            Some(_) => {}
            None => panic!("no browser tool call within {PATIENCE:?}"),
        }
    }
}

async fn answer(
    client: &mut TestClient,
    call_id: u64,
    outcome: AgentBrowserOutcome,
) -> Result<(), ErrorReply> {
    client
        .request::<AgentBrowserAnswer>(&AgentBrowserToolAnswer { call_id, outcome })
        .await
}

fn done(result: &Value) -> AgentBrowserOutcome {
    AgentBrowserOutcome::Done {
        value: to_payload(result).expect("encode a tool result"),
    }
}

fn says_no_browser_is_attached(result: &Value) {
    assert_eq!(result["isError"], true, "{result}");
    let text = result["content"][0]["text"].as_str().unwrap_or_default();
    assert!(text.contains("No browser is attached"), "{text}");
    assert!(text.contains("Helm"), "{text}");
}

/// The status a request with `method`, `token` and `origin` is answered
/// with, its body `{}`.
async fn status_of(url: &str, method: &str, token: Option<&str>, origin: Option<&str>) -> u16 {
    let (address, path) = split_url(url);
    let body = "{}";
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\n",
        body.len()
    );
    if let Some(token) = token {
        head.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    if let Some(origin) = origin {
        head.push_str(&format!("Origin: {origin}\r\n"));
    }
    head.push_str("\r\n");
    tokio::time::timeout(PATIENCE, async {
        let mut stream = TcpStream::connect(address).await.expect("connect");
        stream.write_all(head.as_bytes()).await.expect("send");
        stream.write_all(body.as_bytes()).await.expect("send");
        let mut answer = Vec::new();
        stream.read_to_end(&mut answer).await.expect("read");
        parse_reply(&answer).status
    })
    .await
    .expect("an answer within the patience")
}

#[tokio::test(flavor = "multi_thread")]
async fn s2_s3_a_session_started_with_helms_window_attached_lists_todays_browser_tools_and_that_window_answers_its_calls()
 {
    let world = World::new();
    let host = world.host();
    let mut desktop = world.browser_client().await;
    let mut client = world.client().await;
    let alpha = world
        .fake_session(&mut client, &world.folder("alpha"), "alpha")
        .await;

    // Named as today, at today's route, with the session's one token on the
    // one port.
    assert_eq!(alpha.servers(), ["helm-browser", "helm-sessions"]);
    let (url, token) = alpha.browser();
    let (address, path) = split_url(url);
    assert_eq!(path, "/mcp");
    assert_eq!(address, split_url(&alpha.url).0);
    assert_eq!(token, alpha.token);

    // Exactly today's tools and instructions.
    let table = browser_table();
    let initialized = rpc(
        url,
        Some(token),
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "claude-code", "version": "2.1.300" },
        }),
    )
    .await
    .result();
    assert_eq!(initialized["serverInfo"]["name"], "helm-browser");
    assert_eq!(initialized["instructions"], table["instructions"]);
    let listed = rpc(url, Some(token), "tools/list", json!({}))
        .await
        .result();
    assert_eq!(listed["tools"], table["tools"]);

    // A call reaches the window, naming the session, and its answer, image
    // included, is the agent's.
    let calling = alpha.call_browser("browser_screenshot", json!({ "tab": 3 }));
    let call = next_call(&mut desktop).await;
    assert_eq!(call.session, alpha.record.id);
    assert_eq!(call.tool, "browser_screenshot");
    assert_eq!(
        from_payload::<Value>(&call.arguments).unwrap(),
        json!({ "tab": 3 })
    );
    let screenshot = json!({
        "content": [
            { "type": "text", "text": "Tab 3, https://example.com/." },
            { "type": "image", "data": "iVBORw0KGgoAAAANSUhEUg==", "mimeType": "image/png" },
        ],
        "isError": false,
    });
    answer(&mut desktop, call.call_id, done(&screenshot))
        .await
        .expect("the window's answer is taken");
    assert_eq!(calling.await.unwrap(), screenshot);

    // A refusal is the agent's to read, as the window words it.
    let calling = alpha.call_browser("browser_open", json!({ "url": "https://example.com" }));
    let call = next_call(&mut desktop).await;
    let sentence = "That page is outside what this session may reach.";
    answer(
        &mut desktop,
        call.call_id,
        AgentBrowserOutcome::Failed {
            message: sentence.to_owned(),
        },
    )
    .await
    .expect("the window's answer is taken");
    let result = calling.await.unwrap();
    assert_eq!(result["isError"], true, "{result}");
    assert_eq!(result["content"][0]["text"], sentence);

    close(&mut client, &alpha.record).await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s9_a_session_started_with_no_browser_attached_has_no_helm_browser_entry_route_or_tool() {
    let world = World::new();
    let host = world.host();
    // A terminal client, as a script or another device starts sessions.
    let mut client = world.client().await;
    let alpha = world
        .fake_session(&mut client, &world.folder("alpha"), "alpha")
        .await;
    assert_eq!(alpha.servers(), ["helm-sessions"]);
    let (address, _) = split_url(&alpha.url);
    let route = format!("http://{address}/mcp");
    let reply = rpc(&route, Some(&alpha.token), "tools/list", json!({})).await;
    assert_eq!(reply.status, 404, "{reply:?}");
    let reply = rpc(
        &route,
        Some(&alpha.token),
        "tools/call",
        json!({ "name": "browser_tabs", "arguments": {} }),
    )
    .await;
    assert_eq!(reply.status, 404, "{reply:?}");
    let listed = alpha.tools_list().await.result();
    for tool in listed["tools"].as_array().unwrap() {
        let name = tool["name"].as_str().unwrap();
        assert!(!name.starts_with("browser_"), "{name}");
    }

    // A window attaching later gives later launches the browser tools, never
    // this one.
    let _desktop = world.browser_client().await;
    let reply = rpc(&route, Some(&alpha.token), "tools/list", json!({})).await;
    assert_eq!(reply.status, 404, "{reply:?}");
    let beta = world
        .fake_session(&mut client, &world.folder("beta"), "beta")
        .await;
    assert_eq!(beta.servers(), ["helm-browser", "helm-sessions"]);
    let (url, token) = beta.browser();
    assert_eq!(
        rpc(url, Some(token), "tools/list", json!({})).await.status,
        200
    );

    close(&mut client, &alpha.record).await;
    close(&mut client, &beta.record).await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s10_s11_s12_when_helms_window_detaches_browser_calls_fail_at_once_and_a_window_attached_again_takes_the_next()
 {
    let world = World::new();
    let host = world.host();
    let mut desktop = world.browser_client().await;
    let mut client = world.client().await;
    let alpha = world
        .fake_session(&mut client, &world.folder("alpha"), "alpha")
        .await;

    // In flight when the window goes: it fails at once, saying why.
    let waiting = alpha.call_browser(
        "browser_wait_for",
        json!({ "text": "Ready", "timeout": 60 }),
    );
    let call = next_call(&mut desktop).await;
    assert_eq!(call.tool, "browser_wait_for");
    drop(desktop);
    says_no_browser_is_attached(&waiting.await.unwrap());

    // Made after it went: the same sentence, and the session's other tools
    // keep answering.
    says_no_browser_is_attached(&alpha.call_browser("browser_tabs", json!({})).await.unwrap());
    let (failed, listing) = alpha.list().await;
    assert!(!failed, "{listing}");

    // A window attached again carries out the session's next call.
    let mut again = world.browser_client().await;
    let calling = alpha.call_browser("browser_tabs", json!({}));
    let call = next_call(&mut again).await;
    assert_eq!(call.session, alpha.record.id);
    assert_eq!(call.tool, "browser_tabs");
    let tabs = json!({
        "content": [{ "type": "text", "text": "No tabs are open." }],
        "isError": false,
    });
    answer(&mut again, call.call_id, done(&tabs))
        .await
        .expect("the window's answer is taken");
    assert_eq!(calling.await.unwrap(), tabs);

    close(&mut client, &alpha.record).await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s13_the_browser_tools_route_refuses_as_helms_listener_does_and_only_the_window_a_call_went_to_answers_it()
 {
    let world = World::new();
    let host = world.host();
    let mut desktop = world.browser_client().await;
    let mut second = world.browser_client().await;
    let mut client = world.client().await;
    let alpha = world
        .fake_session(&mut client, &world.folder("alpha"), "alpha")
        .await;
    let (url, token) = alpha.browser();

    // No token, a token that is not the session's, a web page's Origin, a
    // method other than POST.
    assert_eq!(status_of(url, "POST", None, None).await, 401);
    assert_eq!(
        status_of(url, "POST", Some(&"0".repeat(64)), None).await,
        401
    );
    assert_eq!(
        status_of(url, "POST", Some(&format!("{token}0")), None).await,
        401
    );
    assert_eq!(
        status_of(url, "POST", Some(token), Some("https://example.com")).await,
        403
    );
    assert_eq!(status_of(url, "GET", Some(token), None).await, 405);
    assert_eq!(status_of(url, "DELETE", Some(token), None).await, 405);

    // A call goes to the window attached first, and only that window answers
    // it: another window and a client without a browser are refused.
    let calling = alpha.call_browser("browser_tabs", json!({}));
    let call = next_call(&mut desktop).await;
    let forged = json!({
        "content": [{ "type": "text", "text": "forged" }],
        "isError": false,
    });
    let refused = answer(&mut second, call.call_id, done(&forged))
        .await
        .expect_err("another window cannot answer it");
    assert!(
        refused.message.contains("sent to another client"),
        "{refused:?}"
    );
    let refused = answer(&mut client, call.call_id, done(&forged))
        .await
        .expect_err("a client without a browser cannot answer it");
    assert_eq!(refused.code, ErrorCode::MissingCapability, "{refused:?}");
    let tabs = json!({
        "content": [{ "type": "text", "text": "Tab 1 is yours." }],
        "isError": false,
    });
    answer(&mut desktop, call.call_id, done(&tabs))
        .await
        .expect("the window's answer is taken");
    assert_eq!(calling.await.unwrap(), tabs);

    // Switched off in the host's settings: 404 at once, and a launch now has
    // no helm-browser entry. Switched on, the running session's route answers
    // again.
    world.browser_tools(&mut client, false).await;
    assert_eq!(status_of(url, "POST", Some(token), None).await, 404);
    let beta = world
        .fake_session(&mut client, &world.folder("beta"), "beta")
        .await;
    assert_eq!(beta.servers(), ["helm-sessions"]);
    world.browser_tools(&mut client, true).await;
    assert_eq!(
        rpc(url, Some(token), "tools/list", json!({})).await.status,
        200
    );

    // After the session ended: 401.
    close(&mut client, &alpha.record).await;
    eventually("alpha's browser token is refused", async || {
        (status_of(url, "POST", Some(token), None).await == 401).then_some(())
    })
    .await;

    close(&mut client, &beta.record).await;
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// helm-plugin-<id>: each plugin tool server a client offers
// ---------------------------------------------------------------------------

/// The subscriptions a client offering plugin tools hears calls and cancels
/// on.
const PLUGIN_CALLS: u64 = 50;
const PLUGIN_CANCELS: u64 = 51;

impl World {
    /// A client answering plugin tool calls that offers `servers`: Helm's
    /// window with plugins on, as far as the host can tell.
    async fn plugin_client(&self, servers: Vec<AgentPluginServer>) -> TestClient {
        let mut client = TestClient::connect(&self.endpoint, TERMINAL).await;
        client
            .subscribe_quietly(PLUGIN_CALLS, AgentPluginCalls::NAME)
            .await;
        client
            .subscribe_quietly(PLUGIN_CANCELS, AgentPluginCancels::NAME)
            .await;
        offer_plugins(&mut client, servers).await;
        client
    }
}

async fn offer_plugins(client: &mut TestClient, servers: Vec<AgentPluginServer>) {
    client
        .request::<AgentPluginOffer>(&AgentPluginServers { servers })
        .await
        .expect("the offer is taken");
}

/// The notes plugin's server: `find` read-only, `write` not.
fn notes_server() -> AgentPluginServer {
    let schema = json!({
        "type": "object",
        "properties": { "query": { "type": "string" } },
    });
    let tool = |name: &str, read_only: bool| AgentPluginTool {
        name: name.to_owned(),
        description: format!("The notes plugin's {name}."),
        input_schema: to_payload(&schema).expect("encode a schema"),
        read_only,
    };
    AgentPluginServer {
        name: "helm-plugin-notes".into(),
        plugin: "notes".into(),
        instructions: "These tools come from \"Notes\", a plugin the user added to Helm.".into(),
        tools: vec![tool("find", true), tool("write", false)],
    }
}

impl Tooled {
    /// The notes plugin's URL and token, when the tool file names it.
    fn notes(&self) -> Option<(String, String)> {
        let document: Value =
            serde_json::from_slice(&std::fs::read(&self.config).expect("read the tool file"))
                .expect("the tool file is JSON");
        server_in(&document, "helm-plugin-notes")
    }

    /// One notes tool call, made while the test answers it elsewhere.
    fn call_notes(&self, tool: &'static str, arguments: Value) -> tokio::task::JoinHandle<Reply> {
        let (url, token) = self.notes().expect("a helm-plugin-notes entry");
        tokio::spawn(async move {
            rpc(
                &url,
                Some(&token),
                "tools/call",
                json!({ "name": tool, "arguments": arguments }),
            )
            .await
        })
    }
}

/// The next event `client` hears on `subscription`.
async fn next_on<T: serde::de::DeserializeOwned>(client: &mut TestClient, subscription: u64) -> T {
    loop {
        match client.next(PATIENCE).await {
            Some(Message::Event(event)) if event.subscription == subscription => {
                return from_payload(&event.payload).expect("the event");
            }
            Some(_) => {}
            None => panic!("nothing on subscription {subscription} within {PATIENCE:?}"),
        }
    }
}

fn says_helm_is_not_connected(result: &Value) {
    assert_eq!(result["isError"], true, "{result}");
    let text = result["content"][0]["text"].as_str().unwrap_or_default();
    assert!(text.contains("Helm's window is not connected"), "{text}");
    assert!(text.contains("notes"), "{text}");
}

#[tokio::test(flavor = "multi_thread")]
async fn s3_s4_a_plugin_server_offered_by_helms_window_is_listed_as_offered_allowed_where_read_only_and_answered_by_that_window()
 {
    let world = World::new();
    let host = world.host();
    let mut desktop = world.plugin_client(vec![notes_server()]).await;
    let mut client = world.client().await;
    let alpha = world
        .fake_session(&mut client, &world.folder("alpha"), "alpha")
        .await;

    // Named as today, at today's route, with the session's one token on the
    // one port.
    assert_eq!(alpha.servers(), ["helm-plugin-notes", "helm-sessions"]);
    let (url, token) = alpha.notes().expect("a helm-plugin-notes entry");
    let (address, path) = split_url(&url);
    assert_eq!(path, "/mcp/plugin/notes");
    assert_eq!(address, split_url(&alpha.url).0);
    assert_eq!(token, alpha.token);

    // Its read-only tool is allowed at launch; the other asks.
    let allowed: Vec<&String> = alpha
        .argv
        .iter()
        .skip_while(|arg| *arg != "--allowedTools")
        .skip(1)
        .take_while(|arg| !arg.starts_with("--"))
        .collect();
    assert_eq!(
        allowed,
        ["mcp__helm-plugin-notes__find"],
        "{:?}",
        alpha.argv
    );

    // Listed as the window offered it.
    let initialized = rpc(
        &url,
        Some(&token),
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "claude-code", "version": "2.1.300" },
        }),
    )
    .await
    .result();
    assert_eq!(initialized["serverInfo"]["name"], "helm-plugin-notes");
    assert_eq!(
        initialized["instructions"],
        "These tools come from \"Notes\", a plugin the user added to Helm."
    );
    let listed = rpc(&url, Some(&token), "tools/list", json!({}))
        .await
        .result();
    let tools: Vec<(&str, &str, Value, bool)> = listed["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| {
            (
                tool["name"].as_str().unwrap(),
                tool["description"].as_str().unwrap(),
                tool["inputSchema"].clone(),
                tool["annotations"]["readOnlyHint"]
                    .as_bool()
                    .unwrap_or(false),
            )
        })
        .collect();
    let schema = json!({ "type": "object", "properties": { "query": { "type": "string" } } });
    assert_eq!(
        tools,
        [
            ("find", "The notes plugin's find.", schema.clone(), true),
            ("write", "The notes plugin's write.", schema, false),
        ]
    );

    // A call reaches the window, naming the session, and its answer is the
    // agent's as it is.
    let calling = alpha.call_notes("find", json!({ "query": "release" }));
    let call: AgentPluginToolCall = next_on(&mut desktop, PLUGIN_CALLS).await;
    assert_eq!(call.session, alpha.record.id);
    assert_eq!(
        (call.plugin.as_str(), call.tool.as_str()),
        ("notes", "find")
    );
    assert_eq!(
        from_payload::<Value>(&call.arguments).unwrap(),
        json!({ "query": "release" })
    );
    let found = json!({
        "content": [{ "type": "text", "text": "Found 2 notes." }],
        "isError": false,
    });
    desktop
        .request::<AgentPluginAnswer>(&AgentPluginToolAnswer {
            call_id: call.call_id,
            outcome: AgentPluginOutcome::Done {
                value: to_payload(&found).unwrap(),
            },
        })
        .await
        .expect("the window's answer is taken");
    assert_eq!(calling.await.unwrap().result(), found);

    close(&mut client, &alpha.record).await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s5_a_plugin_server_left_out_of_the_next_offer_is_refused_to_running_sessions_at_once_and_given_to_no_launch()
 {
    let world = World::new();
    let host = world.host();
    let mut desktop = world.plugin_client(vec![notes_server()]).await;
    let mut client = world.client().await;
    let alpha = world
        .fake_session(&mut client, &world.folder("alpha"), "alpha")
        .await;
    let (url, token) = alpha.notes().expect("a helm-plugin-notes entry");
    assert_eq!(
        rpc(&url, Some(&token), "tools/list", json!({}))
            .await
            .status,
        200
    );

    // The plugin switched off: its route is gone for the running session.
    offer_plugins(&mut desktop, Vec::new()).await;
    assert_eq!(status_of(&url, "POST", Some(&token), None).await, 404);
    let beta = world
        .fake_session(&mut client, &world.folder("beta"), "beta")
        .await;
    assert_eq!(beta.servers(), ["helm-sessions"]);
    assert!(!beta.argv.iter().any(|arg| arg == "--allowedTools"));

    // Switched on again, it is served again.
    offer_plugins(&mut desktop, vec![notes_server()]).await;
    assert_eq!(
        rpc(&url, Some(&token), "tools/list", json!({}))
            .await
            .status,
        200
    );

    close(&mut client, &alpha.record).await;
    close(&mut client, &beta.record).await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s6_when_the_offering_client_leaves_plugin_calls_fail_at_once_naming_helm_and_launches_get_no_plugin_server()
 {
    let world = World::new();
    let host = world.host();
    let mut desktop = world.plugin_client(vec![notes_server()]).await;
    let mut client = world.client().await;
    let alpha = world
        .fake_session(&mut client, &world.folder("alpha"), "alpha")
        .await;

    // In flight when the window goes: it fails at once, saying why.
    let waiting = alpha.call_notes("write", json!({ "query": "draft" }));
    let call: AgentPluginToolCall = next_on(&mut desktop, PLUGIN_CALLS).await;
    assert_eq!(call.tool, "write");
    drop(desktop);
    says_helm_is_not_connected(&waiting.await.unwrap().result());

    // Made after it went: the same sentence, and the session's other tools
    // keep answering.
    says_helm_is_not_connected(&alpha.call_notes("find", json!({})).await.unwrap().result());
    let (failed, listing) = alpha.list().await;
    assert!(!failed, "{listing}");

    // A launch with nobody to answer gets no plugin server.
    let beta = world
        .fake_session(&mut client, &world.folder("beta"), "beta")
        .await;
    assert_eq!(beta.servers(), ["helm-sessions"]);

    close(&mut client, &alpha.record).await;
    close(&mut client, &beta.record).await;
    host.stop(HostStopReason::Stop).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s6_a_plugin_call_the_session_cancels_or_ends_while_waiting_is_withdrawn_from_the_window() {
    let world = World::new();
    let host = world.host();
    let mut desktop = world.plugin_client(vec![notes_server()]).await;
    let mut client = world.client().await;
    let alpha = world
        .fake_session(&mut client, &world.folder("alpha"), "alpha")
        .await;
    let (url, token) = alpha.notes().expect("a helm-plugin-notes entry");

    // The agent interrupts the call: MCP's cancel reaches the window.
    let waiting = alpha.call_notes("write", json!({ "query": "draft" }));
    let call: AgentPluginToolCall = next_on(&mut desktop, PLUGIN_CALLS).await;
    let notified = post(
        &url,
        Some(&token),
        &json!({
            "jsonrpc": "2.0",
            "method": "notifications/cancelled",
            "params": { "requestId": 1, "reason": "The user interrupted." },
        }),
    )
    .await;
    assert_eq!(notified.status, 202, "{notified:?}");
    let cancel: AgentPluginCallCancel = next_on(&mut desktop, PLUGIN_CANCELS).await;
    assert_eq!(cancel.call_id, call.call_id);
    let interrupted = waiting.await.unwrap();
    assert!(
        interrupted.json().get("result").is_none(),
        "{interrupted:?}"
    );
    // Withdrawn: its answer is refused.
    assert!(
        desktop
            .request::<AgentPluginAnswer>(&AgentPluginToolAnswer {
                call_id: call.call_id,
                outcome: AgentPluginOutcome::Failed {
                    message: "late".into(),
                },
            })
            .await
            .is_err()
    );

    // The session ends while a call waits: withdrawn too.
    let _waiting = alpha.call_notes("write", json!({ "query": "again" }));
    let call: AgentPluginToolCall = next_on(&mut desktop, PLUGIN_CALLS).await;
    close(&mut client, &alpha.record).await;
    let cancel: AgentPluginCallCancel = next_on(&mut desktop, PLUGIN_CANCELS).await;
    assert_eq!(cancel.call_id, call.call_id);

    host.stop(HostStopReason::Stop).await;
}
