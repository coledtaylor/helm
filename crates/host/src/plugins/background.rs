//! What the registry asks of the runtime that runs plugins' background
//! modules: start one for a read of a folder, stop it, deliver it an event,
//! and hand it a session's tool call.
//!
//! The runtime says how a background is doing through the
//! [`BackgroundReporter`] it was started with, never by calling the registry
//! from inside [`BackgroundRuntime::start`]: the registry may be busy with
//! the read that started it. The host runs them in
//! [`crate::plugins::runtime::IsolateRuntime`]; [`NoBackground`] runs
//! nothing, so every background is shown as stopped, for tests of what
//! needs no script.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use floti_protocol::channels::plugins::{
    PluginBackgroundState, PluginPageSecretState, PluginSession, PluginSettingValue,
};

use super::call::CancelToken;
use super::manifest::Manifest;

/// One read of a plugin folder whose manifest names a background module.
#[derive(Clone)]
pub struct BackgroundLaunch {
    pub plugin: String,
    /// The read it is for. A report for an older one is ignored.
    pub revision: u64,
    /// The plugin folder, links resolved.
    pub folder: PathBuf,
    /// The module, relative to `folder`.
    pub module: String,
    pub manifest: Arc<Manifest>,
    pub reporter: BackgroundReporter,
}

/// Tells the registry how one background is doing.
#[derive(Clone)]
pub struct BackgroundReporter {
    report: Arc<dyn Fn(PluginBackgroundState, Option<String>) + Send + Sync>,
}

impl BackgroundReporter {
    pub(crate) fn new(
        report: impl Fn(PluginBackgroundState, Option<String>) + Send + Sync + 'static,
    ) -> Self {
        Self {
            report: Arc::new(report),
        }
    }

    /// It is running, or it crashed with `error`.
    pub fn report(&self, state: PluginBackgroundState, error: Option<String>) {
        (self.report)(state, error);
    }
}

/// An event for a plugin's background.
#[derive(Debug, Clone, PartialEq)]
pub enum BackgroundEvent {
    /// A Quick Open command with no tab.
    Command { id: String },
    /// The user changed the plugin's settings: every value.
    Settings(BTreeMap<String, PluginSettingValue>),
    /// A declared secret's state moved: every declared key.
    Secrets(BTreeMap<String, PluginPageSecretState>),
    /// The sessions the plugin may see.
    Sessions(Vec<PluginSession>),
}

/// A session calling one of a plugin's tools.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub plugin: String,
    pub tool: String,
    pub args: serde_json::Value,
    pub session: ToolCaller,
}

/// The session a tool call came from: the id minted for it at launch, never
/// anything of its conversation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCaller {
    pub id: String,
    pub name: String,
    pub cwd: String,
}

/// What a tool answered, or why it could not, as the sentence the session
/// reads.
pub type ToolAnswer = Result<serde_json::Value, String>;

pub type ToolFuture = Pin<Box<dyn Future<Output = ToolAnswer> + Send>>;

pub trait BackgroundRuntime: Send + Sync {
    /// Starts the background for `launch`, answering its state now:
    /// `Starting` until it reports, or `Stopped` when nothing will run.
    fn start(&self, launch: BackgroundLaunch) -> PluginBackgroundState;

    /// Ends `plugin`'s background, whichever read it is for.
    fn stop(&self, plugin: &str);

    fn deliver(&self, plugin: &str, event: BackgroundEvent);

    /// Answers a tool call, or stops when `cancel` is cancelled.
    fn call_tool(&self, call: ToolCall, cancel: CancelToken) -> ToolFuture;
}

/// The stand-in until the background runtime is built: it runs nothing.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoBackground;

impl BackgroundRuntime for NoBackground {
    fn start(&self, _launch: BackgroundLaunch) -> PluginBackgroundState {
        PluginBackgroundState::Stopped
    }

    fn stop(&self, _plugin: &str) {}

    fn deliver(&self, _plugin: &str, _event: BackgroundEvent) {}

    fn call_tool(&self, _call: ToolCall, _cancel: CancelToken) -> ToolFuture {
        Box::pin(async { Err("The plugin's background is not running.".to_owned()) })
    }
}
