//! A version 2 plugin's tools served by the host itself: a `RunningHost`
//! whose sessions run the fake agent (which takes agent tools as Claude Code
//! does), a plugin folder of the test's own whose background module runs in
//! the host's engine, and its Node service run for real on the Node that
//! runs the tests. No client answers plugin calls: a bare client adds the
//! plugin and starts sessions, and every call is made over HTTP to the
//! listener with the URL and bearer token read from the session's own
//! `--mcp-config` file, after that client has gone.
//!
//! Beside it, a version 1 plugin with a background page is still answered by
//! the client that offers its server, as Helm's window does today.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use floti_host::fake_agent;
use floti_host::platform::process_tree::{Native as NativeTree, ProcessTree};
use floti_host::platform::socket::Endpoint;
use floti_host::server::{HostConfig, HostRun};
use floti_host::testkit::{FakeAgent, PATIENCE, RunningHost, TestClient, TestDirs};
use floti_protocol::channel::{EventChannel, from_payload, to_payload};
use floti_protocol::channels::agent_plugin::{
    AgentPluginAnswer, AgentPluginCalls, AgentPluginOffer, AgentPluginOutcome, AgentPluginServer,
    AgentPluginServers, AgentPluginTool, AgentPluginToolAnswer, AgentPluginToolCall,
};
use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::plugins::{
    PluginAddRequest, PluginBackgroundState, PluginInfo, PluginRemoveRequest, PluginServiceState,
    PluginSwitchRequest, PluginsAdd, PluginsChanged, PluginsList, PluginsRemove, PluginsSetEnabled,
    PluginsSetTools,
};
use floti_protocol::channels::sessions::{SessionStart, StartSessionRequest};
use floti_protocol::{Knowable, Message};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

const TERMINAL: &[&str] = &["terminal"];

/// The subscriptions a client offering plugin tools hears calls and the
/// plugin list on.
const PLUGIN_CALLS: u64 = 50;
const PLUGINS_CHANGED: u64 = 60;

/// The shared owner watch every fake uses, put beside the service script.
const COMMON: &str = include_str!("../../../test/fake-agents/common.mjs");

// ---------------------------------------------------------------------------
// The version 2 plugin
// ---------------------------------------------------------------------------

/// The plugin's service: HTTP on the port it is told, answering only
/// requests carrying its token, with its pid, its plugin and the path it was
/// asked. Each request's path is kept in `asked.txt`.
const SERVICE: &str = r"
import { appendFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { watchOwner } from './common.mjs'

const here = process.cwd()
watchOwner(here, () => process.exit(0))
const token = process.env.HELM_SERVICE_TOKEN
createServer((request, response) => {
  if (request.headers['helm-service-token'] !== token) {
    response.writeHead(403)
    response.end('wrong token')
    return
  }
  appendFileSync('asked.txt', `${request.url}\n`)
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ pid: process.pid, plugin: process.env.HELM_PLUGIN_ID, url: request.url }))
}).listen(Number(process.env.HELM_SERVICE_PORT), '127.0.0.1')
";

/// The module's tools: `whoami` answers with what it was asked and the
/// caller it was told, `ask_service` with what the service replied.
const TOOLS: &str = r#"
floti.tools.handle("whoami", (args, { session }) => JSON.stringify({ args, session }));
floti.tools.handle("ask_service", async () => {
  const response = await floti.fetch("service:/hello?from=tool");
  return await response.text();
});
"#;

/// Paints a badge and a status item at load, then tells its service it did:
/// the test's barrier for "painted with no client attached".
const PAINTS: &str = r#"
(async () => {
  await floti.badge.set(3);
  await floti.status.set({ text: "3 open", tone: "accent", tooltip: "Ledger" });
  await floti.fetch("service:/painted");
})();
"#;

fn ledger_manifest() -> Value {
    json!({
        "apiVersion": 2,
        "id": "ledger",
        "name": "Ledger",
        "version": "1.0.0",
        "background": "bg.js",
        "service": { "node": "service.mjs" },
        "agent": {
            "instructions": "The user's ledger.",
            "tools": {
                "whoami": {
                    "description": "Says who is calling.",
                    "inputSchema": { "type": "object", "properties": { "note": { "type": "string" } } },
                    "readOnly": true
                },
                "ask_service": {
                    "description": "Asks the ledger's service.",
                    "inputSchema": { "type": "object" }
                }
            }
        }
    })
}

const LEDGER_INSTRUCTIONS: &str = "These tools come from \"Ledger\", a plugin the user added to \
     Helm, the app hosting this session. The plugin answers every call; Helm passes it \
     on.\n\nThe user's ledger.";

// ---------------------------------------------------------------------------
// A host whose sessions take agent tools
// ---------------------------------------------------------------------------

struct World {
    endpoint: Endpoint,
    agent: FakeAgent,
    /// Last: fields drop in order.
    dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let agent = fake_agent!(&dirs);
        Self {
            endpoint: dirs.endpoint(),
            agent,
            dirs,
        }
    }

    fn config(&self) -> HostConfig {
        HostConfig {
            run: HostRun {
                node: Some(node_on_path()),
                ..HostRun::default()
            },
            folders: self.dirs.folders(),
            endpoint: self.endpoint.clone(),
            backends: vec![std::sync::Arc::new(
                self.agent
                    .backend(std::iter::empty::<&str>())
                    .with_agent_tools(),
            )],
            inherited_env: std::env::vars_os()
                .filter(|(key, _)| !["HOME", "USERPROFILE"].contains(&&*key.to_string_lossy()))
                .chain(["HOME", "USERPROFILE"].map(|key| {
                    (
                        std::ffi::OsString::from(key),
                        self.dirs.home.clone().into_os_string(),
                    )
                }))
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

    /// The ledger plugin's folder, its module `script`.
    fn ledger(&self, script: &str) -> PathBuf {
        self.dirs.plugin_folder(
            "plugin ledger",
            &ledger_manifest().to_string(),
            &[
                ("bg.js", script),
                ("service.mjs", SERVICE),
                ("common.mjs", COMMON),
            ],
        )
    }

    /// A version 1 plugin `notes` with a background page and the tools the
    /// notes server lists.
    fn notes(&self) -> PathBuf {
        let manifest = json!({
            "apiVersion": 1,
            "id": "notes",
            "name": "Notes",
            "version": "1.0.0",
            "background": "background.html",
            "agent": { "tools": {
                "find": { "description": "Finds a note.", "readOnly": true },
                "write": { "description": "Writes a note." },
            } },
        });
        self.dirs.plugin_folder(
            "plugin notes",
            &manifest.to_string(),
            &[("background.html", "<!doctype html><p>background</p>")],
        )
    }

    /// A fake agent session in a folder of its own, with the tools it was
    /// given.
    async fn session(&self, client: &mut TestClient, name: &str) -> Tooled {
        let folder = self.folder(name);
        let record = client
            .request::<SessionStart>(&StartSessionRequest {
                cwd: folder.to_string_lossy().into_owned(),
                cols: 80,
                rows: 24,
                name: Some(name.to_owned()),
                ..StartSessionRequest::default()
            })
            .await
            .expect("the session starts");
        let run = self.agent_run_in(&folder);
        Tooled::new(record, run.argv)
    }

    fn agent_run_in(&self, folder: &Path) -> floti_host::testkit::FakeAgentRecord {
        let deadline = Instant::now() + PATIENCE;
        loop {
            if let Some(run) = self
                .agent
                .records()
                .into_iter()
                .find(|run| same_folder(Path::new(&run.cwd), folder))
            {
                return run;
            }
            assert!(Instant::now() < deadline, "no run in {}", folder.display());
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

async fn add(client: &mut TestClient, folder: &Path) -> Vec<PluginInfo> {
    let added = client
        .request::<PluginsAdd>(&PluginAddRequest {
            path: folder.to_string_lossy().into_owned(),
        })
        .await
        .expect("the plugin is added");
    assert_eq!(added.error, None, "{:#?}", added.plugins);
    added.plugins
}

async fn switch<C>(client: &mut TestClient, folder: &Path, enabled: bool)
where
    C: floti_protocol::channel::RequestChannel<Request = PluginSwitchRequest>,
{
    client
        .request::<C>(&PluginSwitchRequest {
            path: folder.to_string_lossy().into_owned(),
            enabled,
        })
        .await
        .expect("the switch is taken");
}

async fn listed(client: &mut TestClient, id: &str) -> PluginInfo {
    let list = client.request::<PluginsList>(&()).await.expect("the list");
    by_id(&list, id).clone()
}

fn by_id<'a>(list: &'a [PluginInfo], id: &str) -> &'a PluginInfo {
    list.iter()
        .find(|plugin| plugin.id.as_deref() == Some(id))
        .unwrap_or_else(|| panic!("{id} is not in {list:#?}"))
}

/// A session and the tools its `--mcp-config` file names.
struct Tooled {
    record: SessionRecord,
    argv: Vec<String>,
    document: Value,
}

impl Tooled {
    fn new(record: SessionRecord, argv: Vec<String>) -> Self {
        let config = mcp_config_of(&argv);
        let document = serde_json::from_slice(&std::fs::read(config).expect("read the tool file"))
            .expect("the tool file is JSON");
        Self {
            record,
            argv,
            document,
        }
    }

    /// The names of the servers its tool file names, sorted.
    fn servers(&self) -> Vec<String> {
        let mut names: Vec<String> = self.document["mcpServers"]
            .as_object()
            .expect("a server map")
            .keys()
            .cloned()
            .collect();
        names.sort();
        names
    }

    /// `server`'s URL and token, as its tool file names it.
    fn server(&self, server: &str) -> (String, String) {
        let entry = &self.document["mcpServers"][server];
        let url = entry["url"]
            .as_str()
            .unwrap_or_else(|| panic!("no {server} in {}", self.document))
            .to_owned();
        let token = entry["headers"]["Authorization"]
            .as_str()
            .and_then(|value| value.strip_prefix("Bearer "))
            .expect("a bearer token")
            .to_owned();
        (url, token)
    }

    fn ledger(&self) -> (String, String) {
        self.server("helm-plugin-ledger")
    }

    /// One call of the ledger's `tool`: whether it failed, and its text.
    async fn call_ledger(&self, tool: &str, arguments: Value) -> (bool, String) {
        let (url, token) = self.ledger();
        call_tool(&url, &token, tool, arguments).await
    }

    /// The status the ledger's route answers this session's `tools/list` with.
    async fn ledger_status(&self) -> u16 {
        let (url, token) = self.ledger();
        rpc(&url, Some(&token), "tools/list", json!({}))
            .await
            .status
    }
}

/// The one `--mcp-config` file in `argv`.
fn mcp_config_of(argv: &[String]) -> PathBuf {
    let at = argv
        .iter()
        .position(|arg| arg == "--mcp-config")
        .unwrap_or_else(|| panic!("an --mcp-config in {argv:?}"));
    PathBuf::from(&argv[at + 1])
}

/// The tools a launch is allowed without asking.
fn allowed_in(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip_while(|arg| *arg != "--allowedTools")
        .skip(1)
        .take_while(|arg| !arg.starts_with("--"))
        .cloned()
        .collect()
}

/// The Node running these tests: the first `node` on `PATH`.
fn node_on_path() -> PathBuf {
    let path = std::env::var_os("PATH").expect("PATH is set");
    std::env::split_paths(&path)
        .flat_map(|dir| [dir.join("node.exe"), dir.join("node")])
        .find(|candidate| candidate.is_file())
        .expect("the tests run with Node on PATH")
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

/// What the service was asked, in order.
fn asked(folder: &Path) -> Vec<String> {
    std::fs::read_to_string(folder.join("asked.txt"))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

/// Waits until `check` holds, for at most the patience.
async fn until(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + PATIENCE;
    while !check() {
        assert!(Instant::now() < deadline, "{what} within {PATIENCE:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Waits until none of `pids` is running.
async fn all_ended(pids: &[u32]) {
    until("every service ended", || {
        pids.iter()
            .all(|pid| NativeTree.is_alive(*pid) == Knowable::Known(false))
    })
    .await;
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

async fn rpc(url: &str, token: Option<&str>, method: &str, params: Value) -> Reply {
    let rest = url.strip_prefix("http://").expect("an http URL");
    let (address, path) = rest.split_at(rest.find('/').expect("a path"));
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string();
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
    let address = address.to_owned();
    tokio::time::timeout(PATIENCE, async move {
        let mut stream = TcpStream::connect(address.as_str()).await.expect("connect");
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

/// The name, instructions and tools (name, description, schema, read-only)
/// a session reads of the server at `url`.
async fn server_as_listed(
    url: &str,
    token: &str,
) -> (Value, Value, Vec<(String, String, Value, bool)>) {
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
    let listed = rpc(url, Some(token), "tools/list", json!({}))
        .await
        .result();
    let tools = listed["tools"]
        .as_array()
        .expect("a tool list")
        .iter()
        .map(|tool| {
            (
                tool["name"].as_str().unwrap().to_owned(),
                tool["description"].as_str().unwrap().to_owned(),
                tool["inputSchema"].clone(),
                tool["annotations"]["readOnlyHint"]
                    .as_bool()
                    .unwrap_or(false),
            )
        })
        .collect();
    (
        initialized["serverInfo"]["name"].clone(),
        initialized["instructions"].clone(),
        tools,
    )
}

// ---------------------------------------------------------------------------
// S1, S2, S5: tools, the caller and the service with no client attached
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s1_s2_s5_a_version_2_plugins_tools_are_given_to_a_launch_as_declared_and_answered_by_its_module_and_service_with_no_client_attached()
 {
    let world = World::new();
    let host = world.host();
    let folder = world.ledger(TOOLS);

    // A bare client adds the plugin and starts a session: it offers no tool
    // server and takes no plugin call.
    let mut client = world.client().await;
    add(&mut client, &folder).await;
    let alpha = world.session(&mut client, "alpha").await;
    let before = listed(&mut client, "ledger").await;
    drop(client);

    // S2: given helm-plugin-ledger, at its route on the session's one port,
    // its read-only tool allowed without asking.
    assert_eq!(alpha.servers(), ["helm-plugin-ledger", "helm-sessions"]);
    let (url, token) = alpha.ledger();
    assert!(url.ends_with("/mcp/plugin/ledger"), "{url}");
    assert_eq!(token, alpha.server("helm-sessions").1);
    assert_eq!(
        allowed_in(&alpha.argv),
        ["mcp__helm-plugin-ledger__whoami"],
        "{:?}",
        alpha.argv
    );
    let (name, instructions, tools) = server_as_listed(&url, &token).await;
    assert_eq!(name, "helm-plugin-ledger");
    assert_eq!(instructions, LEDGER_INSTRUCTIONS);
    assert_eq!(
        tools,
        [
            (
                "whoami".to_owned(),
                "Says who is calling.".to_owned(),
                json!({ "type": "object", "properties": { "note": { "type": "string" } } }),
                true
            ),
            (
                "ask_service".to_owned(),
                "Asks the ledger's service.".to_owned(),
                json!({ "type": "object" }),
                false
            ),
        ]
    );

    // S1: the module's handler answers, told the session by the id minted at
    // its launch (never its row id or token), its name and its folder.
    let (failed, text) = alpha.call_ledger("whoami", json!({ "note": "hi" })).await;
    assert!(!failed, "{text}");
    let said: Value = serde_json::from_str(&text).expect("the handler's JSON");
    assert_eq!(said["args"], json!({ "note": "hi" }));
    let session = &said["session"];
    assert_eq!(session["name"], alpha.record.name.as_str());
    assert_eq!(session["cwd"], alpha.record.cwd.as_str());
    let id = session["id"].as_str().expect("an id").to_owned();
    assert!(
        !id.is_empty() && id != alpha.record.id.to_string() && id != token,
        "{session}"
    );
    let (_, again) = alpha.call_ledger("whoami", json!({})).await;
    let again: Value = serde_json::from_str(&again).unwrap();
    assert_eq!(
        again["session"]["id"],
        id.as_str(),
        "the same id every call"
    );

    // S5: nothing had asked the service, so it was not running; the tool's
    // fetch starts it, and the session reads what it replied.
    let service = before.service.expect("the ledger declares a service");
    assert_eq!(service.state, PluginServiceState::Stopped);
    assert!(asked(&folder).is_empty());
    let (failed, text) = alpha.call_ledger("ask_service", json!({})).await;
    assert!(!failed, "{text}");
    let replied: Value = serde_json::from_str(&text).expect("the service's JSON");
    assert_eq!(replied["plugin"], "ledger");
    assert_eq!(replied["url"], "/hello?from=tool");
    assert_eq!(asked(&folder), ["/hello?from=tool"]);
    let pid = u32::try_from(replied["pid"].as_u64().expect("a pid")).unwrap();
    let mut client = world.client().await;
    let shown = listed(&mut client, "ledger").await.service.unwrap();
    assert_eq!(shown.state, PluginServiceState::Running);
    assert_eq!(shown.pid, Some(pid));
    drop(client);

    host.stop(HostStopReason::Stop).await;
    all_ended(&[pid]).await;
}

// ---------------------------------------------------------------------------
// S3: off, tools off and removed
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s3_a_version_2_plugin_turned_off_removed_or_with_its_tools_off_is_refused_at_once_and_given_to_no_launch_until_back_on()
 {
    let world = World::new();
    let host = world.host();
    let folder = world.ledger(TOOLS);
    let mut client = world.client().await;
    add(&mut client, &folder).await;
    let alpha = world.session(&mut client, "alpha").await;
    assert!(!alpha.call_ledger("whoami", json!({})).await.0);

    // Its tools switched off in Settings.
    switch::<PluginsSetTools>(&mut client, &folder, false).await;
    assert_eq!(alpha.ledger_status().await, 404);
    let bravo = world.session(&mut client, "bravo").await;
    assert_eq!(bravo.servers(), ["helm-sessions"]);

    // Back on: launches after are given them again.
    switch::<PluginsSetTools>(&mut client, &folder, true).await;
    let charlie = world.session(&mut client, "charlie").await;
    assert_eq!(charlie.servers(), ["helm-plugin-ledger", "helm-sessions"]);
    assert!(!charlie.call_ledger("whoami", json!({})).await.0);

    // The plugin turned off.
    switch::<PluginsSetEnabled>(&mut client, &folder, false).await;
    assert_eq!(charlie.ledger_status().await, 404);
    let delta = world.session(&mut client, "delta").await;
    assert_eq!(delta.servers(), ["helm-sessions"]);

    // Turned on again: given, and its module answers once more.
    switch::<PluginsSetEnabled>(&mut client, &folder, true).await;
    let echo = world.session(&mut client, "echo").await;
    assert_eq!(echo.servers(), ["helm-plugin-ledger", "helm-sessions"]);
    let (failed, text) = echo.call_ledger("whoami", json!({})).await;
    assert!(!failed, "{text}");

    // Removed.
    client
        .request::<PluginsRemove>(&PluginRemoveRequest {
            path: folder.to_string_lossy().into_owned(),
            delete_secrets: Vec::new(),
        })
        .await
        .expect("the plugin is removed");
    assert_eq!(echo.ledger_status().await, 404);
    let foxtrot = world.session(&mut client, "foxtrot").await;
    assert_eq!(foxtrot.servers(), ["helm-sessions"]);

    drop(client);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S4: what the module painted with no client attached
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_badge_and_status_a_version_2_module_set_with_no_client_attached_are_in_the_list_a_client_attaching_afterwards_is_sent()
 {
    let world = World::new();
    let folder = world.ledger(&format!("{TOOLS}\n{PAINTS}"));

    // Registered on a first run of the host.
    let first = world.host();
    let mut client = world.client().await;
    add(&mut client, &folder).await;
    until("the first run's module painted", || {
        asked(&folder).contains(&"/painted".to_owned())
    })
    .await;
    drop(client);
    first.stop(HostStopReason::Stop).await;
    std::fs::remove_file(folder.join("asked.txt")).expect("forget what the first run asked");

    // The next run starts the plugin with no client attached; its module
    // paints, then tells its service it did.
    let host = world.host();
    until("the module painted with no client attached", || {
        asked(&folder).contains(&"/painted".to_owned())
    })
    .await;

    // A client attaching afterwards is sent that badge and status item.
    let mut watcher = TestClient::connect(&world.endpoint, &[]).await;
    let mut shown: Vec<PluginInfo> = match watcher
        .subscribe_on(PLUGINS_CHANGED, PluginsChanged::NAME)
        .await
    {
        Message::Snapshot(snapshot) => from_payload(&snapshot.state).unwrap(),
        other => panic!("plugins:changed starts with its state, not {other:?}"),
    };
    let painted = |list: &[PluginInfo]| {
        let ledger = by_id(list, "ledger");
        ledger.badge == Some(3)
            && ledger
                .status
                .as_ref()
                .is_some_and(|status| status.text == "3 open")
    };
    // The list a paint sends goes out once its turn is over; the paint was
    // made before the client attached.
    let deadline = Instant::now() + PATIENCE;
    while !painted(&shown) {
        let left = deadline.saturating_duration_since(Instant::now());
        match watcher.next(left).await {
            Some(Message::Event(event)) if event.subscription == PLUGINS_CHANGED => {
                shown = from_payload(&event.payload).unwrap();
            }
            Some(_) => {}
            None => panic!("the badge and status within {PATIENCE:?}: {shown:#?}"),
        }
    }
    let ledger = by_id(&shown, "ledger");
    assert_eq!(
        ledger
            .background
            .as_ref()
            .map(|background| background.state),
        Some(PluginBackgroundState::Running)
    );
    let pid = ledger.service.as_ref().and_then(|service| service.pid);
    drop(watcher);

    host.stop(HostStopReason::Stop).await;
    all_ended(&pid.into_iter().collect::<Vec<_>>()).await;
}

// ---------------------------------------------------------------------------
// S6: a client's offer under a version 2 plugin's name is passed over
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s6_a_client_offering_a_server_under_a_version_2_plugins_name_is_sent_nothing_and_the_module_answers()
 {
    let world = World::new();
    let host = world.host();
    let folder = world.ledger(TOOLS);
    let mut desktop = world.client().await;
    add(&mut desktop, &folder).await;
    desktop
        .subscribe_quietly(PLUGIN_CALLS, AgentPluginCalls::NAME)
        .await;
    let whoami = AgentPluginTool {
        name: "whoami".into(),
        description: "The window's whoami.".into(),
        input_schema: to_payload(&json!({ "type": "object" })).unwrap(),
        read_only: false,
    };
    desktop
        .request::<AgentPluginOffer>(&AgentPluginServers {
            servers: vec![AgentPluginServer {
                name: "helm-plugin-ledger".into(),
                plugin: "ledger".into(),
                instructions: "Offered by the window.".into(),
                tools: vec![whoami],
            }],
        })
        .await
        .expect("the offer is taken");

    let alpha = world.session(&mut desktop, "alpha").await;
    assert_eq!(alpha.servers(), ["helm-plugin-ledger", "helm-sessions"]);
    let (url, token) = alpha.ledger();
    let (_, instructions, tools) = server_as_listed(&url, &token).await;
    assert_eq!(
        instructions, LEDGER_INSTRUCTIONS,
        "the host's, not the window's"
    );
    assert_eq!(tools.len(), 2);
    assert_eq!(allowed_in(&alpha.argv), ["mcp__helm-plugin-ledger__whoami"]);

    let (failed, text) = alpha.call_ledger("whoami", json!({ "note": "hi" })).await;
    assert!(!failed, "{text}");
    let said: Value = serde_json::from_str(&text).expect("the module's answer");
    assert_eq!(said["args"], json!({ "note": "hi" }));

    // Everything the host sent the window before this answer is in: no call.
    desktop.request::<PluginsList>(&()).await.expect("the list");
    while let Some(message) = desktop.next(Duration::ZERO).await {
        assert!(
            !matches!(&message, Message::Event(event) if event.subscription == PLUGIN_CALLS),
            "the window was sent a call: {message:?}"
        );
    }

    drop(desktop);
    host.stop(HostStopReason::Stop).await;
}

// ---------------------------------------------------------------------------
// S8: a version 1 plugin is answered by the client, the engine runs nothing
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn s8_a_version_1_plugins_tool_is_answered_by_the_window_that_offers_it_and_the_hosts_engine_runs_nothing_for_it()
 {
    let world = World::new();
    let host = world.host();
    let folder = world.notes();
    let mut desktop = world.client().await;
    add(&mut desktop, &folder).await;
    desktop
        .subscribe_quietly(PLUGIN_CALLS, AgentPluginCalls::NAME)
        .await;
    let schema = to_payload(&json!({ "type": "object" })).unwrap();
    desktop
        .request::<AgentPluginOffer>(&AgentPluginServers {
            servers: vec![AgentPluginServer {
                name: "helm-plugin-notes".into(),
                plugin: "notes".into(),
                instructions: "Offered by the window.".into(),
                tools: vec![AgentPluginTool {
                    name: "find".into(),
                    description: "Finds a note.".into(),
                    input_schema: schema,
                    read_only: true,
                }],
            }],
        })
        .await
        .expect("the offer is taken");
    let mut client = world.client().await;
    let alpha = world.session(&mut client, "alpha").await;
    assert_eq!(alpha.servers(), ["helm-plugin-notes", "helm-sessions"]);
    let (url, token) = alpha.server("helm-plugin-notes");
    let (_, instructions, _) = server_as_listed(&url, &token).await;
    assert_eq!(instructions, "Offered by the window.");

    let calling = tokio::spawn(async move {
        call_tool(&url, &token, "find", json!({ "query": "release" })).await
    });
    let call: AgentPluginToolCall = loop {
        match desktop.next(PATIENCE).await {
            Some(Message::Event(event)) if event.subscription == PLUGIN_CALLS => {
                break from_payload(&event.payload).expect("a call");
            }
            Some(_) => {}
            None => panic!("no call reached the window within {PATIENCE:?}"),
        }
    };
    assert_eq!(
        (call.plugin.as_str(), call.tool.as_str()),
        ("notes", "find")
    );
    let found =
        json!({ "content": [{ "type": "text", "text": "Found 2 notes." }], "isError": false });
    desktop
        .request::<AgentPluginAnswer>(&AgentPluginToolAnswer {
            call_id: call.call_id,
            outcome: AgentPluginOutcome::Done {
                value: to_payload(&found).unwrap(),
            },
        })
        .await
        .expect("the window's answer is taken");
    assert_eq!(calling.await.unwrap(), (false, "Found 2 notes.".to_owned()));

    // The page is listed for a client to run; the host's engine started
    // nothing for it.
    let notes = listed(&mut client, "notes").await;
    let background = notes.background.expect("a background page");
    assert!(
        background.url.starts_with("helm-plugin://"),
        "{}",
        background.url
    );
    assert_eq!(background.state, PluginBackgroundState::Stopped);

    drop(client);
    drop(desktop);
    host.stop(HostStopReason::Stop).await;
}
