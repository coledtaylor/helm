//! A background script end to end: a plugin folder added to a running host
//! over a client connection, its script calling the host's real methods
//! (`floti.exec`, `floti.fetch` with a secret placeholder, `settings.get`,
//! `secrets.state`) and hearing what clients do through `floti.on`, as
//! today's `desktop/main/plugins/host.test.ts` drives the sample plugin's
//! background page.
//!
//! The plugin's server is a plain HTTP server on `127.0.0.1:0`, the program
//! its `exec` names is `floti-fake-program`, and its secret is saved through
//! `secrets:save`, sealed with the `TestDirs`' own key file. What the script
//! does is read where a user would see it: the status item and badge in every
//! client's plugin list, and the requests its server was sent.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use floti_host::platform::socket::Endpoint;
use floti_host::server::{HostConfig, HostRun, backends};
use floti_host::testkit::{RunningHost, TestClient, TestDirs};
use floti_protocol::Message;
use floti_protocol::channel::{EventChannel, from_payload};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::plugins::{
    PluginAddRequest, PluginBackgroundState, PluginCommandRequest, PluginInfo,
    PluginSetSettingRequest, PluginSettingValue, PluginStatusItem, PluginStatusTone, PluginsAdd,
    PluginsChanged, PluginsCommand, PluginsSetSetting, SecretInput, SecretRemoveRequest,
    SecretsRemove, SecretsSave,
};
use floti_protocol::channels::workspace::AppMode;
use serde_json::{Value, json};

/// How long a test waits on a script, a push or a request.
const WAIT: Duration = Duration::from_secs(10);

const PLUGINS_CHANGED: u64 = 1;

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn fake_program() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_floti-fake-program"))
}

// ---------------------------------------------------------------------------
// The plugin's server, on 127.0.0.1
// ---------------------------------------------------------------------------

/// One request the server was sent.
#[derive(Debug, Clone)]
struct Seen {
    method: String,
    /// The path and query, as sent.
    target: String,
    /// Names lowercased.
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Seen {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(each, _)| each == name)
            .map(|(_, value)| value.as_str())
    }

    fn path(&self) -> &str {
        self.target
            .split_once('?')
            .map_or(self.target.as_str(), |(path, _)| path)
    }
}

/// A server like the sample plugin's: `GET /items` answers how many items are
/// unread, one more each time it is asked, and `POST /report` takes what the
/// script reports. Every request is kept.
struct ItemsServer {
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
    stop: Arc<AtomicBool>,
    accept: Option<JoinHandle<()>>,
}

impl ItemsServer {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let stop = Arc::new(AtomicBool::new(false));
        let asked = Arc::new(AtomicU32::new(0));
        let accept = {
            let (seen, stop) = (Arc::clone(&seen), Arc::clone(&stop));
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    let Ok(stream) = stream else { continue };
                    let (seen, asked) = (Arc::clone(&seen), Arc::clone(&asked));
                    std::thread::spawn(move || serve(stream, &seen, &asked));
                }
            })
        };
        Self {
            port,
            seen,
            stop,
            accept: Some(accept),
        }
    }

    fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    /// Waits until a request the server was sent passes `check`, and answers
    /// the last one that does.
    async fn until(&self, what: &str, check: impl Fn(&Seen) -> bool) -> Seen {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(found) = self.seen().into_iter().rev().find(|seen| check(seen)) {
                return found;
            }
            assert!(
                Instant::now() < deadline,
                "the server was never sent {what} within {WAIT:?}: {:#?}",
                self.seen()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

impl Drop for ItemsServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
    }
}

/// Reads one request from `stream`: its head, then as much body as it says.
fn read_seen(stream: &mut impl Read) -> Option<Seen> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        if let Some(at) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break at;
        }
        let read = stream.read(&mut chunk).ok().filter(|read| *read > 0)?;
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_owned();
    let target = request_line.next()?.to_owned();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    let length: usize = headers
        .iter()
        .find(|(name, _)| name == "content-length")
        .map_or(0, |(_, value)| value.parse().unwrap_or(0));
    let mut body = buffer[head_end + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).ok().filter(|read| *read > 0)?;
        body.extend_from_slice(&chunk[..read]);
    }
    Some(Seen {
        method,
        target,
        headers,
        body,
    })
}

fn serve(mut stream: TcpStream, seen: &Mutex<Vec<Seen>>, asked: &AtomicU32) {
    let Some(request) = read_seen(&mut stream) else {
        return;
    };
    let (status, body) = match (request.method.as_str(), request.path()) {
        ("GET", "/items") => {
            let unread = asked.fetch_add(1, Ordering::SeqCst) + 1;
            (200, json!({ "unread": unread, "items": [] }).to_string())
        }
        ("POST", "/report") => (204, String::new()),
        _ => (404, String::new()),
    };
    seen.lock().unwrap().push(request);
    let head = format!(
        "HTTP/1.1 {status} Whatever\r\nconnection: close\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
}

// ---------------------------------------------------------------------------
// A host and its clients
// ---------------------------------------------------------------------------

struct HostWorld {
    host: Option<RunningHost>,
    client: Option<TestClient>,
    endpoint: Endpoint,
    /// Last: fields drop in order.
    dirs: TestDirs,
}

impl HostWorld {
    async fn start() -> Self {
        let dirs = TestDirs::new();
        let endpoint = dirs.endpoint();
        let host = RunningHost::start(HostConfig {
            folders: dirs.folders(),
            endpoint: endpoint.clone(),
            backends: backends(&dirs.user_env(), None),
            inherited_env: std::env::vars_os()
                .filter(|(key, _)| key != "SHELL")
                .chain([(OsString::from("SHELL"), OsString::from("/bin/sh"))])
                .collect(),
            run: HostRun {
                mode: AppMode::Dev,
                home: Some(dirs.home.clone()),
            },
        });
        let client = TestClient::connect(&endpoint, &[]).await;
        Self {
            host: Some(host),
            client: Some(client),
            endpoint,
            dirs,
        }
    }

    fn client(&mut self) -> &mut TestClient {
        self.client.as_mut().expect("connected")
    }

    async fn stop(mut self) {
        self.client = None;
        if let Some(host) = self.host.take() {
            host.stop(HostStopReason::Stop).await;
        }
    }

    fn plugin(&self, id: &str, manifest: &Value, script: &str) -> PathBuf {
        self.dirs
            .plugin_folder(id, &manifest.to_string(), &[("bg.js", script)])
    }

    async fn add(&mut self, folder: &Path) -> Vec<PluginInfo> {
        let added = self
            .client()
            .request::<PluginsAdd>(&PluginAddRequest { path: text(folder) })
            .await
            .unwrap();
        assert_eq!(added.error, None);
        added.plugins
    }

    async fn command(&mut self, plugin: &str, id: &str) -> Result<(), String> {
        self.client()
            .request::<PluginsCommand>(&PluginCommandRequest {
                plugin: plugin.into(),
                id: id.into(),
            })
            .await
            .map_err(|error| error.message)
    }

    async fn set_setting(&mut self, plugin: &str, key: &str, value: PluginSettingValue) {
        self.client()
            .request::<PluginsSetSetting>(&PluginSetSettingRequest {
                plugin: plugin.into(),
                key: key.into(),
                value,
            })
            .await
            .unwrap();
    }

    async fn save_secret(
        &mut self,
        key: &str,
        value: Option<&str>,
        hosts: &[&str],
        plugins: &[&str],
    ) {
        self.client()
            .request::<SecretsSave>(&SecretInput {
                key: key.into(),
                value: value.map(str::to_owned),
                hosts: hosts.iter().map(|host| (*host).to_owned()).collect(),
                plugins: plugins.iter().map(|plugin| (*plugin).to_owned()).collect(),
            })
            .await
            .unwrap();
    }

    async fn remove_secret(&mut self, key: &str) {
        self.client()
            .request::<SecretsRemove>(&SecretRemoveRequest { key: key.into() })
            .await
            .unwrap();
    }

    /// Another client, subscribed to `plugins:changed`.
    async fn watcher(&self) -> TestClient {
        let mut client = TestClient::connect(&self.endpoint, &[]).await;
        match client
            .subscribe_on(PLUGINS_CHANGED, PluginsChanged::NAME)
            .await
        {
            Message::Snapshot(_) => client,
            other => panic!("plugins:changed starts with its state, not {other:?}"),
        }
    }
}

fn by_id<'a>(listed: &'a [PluginInfo], id: &str) -> &'a PluginInfo {
    listed
        .iter()
        .find(|plugin| plugin.id.as_deref() == Some(id))
        .unwrap_or_else(|| panic!("{id} is not in {listed:#?}"))
}

fn state(info: &PluginInfo) -> PluginBackgroundState {
    info.background
        .as_ref()
        .map_or(PluginBackgroundState::Stopped, |background| {
            background.state
        })
}

/// The `plugins:changed` pushes `watcher` is sent until `check` holds of one,
/// which is answered.
async fn push_where(
    watcher: &mut TestClient,
    what: &str,
    check: impl Fn(&[PluginInfo]) -> bool,
) -> Vec<PluginInfo> {
    let deadline = Instant::now() + WAIT;
    let mut last = None;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match watcher.next(left).await {
            Some(Message::Event(event)) if event.subscription == PLUGINS_CHANGED => {
                let listed: Vec<PluginInfo> = from_payload(&event.payload).unwrap();
                if check(&listed) {
                    return listed;
                }
                last = Some(listed);
            }
            Some(_) => {}
            None => {
                panic!("no plugins:changed push showed {what} within {WAIT:?}; the last: {last:#?}")
            }
        }
    }
}

fn status_text(info: &PluginInfo) -> Option<&str> {
    info.status.as_ref().map(|status| status.text.as_str())
}

// ---------------------------------------------------------------------------
// floti.on hears the commands, settings and secrets clients change
// ---------------------------------------------------------------------------

/// Each event is shown as `<n> <event> <data as JSON>`, `n` counting every
/// event the script heard, so the same data heard twice is two pushes.
const LISTENER: &str = r#"
let heard = 0;
for (const name of ["command", "settings", "secrets"]) {
  floti.on(name, (data) => {
    heard += 1;
    floti.status.set({ text: `${heard} ${name} ${JSON.stringify(data)}` });
  });
}
"#;

/// The `n`th event the listener heard, once every client is shown it: its
/// name and its data.
async fn heard(watchers: &mut [&mut TestClient], n: u32) -> (String, Value) {
    let prefix = format!("{n} ");
    let mut shown = Vec::new();
    for watcher in watchers.iter_mut() {
        let listed = push_where(watcher, &format!("event {n}"), |listed| {
            status_text(by_id(listed, "listener")).is_some_and(|text| text.starts_with(&prefix))
        })
        .await;
        shown.push(status_text(by_id(&listed, "listener")).unwrap().to_owned());
    }
    assert!(
        shown.windows(2).all(|pair| pair[0] == pair[1]),
        "every client is shown the same: {shown:?}"
    );
    let rest = &shown[0][prefix.len()..];
    let (name, data) = rest.split_once(' ').expect("an event and its data");
    (name.to_owned(), serde_json::from_str(data).unwrap())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_background_script_hears_each_command_setting_and_secret_change_a_client_makes_and_an_undeclared_command_is_refused()
 {
    let mut world = HostWorld::start().await;
    let folder = world.plugin(
        "listener",
        &json!({
            "apiVersion": 2,
            "id": "listener",
            "name": "Listener",
            "background": "bg.js",
            "commands": [{ "id": "refresh", "title": "Refresh" }],
            "settings": [
                { "key": "limit", "type": "number", "label": "Limit", "default": 20, "min": 1, "max": 100 },
                { "key": "unreadOnly", "type": "toggle", "label": "Unread only", "default": false },
                { "key": "order", "type": "select", "label": "Order", "default": "new",
                  "options": [{ "value": "new", "label": "Newest" }, { "value": "old", "label": "Oldest" }] }
            ],
            "secrets": ["alpha", "beta"],
        }),
        LISTENER,
    );
    // Subscribed before the plugin is added, so the push that shows it
    // running comes after each subscription's snapshot.
    let mut first = world.watcher().await;
    let mut second = world.watcher().await;
    world.add(&folder).await;
    for watcher in [&mut first, &mut second] {
        push_where(watcher, "the listener running", |listed| {
            state(by_id(listed, "listener")) == PluginBackgroundState::Running
        })
        .await;
    }
    let mut watchers = [&mut first, &mut second];

    // A command with no tab: its id.
    world.command("listener", "refresh").await.unwrap();
    assert_eq!(
        heard(&mut watchers, 1).await,
        ("command".to_owned(), json!({ "id": "refresh" }))
    );

    // A command the manifest does not declare is refused and never reaches
    // the script: the next thing it hears is the setting below.
    assert_eq!(
        world.command("listener", "nope").await,
        Err(r#""nope" is not one of Listener's commands"#.to_owned())
    );

    // A setting: every setting's value, the user's or the default.
    world
        .set_setting("listener", "limit", PluginSettingValue::Number(7.0))
        .await;
    assert_eq!(
        heard(&mut watchers, 2).await,
        (
            "settings".to_owned(),
            json!({ "limit": 7, "unreadOnly": false, "order": "new" })
        )
    );
    world
        .set_setting("listener", "order", PluginSettingValue::Text("old".into()))
        .await;
    assert_eq!(
        heard(&mut watchers, 3).await.1,
        json!({ "limit": 7, "unreadOnly": false, "order": "old" })
    );
    world
        .set_setting("listener", "limit", PluginSettingValue::Unset)
        .await;
    assert_eq!(
        heard(&mut watchers, 4).await.1,
        json!({ "limit": 20, "unreadOnly": false, "order": "old" })
    );

    // A secret saved, allowed, refused and removed: every declared key's
    // state each time.
    let anywhere = ["https://example.com"];
    world
        .save_secret("alpha", Some("first"), &anywhere, &["listener"])
        .await;
    assert_eq!(
        heard(&mut watchers, 5).await,
        (
            "secrets".to_owned(),
            json!({ "alpha": "ready", "beta": "missing" })
        )
    );
    world
        .save_secret("beta", Some("second"), &anywhere, &[])
        .await;
    assert_eq!(
        heard(&mut watchers, 6).await.1,
        json!({ "alpha": "ready", "beta": "missing" }),
        "saved for no plugin, beta is not this one's to use"
    );
    world
        .save_secret("beta", None, &anywhere, &["listener"])
        .await;
    assert_eq!(
        heard(&mut watchers, 7).await.1,
        json!({ "alpha": "ready", "beta": "ready" }),
        "allowed"
    );
    world.save_secret("alpha", None, &anywhere, &[]).await;
    assert_eq!(
        heard(&mut watchers, 8).await.1,
        json!({ "alpha": "missing", "beta": "ready" }),
        "refused"
    );
    world.remove_secret("beta").await;
    assert_eq!(
        heard(&mut watchers, 9).await.1,
        json!({ "alpha": "missing", "beta": "missing" }),
        "removed"
    );

    drop((first, second));
    world.stop().await;
}

// ---------------------------------------------------------------------------
// A plugin like the sample plugin, end to end
// ---------------------------------------------------------------------------

/// The sample plugin's background, on the floti global: a refresh that asks
/// for its secret's state and its settings, runs its program, asks its server
/// with the secret in a header, reports what came back, tells its other
/// channel, and paints the badge and status; on a command, a setting, a
/// secret or a message, and on an interval.
const SAMPLE: &str = r#"
const CHANNEL = "sample-items";
const channel = new BroadcastChannel(CHANNEL);
const listener = new BroadcastChannel(CHANNEL);
const heard = [];
listener.onmessage = (event) => heard.push(event.data);
channel.onmessage = (event) => heard.push(`sender heard ${event.data}`);

let round = 0;
let busy = false;

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    if ((await floti.secrets.state("sample-token")) !== "ready") {
      await floti.badge.set(null);
      await floti.status.set({ text: "Sample: no token", tone: "warn", tooltip: "Add the token in Settings" });
      return;
    }
    round += 1;
    const settings = await floti.settings.get();
    const ran = await floti.exec("echo", ["round", String(round)], { stdin: "from the script" });
    const program = JSON.parse(ran.stdout);
    const query = new URLSearchParams({ limit: String(settings.limit), order: settings.order });
    const response = await floti.fetch(`${settings.server}/items?${query}`, {
      headers: new Headers({ Authorization: "Bearer {{sample-token}}", Accept: "application/json" }),
    });
    const list = await response.json();
    await floti.fetch(`${settings.server}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        round,
        exitCode: ran.exitCode,
        timedOut: ran.timedOut,
        stderr: ran.stderr,
        args: program.args,
        stdin: program.stdin,
        env: program.env,
        status: response.status,
        url: response.url,
        type: response.headers.get("content-type"),
        heard: [...heard],
      }),
    });
    channel.postMessage("refreshed");
    await floti.badge.set(list.unread);
    await floti.status.set({
      text: `${list.unread} unread`,
      tone: list.unread > 0 ? "accent" : "neutral",
      tooltip: "Sample items",
    });
  } catch (failure) {
    await floti.status.set({ text: "Sample: offline", tone: "danger", tooltip: String(failure?.message ?? failure) });
  } finally {
    busy = false;
  }
}

floti.tools.handle("list_items", async () => "no items");
floti.on("command", ({ id }) => { if (id === "refresh") void refresh(); });
floti.on("settings", () => void refresh());
floti.on("secrets", () => void refresh());

void refresh();
setInterval(() => void refresh(), 250);
"#;

fn sample_manifest(origin: &str) -> Value {
    json!({
        "apiVersion": 2,
        "id": "sample",
        "name": "Sample",
        "version": "1.0.0",
        "background": "bg.js",
        "commands": [{ "id": "refresh", "title": "Refresh items" }],
        "settings": [
            { "key": "server", "type": "text", "label": "Server", "default": origin },
            { "key": "limit", "type": "number", "label": "Items shown", "default": 20, "min": 1, "max": 100 },
            { "key": "order", "type": "select", "label": "Order", "default": "new",
              "options": [{ "value": "new", "label": "Newest first" }, { "value": "old", "label": "Oldest first" }] },
            { "key": "token", "type": "secret", "label": "Token", "secret": "sample-token" }
        ],
        "network": [origin],
        "secrets": ["sample-token"],
        "exec": {
            "echo": {
                "command": text(&fake_program()),
                "args": ["--show-env", "SAMPLE_PLAIN"],
                "env": { "SAMPLE_PLAIN": "as declared", "SAMPLE_TOKEN": "{{sample-token}}" }
            }
        },
        "agent": {
            "instructions": "The user's Sample items.",
            "tools": {
                "list_items": { "description": "Lists the Sample items.",
                                "inputSchema": { "type": "object" }, "readOnly": true }
            }
        }
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_plugin_like_the_sample_plugin_has_each_of_its_background_calls_answered_by_the_host() {
    let server = ItemsServer::start();
    let origin = server.origin();
    let mut world = HostWorld::start().await;
    let folder = world.plugin("sample", &sample_manifest(&origin), SAMPLE);
    // Subscribed before the plugin is added, so the push that shows the
    // script's first status comes after each subscription's snapshot.
    let mut first = world.watcher().await;
    let mut second = world.watcher().await;
    let added = world.add(&folder).await;
    let tools = by_id(&added, "sample").agent.as_ref().expect("its tools");
    assert_eq!(tools.tools[0].name, "list_items");

    // No secret yet: secrets.state is missing, and every client says so.
    for watcher in [&mut first, &mut second] {
        let listed = push_where(watcher, "Sample: no token", |listed| {
            status_text(by_id(listed, "sample")) == Some("Sample: no token")
        })
        .await;
        assert_eq!(by_id(&listed, "sample").badge, None);
        assert_eq!(
            state(by_id(&listed, "sample")),
            PluginBackgroundState::Running
        );
    }
    assert!(server.seen().is_empty(), "nothing is asked without a token");

    // The secret is stored for this plugin and the server's origin: the
    // secrets event starts a refresh, and the interval keeps refreshing.
    const TOKEN: &str = "s3cret token";
    world
        .save_secret("sample-token", Some(TOKEN), &[&origin], &["sample"])
        .await;
    for watcher in [&mut first, &mut second] {
        let listed = push_where(watcher, "three refreshes painted", |listed| {
            let sample = by_id(listed, "sample");
            sample.badge.is_some_and(|badge| badge >= 3)
                && status_text(sample)
                    == sample
                        .badge
                        .map(|badge| format!("{badge} unread"))
                        .as_deref()
        })
        .await;
        let sample = by_id(&listed, "sample");
        assert_eq!(
            sample.status,
            Some(PluginStatusItem {
                text: format!("{} unread", sample.badge.unwrap()),
                tone: Some(PluginStatusTone::Accent),
                tooltip: Some("Sample items".into()),
            })
        );
    }

    // The server saw each request with the secret filled in, and the
    // settings' defaults in its query.
    let items: Vec<Seen> = server
        .seen()
        .into_iter()
        .filter(|seen| seen.path() == "/items")
        .collect();
    assert!(items.len() >= 3, "{items:#?}");
    for seen in &items {
        assert_eq!(seen.method, "GET");
        assert_eq!(seen.header("authorization"), Some("Bearer s3cret token"));
        assert_eq!(seen.header("accept"), Some("application/json"));
        assert_eq!(seen.header("cookie"), None);
        assert_eq!(seen.target, "/items?limit=20&order=new");
    }

    // What the script reported: the program's output, the response as it
    // came back, and the other channel's message from the round before.
    let reported = server
        .until("a report after a message", |seen| {
            seen.path() == "/report"
                && serde_json::from_slice::<Value>(&seen.body)
                    .is_ok_and(|report| report["round"].as_u64() >= Some(2))
        })
        .await;
    assert_eq!(reported.header("authorization"), None);
    let report: Value = serde_json::from_slice(&reported.body).unwrap();
    let round = report["round"].as_u64().unwrap();
    assert_eq!(report["exitCode"], 0);
    assert_eq!(report["timedOut"], false);
    assert_eq!(report["stderr"], "");
    assert_eq!(
        report["args"],
        json!(["--show-env", "SAMPLE_PLAIN", "round", round.to_string()]),
        "the declared arguments first, then the call's"
    );
    assert_eq!(report["stdin"], "from the script");
    assert_eq!(report["env"], json!({ "SAMPLE_PLAIN": "as declared" }));
    assert_eq!(report["status"], 200);
    assert_eq!(
        report["url"],
        format!("{origin}/items?limit=20&order=new"),
        "the URL the script asked for"
    );
    assert_eq!(report["type"], "application/json");
    let heard = report["heard"].as_array().unwrap();
    assert!(
        !heard.is_empty() && heard.iter().all(|each| each == "refreshed"),
        "{report}"
    );
    assert!(
        !reported
            .body
            .windows(TOKEN.len())
            .any(|window| window == TOKEN.as_bytes()),
        "the script never sees the secret"
    );

    // A setting a client changes reaches settings.get, and the next request.
    world
        .set_setting("sample", "limit", PluginSettingValue::Number(7.0))
        .await;
    world
        .set_setting("sample", "order", PluginSettingValue::Text("old".into()))
        .await;
    let changed = server
        .until("the changed settings", |seen| {
            seen.target == "/items?limit=7&order=old"
        })
        .await;
    assert_eq!(changed.header("authorization"), Some("Bearer s3cret token"));

    // A command reaches the script too: one more request, painted for every
    // client.
    let before = server.seen().len();
    world.command("sample", "refresh").await.unwrap();
    server
        .until("a request after the command", |_| {
            server.seen().len() > before
        })
        .await;

    drop((first, second));
    world.stop().await;
    drop(server);
}
