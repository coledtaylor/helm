//! Every registered plugin folder, what was read from it, and what it is
//! doing: the one place a plugin's state lives.
//!
//! Its semantics are today's (`desktop/main/plugins/host.ts`):
//!
//! - Every read of a folder (start, switching it on, reload) stops what the
//!   last read had running, bumps its revision and reads the folder again.
//!   A folder whose manifest is wrong is kept and listed with what is wrong,
//!   and runs nothing.
//! - Two enabled folders may not be one plugin: the second read of an id
//!   already loaded is listed with an error naming the first folder.
//! - Switching a plugin off stops it and bumps its revision without reading.
//! - Removing one forgets its settings and deletes, of the secrets only it
//!   could use, only those the client chose.
//!
//! Every change a client asks for answers the whole list, and the same list
//! goes to every subscriber of `plugins:changed` before the answer does.
//! What a plugin does itself (its status, its badge, its background
//! starting) is pushed once per turn, however many changes the turn made.
//! A background script's calls from one pass of its event loop come as one
//! batch, and every call in it is started before anything is pushed
//! ([`Registry::hold_pushes`]).
//!
//! Locks are taken in one order: publishing, then held, then the state, then
//! the store.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use floti_protocol::Payload;
use floti_protocol::channels::plugins::{
    PluginAddResult, PluginBackgroundState, PluginErrorCode, PluginInfo, PluginPageSecretState,
    PluginSecretState, PluginSettingSpec, PluginSettingValue, PluginStatusItem, PluginStatusTone,
    PluginSurfaceKind,
};

use super::background::{
    BackgroundEvent, BackgroundLaunch, BackgroundReporter, BackgroundRuntime, ToolAnswer, ToolCall,
};
use super::call::{
    CallContext, CallResult, CancelToken, Methods, PluginCallError, answer, nothing,
};
use super::info::{self, Live};
use super::loader::{self, LoadFailure, LoadResult, LoadedPlugin};
use super::manifest::{MANIFEST_FILE, Manifest};
use super::net::service::{PluginServices, ServicePlugin};
use super::secrets::SecretsAccess;
use super::settings;
use super::store::{self, PluginFolder};
use crate::store::Store;

const STATUS_TEXT_MAX: usize = 80;
const STATUS_TOOLTIP_MAX: usize = 300;
const BADGE_MAX: u32 = 99_999;
const TONES: &str = "neutral, accent, success, warn, danger";

/// What the registry is built with.
pub struct RegistryParts {
    pub store: Arc<Mutex<Store>>,
    pub background: Arc<dyn BackgroundRuntime>,
    pub secrets: Arc<dyn SecretsAccess>,
    /// Each read's service, for a plugin that declares one.
    pub services: Arc<dyn PluginServices>,
    /// Sends every subscriber the whole list.
    pub publish: Publish,
}

/// How the registry sends every subscriber the whole list.
pub type Publish = Box<dyn Fn(&Vec<PluginInfo>) + Send + Sync>;

/// One bridge call, as the page or background that made it sent it.
pub struct PluginCall {
    /// The plugin's id, established by whoever relayed the call, never by
    /// anything the plugin wrote.
    pub plugin: String,
    pub surface: PluginSurfaceKind,
    pub method: String,
    pub args: Vec<Payload>,
    /// The caller's abort.
    pub cancel: CancelToken,
}

/// The plugin registry. Cloning it is cheap; every clone is the same one.
#[derive(Clone)]
pub struct Registry {
    inner: Arc<Inner>,
}

/// A registry that does not keep it alive: what the background runtime
/// holds, since the registry holds the runtime.
#[derive(Clone)]
pub struct WeakRegistry {
    inner: Weak<Inner>,
}

impl WeakRegistry {
    pub fn upgrade(&self) -> Option<Registry> {
        self.inner.upgrade().map(|inner| Registry { inner })
    }
}

struct Inner {
    store: Arc<Mutex<Store>>,
    background: Arc<dyn BackgroundRuntime>,
    secrets: Arc<dyn SecretsAccess>,
    services: Arc<dyn PluginServices>,
    publish: Publish,
    methods: Methods,
    state: Mutex<State>,
    /// Held while a list is made and sent, so subscribers see lists in the
    /// order they were made.
    publishing: Mutex<()>,
    /// A push is already on its way for this turn.
    pending: AtomicBool,
    /// Taken after `publishing`, never before it.
    held: Mutex<Held>,
    stopped: AtomicBool,
    myself: Weak<Inner>,
}

/// The batches of calls being started ([`Registry::hold_pushes`]), and
/// whether a push waits for them to be.
#[derive(Default)]
struct Held {
    batches: usize,
    waiting: bool,
}

/// Holds back what plugins paint until it is dropped; then one push carries
/// all of it.
pub struct PushesHeld {
    inner: Arc<Inner>,
}

impl Drop for PushesHeld {
    fn drop(&mut self) {
        let waiting = {
            let mut held = lock(&self.inner.held);
            held.batches -= 1;
            held.batches == 0 && std::mem::take(&mut held.waiting)
        };
        if waiting {
            self.inner.changed_soon();
        }
    }
}

#[derive(Default)]
struct State {
    entries: Vec<Entry>,
    revisions: u64,
}

#[derive(Debug, Clone)]
enum Load {
    Loaded(Arc<LoadedPlugin>),
    Failed(LoadFailure),
}

struct Entry {
    folder: PluginFolder,
    load: Load,
    revision: u64,
    status: Option<PluginStatusItem>,
    badge: Option<u32>,
    background: PluginBackgroundState,
    background_error: Option<String>,
    /// Cancelled when what this read started stops: every call in flight for
    /// the plugin is a child of it.
    runtime: CancelToken,
}

impl Entry {
    fn new(folder: PluginFolder) -> Self {
        Self {
            folder,
            load: Load::Failed(LoadFailure {
                error: "not read yet".into(),
                warnings: Vec::new(),
                id: None,
                name: None,
            }),
            revision: 0,
            status: None,
            badge: None,
            background: PluginBackgroundState::Stopped,
            background_error: None,
            runtime: CancelToken::new(),
        }
    }

    /// The plugin, when it is enabled and loaded: the only state in which it
    /// does anything.
    fn live(&self) -> Option<&Arc<LoadedPlugin>> {
        match &self.load {
            Load::Loaded(plugin) if self.folder.enabled => Some(plugin),
            _ => None,
        }
    }

    fn loaded_id(&self) -> Option<&str> {
        match &self.load {
            Load::Loaded(plugin) => Some(&plugin.manifest.id),
            Load::Failed(_) => None,
        }
    }

    fn is_at(&self, path: &str) -> bool {
        self.folder.path.to_lowercase() == path.to_lowercase()
    }
}

/// What has to happen to backgrounds and services once the state's lock is
/// let go.
enum Effect {
    Stop(String),
    Start(BackgroundLaunch),
    /// The read (plugin, revision) stopped: its service ends.
    CloseService(String, u64),
    OpenService(ServicePlugin),
    /// The read's calls in flight end. After its service has closed, so a
    /// call waiting for the service is answered as the service answers it.
    Cancel(CancelToken),
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn text(err: crate::Error) -> String {
    err.to_string()
}

impl Registry {
    /// A registry with nothing read yet; [`start`](Self::start) reads the
    /// registered folders.
    pub fn new(parts: RegistryParts) -> Self {
        let inner = Arc::new_cyclic(|myself: &Weak<Inner>| Inner {
            store: parts.store,
            background: parts.background,
            secrets: parts.secrets,
            services: parts.services,
            publish: parts.publish,
            methods: Methods::default(),
            state: Mutex::new(State::default()),
            publishing: Mutex::new(()),
            pending: AtomicBool::new(false),
            held: Mutex::new(Held::default()),
            stopped: AtomicBool::new(false),
            myself: myself.clone(),
        });
        register_standard(&inner.methods, &inner.myself);
        Self { inner }
    }

    pub fn downgrade(&self) -> WeakRegistry {
        WeakRegistry {
            inner: Arc::downgrade(&self.inner),
        }
    }

    /// The methods every call goes through, for a feature to register its
    /// own on.
    pub fn methods(&self) -> &Methods {
        &self.inner.methods
    }

    /// Holds back what plugins paint while a batch of calls is started, so
    /// a status and a badge set together reach clients in one push. A push
    /// already being made finishes first, and holds nothing of the batch.
    pub fn hold_pushes(&self) -> PushesHeld {
        let _publishing = lock(&self.inner.publishing);
        lock(&self.inner.held).batches += 1;
        PushesHeld {
            inner: Arc::clone(&self.inner),
        }
    }

    /// Reads every registered folder, in the order they were added. Sends
    /// nothing: nobody has the list yet.
    pub fn start(&self) -> crate::Result<()> {
        let folders = store::read_folders(lock(&self.inner.store).connection())?;
        let effects = {
            let mut state = lock(&self.inner.state);
            let mut effects = Vec::new();
            for folder in folders {
                state.entries.push(Entry::new(folder));
                let at = state.entries.len() - 1;
                effects.extend(self.inner.read(&mut state, at));
            }
            effects
        };
        self.inner.run(effects);
        Ok(())
    }

    /// Every registered folder, as a client draws it.
    pub fn list(&self) -> Vec<PluginInfo> {
        self.inner.list()
    }

    /// Registers a folder and reads it. A folder with no manifest is refused
    /// with a sentence and not registered; one already registered is
    /// answered as it is.
    pub fn add(&self, path: &str) -> Result<PluginAddResult, String> {
        let refuse = |error: String| PluginAddResult {
            path: path.to_owned(),
            error: Some(error),
            plugins: self.list(),
        };
        let folder = Path::new(path);
        if !folder.is_absolute() {
            return Ok(refuse("Choose a folder.".into()));
        }
        // A folder already registered under any spelling is that folder,
        // whether or not this file system reaches it by this one.
        let registered = lock(&self.inner.state)
            .entries
            .iter()
            .any(|entry| entry.is_at(path));
        if registered {
            return Ok(PluginAddResult {
                path: path.to_owned(),
                error: None,
                plugins: self.list(),
            });
        }
        if !folder.is_dir() {
            return Ok(refuse(format!("{path} is not a folder.")));
        }
        if !folder.join(MANIFEST_FILE).exists() {
            return Ok(refuse(format!(
                "There is no {MANIFEST_FILE} in {path}. Choose the folder that holds the plugin's manifest."
            )));
        }
        let plugins = self.inner.change(|inner, state| {
            if state.entries.iter().any(|entry| entry.is_at(path)) {
                return Ok((Vec::new(), false));
            }
            let folder = store::add_folder(lock(&inner.store).connection(), path).map_err(text)?;
            state.entries.push(Entry::new(folder));
            let at = state.entries.len() - 1;
            Ok((inner.read(state, at), true))
        })?;
        Ok(PluginAddResult {
            path: path.to_owned(),
            error: None,
            plugins,
        })
    }

    /// Unregisters a folder, forgets its plugin's settings, and deletes the
    /// keys in `delete_secrets` that only this plugin could use.
    pub fn remove(&self, path: &str, delete_secrets: &[String]) -> Result<Vec<PluginInfo>, String> {
        self.inner.change(|inner, state| {
            let at = entry_at(state, path)?;
            let effects = inner.stop_runtime(&mut state.entries[at]);
            let entry = state.entries.remove(at);
            let id = entry.loaded_id().map(str::to_owned);
            let store = lock(&inner.store);
            let conn = store.connection();
            store::remove_folder(conn, &entry.folder.path).map_err(text)?;
            if let Some(id) = id {
                // Settings are kept by id: another folder that reads as the
                // same plugin keeps them.
                if !state
                    .entries
                    .iter()
                    .any(|other| other.loaded_id() == Some(&id))
                {
                    store::forget_settings(conn, &id).map_err(text)?;
                }
                let own = store::own_secret_keys(conn, &id).map_err(text)?;
                let mut removed = Vec::new();
                for key in delete_secrets.iter().filter(|key| own.contains(key)) {
                    if store::delete_secret(conn, key).map_err(text)? {
                        removed.push(key.clone());
                    }
                }
                drop(store);
                if !removed.is_empty() {
                    inner.secrets.removed(&removed);
                }
            }
            Ok((effects, true))
        })
    }

    pub fn set_enabled(&self, path: &str, enabled: bool) -> Result<Vec<PluginInfo>, String> {
        self.inner.change(|inner, state| {
            let at = entry_at(state, path)?;
            if state.entries[at].folder.enabled == enabled {
                return Ok((Vec::new(), false));
            }
            store::set_enabled(lock(&inner.store).connection(), path, enabled).map_err(text)?;
            state.entries[at].folder.enabled = enabled;
            if enabled {
                return Ok((inner.read(state, at), true));
            }
            let effects = inner.stop_runtime(&mut state.entries[at]);
            state.revisions += 1;
            let revision = state.revisions;
            let entry = &mut state.entries[at];
            entry.background = PluginBackgroundState::Stopped;
            entry.background_error = None;
            entry.revision = revision;
            Ok((effects, true))
        })
    }

    /// Reads the folder again.
    pub fn reload(&self, path: &str) -> Result<Vec<PluginInfo>, String> {
        self.inner.change(|inner, state| {
            let at = entry_at(state, path)?;
            Ok((inner.read(state, at), true))
        })
    }

    /// One value on a plugin's settings page, or unset to go back to the
    /// manifest's default. A value that does not fit is refused with the
    /// sentence the page shows.
    pub fn set_setting(
        &self,
        plugin: &str,
        key: &str,
        value: &PluginSettingValue,
    ) -> Result<Vec<PluginInfo>, String> {
        self.inner.change(|inner, state| {
            let entry = state
                .entries
                .iter()
                .find(|entry| entry.loaded_id() == Some(plugin))
                .ok_or_else(|| format!("{plugin} is not a loaded plugin"))?;
            let Load::Loaded(loaded) = &entry.load else {
                unreachable!("found by its loaded id");
            };
            let manifest = &loaded.manifest;
            let spec = manifest
                .settings
                .iter()
                .find(|spec| settings::key(spec) == key)
                .filter(|spec| !matches!(spec, PluginSettingSpec::Secret { .. }))
                .ok_or_else(|| format!("{key} is not one of {}'s settings", manifest.name))?;
            if !matches!(value, PluginSettingValue::Unset)
                && let Some(problem) = settings::problem(spec, value)
            {
                return Err(problem);
            }
            let store = lock(&inner.store);
            store::write_setting(
                store.connection(),
                plugin,
                key,
                settings::to_json(value).as_ref(),
            )
            .map_err(text)?;
            let values = settings::values(
                &manifest.settings,
                &store::read_settings(store.connection(), plugin).unwrap_or_default(),
            );
            drop(store);
            if entry.live().is_some() && manifest.background.is_some() {
                inner
                    .background
                    .deliver(plugin, BackgroundEvent::Settings(values));
            }
            Ok((Vec::new(), true))
        })
    }

    /// A Quick Open command with no tab, for the plugin's background.
    pub fn command(&self, plugin: &str, id: &str) -> Result<(), String> {
        let state = lock(&self.inner.state);
        let loaded = by_id(&state, plugin)
            .and_then(Entry::live)
            .ok_or_else(|| format!("{plugin} is not an enabled plugin"))?;
        let manifest = &loaded.manifest;
        if !manifest.commands.iter().any(|command| command.id == id) {
            return Err(format!(
                "\"{id}\" is not one of {}'s commands",
                manifest.name
            ));
        }
        if manifest.background.is_none() {
            return Err(format!(
                "{} has no background to run \"{id}\"",
                manifest.name
            ));
        }
        drop(state);
        self.inner
            .background
            .deliver(plugin, BackgroundEvent::Command { id: id.to_owned() });
        Ok(())
    }

    /// The stored secret keys no other plugin may use: what removing this
    /// one offers to delete.
    pub fn own_secrets(&self, path: &str) -> Result<Vec<String>, String> {
        let state = lock(&self.inner.state);
        let at = entry_at(&state, path)?;
        let Some(id) = state.entries[at].loaded_id() else {
            return Ok(Vec::new());
        };
        store::own_secret_keys(lock(&self.inner.store).connection(), id).map_err(text)
    }

    /// Answers a bridge call: the plugin must be enabled and loaded, and the
    /// method one the host serves.
    pub async fn call(&self, call: PluginCall) -> CallResult {
        if self.inner.stopped.load(Ordering::SeqCst) {
            return Err(PluginCallError::unavailable("the host is shutting down"));
        }
        let context = {
            let state = lock(&self.inner.state);
            let entry = by_id(&state, &call.plugin)
                .filter(|entry| entry.live().is_some())
                .ok_or_else(|| PluginCallError::unavailable("the plugin is not enabled"))?;
            let plugin = entry.live().expect("filtered to live entries");
            let cancel = entry.runtime.child();
            cancel.follow(&call.cancel);
            CallContext {
                plugin: call.plugin.clone(),
                revision: entry.revision,
                manifest: Arc::new(plugin.manifest.clone()),
                folder: plugin.dir.clone(),
                surface: call.surface,
                cancel,
            }
        };
        let cancel = context.cancel.clone();
        let Some(running) = self.inner.methods.start(&call.method, context, call.args) else {
            return Err(PluginCallError::invalid(format!(
                "floti.{} is not part of the bridge",
                call.method
            )));
        };
        // An answer that is there wins over a cancel that came with it.
        tokio::select! {
            biased;
            answer = running => answer,
            () = cancel.cancelled() => Err(PluginCallError::aborted()),
        }
    }

    /// Hands a session's call to one of a plugin's tools to its background
    /// script. A plugin that is not on, or a tool its manifest does not
    /// declare, is refused here, before anything reaches the script; the
    /// answer is the sentence the session reads.
    pub async fn call_tool(&self, call: ToolCall, cancel: CancelToken) -> ToolAnswer {
        if self.inner.stopped.load(Ordering::SeqCst) {
            return Err("The host is shutting down.".to_owned());
        }
        {
            let state = lock(&self.inner.state);
            let plugin = by_id(&state, &call.plugin).and_then(Entry::live);
            let Some((name, agent)) = plugin.and_then(|plugin| {
                plugin
                    .manifest
                    .agent
                    .as_ref()
                    .map(|agent| (&plugin.manifest.name, agent))
            }) else {
                return Err(
                    "The plugin is not offering tools any more: it was turned off or removed."
                        .to_owned(),
                );
            };
            if !agent.tools.iter().any(|tool| tool.name == call.tool) {
                let offered: Vec<&str> =
                    agent.tools.iter().map(|tool| tool.name.as_str()).collect();
                return Err(format!(
                    "{name} has no tool called \"{}\". It has: {}.",
                    call.tool,
                    offered.join(", ")
                ));
            }
        }
        self.inner.background.call_tool(call, cancel).await
    }

    /// The background runtime's word on one background, for the read it was
    /// started for. A crash clears what the plugin painted: the status bar
    /// and the rail say nothing rather than something stale.
    pub fn background_state(
        &self,
        plugin: &str,
        revision: u64,
        state: PluginBackgroundState,
        error: Option<String>,
    ) {
        self.inner.background_state(plugin, revision, state, error);
    }

    /// The secret store moved: every plugin that declares secrets hears each
    /// one's state, and the list is sent again.
    pub fn secrets_changed(&self) {
        let deliveries: Vec<(
            String,
            std::collections::BTreeMap<String, PluginPageSecretState>,
        )> = {
            let state = lock(&self.inner.state);
            state
                .entries
                .iter()
                .filter_map(Entry::live)
                .filter(|plugin| {
                    plugin.manifest.background.is_some() && !plugin.manifest.secrets.is_empty()
                })
                .map(|plugin| {
                    let id = plugin.manifest.id.clone();
                    let states = plugin
                        .manifest
                        .secrets
                        .iter()
                        .map(|key| {
                            let ready =
                                self.inner.secrets.state(&id, key) == PluginSecretState::Ready;
                            let state = if ready {
                                PluginPageSecretState::Ready
                            } else {
                                PluginPageSecretState::Missing
                            };
                            (key.clone(), state)
                        })
                        .collect();
                    (id, states)
                })
                .collect()
        };
        for (plugin, states) in deliveries {
            self.inner
                .background
                .deliver(&plugin, BackgroundEvent::Secrets(states));
        }
        self.inner.changed_soon();
    }

    /// Stops everything every plugin has running, and refuses calls from now
    /// on.
    pub fn shutdown(&self) {
        self.inner.stopped.store(true, Ordering::SeqCst);
        let effects = {
            let mut state = lock(&self.inner.state);
            let mut effects = Vec::new();
            for entry in &mut state.entries {
                effects.extend(self.inner.stop_runtime(entry));
            }
            effects
        };
        self.inner.run(effects);
    }
}

fn entry_at(state: &State, path: &str) -> Result<usize, String> {
    state
        .entries
        .iter()
        .position(|entry| entry.is_at(path))
        .ok_or_else(|| format!("{path} is not a registered plugin folder"))
}

fn by_id<'a>(state: &'a State, id: &str) -> Option<&'a Entry> {
    state
        .entries
        .iter()
        .find(|entry| entry.live().is_some_and(|plugin| plugin.manifest.id == id))
}

fn by_id_mut<'a>(state: &'a mut State, id: &str) -> Option<&'a mut Entry> {
    state
        .entries
        .iter_mut()
        .find(|entry| entry.live().is_some_and(|plugin| plugin.manifest.id == id))
}

impl Inner {
    /// Runs one change a client asked for: `change` answers what has to
    /// happen to backgrounds and whether anything moved. The list it comes
    /// to is sent to every subscriber, then answered.
    fn change(
        &self,
        change: impl FnOnce(&Self, &mut State) -> Result<(Vec<Effect>, bool), String>,
    ) -> Result<Vec<PluginInfo>, String> {
        let _publishing = lock(&self.publishing);
        let (effects, moved) = {
            let mut state = lock(&self.state);
            change(self, &mut state)?
        };
        self.run(effects);
        let list = self.list();
        if moved {
            (self.publish)(&list);
        }
        Ok(list)
    }

    fn list(&self) -> Vec<PluginInfo> {
        let state = lock(&self.state);
        state
            .entries
            .iter()
            .map(|entry| {
                let live = Live {
                    folder: &entry.folder,
                    revision: entry.revision,
                    status: entry.status.as_ref(),
                    badge: entry.badge,
                    background: entry.background,
                    background_error: entry.background_error.as_deref(),
                    service: entry
                        .loaded_id()
                        .and_then(|id| self.services.status(id, entry.revision)),
                };
                match &entry.load {
                    Load::Failed(failure) => info::failed(&live, failure),
                    Load::Loaded(plugin) => {
                        // The store is let go before the secrets are asked:
                        // they read it too.
                        let stored = store::read_settings(
                            lock(&self.store).connection(),
                            &plugin.manifest.id,
                        )
                        .unwrap_or_default();
                        let values = settings::values(&plugin.manifest.settings, &stored);
                        info::loaded(&live, plugin, values, self.secrets.as_ref())
                    }
                }
            })
            .collect()
    }

    /// Sends the list once this turn is over, however many changes it made.
    fn changed_soon(&self) {
        if self.pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            self.pending.store(false, Ordering::SeqCst);
            self.publish_now();
            return;
        };
        let myself = self.myself.clone();
        runtime.spawn(async move {
            tokio::task::yield_now().await;
            if let Some(inner) = myself.upgrade() {
                inner.pending.store(false, Ordering::SeqCst);
                inner.publish_now();
            }
        });
    }

    fn publish_now(&self) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let _publishing = lock(&self.publishing);
        {
            let mut held = lock(&self.held);
            if held.batches > 0 {
                // The last batch to be started sends it.
                held.waiting = true;
                return;
            }
        }
        let list = self.list();
        (self.publish)(&list);
    }

    /// Everything the entry's last read had running: its calls, its
    /// background, what it painted.
    fn stop_runtime(&self, entry: &mut Entry) -> Vec<Effect> {
        entry.status = None;
        entry.badge = None;
        let had_background = entry.background != PluginBackgroundState::Stopped;
        let mut effects = Vec::new();
        if let Load::Loaded(plugin) = &entry.load {
            let id = &plugin.manifest.id;
            if had_background {
                effects.push(Effect::Stop(id.clone()));
            }
            if plugin.manifest.service.is_some() {
                effects.push(Effect::CloseService(id.clone(), entry.revision));
            }
        }
        effects.push(Effect::Cancel(entry.runtime.clone()));
        effects
    }

    /// Reads (or reads again) the folder of the entry at `at`.
    fn read(&self, state: &mut State, at: usize) -> Vec<Effect> {
        let mut effects = self.stop_runtime(&mut state.entries[at]);
        state.revisions += 1;
        let revision = state.revisions;
        let load = match loader::load_folder(&state.entries[at].folder.path) {
            LoadResult::Failed(failure) => Load::Failed(failure),
            LoadResult::Loaded(plugin) => {
                let taken = state.entries.iter().enumerate().find(|(index, other)| {
                    *index != at
                        && other
                            .live()
                            .is_some_and(|live| live.manifest.id == plugin.manifest.id)
                });
                match taken {
                    Some((_, other)) => Load::Failed(LoadFailure {
                        error: format!(
                            "a plugin with the id \"{}\" is already loaded from {}",
                            plugin.manifest.id, other.folder.path
                        ),
                        warnings: plugin.warnings.clone(),
                        id: Some(plugin.manifest.id.clone()),
                        name: Some(plugin.manifest.name.clone()),
                    }),
                    None => Load::Loaded(Arc::new(*plugin)),
                }
            }
        };
        let entry = &mut state.entries[at];
        entry.revision = revision;
        entry.load = load;
        entry.runtime = CancelToken::new();
        entry.background_error = None;
        entry.background = PluginBackgroundState::Stopped;
        if let Some(plugin) = entry.live().cloned()
            && let Some(module) = plugin.manifest.background.clone()
        {
            entry.background = PluginBackgroundState::Starting;
            effects.push(Effect::Start(BackgroundLaunch {
                plugin: plugin.manifest.id.clone(),
                revision,
                folder: plugin.dir.clone(),
                module,
                manifest: Arc::new(plugin.manifest.clone()),
                reporter: self.reporter(&plugin.manifest.id, revision),
            }));
        }
        if let Some(plugin) = entry.live().cloned()
            && let Some(spec) = plugin.manifest.service.clone()
        {
            let myself = self.myself.clone();
            effects.push(Effect::OpenService(ServicePlugin {
                plugin: plugin.manifest.id.clone(),
                revision,
                folder: plugin.dir.clone(),
                spec,
                secrets: plugin.manifest.secrets.clone(),
                changed: Arc::new(move || {
                    if let Some(inner) = myself.upgrade() {
                        inner.changed_soon();
                    }
                }),
            }));
        }
        effects
    }

    fn reporter(&self, plugin: &str, revision: u64) -> BackgroundReporter {
        let myself = self.myself.clone();
        let plugin = plugin.to_owned();
        BackgroundReporter::new(move |state, error| {
            if let Some(inner) = myself.upgrade() {
                inner.background_state(&plugin, revision, state, error);
            }
        })
    }

    /// Starts and stops backgrounds and services, outside the state's lock.
    fn run(&self, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::Stop(plugin) => self.background.stop(&plugin),
                Effect::CloseService(plugin, revision) => self.services.close(&plugin, revision),
                Effect::OpenService(service) => self.services.open(service),
                Effect::Cancel(runtime) => runtime.cancel(),
                Effect::Start(launch) => {
                    let (plugin, revision) = (launch.plugin.clone(), launch.revision);
                    let now = self.background.start(launch);
                    if now == PluginBackgroundState::Starting {
                        continue;
                    }
                    let mut state = lock(&self.state);
                    if let Some(entry) = by_id_mut(&mut state, &plugin)
                        && entry.revision == revision
                        && entry.background == PluginBackgroundState::Starting
                    {
                        entry.background = now;
                    }
                }
            }
        }
    }

    fn background_state(
        &self,
        plugin: &str,
        revision: u64,
        now: PluginBackgroundState,
        error: Option<String>,
    ) {
        {
            let mut state = lock(&self.state);
            let Some(entry) = by_id_mut(&mut state, plugin) else {
                return;
            };
            if entry.revision != revision || entry.background == PluginBackgroundState::Stopped {
                return;
            }
            let crashed = now == PluginBackgroundState::Crashed;
            if crashed && entry.background != PluginBackgroundState::Crashed {
                entry.status = None;
                entry.badge = None;
            }
            entry.background = now;
            entry.background_error =
                crashed.then(|| error.unwrap_or_else(|| "it stopped responding".into()));
        }
        self.changed_soon();
    }

    /// Runs `change` on the live entry a call was for, while it is still the
    /// read the call was made against.
    fn painted(&self, context: &CallContext, change: impl FnOnce(&mut Entry)) {
        {
            let mut state = lock(&self.state);
            match by_id_mut(&mut state, &context.plugin) {
                Some(entry) if entry.revision == context.revision => change(entry),
                _ => return,
            }
        }
        self.changed_soon();
    }

    fn setting_values(
        &self,
        manifest: &Manifest,
    ) -> std::collections::BTreeMap<String, PluginSettingValue> {
        let stored =
            store::read_settings(lock(&self.store).connection(), &manifest.id).unwrap_or_default();
        settings::values(&manifest.settings, &stored)
    }
}

/// `settings.get`, `status.set` and `badge.set`: the methods that read and
/// paint the plugin's own state.
fn register_standard(methods: &Methods, registry: &Weak<Inner>) {
    let gone = || PluginCallError::unavailable("the host is shutting down");

    let weak = registry.clone();
    methods.register_sync("settings.get", move |context, _args| {
        let inner = weak.upgrade().ok_or_else(gone)?;
        answer(&inner.setting_values(&context.manifest))
    });

    let weak = registry.clone();
    methods.register_sync("status.set", move |context, args| {
        let inner = weak.upgrade().ok_or_else(gone)?;
        let item = read_status(args)?;
        inner.painted(context, |entry| entry.status = item);
        Ok(nothing())
    });

    let weak = registry.clone();
    methods.register_sync("badge.set", move |context, args| {
        let inner = weak.upgrade().ok_or_else(gone)?;
        let badge = read_badge(args)?;
        inner.painted(context, |entry| entry.badge = badge);
        Ok(nothing())
    });
}

/// `floti.status.set`'s item, checked: it came from a plugin.
fn read_status(args: &[Payload]) -> Result<Option<PluginStatusItem>, PluginCallError> {
    let shape = || PluginCallError::invalid("a status item is an object, or null");
    let value: serde_json::Value = match args.first() {
        None => return Err(shape()),
        Some(Payload::Null) => return Ok(None),
        Some(item) => item.deserialized().map_err(|_| shape())?,
    };
    let item = value.as_object().ok_or_else(shape)?;
    let text = item
        .get("text")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if text.trim().is_empty() || text.encode_utf16().count() > STATUS_TEXT_MAX {
        return Err(PluginCallError::invalid(format!(
            "a status item's text is 1-{STATUS_TEXT_MAX} characters"
        )));
    }
    let tone = match item.get("tone") {
        None => None,
        Some(tone) => Some(
            serde_json::from_value::<PluginStatusTone>(tone.clone())
                .map_err(|_| PluginCallError::invalid(format!("tone is one of {TONES}")))?,
        ),
    };
    let tooltip = match item.get("tooltip") {
        None => None,
        Some(serde_json::Value::String(tooltip))
            if tooltip.encode_utf16().count() <= STATUS_TOOLTIP_MAX =>
        {
            Some(tooltip.clone())
        }
        Some(_) => {
            return Err(PluginCallError::invalid(format!(
                "a tooltip is at most {STATUS_TOOLTIP_MAX} characters"
            )));
        }
    };
    Ok(Some(PluginStatusItem {
        text: text.trim().to_owned(),
        tone,
        tooltip,
    }))
}

/// `floti.badge.set`'s count: a whole number of zero or more, capped, or
/// null. Zero clears it, as null does.
fn read_badge(args: &[Payload]) -> Result<Option<u32>, PluginCallError> {
    let shape = || {
        PluginCallError::new(
            PluginErrorCode::Invalid,
            "a badge is a whole number of zero or more, or null",
        )
    };
    let count = match args.first() {
        Some(Payload::Null) => return Ok(None),
        Some(Payload::Integer(count)) => i128::from(*count),
        Some(Payload::Float(count)) if count.fract() == 0.0 && count.is_finite() => {
            // A whole float, compared and capped below.
            #[allow(clippy::cast_possible_truncation)]
            {
                *count as i128
            }
        }
        _ => return Err(shape()),
    };
    if count < 0 {
        return Err(shape());
    }
    if count == 0 {
        return Ok(None);
    }
    Ok(Some(
        u32::try_from(count.min(i128::from(BADGE_MAX))).unwrap_or(BADGE_MAX),
    ))
}
