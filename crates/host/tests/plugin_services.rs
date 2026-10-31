//! Plugin services on the host, run for real: a Node script in a plugin
//! folder (with spaces in its path), started on the Node it was handed, as
//! the packaged host is handed the Node it ships. The tests hand it the Node
//! that runs them, found on `PATH`, and download nothing.
//!
//! Each test builds a registry over a store of its own with `floti.fetch` on
//! the real services, and calls it as a background script's call arrives.
//! The service script exits once the test process is gone (`watchOwner` in
//! `test/fake-agents/common.mjs`, copied beside it), so a test that crashed
//! leaves no Node running; one that finishes ends it through the registry.

use std::collections::BTreeSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use floti_host::platform::process_tree::{self, ProcessTree};
use floti_host::plugins::background::NoBackground;
use floti_host::plugins::call::CallOrigin;
use floti_host::plugins::call::{
    CancelToken, FetchRedirect, PluginCallError, PluginFetchRequest, PluginFetchResponse,
};
use floti_host::plugins::net::{Net, register_methods};
use floti_host::plugins::secrets::NoSecrets;
use floti_host::plugins::services::launcher::ProcessLauncher;
use floti_host::plugins::services::{ProcessServices, ServicesConfig};
use floti_host::plugins::{PluginCall, Registry, RegistryParts};
use floti_host::store::Store;
use floti_host::testkit::{PATIENCE, TestDirs};
use floti_protocol::channels::plugins::{
    PluginErrorCode, PluginServiceInfo, PluginServiceState, PluginSurfaceKind,
};
use floti_protocol::{Knowable, Payload};
use serde_json::{Value, json};

/// The shared owner watch every fake uses, put beside each service script.
const COMMON: &str = include_str!("../../../test/fake-agents/common.mjs");

/// A service as plugin authors write one: HTTP on the port it is told,
/// answering only requests carrying its token. It records each start in
/// `runs.txt`, starts a child of its own, and reports what it was given.
/// With `SILENT` set it never listens.
const SERVICE: &str = r"
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { childScript, watchOwner } from './common.mjs'

const here = process.cwd()
appendFileSync('runs.txt', `${process.pid}\n`)
watchOwner(here, () => process.exit(0))
const child = spawn(process.execPath, ['-e', childScript(here)], { stdio: 'ignore' })
const token = process.env.HELM_SERVICE_TOKEN
if (process.env.SILENT === '1') {
  setInterval(() => {}, 1 << 30)
} else {
  createServer((request, response) => {
    if (request.headers['helm-service-token'] !== token) {
      response.writeHead(403)
      response.end('wrong token')
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      pid: process.pid,
      child: child.pid,
      plugin: process.env.HELM_PLUGIN_ID,
      port: Number(process.env.HELM_SERVICE_PORT),
      token,
      greeting: process.env.GREETING ?? null,
      cwd: process.cwd(),
      url: request.url,
      hostOwn: Object.keys(process.env).filter((name) => /^(FLOTI_|ELECTRON_|CLAUDE)/i.test(name)),
    }))
  }).listen(Number(process.env.HELM_SERVICE_PORT), '127.0.0.1')
}
";

/// The Node running these tests: the first `node` on `PATH`.
fn node_on_path() -> PathBuf {
    let path = std::env::var_os("PATH").expect("PATH is set");
    std::env::split_paths(&path)
        .flat_map(|dir| [dir.join("node.exe"), dir.join("node")])
        .find(|candidate| candidate.is_file())
        .expect("the tests run with Node on PATH")
}

struct World {
    registry: Registry,
    logs: Arc<Mutex<Vec<String>>>,
    store: Arc<Mutex<Store>>,
    /// Last: the store is closed and the services ended before it goes.
    dirs: TestDirs,
}

impl World {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let store = Arc::new(Mutex::new(Store::open(&dirs.data).unwrap()));
        let logs = Arc::new(Mutex::new(Vec::new()));
        let services = Arc::new(ProcessServices::new(ServicesConfig {
            node: Some(node_on_path()),
            secrets: Arc::new(NoSecrets),
            launcher: Arc::new(ProcessLauncher),
            // The host's own variables, as a host started by the app has
            // them: none reaches a service.
            inherited: Arc::new(|| {
                std::env::vars_os()
                    .chain([
                        (OsString::from("FLOTI_DATA_DIR"), OsString::from("/data")),
                        (OsString::from("CLAUDECODE"), OsString::from("1")),
                        (OsString::from("ELECTRON_RUN_AS_NODE"), OsString::from("1")),
                    ])
                    .collect()
            }),
            log: {
                let logs = Arc::clone(&logs);
                Arc::new(move |plugin, _stream, line| {
                    logs.lock().unwrap().push(format!("{plugin}: {line}"));
                })
            },
        }));
        let registry = Registry::new(RegistryParts {
            store: Arc::clone(&store),
            background: Arc::new(NoBackground),
            secrets: Arc::new(NoSecrets),
            services: Arc::clone(&services) as _,
            logs: Default::default(),
            publish: Box::new(|_| ()),
            deliver: Box::new(|_| ()),
        });
        register_methods(
            registry.methods(),
            Arc::new(Net::new(Arc::new(NoSecrets), services)),
        );
        registry.start().unwrap();
        Self {
            registry,
            logs,
            store,
            dirs,
        }
    }

    /// A plugin `id` whose service is `service`, registered; its folder.
    fn plugin(&self, id: &str, service: Value) -> PathBuf {
        let manifest = json!({
            "apiVersion": 2,
            "id": id,
            "name": id,
            "service": service,
        });
        let folder = self.dirs.plugin_folder(
            &format!("plugin {id}"),
            &manifest.to_string(),
            &[("service.mjs", SERVICE), ("common.mjs", COMMON)],
        );
        self.registry.add(&text(&folder)).unwrap();
        folder
    }

    fn service(&self, id: &str) -> PluginServiceInfo {
        self.registry
            .list()
            .into_iter()
            .find(|plugin| plugin.id.as_deref() == Some(id))
            .and_then(|plugin| plugin.service)
            .expect("the plugin declares a service")
    }

    fn call(
        &self,
        plugin: &str,
        path: &str,
    ) -> tokio::task::JoinHandle<Result<PluginFetchResponse, PluginCallError>> {
        let registry = self.registry.clone();
        let call = PluginCall {
            plugin: plugin.to_owned(),
            surface: PluginSurfaceKind::Background,
            origin: CallOrigin::Host,
            method: "fetch".into(),
            args: vec![
                Payload::serialized(&PluginFetchRequest {
                    url: format!("service:{path}"),
                    method: "GET".into(),
                    headers: Vec::new(),
                    body: None,
                    redirect: FetchRedirect::Follow,
                })
                .unwrap(),
            ],
            cancel: CancelToken::new(),
        };
        tokio::spawn(async move {
            registry
                .call(call)
                .await
                .map(|answer| answer.deserialized::<PluginFetchResponse>().unwrap())
        })
    }

    /// What the service said about itself, answering `path`.
    async fn fetch(&self, plugin: &str, path: &str) -> Value {
        let response = self.call(plugin, path).await.unwrap().unwrap();
        assert_eq!(
            response.status,
            200,
            "{}",
            String::from_utf8_lossy(&response.body)
        );
        serde_json::from_slice(&response.body).unwrap()
    }

    /// Waits, for at most [`PATIENCE`], until the plugin list shows `id`'s
    /// service as `done` says.
    async fn until(&self, id: &str, what: &str, done: impl Fn(&PluginServiceInfo) -> bool) {
        let deadline = tokio::time::Instant::now() + PATIENCE;
        loop {
            let now = self.service(id);
            if done(&now) {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "{id}'s service never {what}: {now:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Stops every plugin, ending its service, and closes the store. The
    /// folders are handed back, for the test to drop once it has seen what
    /// the services started end: a process still exiting may hold its folder.
    fn stop(self) -> TestDirs {
        let Self {
            registry,
            store,
            dirs,
            ..
        } = self;
        registry.shutdown();
        drop(registry);
        let store = Arc::try_unwrap(store)
            .unwrap_or_else(|_| panic!("nothing else holds the store"))
            .into_inner()
            .unwrap();
        store.close().unwrap();
        dirs
    }
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The pids each start of the service in `folder` recorded.
fn runs(folder: &Path) -> Vec<u32> {
    std::fs::read_to_string(folder.join("runs.txt"))
        .unwrap_or_default()
        .lines()
        .map(|line| line.trim().parse().unwrap())
        .collect()
}

fn pid(said: &Value, field: &str) -> u32 {
    u32::try_from(said[field].as_u64().expect("a pid")).unwrap()
}

/// Waits, for at most [`PATIENCE`], until none of `pids` is running.
async fn all_ended(pids: &[u32]) {
    let deadline = tokio::time::Instant::now() + PATIENCE;
    loop {
        let running: Vec<u32> = pids
            .iter()
            .copied()
            .filter(|pid| process_tree::Native.is_alive(*pid) != Knowable::Known(false))
            .collect();
        if running.is_empty() {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "still running after {PATIENCE:?}: {running:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn node_service() -> Value {
    json!({ "node": "service.mjs", "args": ["--from", "a test"], "env": { "GREETING": "hello" } })
}

#[tokio::test(flavor = "multi_thread")]
async fn s1_s2_a_node_service_starts_only_on_the_first_fetch_on_the_node_it_was_given() {
    let world = World::new();
    let folder = world.plugin("board", node_service());

    // Nothing has fetched from it: no Node runs for it.
    let before = world.service("board");
    assert_eq!(before.state, PluginServiceState::Stopped);
    assert_eq!((before.pid, before.port), (None, None));
    assert!(runs(&folder).is_empty());

    let said = world.fetch("board", "/items?x=1").await;
    let service = pid(&said, "pid");
    assert_eq!(runs(&folder), vec![service]);
    assert_eq!(said["plugin"], "board");
    assert_eq!(said["greeting"], "hello");
    assert_eq!(said["url"], "/items?x=1");
    assert_eq!(said["hostOwn"], json!([]));
    assert_eq!(said["token"].as_str().unwrap().len(), 64);
    assert_eq!(
        std::fs::canonicalize(said["cwd"].as_str().unwrap()).unwrap(),
        std::fs::canonicalize(&folder).unwrap()
    );
    let shown = world.service("board");
    assert_eq!(shown.state, PluginServiceState::Running);
    assert_eq!(shown.pid, Some(service));
    assert_eq!(shown.port.map(u64::from), said["port"].as_u64());

    // The second fetch reaches the same run.
    let again = world.fetch("board", "/again").await;
    assert_eq!(pid(&again, "pid"), service);
    assert_eq!(again["token"], said["token"]);
    assert_eq!(runs(&folder), vec![service]);

    let _dirs = world.stop();
    all_ended(&[service, pid(&said, "child")]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s3_an_enable_service_starts_when_the_plugin_is_read_with_no_fetch() {
    let world = World::new();
    let folder = world.plugin("eager", json!({ "node": "service.mjs", "start": "enable" }));
    world
        .until("eager", "ran", |now| {
            now.state == PluginServiceState::Running && now.pid.is_some()
        })
        .await;
    let shown = world.service("eager");
    assert_eq!(runs(&folder), vec![shown.pid.unwrap()]);
    assert!(shown.port.is_some());

    let _dirs = world.stop();
    all_ended(&runs(&folder)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s4_switching_off_reloading_removing_and_stopping_each_end_the_service_and_its_child() {
    let world = World::new();
    let mut folders = Vec::new();
    for id in ["off", "reloaded", "removed", "stopped"] {
        folders.push(world.plugin(id, node_service()));
    }
    let mut trees = Vec::new();
    for id in ["off", "reloaded", "removed", "stopped"] {
        let said = world.fetch(id, "/").await;
        trees.push(vec![pid(&said, "pid"), pid(&said, "child")]);
    }

    world
        .registry
        .set_enabled(&text(&folders[0]), false)
        .unwrap();
    all_ended(&trees[0]).await;
    assert_eq!(world.service("off").state, PluginServiceState::Stopped);

    world.registry.reload(&text(&folders[1])).unwrap();
    all_ended(&trees[1]).await;
    let reread = world.service("reloaded");
    assert_eq!(
        (reread.state, reread.pid, reread.restarts),
        (PluginServiceState::Stopped, None, 0)
    );

    world.registry.remove(&text(&folders[2]), &[]).unwrap();
    all_ended(&trees[2]).await;

    let _dirs = world.stop();
    all_ended(&trees[3]).await;
    // Each ran once, and none was started again.
    for folder in &folders {
        assert_eq!(runs(folder).len(), 1);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn s4_a_fetch_waiting_for_a_service_that_is_switched_off_is_refused_as_unavailable() {
    let world = World::new();
    let folder = world.plugin(
        "silent",
        json!({ "node": "service.mjs", "env": { "SILENT": "1" } }),
    );
    let waiting = world.call("silent", "/");
    world
        .until("silent", "started", |now| now.pid.is_some())
        .await;
    world.registry.set_enabled(&text(&folder), false).unwrap();
    let refused = waiting.await.unwrap().unwrap_err();
    assert_eq!(refused.code, PluginErrorCode::Unavailable, "{refused:?}");
    all_ended(&runs(&folder)).await;
    let _dirs = world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn s6_the_token_is_in_no_log_line_and_not_in_the_plugin_list() {
    let world = World::new();
    world.plugin("board", node_service());
    let said = world.fetch("board", "/").await;
    let token = said["token"].as_str().unwrap().to_owned();
    let listed = format!("{:?}", world.registry.list());
    let sent = serde_json::to_string(&world.registry.list()).unwrap();
    let logs = Arc::clone(&world.logs);
    let _dirs = world.stop();
    let logs = logs.lock().unwrap().clone();
    for line in &logs {
        assert!(!line.contains(&token), "the token is in {line}");
    }
    assert!(
        logs.iter()
            .any(|line| line.contains("started service.mjs, listening on 127.0.0.1:")),
        "{logs:?}"
    );
    assert!(logs.iter().any(|line| line == "board: stopped"), "{logs:?}");
    assert!(!listed.contains(&token));
    assert!(!sent.contains(&token));
    all_ended(&[pid(&said, "pid"), pid(&said, "child")]).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn s8_a_command_service_runs_its_program_under_the_same_port_token_and_stop_rules() {
    let world = World::new();
    let node = text(&node_on_path());
    let folder = world.plugin(
        "program",
        json!({ "command": node, "args": ["service.mjs"], "env": { "GREETING": "from a program" } }),
    );
    assert!(runs(&folder).is_empty());
    let said = world.fetch("program", "/").await;
    assert_eq!(said["greeting"], "from a program");
    assert_eq!(said["plugin"], "program");
    assert_eq!(said["token"].as_str().unwrap().len(), 64);
    let tree = [pid(&said, "pid"), pid(&said, "child")];
    world.registry.set_enabled(&text(&folder), false).unwrap();
    all_ended(&tree).await;
    let ran: BTreeSet<u32> = runs(&folder).into_iter().collect();
    assert_eq!(ran, BTreeSet::from([tree[0]]));
    let _dirs = world.stop();
}
