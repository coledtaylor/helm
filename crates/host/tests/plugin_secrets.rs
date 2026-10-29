//! Plugin secrets, as today's `desktop/main/plugins/secrets.test.ts` and the
//! store's secrets cases test them, with the same inputs and sentences.
//!
//! The channels and `secrets:changed` are tested as a client sees them:
//! through client connections to a running host over a test's own
//! `floti.db`. What a plugin reaches (`floti.secrets.state` and a value
//! revealed for one use) is tested against the registry and the store, since
//! no channel carries a bridge call yet.
//!
//! Every host here seals with a key file in its test data folder, or has no
//! store at all, as the testkit arranges: no test touches the user's own
//! credential store.

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
use floti_host::plugins::secrets::store::CANNOT_SEAL;
use floti_host::plugins::secrets::{SecretStore, SecretUse, SecretsAccess, register_methods, seal};
use floti_host::plugins::{PluginCall, Registry, RegistryParts};
use floti_host::server::{Host, HostConfig, HostRun, backends, unserved};
use floti_host::store::Store;
use floti_host::testkit::{PATIENCE, RunningHost, TestClient, TestDirs, names_unserved_channel};
use floti_protocol::channel::{EventChannel, from_payload};
use floti_protocol::channels::host::HostStopReason;
use floti_protocol::channels::plugins::{
    PluginAddRequest, PluginBackgroundState, PluginErrorCode, PluginInfo, PluginPageSecretState,
    PluginSecretState, PluginSetSettingRequest, PluginSettingValue, PluginSurfaceKind, PluginsAdd,
    PluginsChanged, PluginsList, PluginsSetSetting, SecretInput, SecretRemoveRequest,
    SecretsChanged, SecretsList, SecretsRemove, SecretsSave, SecretsState,
};
use floti_protocol::channels::workspace::AppMode;
use floti_protocol::{Catalogue, Message, Payload};

const SECRETS_CHANGED: u64 = 1;
const PLUGINS_CHANGED: u64 = 2;

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn input(key: &str, value: Option<&str>, hosts: &[&str], plugins: &[&str]) -> SecretInput {
    SecretInput {
        key: key.into(),
        value: value.map(str::to_owned),
        hosts: hosts.iter().map(|host| (*host).to_owned()).collect(),
        plugins: plugins.iter().map(|plugin| (*plugin).to_owned()).collect(),
    }
}

/// A version 2 manifest for `id` declaring `secrets`, with `extra` fields.
fn manifest(id: &str, secrets: &[&str], extra: &str) -> String {
    let secrets = serde_json::to_string(secrets).unwrap();
    format!(r#"{{ "apiVersion": 2, "id": "{id}", "name": "{id}", "secrets": {secrets}{extra} }}"#)
}

fn start_host(dirs: &TestDirs, endpoint: &Endpoint) -> RunningHost {
    RunningHost::start(config(dirs, endpoint))
}

fn config(dirs: &TestDirs, endpoint: &Endpoint) -> HostConfig {
    HostConfig {
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
    }
}

/// A host over a test's folders, with a client connected to it.
struct HostWorld {
    host: Option<RunningHost>,
    client: Option<TestClient>,
    endpoint: Endpoint,
    /// Last: fields drop in order, and the folder goes only once the host
    /// has let go of its store.
    dirs: TestDirs,
}

impl HostWorld {
    async fn start() -> Self {
        Self::start_in(TestDirs::new()).await
    }

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

    async fn stop_host(&mut self) {
        self.client = None;
        if let Some(host) = self.host.take() {
            host.stop(HostStopReason::Stop).await;
        }
    }

    async fn stop(mut self) {
        self.stop_host().await;
    }

    async fn list(&mut self) -> SecretsState {
        self.client().request::<SecretsList>(&()).await.unwrap()
    }

    async fn save(&mut self, input: &SecretInput) -> Result<SecretsState, String> {
        self.client()
            .request::<SecretsSave>(input)
            .await
            .map_err(|error| error.message)
    }

    async fn remove(&mut self, key: &str) -> SecretsState {
        self.client()
            .request::<SecretsRemove>(&SecretRemoveRequest { key: key.into() })
            .await
            .unwrap()
    }

    async fn add_plugin(&mut self, folder: &Path) -> Vec<PluginInfo> {
        self.client()
            .request::<PluginsAdd>(&PluginAddRequest { path: text(folder) })
            .await
            .unwrap()
            .plugins
    }

    /// Another client, subscribed to `secrets:changed` and `plugins:changed`,
    /// and the secrets list it started with.
    async fn watcher(&self) -> (TestClient, SecretsState) {
        let mut client = TestClient::connect(&self.endpoint, &[]).await;
        let started = match client
            .subscribe_on(SECRETS_CHANGED, SecretsChanged::NAME)
            .await
        {
            Message::Snapshot(snapshot) => from_payload(&snapshot.state).unwrap(),
            other => panic!("secrets:changed starts with its state, not {other:?}"),
        };
        match client
            .subscribe_on(PLUGINS_CHANGED, PluginsChanged::NAME)
            .await
        {
            Message::Snapshot(_) => {}
            other => panic!("plugins:changed starts with its state, not {other:?}"),
        }
        (client, started)
    }

    /// The store and seal the stopped host left, opened for a look.
    fn secret_store(&self) -> SecretStore {
        assert!(
            self.host.is_none(),
            "look at the store once the host has stopped"
        );
        SecretStore::new(
            Arc::new(Mutex::new(Store::open(&self.dirs.data).unwrap())),
            seal::for_data_folder(&self.dirs.data),
            Box::new(|_| ()),
        )
    }

    /// The sealed bytes the stopped host stored for `key`.
    fn sealed(&self, key: &str) -> Vec<u8> {
        assert!(
            self.host.is_none(),
            "look at the store once the host has stopped"
        );
        let store = Store::open(&self.dirs.data).unwrap();
        let sealed = store
            .connection()
            .query_row("SELECT value FROM secrets WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .unwrap();
        store.close().unwrap();
        sealed
    }
}

/// The next message on `subscription`, as `T`.
async fn next_on<T: serde::de::DeserializeOwned>(client: &mut TestClient, subscription: u64) -> T {
    let deadline = Instant::now() + PATIENCE;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match client.next(left).await {
            Some(Message::Event(event)) if event.subscription == subscription => {
                return from_payload(&event.payload).unwrap();
            }
            Some(_) => {}
            None => panic!("no event on subscription {subscription} within {PATIENCE:?}"),
        }
    }
}

fn keys(state: &SecretsState) -> Vec<&str> {
    state
        .secrets
        .iter()
        .map(|secret| secret.key.as_str())
        .collect()
}

fn secret_state_of(listed: &[PluginInfo], plugin: &str, key: &str) -> PluginSecretState {
    listed
        .iter()
        .find(|info| info.id.as_deref() == Some(plugin))
        .and_then(|info| info.secrets.iter().find(|secret| secret.key == key))
        .unwrap_or_else(|| panic!("{plugin} lists {key}: {listed:#?}"))
        .state
}

// ---------------------------------------------------------------------------
// Saving and removing, as every client sees it
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_saved_value_is_stored_sealed_with_canonical_origins_and_every_client_lists_it_without_the_value()
 {
    let mut world = HostWorld::start().await;
    let (mut watcher, started) = world.watcher().await;
    assert_eq!(
        started,
        SecretsState {
            available: true,
            secrets: Vec::new()
        }
    );

    let saved = world
        .save(&input(
            "gh-token",
            Some("ghp_secret"),
            &[
                "https://API.github.com/",
                "https://api.github.com",
                "https://*.example.com",
            ],
            &["sample", "sample"],
        ))
        .await
        .unwrap();
    assert!(saved.available);
    let [secret] = saved.secrets.as_slice() else {
        panic!("{saved:#?}");
    };
    assert_eq!(secret.key, "gh-token");
    assert_eq!(
        secret.hosts,
        ["https://api.github.com", "https://*.example.com"]
    );
    assert_eq!(secret.plugins, ["sample"]);
    assert!(secret.updated_at.ends_with('Z'), "{}", secret.updated_at);

    let pushed: SecretsState = next_on(&mut watcher, SECRETS_CHANGED).await;
    assert_eq!(
        pushed, saved,
        "every client is sent the list it was answered"
    );
    let listed = world.list().await;
    assert_eq!(listed, saved);
    for shown in [&pushed, &listed] {
        let wire = serde_json::to_string(shown).unwrap();
        assert!(
            !wire.contains("ghp_secret"),
            "a list carries a value: {wire}"
        );
        assert!(
            !wire.contains("\"value\""),
            "a list has a value field: {wire}"
        );
    }

    drop(watcher);
    world.stop_host().await;
    let sealed = world.sealed("gh-token");
    assert!(
        !sealed
            .windows(b"ghp_secret".len())
            .any(|window| window == b"ghp_secret"),
        "the value is stored in plain text"
    );
    assert_eq!(
        seal::for_data_folder(&world.dirs.data)
            .unseal(&sealed)
            .unwrap(),
        b"ghp_secret",
        "the value is stored sealed by the host's seal"
    );
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_save_whose_value_is_null_keeps_the_stored_value_and_changes_only_who_may_use_it() {
    let mut world = HostWorld::start().await;
    world
        .save(&input(
            "k",
            Some("original"),
            &["https://a.example.com"],
            &["sample"],
        ))
        .await
        .unwrap();
    world.stop_host().await;
    let before = world.sealed("k");
    world.host = Some(start_host(&world.dirs, &world.endpoint));
    world.client = Some(TestClient::connect(&world.endpoint, &[]).await);

    let saved = world
        .save(&input(
            "k",
            None,
            &["https://b.example.com"],
            &["sample", "other"],
        ))
        .await
        .unwrap();
    assert_eq!(saved.secrets[0].hosts, ["https://b.example.com"]);
    assert_eq!(saved.secrets[0].plugins, ["sample", "other"]);

    world.stop_host().await;
    assert_eq!(
        world.sealed("k"),
        before,
        "the stored value is kept as it was"
    );
    let store = world.secret_store();
    let value = store
        .reveal(
            "other",
            &["k".to_owned()],
            "k",
            SecretUse::Request {
                origin: "https://b.example.com/x",
            },
        )
        .unwrap();
    assert_eq!(value.expose(), "original");
    drop(store);
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_malformed_key_origin_or_plugin_or_an_empty_or_overlong_value_is_refused_with_the_sentence_the_form_shows()
 {
    let mut world = HostWorld::start().await;
    let (mut watcher, _) = world.watcher().await;
    let long = "x".repeat(16 * 1024 + 1);
    let cases: [(SecretInput, &str); 8] = [
        (
            input("bad key", Some("v"), &[], &[]),
            "A key is letters, digits, dots, dashes and underscores, starting with a letter or digit.",
        ),
        (
            input("k", Some("v"), &["api.example.com"], &[]),
            "\"api.example.com\" is not an origin. Write it as https://api.example.com or https://*.example.com.",
        ),
        (
            input("k", Some("v"), &["https://example.com/path"], &[]),
            "\"https://example.com/path\" is not an origin. Write it as https://api.example.com or https://*.example.com.",
        ),
        (
            input("k", Some("v"), &["https://*.127.0.0.1"], &[]),
            "\"https://*.127.0.0.1\" is not an origin. Write it as https://api.example.com or https://*.example.com.",
        ),
        (
            input("k", Some("v"), &[], &["Not An Id"]),
            "\"Not An Id\" is not a plugin id.",
        ),
        (input("k", Some(""), &[], &[]), "A secret needs a value."),
        (input("k", None, &[], &[]), "A secret needs a value."),
        (
            input("k", Some(&long), &[], &[]),
            "That value is longer than a secret can be.",
        ),
    ];
    for (refused, sentence) in &cases {
        assert_eq!(
            world.save(refused).await.as_ref().map(keys),
            Err(&(*sentence).to_owned()),
            "{:?}",
            refused.key
        );
    }
    assert!(world.list().await.secrets.is_empty());

    // Exactly 16 KB is a value; the refusals above sent nothing, so the
    // first push the watcher gets is this save's.
    let fits = "x".repeat(16 * 1024);
    let saved = world
        .save(&input("k", Some(&fits), &[], &["sample"]))
        .await
        .unwrap();
    let pushed: SecretsState = next_on(&mut watcher, SECRETS_CHANGED).await;
    assert_eq!(pushed, saved);
    drop(watcher);
    world.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_a_secret_takes_it_away_for_every_plugin_and_every_client_is_told() {
    let mut world = HostWorld::start().await;
    let one = world
        .dirs
        .plugin_folder("one", &manifest("one", &["shared"], ""), &[]);
    let two = world
        .dirs
        .plugin_folder("two", &manifest("two", &["shared"], ""), &[]);
    world.add_plugin(&one).await;
    let listed = world.add_plugin(&two).await;
    assert_eq!(
        secret_state_of(&listed, "one", "shared"),
        PluginSecretState::Missing
    );
    let (mut watcher, _) = world.watcher().await;

    world
        .save(&input("shared", Some("v"), &[], &["one", "two"]))
        .await
        .unwrap();
    let _: SecretsState = next_on(&mut watcher, SECRETS_CHANGED).await;
    let plugins: Vec<PluginInfo> = next_on(&mut watcher, PLUGINS_CHANGED).await;
    assert_eq!(
        secret_state_of(&plugins, "one", "shared"),
        PluginSecretState::Ready
    );
    assert_eq!(
        secret_state_of(&plugins, "two", "shared"),
        PluginSecretState::Ready
    );

    let after = world.remove("shared").await;
    assert!(after.secrets.is_empty());
    let pushed: SecretsState = next_on(&mut watcher, SECRETS_CHANGED).await;
    assert_eq!(pushed, after);
    let plugins: Vec<PluginInfo> = next_on(&mut watcher, PLUGINS_CHANGED).await;
    assert_eq!(
        secret_state_of(&plugins, "one", "shared"),
        PluginSecretState::Missing
    );
    assert_eq!(
        secret_state_of(&plugins, "two", "shared"),
        PluginSecretState::Missing
    );
    let listed = world.client().request::<PluginsList>(&()).await.unwrap();
    assert_eq!(
        secret_state_of(&listed, "two", "shared"),
        PluginSecretState::Missing
    );

    // Removing what is not there tells nobody anything: the next push is
    // the next save's.
    assert!(world.remove("shared").await.secrets.is_empty());
    let saved = world
        .save(&input("again", Some("v"), &[], &["one"]))
        .await
        .unwrap();
    let pushed: SecretsState = next_on(&mut watcher, SECRETS_CHANGED).await;
    assert_eq!(pushed, saved);
    drop(watcher);

    world.stop_host().await;
    let store = world.secret_store();
    for plugin in ["one", "two"] {
        assert_eq!(
            store
                .reveal(plugin, &["shared".to_owned()], "shared", SecretUse::Program)
                .unwrap_err()
                .message,
            "the secret \"shared\" is not stored - add it in Settings > Secrets"
        );
    }
    drop(store);
    world.stop().await;
}

// ---------------------------------------------------------------------------
// A computer with no secret store
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn with_no_secret_store_a_value_is_refused_the_list_says_so_and_the_rest_of_plugins_keeps_working()
 {
    let dirs = TestDirs::new();
    dirs.without_secret_store();
    let mut world = HostWorld::start_in(dirs).await;
    let (mut watcher, started) = world.watcher().await;
    assert!(
        !started.available,
        "the list says encryption is unavailable"
    );
    assert!(!world.list().await.available);

    assert_eq!(
        world
            .save(&input("k", Some("v"), &[], &["sample"]))
            .await
            .unwrap_err(),
        CANNOT_SEAL
    );
    assert_eq!(
        CANNOT_SEAL,
        "Floti cannot encrypt on this computer, so it will not store a secret. Nothing was saved."
    );
    assert!(world.list().await.secrets.is_empty(), "nothing was saved");

    // Every other part of plugins keeps working.
    let folder = world.dirs.plugin_folder(
        "sample",
        &manifest(
            "sample",
            &["k"],
            r#", "settings": [{ "type": "number", "key": "interval", "label": "Interval", "default": 30 }]"#,
        ),
        &[],
    );
    let listed = world.add_plugin(&folder).await;
    assert_eq!(
        secret_state_of(&listed, "sample", "k"),
        PluginSecretState::Missing
    );
    let set = world
        .client()
        .request::<PluginsSetSetting>(&PluginSetSettingRequest {
            plugin: "sample".into(),
            key: "interval".into(),
            value: PluginSettingValue::Number(60.0),
        })
        .await
        .unwrap();
    assert_eq!(
        set[0].setting_values.get("interval"),
        Some(&PluginSettingValue::Number(60.0))
    );
    let plugins: Vec<PluginInfo> = next_on(&mut watcher, PLUGINS_CHANGED).await;
    assert_eq!(plugins.len(), 1);
    drop(watcher);
    world.stop().await;
}

// ---------------------------------------------------------------------------
// What a plugin reaches
// ---------------------------------------------------------------------------

/// A background runtime that runs nothing and records what it is sent.
#[derive(Default)]
struct Recorder {
    delivered: Mutex<Vec<(String, BackgroundEvent)>>,
}

impl BackgroundRuntime for Recorder {
    fn start(&self, _launch: BackgroundLaunch) -> PluginBackgroundState {
        PluginBackgroundState::Starting
    }

    fn stop(&self, _plugin: &str) {}

    fn deliver(&self, plugin: &str, event: BackgroundEvent) {
        self.delivered
            .lock()
            .unwrap()
            .push((plugin.to_owned(), event));
    }

    fn call_tool(&self, call: ToolCall, cancel: CancelToken) -> ToolFuture {
        NoBackground.call_tool(call, cancel)
    }
}

/// A registry and the secret store it reaches, over a store of their own.
struct RegistryWorld {
    registry: Registry,
    secrets: Arc<SecretStore>,
    background: Arc<Recorder>,
    store: Arc<Mutex<Store>>,
    /// Last: the store is closed before its folder goes.
    dirs: TestDirs,
}

impl RegistryWorld {
    fn new() -> Self {
        let dirs = TestDirs::new();
        let store = Arc::new(Mutex::new(Store::open(&dirs.data).unwrap()));
        let secrets = Arc::new(SecretStore::new(
            Arc::clone(&store),
            seal::for_data_folder(&dirs.data),
            Box::new(|_| ()),
        ));
        let background = Arc::new(Recorder::default());
        let registry = Registry::new(RegistryParts {
            store: Arc::clone(&store),
            background: Arc::clone(&background) as Arc<dyn BackgroundRuntime>,
            secrets: Arc::clone(&secrets) as Arc<dyn SecretsAccess>,
            publish: Box::new(|_| ()),
        });
        register_methods(
            registry.methods(),
            Arc::clone(&secrets) as Arc<dyn SecretsAccess>,
        );
        registry.start().unwrap();
        Self {
            registry,
            secrets,
            background,
            store,
            dirs,
        }
    }

    async fn state_of(&self, plugin: &str, key: Payload) -> Result<String, PluginCallError> {
        self.registry
            .call(PluginCall {
                plugin: plugin.into(),
                surface: PluginSurfaceKind::Background,
                method: "secrets.state".into(),
                args: vec![key],
                cancel: CancelToken::new(),
            })
            .await
            .map(|answer| answer.deserialized::<String>().unwrap())
    }

    fn stop(self) {
        self.registry.shutdown();
        drop(self.registry);
        drop(self.secrets);
        let store = Arc::try_unwrap(self.store)
            .unwrap_or_else(|_| panic!("nothing else holds the store"))
            .into_inner()
            .unwrap();
        store.close().unwrap();
    }
}

fn declared(keys: &[&str]) -> Vec<String> {
    keys.iter().map(|key| (*key).to_owned()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn secrets_state_is_ready_when_stored_and_allowed_missing_otherwise_and_refuses_an_undeclared_key()
 {
    let world = RegistryWorld::new();
    let folder = world.dirs.plugin_folder(
        "sample",
        &manifest("sample", &["token", "theirs", "unset"], ""),
        &[],
    );
    world.registry.add(&text(&folder)).unwrap();
    world
        .secrets
        .save(&input("token", Some("s3cret"), &[], &["sample"]))
        .unwrap();
    world
        .secrets
        .save(&input("theirs", Some("v"), &[], &["other"]))
        .unwrap();

    let state = |key: &str| world.state_of("sample", Payload::Text(key.to_owned()));
    assert_eq!(state("token").await.unwrap(), "ready");
    assert_eq!(
        state("theirs").await.unwrap(),
        "missing",
        "stored, not allowed"
    );
    assert_eq!(state("unset").await.unwrap(), "missing", "not stored");
    for undeclared in [
        Payload::Text("nope".into()),
        Payload::Integer(3.into()),
        Payload::Null,
    ] {
        let refused = world.state_of("sample", undeclared).await.unwrap_err();
        assert_eq!(refused.code, PluginErrorCode::NotDeclared, "{refused:?}");
        assert!(
            refused
                .message
                .ends_with("is not one of the secrets the manifest declares"),
            "{refused:?}"
        );
    }
    assert_eq!(
        world
            .state_of("sample", Payload::Text("nope".into()))
            .await
            .unwrap_err()
            .message,
        "\"nope\" is not one of the secrets the manifest declares"
    );
    assert_eq!(
        world.secrets.state("sample", "theirs"),
        PluginSecretState::NotAllowed
    );
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_change_tells_each_background_that_declares_secrets_where_its_keys_stand() {
    let world = RegistryWorld::new();
    let folder = world.dirs.plugin_folder(
        "sample",
        &manifest("sample", &["token", "unset"], r#", "background": "bg.mjs""#),
        &[("bg.mjs", "export {}")],
    );
    world.registry.add(&text(&folder)).unwrap();
    world
        .secrets
        .save(&input("token", Some("v"), &[], &["sample"]))
        .unwrap();
    world.registry.secrets_changed();
    let delivered = world.background.delivered.lock().unwrap().clone();
    assert_eq!(
        delivered,
        [(
            "sample".to_owned(),
            BackgroundEvent::Secrets(BTreeMap::from([
                ("token".to_owned(), PluginPageSecretState::Ready),
                ("unset".to_owned(), PluginPageSecretState::Missing),
            ]))
        )]
    );
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_value_is_revealed_only_to_a_plugin_and_origin_the_user_allowed_with_each_refusal_saying_why()
 {
    let world = RegistryWorld::new();
    world
        .secrets
        .save(&input(
            "token",
            Some("s3cret"),
            &["https://api.example.com", "https://*.example.org"],
            &["sample"],
        ))
        .unwrap();
    let reveal = |plugin: &str, declared_keys: &[&str], use_: SecretUse<'_>| {
        world
            .secrets
            .reveal(plugin, &declared(declared_keys), "token", use_)
    };
    let request = |origin| SecretUse::Request { origin };

    for allowed in [
        "https://api.example.com/v1",
        "https://deep.sub.example.org/",
    ] {
        assert_eq!(
            reveal("sample", &["token"], request(allowed))
                .unwrap()
                .expose(),
            "s3cret"
        );
    }
    assert_eq!(
        reveal("sample", &["token"], SecretUse::Program)
            .unwrap()
            .expose(),
        "s3cret",
        "a program is given the value with no origin to check"
    );
    assert_eq!(
        format!(
            "{:?}",
            reveal("sample", &["token"], SecretUse::Program).unwrap()
        ),
        "SecretValue(..)"
    );

    let refused = |result: Result<_, PluginCallError>| {
        let error = result.unwrap_err();
        assert_eq!(error.code, PluginErrorCode::Secret, "{error:?}");
        error.message
    };
    assert_eq!(
        refused(reveal("sample", &[], request("https://api.example.com/"))),
        "{{token}} is not one of the secrets the manifest declares"
    );
    assert_eq!(
        refused(
            world
                .secrets
                .reveal("sample", &declared(&["other"]), "other", SecretUse::Program)
        ),
        "the secret \"other\" is not stored - add it in Settings > Secrets"
    );
    assert_eq!(
        refused(reveal(
            "other",
            &["token"],
            request("https://api.example.com/")
        )),
        "the secret \"token\" is not allowed for this plugin"
    );
    for elsewhere in [
        "https://evil.example.com/",
        "http://api.example.com/",
        "https://api.example.com:8443/",
        "https://example.org/",
    ] {
        let message = refused(reveal("sample", &["token"], request(elsewhere)));
        assert!(
            message.contains("may not be sent to"),
            "{elsewhere}: {message}"
        );
    }
    assert_eq!(
        refused(reveal(
            "sample",
            &["token"],
            request("https://evil.example.com/x?y")
        )),
        "the secret \"token\" may not be sent to https://evil.example.com"
    );
    world.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stored_value_that_cannot_be_unsealed_on_this_computer_fails_the_call_that_needs_it_saying_so()
 {
    let world = RegistryWorld::new();
    world
        .secrets
        .save(&input("token", Some("s3cret"), &[], &["sample"]))
        .unwrap();
    // Sealed somewhere else: these bytes are no seal of this computer's.
    world
        .store
        .lock()
        .unwrap()
        .connection()
        .execute(
            "UPDATE secrets SET value = ?1 WHERE key = 'token'",
            [b"sealed on another computer".to_vec()],
        )
        .unwrap();
    assert_eq!(
        world.secrets.state("sample", "token"),
        PluginSecretState::Ready
    );
    let error = world
        .secrets
        .reveal("sample", &declared(&["token"]), "token", SecretUse::Program)
        .unwrap_err();
    assert_eq!(error.code, PluginErrorCode::Secret);
    assert_eq!(
        error.message,
        "the secret \"token\" could not be decrypted on this computer"
    );
    world.stop();
}

// ---------------------------------------------------------------------------
// What is served
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_plugin_channel_not_served_yet_is_answered_naming_it_and_its_feature_and_every_other_plugin_and_secrets_channel_is_served()
 {
    let dirs = TestDirs::new();
    let endpoint = dirs.endpoint();
    let (host, served) = RunningHost::start_with(config(&dirs, &endpoint), Host::served_channels);
    let mut client = TestClient::connect(&endpoint, &[]).await;

    let later = [
        ("plugins:call", "plugin pages"),
        ("plugins:cancel", "plugin pages"),
        ("plugins:answer", "plugin pages"),
        ("plugins:session", "plugin pages"),
        ("plugins:ui", "plugin pages"),
        ("plugins:deliver", "plugin pages"),
        ("plugins:setTools", "plugin tool families"),
        ("plugins:log", "plugin services"),
        ("plugins:metrics", "plugin services"),
    ];
    for (channel, feature) in later {
        let error = client
            .request_on(channel, Payload::Map(Vec::new()))
            .await
            .unwrap_err();
        assert!(
            names_unserved_channel(&error, channel),
            "{channel}: {error:?}"
        );
        assert!(error.message.contains(feature), "{channel}: {error:?}");
    }

    let catalogue = Catalogue::protocol();
    for decl in catalogue.channels() {
        let name = decl.name();
        if !(name.starts_with("plugins:") || name.starts_with("secrets:")) {
            continue;
        }
        let listed = later.iter().any(|(channel, _)| *channel == name);
        assert_eq!(
            unserved::later(name).is_some(),
            listed,
            "{name} is listed as not served yet exactly when it is one of the later ones"
        );
        if !listed && !floti_host_internal(name) {
            assert!(served.contains(name), "{name} is not served");
        }
    }
    let drift = unserved::drift(&catalogue, &served);
    assert!(drift.is_empty(), "{drift}");

    // secrets:list is answered rather than refused.
    assert!(client.request::<SecretsList>(&()).await.unwrap().available);
    drop(client);
    host.stop(HostStopReason::Stop).await;
}

/// The plugin channels that stay inside the host and are never a client's.
fn floti_host_internal(name: &str) -> bool {
    floti_protocol::channels::boundary::HOST_INTERNAL
        .iter()
        .any(|internal| internal.covers(name))
}
