//! Registered plugin folders and their settings, as today's
//! `desktop/main/plugins/host.test.ts` (reading, switching and removing) and
//! `core/store/plugins.test.ts` test them, with the same inputs and
//! expectations where today has them. The channels and `plugins:changed`
//! are tested as a client sees them: through client connections to a
//! running host, over a test's own `floti.db`. The bridge methods the
//! registry answers itself, and what a read starts, are tested against the
//! registry, since no channel carries a bridge call yet.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use floti_host::platform::socket::Endpoint;
use floti_host::plugins::background::{
    BackgroundEvent, BackgroundLaunch, BackgroundRuntime, NoBackground, ToolCall, ToolFuture,
};
use floti_host::plugins::call::{CancelToken, PluginCallError};
use floti_host::plugins::secrets::NoSecrets;
use floti_host::plugins::store as plugin_store;
use floti_host::plugins::{PluginCall, Registry, RegistryParts};
use floti_host::server::{HostConfig, HostRun, backends};
use floti_host::store::Store;
use floti_host::testkit::{PATIENCE, RunningHost, TestClient, TestDirs};
use floti_protocol::channel::{EventChannel, from_payload};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::plugins::{
    PluginAddRequest, PluginAddResult, PluginBackgroundState, PluginCommandRequest,
    PluginErrorCode, PluginInfo, PluginPathRequest, PluginRemoveRequest, PluginSetSettingRequest,
    PluginSettingValue, PluginStatusItem, PluginStatusTone, PluginSurfaceKind, PluginSwitchRequest,
    PluginsAdd, PluginsChanged, PluginsCommand, PluginsList, PluginsOwnSecrets, PluginsReload,
    PluginsRemove, PluginsSetEnabled, PluginsSetSetting,
};
use floti_protocol::channels::workspace::AppMode;
use floti_protocol::{Message, Payload};

/// A version 2 manifest for `id`, with `extra` fields (`"key": value, ...`).
fn manifest(id: &str, name: &str, extra: &str) -> String {
    let extra = if extra.is_empty() {
        String::new()
    } else {
        format!(", {extra}")
    };
    format!(r#"{{ "apiVersion": 2, "id": "{id}", "name": "{name}"{extra} }}"#)
}

/// The settings host.test.ts's factory plugin declares, and a secret.
const FACTORY_SETTINGS: &str = r#""secrets": ["factory.token"], "settings": [
    { "type": "text", "key": "baseUrl", "label": "Base URL", "default": "https://factory.example" },
    { "type": "number", "key": "interval", "label": "Interval", "default": 30, "min": 5, "max": 600 },
    { "type": "toggle", "key": "live", "label": "Live updates" },
    { "type": "select", "key": "mode", "label": "Mode", "default": "fast",
      "options": [{ "value": "fast", "label": "Fast" }, { "value": "slow", "label": "Slow" }] },
    { "type": "secret", "key": "token", "label": "Token", "secret": "factory.token" }
]"#;

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn values(pairs: &[(&str, PluginSettingValue)]) -> BTreeMap<String, PluginSettingValue> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

const PLUGINS_CHANGED: u64 = 1;

/// A host over a test's folders, with a client connected to it.
struct HostWorld {
    host: Option<RunningHost>,
    client: Option<TestClient>,
    endpoint: Endpoint,
    /// Last: fields drop in order, and the folder goes only once the host
    /// has let go of its store.
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
        Self::start_in(TestDirs::new()).await
    }

    /// A host over `dirs`, which a test may have put a store in first.
    async fn start_in(dirs: TestDirs) -> Self {
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
        self.client
            .as_mut()
            .expect("a world has its client until it stops")
    }

    /// Stops the host, letting go of the store.
    async fn stop_host(&mut self) {
        self.client = None;
        if let Some(host) = self.host.take() {
            host.stop(HostStopReason::Stop).await;
        }
    }

    /// Stops the host and starts another over the same folders.
    async fn restart(&mut self) {
        self.stop_host().await;
        self.host = Some(start_host(&self.dirs, &self.endpoint));
        self.client = Some(TestClient::connect(&self.endpoint, &[]).await);
    }

    async fn stop(mut self) {
        self.stop_host().await;
    }

    /// The store the stopped host left, opened for a look.
    fn store(&self) -> Store {
        assert!(
            self.host.is_none(),
            "look at the store once the host has stopped"
        );
        Store::open(&self.dirs.data).unwrap()
    }

    async fn add(&mut self, path: &Path) -> PluginAddResult {
        self.add_text(&text(path)).await
    }

    async fn add_text(&mut self, path: &str) -> PluginAddResult {
        self.client()
            .request::<PluginsAdd>(&PluginAddRequest { path: path.into() })
            .await
            .unwrap()
    }

    async fn list(&mut self) -> Vec<PluginInfo> {
        self.client().request::<PluginsList>(&()).await.unwrap()
    }

    async fn switch(&mut self, path: &Path, enabled: bool) -> Vec<PluginInfo> {
        self.client()
            .request::<PluginsSetEnabled>(&PluginSwitchRequest {
                path: text(path),
                enabled,
            })
            .await
            .unwrap()
    }

    async fn reload(&mut self, path: &Path) -> Vec<PluginInfo> {
        self.client()
            .request::<PluginsReload>(&PluginPathRequest { path: text(path) })
            .await
            .unwrap()
    }

    async fn remove(&mut self, path: &Path, delete_secrets: &[&str]) -> Vec<PluginInfo> {
        self.client()
            .request::<PluginsRemove>(&PluginRemoveRequest {
                path: text(path),
                delete_secrets: delete_secrets.iter().map(|key| (*key).to_owned()).collect(),
            })
            .await
            .unwrap()
    }

    async fn set_setting(
        &mut self,
        plugin: &str,
        key: &str,
        value: PluginSettingValue,
    ) -> Result<Vec<PluginInfo>, String> {
        self.client()
            .request::<PluginsSetSetting>(&PluginSetSettingRequest {
                plugin: plugin.into(),
                key: key.into(),
                value,
            })
            .await
            .map_err(|error| error.message)
    }

    /// Another client, subscribed to `plugins:changed`, and the list it
    /// started with.
    async fn watcher(&self) -> (TestClient, Vec<PluginInfo>) {
        let mut client = TestClient::connect(&self.endpoint, &[]).await;
        match client
            .subscribe_on(PLUGINS_CHANGED, PluginsChanged::NAME)
            .await
        {
            Message::Snapshot(snapshot) => {
                let listed = from_payload(&snapshot.state).unwrap();
                (client, listed)
            }
            other => panic!("plugins:changed starts with its state, not {other:?}"),
        }
    }
}

/// The next list published on `plugins:changed`.
async fn next_list(client: &mut TestClient) -> Vec<PluginInfo> {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match client.next(left).await {
            Some(Message::Event(event)) if event.subscription == PLUGINS_CHANGED => {
                return from_payload(&event.payload).unwrap();
            }
            Some(_) => {}
            None => panic!("no plugins:changed event within {PATIENCE:?}"),
        }
    }
}

fn only(listed: &[PluginInfo]) -> &PluginInfo {
    assert_eq!(listed.len(), 1, "{listed:#?}");
    &listed[0]
}

fn paths(listed: &[PluginInfo]) -> Vec<(String, bool)> {
    listed
        .iter()
        .map(|plugin| (plugin.path.clone(), plugin.enabled))
        .collect()
}

// Reading folders

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_with_no_manifest_is_refused_with_a_sentence_and_not_registered() {
    let mut world = HostWorld::start().await;
    let empty = world.dirs.folder("no manifest here");
    let refused = world.add(&empty).await;
    assert_eq!(
        refused.error.as_deref(),
        Some(
            format!(
                "There is no helm-plugin.json in {}. Choose the folder that holds the plugin's manifest.",
                text(&empty)
            )
            .as_str()
        )
    );
    assert!(refused.plugins.is_empty());

    assert_eq!(
        world.add_text("relative/plugin").await.error.as_deref(),
        Some("Choose a folder.")
    );
    let gone = world.dirs.root().join("not made");
    assert_eq!(
        world.add(&gone).await.error,
        Some(format!("{} is not a folder.", text(&gone)))
    );
    assert!(world.list().await.is_empty());

    world.restart().await;
    assert!(world.list().await.is_empty(), "nothing refused was kept");
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_wrong_manifest_is_registered_and_listed_with_what_is_wrong_and_runs_nothing() {
    let mut world = HostWorld::start().await;
    let broken = world
        .dirs
        .plugin_folder("broken json", "{ \"apiVersion\": 2,", &[]);
    let invalid =
        world
            .dirs
            .plugin_folder("invalid", &manifest("NOT VALID", "Bad Plugin", ""), &[]);
    let unbuilt = world.dirs.plugin_folder(
        "unbuilt",
        &manifest(
            "unbuilt",
            "Unbuilt",
            r#""background": "dist/background.js""#,
        ),
        &[],
    );
    for folder in [&broken, &invalid, &unbuilt] {
        let added = world.add(folder).await;
        assert_eq!(added.error, None, "a folder with a manifest is registered");
    }
    let listed = world.list().await;
    assert_eq!(listed.len(), 3);
    for plugin in &listed {
        assert!(plugin.enabled && plugin.error.is_some(), "{plugin:#?}");
        assert!(
            plugin.background.is_none() && plugin.panels.is_empty() && plugin.commands.is_empty()
        );
    }

    let error = listed[0].error.as_deref().unwrap();
    assert!(
        error.starts_with("helm-plugin.json is not valid JSON: "),
        "{error}"
    );
    assert_eq!(
        (listed[0].id.as_deref(), listed[0].name.as_str()),
        (None, "broken json")
    );

    assert!(
        listed[1].error.as_deref().unwrap().contains("id"),
        "{:?}",
        listed[1].error
    );
    assert_eq!(listed[1].name, "Bad Plugin");

    assert_eq!(
        listed[2].error.as_deref(),
        Some("background: dist/background.js does not exist - has the plugin been built?")
    );
    assert_eq!(listed[2].id.as_deref(), Some("unbuilt"));

    // Built, and reloaded: it loads, and its background is shown as stopped
    // while no runtime runs it.
    std::fs::create_dir_all(unbuilt.join("dist")).unwrap();
    std::fs::write(unbuilt.join("dist").join("background.js"), "export {}").unwrap();
    let reloaded = world.reload(&unbuilt).await;
    let plugin = &reloaded[2];
    assert_eq!(plugin.error, None);
    let background = plugin.background.as_ref().unwrap();
    assert_eq!(background.url, "floti-plugin://unbuilt/dist/background.js");
    assert_eq!(background.state, PluginBackgroundState::Stopped);
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_version_1_manifest_is_listed_with_an_error_naming_version_2() {
    let mut world = HostWorld::start().await;
    let folder = world.dirs.plugin_folder(
        "helm plugin",
        r#"{ "apiVersion": 1, "id": "old", "name": "Old Plugin", "background": "background.html" }"#,
        &[("background.html", "<!doctype html>")],
    );
    let plugin = only(&world.add(&folder).await.plugins).clone();
    assert_eq!(
        plugin.error.as_deref(),
        Some("apiVersion 1 is not supported: this host runs apiVersion 2 plugins")
    );
    assert_eq!(
        (plugin.id.as_deref(), plugin.name.as_str()),
        (Some("old"), "Old Plugin")
    );
    assert!(plugin.background.is_none());
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_folder_whose_id_is_already_loaded_is_listed_with_an_error_naming_the_first() {
    let mut world = HostWorld::start().await;
    let first = world
        .dirs
        .plugin_folder("first", &manifest("dup", "First", ""), &[]);
    let second = world
        .dirs
        .plugin_folder("second", &manifest("dup", "Second", ""), &[]);
    world.add(&first).await;
    let listed = world.add(&second).await.plugins;
    assert_eq!(listed[0].error, None);
    assert_eq!(
        listed[1].error,
        Some(format!(
            "a plugin with the id \"dup\" is already loaded from {}",
            text(&first)
        ))
    );
    assert_eq!(listed[1].name, "Second");

    // Only an enabled folder holds its id.
    world.switch(&first, false).await;
    let listed = world.reload(&second).await;
    assert_eq!(listed[1].error, None);
    assert_eq!(listed[1].id.as_deref(), Some("dup"));
    world.stop().await;
}

// Switching and removing

#[tokio::test(flavor = "multi_thread")]
async fn list_switch_reload_and_remove_each_answer_the_list_every_subscriber_is_pushed() {
    let mut world = HostWorld::start().await;
    let folder = world.dirs.plugin_folder(
        "factory",
        &manifest(
            "factory",
            "Factory",
            r#""panels": { "main": { "title": "Main", "entry": "ui/main page.html" } }"#,
        ),
        &[("ui/main page.html", "<!doctype html>")],
    );
    let (mut one, at_start) = world.watcher().await;
    let (mut two, _) = world.watcher().await;
    assert!(at_start.is_empty());

    let added = world.add(&folder).await.plugins;
    assert_eq!(next_list(&mut one).await, added);
    assert_eq!(next_list(&mut two).await, added);
    let plugin = only(&added);
    assert!(plugin.enabled && plugin.error.is_none());
    assert_eq!(
        plugin.panels["main"].url,
        "floti-plugin://factory/ui/main%20page.html"
    );
    assert_eq!(world.list().await, added);

    let off = world.switch(&folder, false).await;
    assert_eq!(next_list(&mut one).await, off);
    assert_eq!(next_list(&mut two).await, off);
    assert!(!only(&off).enabled);
    assert!(
        only(&off).revision > plugin.revision,
        "switching off bumps the revision"
    );

    let on = world.switch(&folder, true).await;
    assert_eq!(next_list(&mut one).await, on);
    assert_eq!(next_list(&mut two).await, on);
    assert!(only(&on).enabled && only(&on).revision > only(&off).revision);

    let reloaded = world.reload(&folder).await;
    assert_eq!(next_list(&mut one).await, reloaded);
    assert_eq!(next_list(&mut two).await, reloaded);
    assert!(
        only(&reloaded).revision > only(&on).revision,
        "every read is a new revision"
    );

    // Any spelling of the path is the folder.
    let upper = Path::new(&text(&folder).to_uppercase()).to_path_buf();
    let removed = world.remove(&upper, &[]).await;
    assert!(removed.is_empty());
    assert_eq!(next_list(&mut one).await, removed);
    assert_eq!(next_list(&mut two).await, removed);
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn folders_and_their_on_off_state_survive_a_host_restart() {
    let mut world = HostWorld::start().await;
    let b = world
        .dirs
        .plugin_folder("plugin b", &manifest("b", "B", ""), &[]);
    let a = world
        .dirs
        .plugin_folder("plugin a", &manifest("a", "A", ""), &[]);
    world.add(&b).await;
    world.add(&a).await;
    // Added again under another spelling: one folder, kept as first given.
    let again = world.add_text(&text(&b).to_uppercase()).await;
    assert_eq!(again.error, None);
    assert_eq!(again.plugins.len(), 2);
    world.switch(&b, false).await;
    let before = paths(&world.list().await);
    assert_eq!(before, [(text(&b), false), (text(&a), true)]);

    world.restart().await;
    let after = world.list().await;
    assert_eq!(
        paths(&after),
        before,
        "in the order they were added, switched as they were"
    );
    assert!(after[0].error.is_none() && after[1].error.is_none());
    world.stop_host().await;

    let store = world.store();
    let folders = plugin_store::read_folders(store.connection()).unwrap();
    assert_eq!(
        folders
            .iter()
            .map(|folder| (folder.path.clone(), folder.enabled, folder.tools_enabled))
            .collect::<Vec<_>>(),
        [(text(&b), false, true), (text(&a), true, true)]
    );
    store.close().unwrap();
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_a_plugin_forgets_its_settings_and_deletes_only_the_chosen_secrets_no_other_plugin_may_use()
 {
    let dirs = TestDirs::new();
    let store = Store::open(&dirs.data).unwrap();
    for (key, plugins) in [
        ("factory.a", r#"["factory"]"#),
        ("factory.b", r#"["factory"]"#),
        ("shared", r#"["factory","other"]"#),
        ("elsewhere", r#"["other"]"#),
    ] {
        store
            .connection()
            .execute(
                "INSERT INTO secrets (key, value, hosts, plugins) VALUES (?1, x'00', '[]', ?2)",
                [key, plugins],
            )
            .unwrap();
    }
    store.close().unwrap();

    let mut world = HostWorld::start_in(dirs).await;
    let folder = world.dirs.plugin_folder(
        "factory",
        &manifest("factory", "Factory", FACTORY_SETTINGS),
        &[],
    );
    world.add(&folder).await;
    world
        .set_setting("factory", "interval", PluginSettingValue::Number(60.0))
        .await
        .unwrap();
    let own: Vec<String> = world
        .client()
        .request::<PluginsOwnSecrets>(&PluginPathRequest {
            path: text(&folder),
        })
        .await
        .unwrap();
    assert_eq!(own, ["factory.a", "factory.b"]);

    let left = world
        .remove(&folder, &["factory.a", "shared", "elsewhere"])
        .await;
    assert!(left.is_empty());

    // Added back, it starts from its defaults.
    let back = world.add(&folder).await.plugins;
    assert_eq!(
        only(&back).setting_values["interval"],
        PluginSettingValue::Number(30.0)
    );
    world.stop_host().await;

    let store = world.store();
    let mut keys: Vec<String> = store
        .connection()
        .prepare("SELECT key FROM secrets ORDER BY key")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    keys.sort();
    assert_eq!(keys, ["elsewhere", "factory.b", "shared"]);
    assert!(
        plugin_store::read_settings(store.connection(), "factory")
            .unwrap()
            .is_empty()
    );
    store.close().unwrap();
    world.stop().await;
}

// Settings

#[tokio::test(flavor = "multi_thread")]
async fn set_setting_refuses_a_value_that_does_not_fit_its_spec_with_a_sentence() {
    let mut world = HostWorld::start().await;
    let folder = world.dirs.plugin_folder(
        "factory",
        &manifest("factory", "Factory", FACTORY_SETTINGS),
        &[],
    );
    world.add(&folder).await;
    let (mut watcher, _) = world.watcher().await;
    let cases = [
        (
            "baseUrl",
            PluginSettingValue::Number(3.0),
            "Base URL is text",
        ),
        (
            "baseUrl",
            PluginSettingValue::Text("x".repeat(2001)),
            "Base URL is text",
        ),
        (
            "interval",
            PluginSettingValue::Text("60".into()),
            "Interval is a number",
        ),
        (
            "interval",
            PluginSettingValue::Number(4.0),
            "Interval is at least 5",
        ),
        (
            "interval",
            PluginSettingValue::Number(601.0),
            "Interval is at most 600",
        ),
        (
            "live",
            PluginSettingValue::Text("yes".into()),
            "Live updates is on or off",
        ),
        (
            "mode",
            PluginSettingValue::Text("medium".into()),
            "Mode is one of its options",
        ),
        (
            "token",
            PluginSettingValue::Text("t".into()),
            "token is not one of Factory's settings",
        ),
        (
            "colour",
            PluginSettingValue::Text("red".into()),
            "colour is not one of Factory's settings",
        ),
    ];
    for (key, value, said) in cases {
        assert_eq!(
            world.set_setting("factory", key, value).await.unwrap_err(),
            said,
            "{key}"
        );
    }
    assert_eq!(
        world
            .set_setting("nobody", "interval", PluginSettingValue::Number(10.0))
            .await
            .unwrap_err(),
        "nobody is not a loaded plugin"
    );
    // Nothing refused was kept or sent.
    let plugin = only(&world.list().await).clone();
    assert_eq!(
        plugin.setting_values["interval"],
        PluginSettingValue::Number(30.0)
    );
    assert!(
        watcher
            .next(std::time::Duration::from_millis(300))
            .await
            .is_none(),
        "a refused setting sends nothing"
    );
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_setting_is_kept_shown_in_every_clients_list_and_null_goes_back_to_the_default() {
    let mut world = HostWorld::start().await;
    let folder = world.dirs.plugin_folder(
        "factory",
        &manifest("factory", "Factory", FACTORY_SETTINGS),
        &[],
    );
    let added = world.add(&folder).await.plugins;
    assert_eq!(
        only(&added).setting_values,
        values(&[
            (
                "baseUrl",
                PluginSettingValue::Text("https://factory.example".into())
            ),
            ("interval", PluginSettingValue::Number(30.0)),
            ("live", PluginSettingValue::Unset),
            ("mode", PluginSettingValue::Text("fast".into())),
        ]),
        "every setting but the secret, with its default or null"
    );

    let (mut watcher, _) = world.watcher().await;
    let set = world
        .set_setting("factory", "interval", PluginSettingValue::Number(60.0))
        .await
        .unwrap();
    assert_eq!(
        only(&set).setting_values["interval"],
        PluginSettingValue::Number(60.0)
    );
    assert_eq!(next_list(&mut watcher).await, set);
    world
        .set_setting("factory", "live", PluginSettingValue::Toggle(false))
        .await
        .unwrap();
    assert_eq!(
        only(&next_list(&mut watcher).await).setting_values["live"],
        PluginSettingValue::Toggle(false)
    );
    drop(watcher);

    world.restart().await;
    let listed = world.list().await;
    assert_eq!(
        only(&listed).setting_values["interval"],
        PluginSettingValue::Number(60.0)
    );
    let reset = world
        .set_setting("factory", "interval", PluginSettingValue::Unset)
        .await
        .unwrap();
    assert_eq!(
        only(&reset).setting_values["interval"],
        PluginSettingValue::Number(30.0)
    );
    world.stop_host().await;

    let store = world.store();
    let stored = plugin_store::read_settings(store.connection(), "factory").unwrap();
    assert_eq!(
        stored,
        BTreeMap::from([("live".to_owned(), serde_json::json!(false))]),
        "null deleted the row; a value is kept as JSON"
    );
    store.close().unwrap();
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_command_the_manifest_does_not_declare_is_refused() {
    let mut world = HostWorld::start().await;
    let folder = world.dirs.plugin_folder(
        "factory",
        &manifest(
            "factory",
            "Factory",
            r#""background": "bg.js", "commands": [{ "id": "sync", "title": "Sync now" }]"#,
        ),
        &[("bg.js", "export {}")],
    );
    world.add(&folder).await;
    let mut command = async |id: &str| {
        world
            .client()
            .request::<PluginsCommand>(&PluginCommandRequest {
                plugin: "factory".into(),
                id: id.into(),
            })
            .await
            .map_err(|error| error.message)
    };
    assert_eq!(command("sync").await, Ok(()));
    assert_eq!(
        command("deploy").await,
        Err("\"deploy\" is not one of Factory's commands".to_owned())
    );
    world.stop().await;
}

// The registry itself

/// A background runtime that records what it was asked and runs nothing.
#[derive(Default)]
struct Recorder {
    started: Mutex<Vec<(String, u64, String)>>,
    stopped: Mutex<Vec<String>>,
    delivered: Mutex<Vec<(String, BackgroundEvent)>>,
}

impl BackgroundRuntime for Recorder {
    fn start(&self, launch: BackgroundLaunch) -> PluginBackgroundState {
        self.started
            .lock()
            .unwrap()
            .push((launch.plugin, launch.revision, launch.module));
        PluginBackgroundState::Starting
    }

    fn stop(&self, plugin: &str) {
        self.stopped.lock().unwrap().push(plugin.to_owned());
    }

    fn deliver(&self, plugin: &str, event: BackgroundEvent) {
        self.delivered
            .lock()
            .unwrap()
            .push((plugin.to_owned(), event));
    }

    fn call_tool(&self, _call: ToolCall, _cancel: CancelToken) -> ToolFuture {
        NoBackground.call_tool(_call, _cancel)
    }
}

/// A registry over a store of its own, and every list it published.
struct RegistryWorld {
    registry: Registry,
    published: Arc<Mutex<Vec<Vec<PluginInfo>>>>,
    background: Arc<Recorder>,
    /// Last: the registry's store is closed before its folder goes.
    dirs: TestDirs,
}

impl RegistryWorld {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let published: Arc<Mutex<Vec<Vec<PluginInfo>>>> = Arc::default();
        let into = Arc::clone(&published);
        let background = Arc::new(Recorder::default());
        let registry = Registry::new(RegistryParts {
            store: Arc::new(Mutex::new(Store::open(&dirs.data).unwrap())),
            background: Arc::clone(&background) as Arc<dyn BackgroundRuntime>,
            secrets: Arc::new(NoSecrets),
            publish: Box::new(move |list| into.lock().unwrap().push(list.clone())),
        });
        registry.start().unwrap();
        Self {
            registry,
            published,
            background,
            dirs,
        }
    }

    fn add(&self, folder: &Path) -> PluginInfo {
        let added = self.registry.add(&text(folder)).unwrap();
        added
            .plugins
            .into_iter()
            .find(|plugin| plugin.path == text(folder))
            .unwrap()
    }

    async fn call(
        &self,
        plugin: &str,
        method: &str,
        args: Vec<Payload>,
    ) -> Result<Payload, PluginCallError> {
        self.registry
            .call(PluginCall {
                plugin: plugin.into(),
                surface: PluginSurfaceKind::Background,
                method: method.into(),
                args,
                cancel: CancelToken::new(),
            })
            .await
    }

    /// The last list published, once this turn's push has gone.
    async fn last_published(&self) -> Vec<PluginInfo> {
        tokio::task::yield_now().await;
        let deadline = Instant::now() + PATIENCE;
        loop {
            let count = self.published.lock().unwrap().len();
            if count > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                return self.published.lock().unwrap().last().cloned().unwrap();
            }
            assert!(Instant::now() < deadline, "nothing was published");
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_starts_the_background_of_a_plugin_that_loaded_and_of_nothing_else() {
    let world = RegistryWorld::new();
    let good = world.dirs.plugin_folder(
        "good",
        &manifest("good", "Good", r#""background": "bg.mjs""#),
        &[("bg.mjs", "export {}")],
    );
    let old = world.dirs.plugin_folder(
        "old",
        r#"{ "apiVersion": 1, "id": "old", "name": "Old", "background": "bg.html" }"#,
        &[("bg.html", "<!doctype html>")],
    );
    let plugin = world.add(&good);
    world.add(&old);
    assert_eq!(
        plugin.background.unwrap().state,
        PluginBackgroundState::Starting
    );
    assert_eq!(
        *world.background.started.lock().unwrap(),
        [("good".to_owned(), plugin.revision, "bg.mjs".to_owned())]
    );

    // Reported running for that read; a report for an older read is ignored.
    world.registry.background_state(
        "good",
        plugin.revision,
        PluginBackgroundState::Running,
        None,
    );
    world.registry.background_state(
        "good",
        plugin.revision - 1,
        PluginBackgroundState::Crashed,
        None,
    );
    let listed = world.last_published().await;
    assert_eq!(
        listed[0].background.as_ref().unwrap().state,
        PluginBackgroundState::Running
    );

    world.registry.set_enabled(&text(&good), false).unwrap();
    assert_eq!(*world.background.stopped.lock().unwrap(), ["good"]);
    world.registry.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn settings_get_answers_every_declared_setting_with_the_users_value_or_its_default() {
    let world = RegistryWorld::new();
    let folder = world.dirs.plugin_folder(
        "factory",
        &manifest(
            "factory",
            "Factory",
            &format!(r#""background": "bg.js", {FACTORY_SETTINGS}"#),
        ),
        &[("bg.js", "export {}")],
    );
    world.add(&folder);
    world
        .registry
        .set_setting("factory", "interval", &PluginSettingValue::Number(90.0))
        .unwrap();
    let got: BTreeMap<String, PluginSettingValue> = world
        .call("factory", "settings.get", vec![])
        .await
        .unwrap()
        .deserialized()
        .unwrap();
    assert_eq!(
        got,
        values(&[
            (
                "baseUrl",
                PluginSettingValue::Text("https://factory.example".into())
            ),
            ("interval", PluginSettingValue::Number(90.0)),
            ("live", PluginSettingValue::Unset),
            ("mode", PluginSettingValue::Text("fast".into())),
        ])
    );
    // The background heard the change with every value.
    let delivered = world.background.delivered.lock().unwrap().clone();
    assert!(
        matches!(&delivered[..], [(plugin, BackgroundEvent::Settings(sent))]
            if plugin == "factory" && sent["interval"] == PluginSettingValue::Number(90.0)),
        "{delivered:?}"
    );
    world.registry.shutdown();
}

#[tokio::test(flavor = "multi_thread")]
async fn status_and_badge_are_painted_while_the_plugin_is_on_and_checked_as_today() {
    let world = RegistryWorld::new();
    let folder = world
        .dirs
        .plugin_folder("factory", &manifest("factory", "Factory", ""), &[]);
    world.add(&folder);
    let status =
        Payload::serialized(&serde_json::json!({ "text": " 3 builds ", "tone": "warn" })).unwrap();
    world
        .call("factory", "status.set", vec![status])
        .await
        .unwrap();
    world
        .call(
            "factory",
            "badge.set",
            vec![Payload::serialized(&250_000).unwrap()],
        )
        .await
        .unwrap();
    let listed = world.last_published().await;
    assert_eq!(
        listed[0].status,
        Some(PluginStatusItem {
            text: "3 builds".into(),
            tone: Some(PluginStatusTone::Warn),
            tooltip: None
        })
    );
    assert_eq!(listed[0].badge, Some(99_999), "capped");

    let refused = |code, message: &str| Err(PluginCallError::new(code, message));
    assert_eq!(
        world
            .call(
                "factory",
                "badge.set",
                vec![Payload::serialized(&-1).unwrap()]
            )
            .await,
        refused(
            PluginErrorCode::Invalid,
            "a badge is a whole number of zero or more, or null"
        )
    );
    assert_eq!(
        world
            .call(
                "factory",
                "status.set",
                vec![
                    Payload::serialized(&serde_json::json!({ "text": "x", "tone": "loud" }))
                        .unwrap()
                ]
            )
            .await,
        refused(
            PluginErrorCode::Invalid,
            "tone is one of neutral, accent, success, warn, danger"
        )
    );
    assert_eq!(
        world.call("factory", "nothing.here", vec![]).await,
        refused(
            PluginErrorCode::Invalid,
            "floti.nothing.here is not part of the bridge"
        )
    );

    // Off, it paints nothing and answers nothing.
    let off = world.registry.set_enabled(&text(&folder), false).unwrap();
    assert_eq!((off[0].status.clone(), off[0].badge), (None, None));
    assert_eq!(
        world.call("factory", "settings.get", vec![]).await,
        refused(PluginErrorCode::Unavailable, "the plugin is not enabled")
    );
    world.registry.shutdown();
}
