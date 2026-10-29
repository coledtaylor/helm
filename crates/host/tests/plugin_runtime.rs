//! Plugin background scripts in the host's isolates, as today's
//! `desktop/main/plugins/host.test.ts` tests the background page and tools
//! for sessions, and `tools.test.ts` the tool calls in flight.
//!
//! Each script is written into a plugin folder under the test's own
//! `TestDirs`. What a client sees (the plugin list going from starting to
//! running, what a script paints) is tested over client connections to a
//! running host. What has no channel yet (a session's tool call, posting
//! into a plugin's channel) is tested against a registry and the runtime
//! built the way the host builds them, over the test's own `floti.db`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use floti_host::platform::socket::Endpoint;
use floti_host::plugins::background::{BackgroundRuntime, ToolCall, ToolCaller};
use floti_host::plugins::call::{CancelToken, PluginCallError};
use floti_host::plugins::runtime::IsolateRuntime;
use floti_host::plugins::secrets::NoSecrets;
use floti_host::plugins::{Registry, RegistryParts};
use floti_host::server::{HostConfig, HostRun, backends};
use floti_host::store::Store;
use floti_host::testkit::{RunningHost, TestClient, TestDirs, link_folder};
use floti_protocol::Message;
use floti_protocol::Payload;
use floti_protocol::channel::{EventChannel, from_payload};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::plugins::{
    PluginAddRequest, PluginBackgroundState, PluginInfo, PluginLogStream, PluginPathRequest,
    PluginStatusItem, PluginStatusTone, PluginSwitchRequest, PluginsAdd, PluginsChanged,
    PluginsList, PluginsReload, PluginsSetEnabled,
};
use floti_protocol::channels::workspace::AppMode;

/// How long a test waits on a script, a thread or a push.
const WAIT: Duration = Duration::from_secs(10);

/// A version 2 manifest whose background is `bg.js`, with `extra` fields.
fn manifest(id: &str, extra: &str) -> String {
    let extra = if extra.is_empty() {
        String::new()
    } else {
        format!(", {extra}")
    };
    format!(
        r#"{{ "apiVersion": 2, "id": "{id}", "name": "{}", "background": "bg.js"{extra} }}"#,
        title(id)
    )
}

/// `cards` as `Cards`: the plugin's name.
fn title(id: &str) -> String {
    let mut chars = id.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn state(info: &PluginInfo) -> PluginBackgroundState {
    info.background
        .as_ref()
        .map_or(PluginBackgroundState::Stopped, |background| {
            background.state
        })
}

/// A registry and the isolate runtime, built as the host builds them, over
/// the test's own store.
struct World {
    registry: Option<Registry>,
    runtime: IsolateRuntime,
    published: Arc<Mutex<Vec<Vec<PluginInfo>>>>,
    /// What the stand-in for `floti.fetch` saw: `started <revision>` and
    /// `ended <revision>`.
    fetches: Arc<Mutex<Vec<String>>>,
    /// Last: the folder goes only once the registry has let go of its store.
    dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let published: Arc<Mutex<Vec<Vec<PluginInfo>>>> = Arc::default();
        let into = Arc::clone(&published);
        let runtime = IsolateRuntime::new();
        let registry = Registry::new(RegistryParts {
            store: Arc::new(Mutex::new(Store::open(&dirs.data).unwrap())),
            background: Arc::new(runtime.clone()) as Arc<dyn BackgroundRuntime>,
            secrets: Arc::new(NoSecrets),
            publish: Box::new(move |list| into.lock().unwrap().push(list.clone())),
        });
        runtime.connect(&registry);
        // A fetch that never answers on its own: a call in flight until the
        // plugin's calls are ended.
        let fetches: Arc<Mutex<Vec<String>>> = Arc::default();
        let seen = Arc::clone(&fetches);
        registry.methods().register("fetch", move |context, _args| {
            let seen = Arc::clone(&seen);
            async move {
                seen.lock()
                    .unwrap()
                    .push(format!("started {}", context.revision));
                // Ended however it ends: cancelled, or dropped by the layer
                // that answered for it.
                let _ended = Ended(seen, context.revision);
                context.cancel.cancelled().await;
                Err(PluginCallError::aborted())
            }
        });
        registry.start().unwrap();
        Self {
            registry: Some(registry),
            runtime,
            published,
            fetches,
            dirs,
        }
    }

    fn registry(&self) -> &Registry {
        self.registry
            .as_ref()
            .expect("a world has its registry until it stops")
    }

    /// A plugin folder named after `id`, with `script` as its background.
    fn plugin(&self, id: &str, script: &str, extra: &str) -> PathBuf {
        self.dirs
            .plugin_folder(id, &manifest(id, extra), &[("bg.js", script)])
    }

    fn add(&self, folder: &Path) -> PluginInfo {
        let added = self.registry().add(&text(folder)).unwrap();
        assert_eq!(added.error, None);
        added
            .plugins
            .into_iter()
            .find(|plugin| plugin.path == text(folder))
            .unwrap()
    }

    fn info(&self, id: &str) -> PluginInfo {
        self.registry()
            .list()
            .into_iter()
            .find(|plugin| plugin.id.as_deref() == Some(id))
            .unwrap_or_else(|| panic!("{id} is not listed"))
    }

    /// Waits until `check` holds of `id`'s entry in the list.
    async fn until(&self, id: &str, what: &str, check: impl Fn(&PluginInfo) -> bool) -> PluginInfo {
        let deadline = Instant::now() + WAIT;
        loop {
            let info = self.info(id);
            if check(&info) {
                return info;
            }
            assert!(
                Instant::now() < deadline,
                "{id}: {what} within {WAIT:?}; it is {info:#?}\nlog: {:#?}",
                self.runtime.log(id)
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn running(&self, id: &str) -> PluginInfo {
        self.until(id, "running", |info| {
            state(info) == PluginBackgroundState::Running
        })
        .await
    }

    /// What `id`'s scripts wrote with `console.log`.
    fn output(&self, id: &str) -> Vec<String> {
        self.runtime
            .log(id)
            .into_iter()
            .filter(|line| line.stream == PluginLogStream::Out)
            .map(|line| line.text)
            .collect()
    }

    /// Waits for a line `id`'s script logs that starts with `prefix`, and
    /// answers it.
    async fn line(&self, id: &str, prefix: &str) -> String {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(line) = self
                .output(id)
                .into_iter()
                .find(|line| line.starts_with(prefix))
            {
                return line;
            }
            assert!(
                Instant::now() < deadline,
                "{id} logged no line starting {prefix:?} within {WAIT:?}: {:#?}",
                self.runtime.log(id)
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn count(&self, id: &str, prefix: &str) -> usize {
        self.output(id)
            .iter()
            .filter(|line| line.starts_with(prefix))
            .count()
    }

    async fn call_tool(
        &self,
        plugin: &str,
        tool: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        self.registry()
            .call_tool(tool_call(plugin, tool, args), CancelToken::new())
            .await
    }

    /// Waits until the stand-in for `floti.fetch` has seen `count` calls
    /// `started` or `ended`.
    async fn fetched(&self, what: &str, count: usize) {
        let deadline = Instant::now() + WAIT;
        loop {
            let seen = self.fetches.lock().unwrap().clone();
            if seen.iter().filter(|line| line.starts_with(what)).count() >= count {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "{count} fetches {what} within {WAIT:?}: {seen:?}
flight: {:#?}
other: {:#?}",
                self.runtime.log("flight"),
                self.runtime.log("other")
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Stops every script and waits until nothing holds the registry, so the
    /// store is let go before the test's folders are removed.
    async fn stop(mut self) {
        let registry = self.registry.take().expect("a world stops once");
        registry.shutdown();
        let weak = registry.downgrade();
        drop(registry);
        let deadline = Instant::now() + WAIT;
        while weak.upgrade().is_some() {
            assert!(
                Instant::now() < deadline,
                "the registry was still held after {WAIT:?}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

/// Writes `ended <revision>` when a call to the stand-in fetch ends.
struct Ended(Arc<Mutex<Vec<String>>>, u64);

impl Drop for Ended {
    fn drop(&mut self) {
        self.0.lock().unwrap().push(format!("ended {}", self.1));
    }
}

impl Drop for World {
    fn drop(&mut self) {
        if let Some(registry) = self.registry.take() {
            registry.shutdown();
        }
    }
}

fn tool_call(plugin: &str, tool: &str, args: serde_json::Value) -> ToolCall {
    ToolCall {
        plugin: plugin.to_owned(),
        tool: tool.to_owned(),
        args,
        session: ToolCaller {
            id: "a1b2c3".to_owned(),
            name: "alpha".to_owned(),
            cwd: "C:/work/alpha".to_owned(),
        },
    }
}

// ---------------------------------------------------------------------------
// A host and its clients
// ---------------------------------------------------------------------------

const PLUGINS_CHANGED: u64 = 1;

struct HostWorld {
    host: Option<RunningHost>,
    client: Option<TestClient>,
    endpoint: Endpoint,
    /// Last: fields drop in order.
    dirs: TestDirs,
}

fn start_host(dirs: &TestDirs, endpoint: &Endpoint) -> RunningHost {
    RunningHost::start(HostConfig {
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
    })
}

impl HostWorld {
    async fn start() -> Self {
        let dirs = TestDirs::new();
        let endpoint = dirs.endpoint();
        let host = start_host(&dirs, &endpoint);
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

    async fn connect(&mut self) {
        self.client = Some(TestClient::connect(&self.endpoint, &[]).await);
    }

    async fn stop_host(&mut self) -> Duration {
        self.client = None;
        let began = Instant::now();
        if let Some(host) = self.host.take() {
            host.stop(HostStopReason::Stop).await;
        }
        began.elapsed()
    }

    async fn restart(&mut self) {
        self.stop_host().await;
        self.host = Some(start_host(&self.dirs, &self.endpoint));
        self.connect().await;
    }

    async fn stop(mut self) {
        self.stop_host().await;
    }

    fn plugin(&self, id: &str, script: &str, extra: &str) -> PathBuf {
        self.dirs
            .plugin_folder(id, &manifest(id, extra), &[("bg.js", script)])
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

    async fn list(&mut self) -> Vec<PluginInfo> {
        self.client().request::<PluginsList>(&()).await.unwrap()
    }

    async fn switch(&mut self, folder: &Path, enabled: bool) -> Vec<PluginInfo> {
        self.client()
            .request::<PluginsSetEnabled>(&PluginSwitchRequest {
                path: text(folder),
                enabled,
            })
            .await
            .unwrap()
    }

    async fn reload(&mut self, folder: &Path) -> Vec<PluginInfo> {
        self.client()
            .request::<PluginsReload>(&PluginPathRequest { path: text(folder) })
            .await
            .unwrap()
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

/// Every `plugins:changed` push `watcher` is sent until `check` holds of
/// one, that one last.
async fn pushes_until(
    watcher: &mut TestClient,
    what: &str,
    check: impl Fn(&[PluginInfo]) -> bool,
) -> Vec<Vec<PluginInfo>> {
    let deadline = Instant::now() + WAIT;
    let mut seen = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match watcher.next(left).await {
            Some(Message::Event(event)) if event.subscription == PLUGINS_CHANGED => {
                let listed: Vec<PluginInfo> = from_payload(&event.payload).unwrap();
                let done = check(&listed);
                seen.push(listed);
                if done {
                    return seen;
                }
            }
            Some(_) => {}
            None => panic!("no plugins:changed push showed {what} within {WAIT:?}: {seen:#?}"),
        }
    }
}

// ---------------------------------------------------------------------------
// S1: a script of its own, from starting to running, with or without clients
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_background_script_runs_in_its_own_isolate_from_starting_to_running_with_or_without_a_client()
 {
    let mut world = HostWorld::start().await;
    let ticker = world.plugin(
        "ticker",
        "let n = 0; setInterval(() => floti.badge.set(++n), 100);",
        "",
    );
    let mut watcher = world.watcher().await;

    let added = world.add(&ticker).await;
    assert_eq!(
        state(by_id(&added, "ticker")),
        PluginBackgroundState::Starting
    );
    pushes_until(&mut watcher, "ticker running", |listed| {
        state(by_id(listed, "ticker")) == PluginBackgroundState::Running
    })
    .await;
    pushes_until(&mut watcher, "a badge the script set", |listed| {
        by_id(listed, "ticker").badge.is_some()
    })
    .await;

    // Switched off, it stops; switched on, it starts again.
    let off = world.switch(&ticker, false).await;
    assert_eq!(state(by_id(&off, "ticker")), PluginBackgroundState::Stopped);
    assert_eq!(by_id(&off, "ticker").badge, None);
    let on = world.switch(&ticker, true).await;
    assert_eq!(state(by_id(&on, "ticker")), PluginBackgroundState::Starting);
    pushes_until(&mut watcher, "ticker running again", |listed| {
        state(by_id(listed, "ticker")) == PluginBackgroundState::Running
    })
    .await;

    // With no client connected, it keeps running.
    drop(watcher);
    let before = by_id(&world.list().await, "ticker").badge.unwrap_or(0);
    world.client = None;
    tokio::time::sleep(Duration::from_millis(800)).await;
    world.connect().await;
    let after = by_id(&world.list().await, "ticker").badge.unwrap_or(0);
    assert!(
        after >= before + 4,
        "the badge went from {before} to {after}"
    );

    // A host that starts with it registered starts it.
    world.restart().await;
    let mut watcher = world.watcher().await;
    let listed = world.list().await;
    assert!(matches!(
        state(by_id(&listed, "ticker")),
        PluginBackgroundState::Starting | PluginBackgroundState::Running
    ));
    if state(by_id(&listed, "ticker")) == PluginBackgroundState::Starting {
        pushes_until(&mut watcher, "ticker running after a restart", |listed| {
            state(by_id(listed, "ticker")) == PluginBackgroundState::Running
        })
        .await;
    }
    drop(watcher);
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S2: no way to the computer itself
// ---------------------------------------------------------------------------

/// ECMAScript's own globals and the web's data types: what every isolate has.
const LANGUAGE_AND_WEB: &str = r#"[
  "AggregateError","Array","ArrayBuffer","AsyncDisposableStack","Atomics","BigInt","BigInt64Array",
  "BigUint64Array","Boolean","DataView","Date","DisposableStack","Error","EvalError",
  "FinalizationRegistry","Float16Array","Float32Array","Float64Array","Function","Infinity",
  "Int16Array","Int32Array","Int8Array","Intl","Iterator","JSON","Map","Math","NaN","Number",
  "Object","Promise","Proxy","RangeError","ReferenceError","Reflect","RegExp","Set",
  "SharedArrayBuffer","String","SuppressedError","Symbol","SyntaxError","Temporal","TypeError",
  "URIError","Uint16Array","Uint32Array","Uint8Array","Uint8ClampedArray","WeakMap","WeakRef",
  "WeakSet","decodeURI","decodeURIComponent","encodeURI","encodeURIComponent","escape","eval",
  "globalThis","isFinite","isNaN","parseFloat","parseInt","undefined","unescape",
  "AbortController","AbortSignal","DOMException","Event","EventTarget","Headers","MessageEvent",
  "TextDecoder","TextEncoder","URL","URLSearchParams","console","structuredClone"
]"#;

#[tokio::test(flavor = "multi_thread")]
async fn a_background_script_has_no_way_to_the_computer_and_only_the_globals_floti_gives_it() {
    let world = World::new();
    // Something outside the plugin's folder to try to reach: a file beside
    // it, and a folder linked from inside it.
    let outside = world.dirs.folder("outside");
    std::fs::write(outside.join("secret.js"), "export const value = 'reached';").unwrap();
    std::fs::write(
        world.dirs.root().join("beside.js"),
        "export const value = 'reached';",
    )
    .unwrap();
    let script = format!(
        r#"
const known = new Set({LANGUAGE_AND_WEB});
const extra = Object.getOwnPropertyNames(globalThis).filter((name) => !known.has(name)).sort();
console.log("globals " + extra.join(","));
const present = ["Deno", "require", "process", "fetch", "XMLHttpRequest", "WebSocket", "Worker",
  "module", "exports", "Bun", "__bootstrap", "importScripts", "navigator", "queueMicrotask"]
  .filter((name) => typeof globalThis[name] !== "undefined");
console.log("present " + present.join(","));
const tried = [];
for (const specifier of ["../beside.js", "./linked/secret.js", "https://example.com/x.js",
    "node:fs", "npm:left-pad", "left-pad", "file:///C:/Windows/win.ini", "/etc/hosts"]) {{
  try {{ await import(specifier); tried.push(specifier + " imported"); }}
  catch (error) {{ tried.push(specifier + " refused"); }}
}}
console.log("imports " + tried.join(" | "));
const own = await import("./lib/own.js");
console.log("own " + own.value);
"#
    );
    let folder = world.dirs.plugin_folder(
        "sealed",
        &manifest("sealed", ""),
        &[
            ("bg.js", &script),
            ("lib/own.js", "export const value = 'mine';"),
        ],
    );
    link_folder(&outside, &folder.join("linked"));
    world.add(&folder);
    world.running("sealed").await;

    assert_eq!(
        world.line("sealed", "globals ").await,
        "globals BroadcastChannel,clearInterval,clearTimeout,floti,setInterval,setTimeout"
    );
    assert_eq!(world.line("sealed", "present ").await, "present ");
    assert_eq!(
        world.line("sealed", "imports ").await,
        "imports ../beside.js refused | ./linked/secret.js refused | https://example.com/x.js refused | \
         node:fs refused | npm:left-pad refused | left-pad refused | file:///C:/Windows/win.ini refused | \
         /etc/hosts refused"
    );
    assert_eq!(world.line("sealed", "own ").await, "own mine");

    // A static import of anything else is refused before the script runs:
    // it never starts.
    let importer = world.plugin(
        "importer",
        "import { value } from '../beside.js'; console.log(value);",
        "",
    );
    world.add(&importer);
    let crashed = world
        .until("importer", "crashed", |info| {
            state(info) == PluginBackgroundState::Crashed
        })
        .await;
    let error = crashed.background.unwrap().error.unwrap();
    assert!(error.contains("outside the plugin's folder"), "{error}");
    assert!(world.output("importer").is_empty());
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S3: two plugins see nothing of each other
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn two_plugins_share_no_global_no_channel_and_no_crash() {
    let world = World::new();
    let mut heard = world.runtime.channel_messages();
    let loud = world.plugin(
        "loud",
        r#"
globalThis.shared = "loud's";
const channel = new BroadcastChannel("same");
setInterval(() => channel.postMessage("from loud"), 20);
"#,
        "",
    );
    let quiet = world.plugin(
        "quiet",
        r#"
const channel = new BroadcastChannel("same");
channel.onmessage = (event) => console.log("heard " + event.data);
setTimeout(() => console.log("shared " + typeof globalThis.shared), 300);
let ticks = 0;
setInterval(() => console.log("tick " + (++ticks)), 50);
"#,
        "",
    );
    world.add(&loud);
    world.add(&quiet);
    world.running("loud").await;
    world.running("quiet").await;
    assert_eq!(world.line("quiet", "shared ").await, "shared undefined");

    // The host side hears loud's channel as loud's.
    let message = tokio::time::timeout(WAIT, heard.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(message.plugin, "loud");
    assert_eq!(message.channel, "same");
    assert_eq!(message.data, Payload::Text("from loud".into()));

    // One crashes; the others keep running.
    let ticks = world.count("quiet", "tick ");
    let crasher = world.plugin("crasher", "throw new Error('on purpose');", "");
    world.add(&crasher);
    world
        .until("crasher", "crashed", |info| {
            state(info) == PluginBackgroundState::Crashed
        })
        .await;
    let deadline = Instant::now() + WAIT;
    while world.count("quiet", "tick ") < ticks + 5 {
        assert!(Instant::now() < deadline, "quiet stopped ticking");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(state(&world.info("loud")), PluginBackgroundState::Running);
    assert_eq!(state(&world.info("quiet")), PluginBackgroundState::Running);
    assert_eq!(
        world.count("quiet", "heard "),
        0,
        "{:#?}",
        world.output("quiet")
    );
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S4: timers
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn timers_fire_at_their_delay_with_their_arguments_until_cleared() {
    let world = World::new();
    let timers = world.plugin(
        "timers",
        r#"
const began = Date.now();
setTimeout((a, b) => console.log(`timeout ${a} ${b} ${Date.now() - began >= 100}`), 100, "x", 2);
const never = setTimeout(() => console.log("cleared timeout fired"), 30);
clearTimeout(never);
let n = 0;
const every = setInterval((tag) => {
  n += 1;
  console.log(`interval ${tag} ${n}`);
  if (n === 3) {
    clearInterval(every);
    setTimeout(() => console.log(`after clearing ${n}`), 200);
  }
}, 20, "t");
"#,
        "",
    );
    world.add(&timers);
    assert_eq!(world.line("timers", "timeout ").await, "timeout x 2 true");
    assert_eq!(
        world.line("timers", "after clearing ").await,
        "after clearing 3"
    );
    let intervals: Vec<String> = world
        .output("timers")
        .into_iter()
        .filter(|line| line.starts_with("interval "))
        .collect();
    assert_eq!(intervals, ["interval t 1", "interval t 2", "interval t 3"]);
    assert_eq!(world.count("timers", "cleared timeout fired"), 0);
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn switching_off_reloading_or_stopping_ends_every_timer() {
    let world = World::new();
    let ticker = world.plugin(
        "ticker",
        "let n = 0; setInterval(() => console.log('tick ' + (++n)), 20); setTimeout(() => console.log('late'), 400);",
        "",
    );
    world.add(&ticker);
    world.line("ticker", "tick 3").await;

    async fn still(world: &World) {
        let before = world.output("ticker").len();
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(
            world.output("ticker").len(),
            before,
            "{:#?}",
            world.output("ticker")
        );
    }

    world.registry().set_enabled(&text(&ticker), false).unwrap();
    still(&world).await;
    assert_eq!(world.count("ticker", "late"), 0);

    // Reloaded, the old isolate's timers are gone and the new one counts
    // from the start.
    world.registry().set_enabled(&text(&ticker), true).unwrap();
    world.running("ticker").await;
    world.registry().reload(&text(&ticker)).unwrap();
    let from = world.output("ticker").len();
    world.running("ticker").await;
    let deadline = Instant::now() + WAIT;
    while !world.output("ticker")[from..]
        .iter()
        .any(|line| line == "tick 3")
    {
        assert!(Instant::now() < deadline, "{:#?}", world.output("ticker"));
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let after_reload = &world.output("ticker")[from..];
    let first = after_reload
        .iter()
        .position(|line| line == "tick 1")
        .unwrap();
    assert!(
        after_reload[first..].windows(2).all(|pair| {
            let number = |line: &str| line.trim_start_matches("tick ").parse::<u32>().unwrap_or(0);
            number(&pair[1]) == number(&pair[0]) + 1 || !pair[1].starts_with("tick ")
        }),
        "one count after a reload: {after_reload:#?}"
    );

    world.registry().shutdown();
    still(&world).await;
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S5: BroadcastChannel
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_broadcast_channel_reaches_the_others_of_its_name_but_not_itself_or_a_closed_one() {
    let world = World::new();
    let mut heard = world.runtime.channel_messages();
    let channels = world.plugin(
        "channels",
        r#"
const sender = new BroadcastChannel("board");
const other = new BroadcastChannel("board");
const closed = new BroadcastChannel("board");
const elsewhere = new BroadcastChannel("elsewhere");
sender.onmessage = (event) => console.log("sender heard " + JSON.stringify(event.data));
other.addEventListener("message", (event) =>
  console.log(`other heard ${JSON.stringify(event.data)} ${event instanceof MessageEvent} ${event.data.bytes instanceof Uint8Array}`));
closed.onmessage = () => console.log("closed heard");
elsewhere.onmessage = () => console.log("elsewhere heard");
closed.close();
sender.postMessage({ n: 1, list: [1, "two", null, true], bytes: new Uint8Array([1, 2]) });
const thrown = [];
const cyclic = {}; cyclic.self = cyclic;
for (const [label, value] of [["function", () => 1], ["symbol", Symbol("s")], ["cyclic", cyclic],
    ["nested function", { f() {} }], ["date", new Date()]]) {
  try { sender.postMessage(value); thrown.push(label + " sent"); }
  catch (error) { thrown.push(label + " " + error.name); }
}
console.log("thrown " + thrown.join(", "));
try { closed.postMessage(1); console.log("closed post sent"); }
catch (error) { console.log("closed post " + error.name); }
"#,
        "",
    );
    world.add(&channels);
    assert_eq!(
        world.line("channels", "other heard ").await,
        r#"other heard {"n":1,"list":[1,"two",null,true],"bytes":{"0":1,"1":2}} true true"#
    );
    assert_eq!(
        world.line("channels", "thrown ").await,
        "thrown function DataCloneError, symbol DataCloneError, cyclic DataCloneError, \
         nested function DataCloneError, date DataCloneError"
    );
    assert_eq!(
        world.line("channels", "closed post ").await,
        "closed post InvalidStateError"
    );

    // What it posted reached the host side as the protocol carries it.
    let message = tokio::time::timeout(WAIT, heard.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        (message.plugin.as_str(), message.channel.as_str()),
        ("channels", "board")
    );
    let fields = message.data.as_map().unwrap();
    let field = |name: &str| {
        fields
            .iter()
            .find(|(key, _)| key.as_text() == Some(name))
            .map(|(_, value)| value.clone())
            .unwrap()
    };
    assert_eq!(field("bytes"), Payload::Bytes(vec![1, 2]));
    assert_eq!(field("n"), Payload::Integer(1.into()));

    // And what the host side posts reaches every open channel of the name.
    assert!(world.runtime.post_to_channel(
        "channels",
        "board",
        Payload::Text("from the host".into())
    ));
    world
        .line("channels", "sender heard \"from the host\"")
        .await;
    world
        .line("channels", "other heard \"from the host\"")
        .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    for never in ["sender heard {", "closed heard", "elsewhere heard"] {
        assert_eq!(
            world.count("channels", never),
            0,
            "{:#?}",
            world.output("channels")
        );
    }
    assert!(
        !world
            .runtime
            .post_to_channel("nobody", "board", Payload::Null)
    );
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S6: a crash
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_script_that_throws_is_shown_crashed_with_its_error_cleared_and_not_restarted() {
    let world = World::new();
    let steady = world.plugin(
        "steady",
        "let n = 0; setInterval(() => floti.badge.set(++n), 30);",
        "",
    );
    world.add(&steady);
    let thrower = world.plugin(
        "thrower",
        r#"
await floti.status.set({ text: "busy" });
await floti.badge.set(4);
console.log("painted");
await new Promise((resolve) => setTimeout(resolve, 100));
throw new Error("on purpose");
"#,
        "",
    );
    world.add(&thrower);
    world.line("thrower", "painted").await;
    let crashed = world
        .until("thrower", "crashed", |info| {
            state(info) == PluginBackgroundState::Crashed
        })
        .await;
    let error = crashed.background.as_ref().unwrap().error.clone().unwrap();
    assert!(error.contains("on purpose"), "{error}");
    assert_eq!((crashed.status, crashed.badge), (None, None));
    assert!(world.published.lock().unwrap().iter().any(|list| {
        list.iter().any(|plugin| {
            plugin.id.as_deref() == Some("thrower")
                && state(plugin) == PluginBackgroundState::Crashed
        })
    }));
    assert!(
        world
            .runtime
            .log("thrower")
            .iter()
            .any(|line| line.stream == PluginLogStream::Host && line.text.contains("on purpose"))
    );

    // Not restarted, and nothing else stopped.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(
        state(&world.info("thrower")),
        PluginBackgroundState::Crashed
    );
    assert_eq!(world.count("thrower", "painted"), 1);
    let badge = world.info("steady").badge.unwrap();
    world
        .until("steady", "still counting", |info| {
            info.badge.unwrap_or(0) > badge
        })
        .await;

    // Fixed and reloaded, it starts afresh.
    std::fs::write(thrower.join("bg.js"), "console.log('fixed');").unwrap();
    world.registry().reload(&text(&thrower)).unwrap();
    let running = world.running("thrower").await;
    assert_eq!(running.background.unwrap().error, None);
    world.line("thrower", "fixed").await;
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_script_past_its_memory_limit_crashes_alone() {
    let world = World::new();
    let steady = world.plugin(
        "steady",
        "let n = 0; setInterval(() => floti.badge.set(++n), 30);",
        "",
    );
    world.add(&steady);
    let hungry = world.plugin(
        "hungry",
        r#"
await floti.badge.set(7);
const kept = [];
setTimeout(() => { for (;;) kept.push(new Array(100000).fill(Math.random())); }, 10);
"#,
        "",
    );
    world.add(&hungry);
    let crashed = world
        .until("hungry", "crashed", |info| {
            state(info) == PluginBackgroundState::Crashed
        })
        .await;
    assert_eq!(
        crashed.background.unwrap().error.as_deref(),
        Some("it ran past its memory limit of 128 MB")
    );
    assert_eq!(crashed.badge, None);
    let badge = world.info("steady").badge.unwrap();
    world
        .until("steady", "still counting", |info| {
            info.badge.unwrap_or(0) > badge
        })
        .await;
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S7: an endless loop
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_script_in_an_endless_loop_is_ended_within_ten_seconds_and_the_host_serves_throughout() {
    let mut world = HostWorld::start().await;
    let steady = world.plugin(
        "steady",
        "let n = 0; setInterval(() => floti.badge.set(++n), 50);",
        "",
    );
    // Running first, then stuck in a timer; and stuck at its top level.
    let spinner = world.plugin(
        "spinner",
        "floti.badge.set(1); setTimeout(() => { for (;;) {} }, 50);",
        "",
    );
    let stuck = world.plugin("stuck", "for (;;) {}", "");
    world.add(&steady).await;
    world.add(&spinner).await;
    world.add(&stuck).await;
    let mut watcher = world.watcher().await;
    pushes_until(&mut watcher, "steady and spinner running", |listed| {
        state(by_id(listed, "steady")) == PluginBackgroundState::Running
            && state(by_id(listed, "spinner")) == PluginBackgroundState::Running
    })
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;

    // The host and the other plugins are served while two scripts spin.
    let listed = world.list().await;
    assert_eq!(
        state(by_id(&listed, "stuck")),
        PluginBackgroundState::Starting
    );
    let badge = by_id(&listed, "steady").badge.unwrap_or(0);
    pushes_until(&mut watcher, "steady still counting", |listed| {
        by_id(listed, "steady").badge.unwrap_or(0) > badge
    })
    .await;

    let began = Instant::now();
    let off = world.switch(&spinner, false).await;
    assert!(
        began.elapsed() < WAIT,
        "switching off took {:?}",
        began.elapsed()
    );
    assert_eq!(
        state(by_id(&off, "spinner")),
        PluginBackgroundState::Stopped
    );

    let began = Instant::now();
    let reloaded = world.reload(&stuck).await;
    assert!(
        began.elapsed() < WAIT,
        "reloading took {:?}",
        began.elapsed()
    );
    assert_eq!(
        state(by_id(&reloaded, "stuck")),
        PluginBackgroundState::Starting
    );

    world.switch(&spinner, true).await;
    pushes_until(&mut watcher, "spinner running again", |listed| {
        state(by_id(listed, "spinner")) == PluginBackgroundState::Running
    })
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(
        state(by_id(&world.list().await, "steady")),
        PluginBackgroundState::Running
    );

    drop(watcher);
    let took = world.stop_host().await;
    assert!(took < WAIT, "stopping the host took {took:?}");
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S8: calls in flight
// ---------------------------------------------------------------------------

const IN_FLIGHT: &str = r#"
globalThis.reads = (globalThis.reads ?? 0) + 1;
console.log("reads " + globalThis.reads);
await floti.status.set({ text: "waiting" });
await floti.badge.set(2);
floti.fetch("https://example.com/slow").then(
  () => console.log("fetch answered"),
  (error) => console.log("fetch failed " + error.name),
);
"#;

#[tokio::test(flavor = "multi_thread")]
async fn switching_off_reloading_removing_or_stopping_ends_the_calls_in_flight() {
    let world = World::new();
    let folder = world.plugin("flight", IN_FLIGHT, r#""network": ["https://example.com"]"#);
    let first = world.add(&folder).revision;
    world.fetched("started", 1).await;
    let painted = world
        .until("flight", "painted", |info| info.badge == Some(2))
        .await;
    assert_eq!(painted.status.unwrap().text, "waiting");

    // Off: the call ends, and what it painted is forgotten.
    let off = world.registry().set_enabled(&text(&folder), false).unwrap();
    world.fetched("ended", 1).await;
    let info = off
        .into_iter()
        .find(|plugin| plugin.id.as_deref() == Some("flight"))
        .unwrap();
    assert_eq!((info.status, info.badge), (None, None));
    assert!(!world.runtime.is_running("flight"));

    // On, then reloaded: a new isolate under a new revision, with nothing
    // of the old one.
    world.registry().set_enabled(&text(&folder), true).unwrap();
    world.fetched("started", 2).await;
    let before = world.info("flight").revision;
    world.registry().reload(&text(&folder)).unwrap();
    world.fetched("ended", 2).await;
    world.fetched("started", 3).await;
    let after = world.info("flight").revision;
    assert!(first < before && before < after);
    assert_eq!(
        world.fetches.lock().unwrap().last().map(String::as_str),
        Some(format!("started {after}").as_str())
    );
    assert_eq!(world.count("flight", "reads 1"), 3);
    assert_eq!(world.count("flight", "reads 2"), 0);

    // Removed: ended.
    world.registry().remove(&text(&folder), &[]).unwrap();
    world.fetched("ended", 3).await;
    assert!(!world.runtime.is_running("flight"));

    // And the host stopping ends another's.
    let other = world.plugin("other", IN_FLIGHT, r#""network": ["https://example.com"]"#);
    world.add(&other);
    world.fetched("started", 4).await;
    world.registry().shutdown();
    world.fetched("ended", 4).await;
    assert!(!world.runtime.is_running("other"));
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S9: arguments a method does not take, and methods that need a client
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_call_with_wrong_arguments_or_that_needs_a_client_rejects_with_a_code_and_a_reason() {
    let world = World::new();
    let folder = world.plugin(
        "asker",
        r#"
async function attempt(label, run) {
  try { await run(); console.log(`result ${label} resolved`); }
  catch (error) { console.log(`result ${label} ${error.code} ${error.message}`); }
}
await attempt("status.set", () => floti.status.set(5));
await attempt("badge.set", () => floti.badge.set("many"));
await attempt("cyclic", () => { const item = {}; item.item = item; return floti.status.set(item); });
await attempt("tabs.open", () => floti.tabs.open("main"));
await attempt("open", () => floti.open("https://example.com"));
await attempt("secrets.request", () => floti.secrets.request("token"));
await attempt("sessions.start", () => floti.sessions.start({ cwd: "C:/", prompt: "hi" }));
await attempt("sessions.list", () => floti.sessions.list());
try { floti.tools.handle("", () => 1); console.log("result handle registered"); }
catch (error) { console.log(`result handle ${error.code} ${error.message}`); }
setTimeout(() => console.log("still running"), 50);
"#,
        "",
    );
    world.add(&folder);
    world.line("asker", "still running").await;
    let results: Vec<String> = world
        .output("asker")
        .into_iter()
        .filter_map(|line| line.strip_prefix("result ").map(str::to_owned))
        .collect();
    let expected = [
        ("status.set", "invalid"),
        ("badge.set", "invalid"),
        ("cyclic", "invalid"),
        ("tabs.open", "unavailable"),
        ("open", "unavailable"),
        ("secrets.request", "unavailable"),
        ("sessions.start", "unavailable"),
        ("sessions.list", "unavailable"),
        ("handle", "invalid"),
    ];
    assert_eq!(results.len(), expected.len(), "{results:#?}");
    for (result, (label, code)) in results.iter().zip(expected) {
        let reason = result
            .strip_prefix(&format!("{label} {code} "))
            .unwrap_or_else(|| panic!("{label} rejected as {code}: {result}"));
        assert!(reason.len() > 10, "{label} says why: {result}");
    }
    assert!(results[3].contains("needs a client"), "{}", results[3]);
    assert_eq!(state(&world.info("asker")), PluginBackgroundState::Running);
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S10: status and badge
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn status_and_badge_reach_every_client_in_one_push_and_are_held_to_their_shapes() {
    let mut world = HostWorld::start().await;
    let folder = world.plugin(
        "painter",
        r#"
async function attempt(label, run) {
  try { await run(); console.log(`result ${label} resolved`); }
  catch (error) { console.log(`result ${label} ${error.code}`); }
}
floti.on("command", async ({ id }) => {
  if (id === "paint") { floti.status.set({ text: "3 new", tone: "accent", tooltip: "Cards" }); floti.badge.set(3); }
  if (id === "zero") await floti.badge.set(0);
  if (id === "huge") await floti.badge.set(123456);
  if (id === "null") await floti.badge.set(null);
});
"#,
        r#""commands": [{ "id": "paint", "title": "Paint" }, { "id": "zero", "title": "Zero" },
           { "id": "huge", "title": "Huge" }, { "id": "null", "title": "Null" }]"#,
    );
    // Subscribed before the plugin is added, so the push that shows it
    // running comes after each subscription's snapshot.
    let mut watcher = world.watcher().await;
    let mut second = world.watcher().await;
    world.add(&folder).await;
    pushes_until(&mut watcher, "painter running", |listed| {
        state(by_id(listed, "painter")) == PluginBackgroundState::Running
    })
    .await;
    pushes_until(&mut second, "painter running", |listed| {
        state(by_id(listed, "painter")) == PluginBackgroundState::Running
    })
    .await;

    let command = |id: &'static str| floti_protocol::channels::plugins::PluginCommandRequest {
        plugin: "painter".into(),
        id: id.into(),
    };
    world
        .client()
        .request::<floti_protocol::channels::plugins::PluginsCommand>(&command("paint"))
        .await
        .unwrap();
    let painted = |listed: &[PluginInfo]| {
        by_id(listed, "painter").status.is_some() || by_id(listed, "painter").badge.is_some()
    };
    for client in [&mut watcher, &mut second] {
        let pushes = pushes_until(client, "the status or the badge", painted).await;
        let shown = by_id(pushes.last().unwrap(), "painter");
        assert_eq!(
            shown.status,
            Some(PluginStatusItem {
                text: "3 new".into(),
                tone: Some(PluginStatusTone::Accent),
                tooltip: Some("Cards".into()),
            })
        );
        assert_eq!(
            shown.badge,
            Some(3),
            "the item and the count arrive in one push"
        );
    }

    for (id, expected) in [
        ("huge", Some(99_999)),
        ("zero", None),
        ("huge", Some(99_999)),
        ("null", None),
    ] {
        world
            .client()
            .request::<floti_protocol::channels::plugins::PluginsCommand>(&command(id))
            .await
            .unwrap();
        pushes_until(&mut watcher, &format!("the badge after {id}"), |listed| {
            by_id(listed, "painter").badge == expected
        })
        .await;
    }
    drop((watcher, second));
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_malformed_status_item_or_badge_is_refused_as_invalid() {
    let world = World::new();
    let folder = world.plugin(
        "shapes",
        r#"
const tries = [
  ["empty text", () => floti.status.set({ text: "  " })],
  ["long text", () => floti.status.set({ text: "x".repeat(81) })],
  ["loud tone", () => floti.status.set({ text: "ok", tone: "loud" })],
  ["long tooltip", () => floti.status.set({ text: "ok", tooltip: "t".repeat(301) })],
  ["negative", () => floti.badge.set(-1)],
  ["fraction", () => floti.badge.set(1.5)],
  ["text count", () => floti.badge.set("3")],
];
const out = [];
for (const [label, run] of tries) {
  try { await run(); out.push(label + " resolved"); } catch (error) { out.push(label + " " + error.code); }
}
console.log("shapes " + out.join(", "));
"#,
        "",
    );
    world.add(&folder);
    assert_eq!(
        world.line("shapes", "shapes ").await,
        "shapes empty text invalid, long text invalid, loud tone invalid, long tooltip invalid, \
         negative invalid, fraction invalid, text count invalid"
    );
    let info = world.info("shapes");
    assert_eq!((info.status, info.badge), (None, None));
    world.stop().await;
}

// ---------------------------------------------------------------------------
// S11: tools for sessions
// ---------------------------------------------------------------------------

const TOOLS: &str = r#""agent": { "instructions": "Cards are on the board.", "tools": {
  "echo": { "description": "Echoes." }, "text": { "description": "Text." },
  "nothing": { "description": "Nothing." }, "object": { "description": "An object." },
  "fails": { "description": "Fails." }, "big": { "description": "Too much." },
  "slow": { "description": "Slow." }, "late": { "description": "Registered late." },
  "never": { "description": "Never registered." } } }"#;

const TOOL_SCRIPT: &str = r#"
floti.tools.handle("echo", (args, call) => JSON.stringify({
  args, session: call.session, signal: call.signal instanceof AbortSignal, aborted: call.signal.aborted }));
floti.tools.handle("text", () => "plain text");
floti.tools.handle("nothing", () => undefined);
floti.tools.handle("object", async () => ({ cards: [1, 2] }));
floti.tools.handle("fails", () => { throw new Error("The board is locked."); });
floti.tools.handle("big", () => "x".repeat(1000001));
floti.tools.handle("slow", (_args, call) => new Promise((resolve) => {
  console.log("slow started");
  call.signal.addEventListener("abort", () => { console.log("slow aborted"); resolve("too late"); });
}));
setTimeout(() => floti.tools.handle("late", () => "registered late"), 500);
"#;

#[tokio::test(flavor = "multi_thread")]
async fn a_tool_call_reaches_the_handler_with_the_session_and_is_answered_as_tools_ts_answers() {
    let world = World::new();
    let folder = world.plugin("cards", TOOL_SCRIPT, TOOLS);
    world.add(&folder);

    // Called while the script is starting, before "late" is registered: it
    // waits for both.
    assert_eq!(
        world
            .call_tool("cards", "late", serde_json::json!({}))
            .await,
        Ok(serde_json::json!("registered late"))
    );

    let echoed = world
        .call_tool(
            "cards",
            "echo",
            serde_json::json!({ "all": true, "title": "One" }),
        )
        .await
        .unwrap();
    let echoed: serde_json::Value = serde_json::from_str(echoed.as_str().unwrap()).unwrap();
    assert_eq!(
        echoed,
        serde_json::json!({
            "args": { "all": true, "title": "One" },
            "session": { "id": "a1b2c3", "name": "alpha", "cwd": "C:/work/alpha" },
            "signal": true,
            "aborted": false,
        })
    );
    assert_eq!(
        world
            .call_tool("cards", "text", serde_json::json!({}))
            .await,
        Ok("plain text".into())
    );
    assert_eq!(
        world
            .call_tool("cards", "nothing", serde_json::json!({}))
            .await,
        Ok("Done.".into())
    );
    assert_eq!(
        world
            .call_tool("cards", "object", serde_json::json!({}))
            .await,
        Ok("{\n  \"cards\": [\n    1,\n    2\n  ]\n}".into())
    );
    assert_eq!(
        world
            .call_tool("cards", "fails", serde_json::json!({}))
            .await,
        Err("The board is locked.".into())
    );
    let big = world
        .call_tool("cards", "big", serde_json::json!({}))
        .await
        .unwrap_err();
    assert!(big.contains("1000000"), "{big}");

    // A tool the manifest does not declare never reaches the script.
    assert_eq!(
        world.call_tool("cards", "remove_card", serde_json::json!({})).await,
        Err("Cards has no tool called \"remove_card\". It has: echo, text, nothing, object, fails, big, slow, late, never.".into())
    );
    assert!(
        !world
            .runtime
            .log("cards")
            .iter()
            .any(|line| line.text.contains("remove_card")),
        "{:#?}",
        world.runtime.log("cards")
    );
    assert!(
        world
            .runtime
            .log("cards")
            .iter()
            .any(|line| line.stream == PluginLogStream::Host
                && line.text == "echo called by session \"alpha\"")
    );
    assert!(
        world
            .call_tool("nobody", "echo", serde_json::json!({}))
            .await
            .is_err()
    );
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tool_call_waits_for_a_starting_script_and_for_its_handler_then_says_why_not() {
    let world = World::new();
    world.runtime.set_tool_wait(Duration::from_millis(1500));
    let folder = world.plugin(
        "slowstart",
        r#"
await new Promise((resolve) => setTimeout(resolve, 600));
floti.tools.handle("echo", () => "up");
"#,
        r#""agent": { "tools": { "echo": { "description": "Echoes." }, "never": { "description": "Never." } } }"#,
    );
    world.add(&folder);
    assert_eq!(
        state(&world.info("slowstart")),
        PluginBackgroundState::Starting
    );
    assert_eq!(
        world
            .call_tool("slowstart", "echo", serde_json::json!({}))
            .await,
        Ok("up".into())
    );

    let began = Instant::now();
    let missing = world
        .call_tool("slowstart", "never", serde_json::json!({}))
        .await
        .unwrap_err();
    assert!(
        began.elapsed() >= Duration::from_millis(1400),
        "{:?}",
        began.elapsed()
    );
    assert!(missing.contains("has no handler for never"), "{missing}");

    // A script that never finishes starting is waited for, then given up on.
    let stuck = world.plugin(
        "stuckstart",
        "await new Promise(() => {});",
        r#""agent": { "tools": { "echo": { "description": "Echoes." } } }"#,
    );
    world.add(&stuck);
    let failed = world
        .call_tool("stuckstart", "echo", serde_json::json!({}))
        .await
        .unwrap_err();
    assert!(failed.contains("did not start within"), "{failed}");

    // A crashed one says so.
    let crashing = world.plugin(
        "crashing",
        "throw new Error('it threw on start');",
        r#""agent": { "tools": { "echo": { "description": "Echoes." } } }"#,
    );
    world.add(&crashing);
    let crashed = world
        .call_tool("crashing", "echo", serde_json::json!({}))
        .await
        .unwrap_err();
    assert!(crashed.contains("it threw on start"), "{crashed}");
    assert!(crashed.contains("Reloading the plugin"), "{crashed}");
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_a_tool_call_aborts_the_handlers_signal_and_stopping_the_plugin_ends_it() {
    let world = World::new();
    let folder = world.plugin("cards", TOOL_SCRIPT, TOOLS);
    world.add(&folder);
    world.running("cards").await;

    let cancel = CancelToken::new();
    let registry = world.registry().clone();
    let call = tokio::spawn({
        let cancel = cancel.clone();
        async move {
            registry
                .call_tool(tool_call("cards", "slow", serde_json::json!({})), cancel)
                .await
        }
    });
    world.line("cards", "slow started").await;
    cancel.cancel();
    assert_eq!(call.await.unwrap(), Err("The call was cancelled.".into()));
    world.line("cards", "slow aborted").await;

    // A call in flight when the plugin is switched off is answered.
    let registry = world.registry().clone();
    let call = tokio::spawn(async move {
        registry
            .call_tool(
                tool_call("cards", "slow", serde_json::json!({})),
                CancelToken::new(),
            )
            .await
    });
    let deadline = Instant::now() + WAIT;
    while world.count("cards", "slow started") < 2 {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    world.registry().set_enabled(&text(&folder), false).unwrap();
    assert_eq!(
        tokio::time::timeout(WAIT, call).await.unwrap().unwrap(),
        Err("The plugin stopped before it answered.".into())
    );
    assert_eq!(
        world
            .call_tool("cards", "echo", serde_json::json!({}))
            .await,
        Err("The plugin is not offering tools any more: it was turned off or removed.".into())
    );

    world.registry().shutdown();
    assert_eq!(
        world
            .call_tool("cards", "echo", serde_json::json!({}))
            .await,
        Err("The host is shutting down.".into())
    );
    world.stop().await;
}

// ---------------------------------------------------------------------------
// Events and the log
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn console_writes_to_the_plugins_log_lines_and_events_reach_floti_on() {
    let world = World::new();
    let folder = world.plugin(
        "talker",
        r#"
console.log("hello %s", "there", { n: 1 });
console.warn("careful");
console.error("broken");
floti.on("command", ({ id }) => console.log("command " + id));
floti.on("settings", (values) => console.log("settings " + JSON.stringify(values)));
const off = floti.on("command", () => console.log("unsubscribed heard"));
off();
floti.on("command", () => { throw new Error("a listener's bug"); });
floti.on("command", () => console.log("after the bug"));
"#,
        r#""commands": [{ "id": "refresh", "title": "Refresh" }],
           "settings": [{ "type": "number", "key": "limit", "label": "Limit", "default": 5 }]"#,
    );
    world.add(&folder);
    world.running("talker").await;
    world.registry().command("talker", "refresh").unwrap();
    assert_eq!(world.line("talker", "command ").await, "command refresh");
    world.line("talker", "after the bug").await;
    assert_eq!(world.count("talker", "unsubscribed heard"), 0);
    assert!(world.registry().command("talker", "undeclared").is_err());
    world
        .registry()
        .set_setting(
            "talker",
            "limit",
            &floti_protocol::channels::plugins::PluginSettingValue::Number(7.0),
        )
        .unwrap();
    assert_eq!(
        world.line("talker", "settings ").await,
        r#"settings {"limit":7}"#
    );

    let log = world.runtime.log("talker");
    let of = |stream: PluginLogStream| -> Vec<String> {
        log.iter()
            .filter(|line| line.stream == stream)
            .map(|line| line.text.clone())
            .collect()
    };
    assert_eq!(of(PluginLogStream::Out)[0], "hello there { n: 1 }");
    let errors = of(PluginLogStream::Err);
    assert_eq!(&errors[..2], ["careful", "broken"]);
    assert!(
        errors.iter().any(|line| line.contains("a listener's bug")),
        "{errors:#?}"
    );
    assert!(of(PluginLogStream::Host).contains(&"background script started".to_owned()));
    assert!(log.iter().all(|line| line.at.ends_with('Z')));
    world.stop().await;
}
