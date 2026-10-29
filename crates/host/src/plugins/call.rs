//! The call layer every `floti.*` method goes through.
//!
//! A method is registered once, by name, from the file that implements it
//! ([`Methods::register`]); the registry finds the plugin a call is for,
//! refuses it when that plugin is not enabled and loaded, and hands the
//! method a [`CallContext`]. A method fails with a [`PluginCallError`],
//! which carries the protocol's [`PluginErrorCode`] so a plugin can tell
//! "not declared" from "the network was down".
//!
//! Arguments and results are protocol payloads: what a page sends is what a
//! method reads, bytes included.

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock, Weak};

use floti_protocol::Payload;
use floti_protocol::channels::plugins::{PluginErrorCode, PluginSurfaceKind};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use super::manifest::Manifest;

/// A bridge call that failed for a reason the plugin is told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginCallError {
    pub code: PluginErrorCode,
    pub message: String,
}

impl PluginCallError {
    pub fn new(code: PluginErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(PluginErrorCode::Invalid, message)
    }

    pub fn not_declared(message: impl Into<String>) -> Self {
        Self::new(PluginErrorCode::NotDeclared, message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new(PluginErrorCode::Unavailable, message)
    }

    pub fn aborted() -> Self {
        Self::new(PluginErrorCode::Aborted, "the call was cancelled")
    }
}

impl fmt::Display for PluginCallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PluginCallError {}

/// Cancellation for a call: the caller's abort, or the plugin stopping under
/// it. Cancelling a token cancels every token made from it with
/// [`child`](Self::child).
#[derive(Clone, Default)]
pub struct CancelToken {
    inner: Arc<CancelInner>,
}

#[derive(Default)]
struct CancelInner {
    cancelled: AtomicBool,
    notify: Notify,
    children: Mutex<Vec<Weak<CancelInner>>>,
}

impl CancelInner {
    fn cancel(&self) {
        if self.cancelled.swap(true, Ordering::SeqCst) {
            return;
        }
        self.notify.notify_waiters();
        let children =
            std::mem::take(&mut *self.children.lock().unwrap_or_else(PoisonError::into_inner));
        for child in children.iter().filter_map(Weak::upgrade) {
            child.cancel();
        }
    }
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    /// A token cancelled with this one, or on its own.
    pub fn child(&self) -> Self {
        let child = Self::new();
        child.follow(self);
        child
    }

    /// Cancels this token with `parent` too, as well as with whatever it
    /// was made from.
    pub fn follow(&self, parent: &CancelToken) {
        let mut children = parent
            .inner
            .children
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if parent.is_cancelled() {
            drop(children);
            self.cancel();
        } else {
            children.retain(|weak| weak.strong_count() > 0);
            children.push(Arc::downgrade(&self.inner));
        }
    }

    pub fn cancel(&self) {
        self.inner.cancel();
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves once the token is cancelled.
    pub async fn cancelled(&self) {
        loop {
            let notified = self.inner.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

impl fmt::Debug for CancelToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CancelToken")
            .field("cancelled", &self.is_cancelled())
            .finish()
    }
}

/// What a method knows about the call it is answering.
#[derive(Debug, Clone)]
pub struct CallContext {
    /// The plugin's id.
    pub plugin: String,
    /// The read of the folder the call is for. A method that outlives it
    /// (the plugin was reloaded) is cancelled.
    pub revision: u64,
    pub manifest: Arc<Manifest>,
    /// The plugin folder, links resolved.
    pub folder: PathBuf,
    pub surface: PluginSurfaceKind,
    /// Cancelled when the caller aborts, or when the plugin is turned off,
    /// reloaded or removed.
    pub cancel: CancelToken,
}

pub type CallResult = Result<Payload, PluginCallError>;

pub type CallFuture = Pin<Box<dyn Future<Output = CallResult> + Send>>;

type Handler = Arc<dyn Fn(CallContext, Vec<Payload>) -> CallFuture + Send + Sync>;

/// Every `floti.*` method, by name.
#[derive(Default)]
pub struct Methods {
    handlers: RwLock<HashMap<&'static str, Handler>>,
}

impl Methods {
    /// Serves `name` with `handler`.
    ///
    /// # Panics
    ///
    /// When `name` is already served: one registration per method.
    pub fn register<F, Fut>(&self, name: &'static str, handler: F)
    where
        F: Fn(CallContext, Vec<Payload>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = CallResult> + Send + 'static,
    {
        let handler: Handler = Arc::new(move |context, args| Box::pin(handler(context, args)));
        let previous = self
            .handlers
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(name, handler);
        assert!(previous.is_none(), "floti.{name} is registered twice");
    }

    /// Serves `name` with a handler that answers at once.
    pub fn register_sync<F>(&self, name: &'static str, handler: F)
    where
        F: Fn(&CallContext, &[Payload]) -> CallResult + Send + Sync + 'static,
    {
        self.register(name, move |context, args| {
            let answer = handler(&context, &args);
            async move { answer }
        });
    }

    /// The call `name` with `args` comes to, or `None` when no method has
    /// that name.
    pub fn start(
        &self,
        name: &str,
        context: CallContext,
        args: Vec<Payload>,
    ) -> Option<CallFuture> {
        let handler = self
            .handlers
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(name)
            .cloned()?;
        Some(handler(context, args))
    }

    pub fn names(&self) -> Vec<&'static str> {
        let mut names: Vec<&'static str> = self
            .handlers
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .keys()
            .copied()
            .collect();
        names.sort_unstable();
        names
    }
}

/// The `undefined` a method that answers nothing answers.
pub fn nothing() -> Payload {
    Payload::Null
}

/// Reads one argument as `T`, or fails the call as `invalid` with `what`.
pub fn argument<T: serde::de::DeserializeOwned>(
    args: &[Payload],
    index: usize,
    what: &str,
) -> Result<T, PluginCallError> {
    let value = args.get(index).cloned().unwrap_or(Payload::Null);
    value
        .deserialized::<T>()
        .map_err(|_| PluginCallError::invalid(what))
}

/// Encodes a method's answer.
pub fn answer<T: Serialize>(value: &T) -> CallResult {
    Payload::serialized(value).map_err(|err| {
        PluginCallError::unavailable(format!("the host could not encode its answer: {err}"))
    })
}

/// What `floti.fetch` sends across: a `Request`, taken apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFetchRequest {
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    #[serde(with = "optional_bytes")]
    pub body: Option<Vec<u8>>,
    pub redirect: FetchRedirect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FetchRedirect {
    Follow,
    Manual,
    Error,
}

/// And what comes back, for the bridge to make a `Response` of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFetchResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    #[serde(with = "serde_bytes")]
    pub body: Vec<u8>,
    pub url: String,
    pub redirected: bool,
}

/// `floti.exec`'s request, checked: the arguments after the manifest's own,
/// what to write to standard input, and how long it may run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecRequest {
    pub args: Vec<String>,
    pub stdin: Option<String>,
    pub timeout_ms: u64,
}

/// How a program ended. A non-zero exit is an answer, not a failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    /// Null when the program was stopped (`timed_out`) or never started.
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

mod optional_bytes {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(
        value: &Option<Vec<u8>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(bytes) => serializer.serialize_bytes(bytes),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Vec<u8>>, D::Error> {
        Option::<serde_bytes::ByteBuf>::deserialize(deserializer)
            .map(|bytes| bytes.map(serde_bytes::ByteBuf::into_vec))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelling_a_token_cancels_its_children_and_theirs() {
        let root = CancelToken::new();
        let child = root.child();
        let grandchild = child.child();
        let apart = CancelToken::new();
        root.cancel();
        assert!(child.is_cancelled() && grandchild.is_cancelled());
        assert!(!apart.is_cancelled());
        assert!(
            root.child().is_cancelled(),
            "a child of a cancelled token starts cancelled"
        );
    }

    #[test]
    #[should_panic(expected = "floti.badge.set is registered twice")]
    fn a_method_is_registered_once() {
        let methods = Methods::default();
        methods.register_sync("badge.set", |_, _| Ok(nothing()));
        methods.register_sync("badge.set", |_, _| Ok(nothing()));
    }

    #[test]
    fn a_fetch_body_crosses_as_bytes() {
        let request = PluginFetchRequest {
            url: "https://example.com/".into(),
            method: "POST".into(),
            headers: vec![("content-type".into(), "text/plain".into())],
            body: Some(b"hi".to_vec()),
            redirect: FetchRedirect::Follow,
        };
        let payload = Payload::serialized(&request).unwrap();
        let body = payload
            .as_map()
            .unwrap()
            .iter()
            .find(|(key, _)| key.as_text() == Some("body"))
            .map(|(_, value)| value.clone());
        assert_eq!(body, Some(Payload::Bytes(b"hi".to_vec())));
        assert_eq!(
            payload.deserialized::<PluginFetchRequest>().unwrap(),
            request
        );
    }
}
