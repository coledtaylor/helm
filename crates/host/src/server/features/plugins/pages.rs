//! Plugin pages' calls, framed by a client and answered here:
//! `plugins:call`, `plugins:cancel`, `plugins:answer` and `plugins:session`,
//! and the bridge methods only a client can finish, `secrets.request` and
//! `sessions.start`, which ask on `plugins:ui`.
//!
//! **Each call is the calling client's.** A call is held by the client that
//! relayed it and the id that client chose, so only that client can cancel
//! it, and every call a client holds is cancelled when it leaves. A call ends
//! with its answer, its cancel, the plugin turned off or reloaded, or its
//! client leaving; nothing here waits on a timer.
//!
//! **An ask goes to the client whose page asked.** The secret dialog and the
//! session dialog are put up on that client only (`plugins:ui` is per
//! client), and only that client's answer counts. A session ask is withdrawn
//! (`sessionWithdrawn`) when its call ends first. A plugin has at most one
//! session ask waiting.
//!
//! **What a session runs is composed here.** `plugins:session` says yes or
//! no and the terminal size; the folder, name and first message are the ones
//! the host checked when the plugin asked, which the dialog showed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use floti_protocol::channel::{Later, Router};
use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::plugins::{
    PluginCallOutcome, PluginCallRequest, PluginErrorCode, PluginPageSecretState,
    PluginSecretState, PluginSurfaceKind, PluginUiRequest, PluginsAnswer, PluginsCall,
    PluginsCancel, PluginsSession, PluginsUi,
};
use floti_protocol::channels::sessions::StartSessionRequest;
use floti_protocol::{BackendId, Payload};
use tokio::sync::oneshot;

use super::sessions::PluginSessions;
use crate::agent::new_conversation_id;
use crate::devices::Role;
use crate::plugins::call::{
    CallContext, CallOrigin, CancelToken, Methods, PluginCallError, answer,
};
use crate::plugins::secrets::SecretsAccess;
use crate::plugins::{PluginCall, Registry};
use crate::server::events::Events;
use crate::server::features::{ActivityHandle, Caller};
use crate::server::hosted::Hosted;
use crate::session::ClientId;

/// The longest first message a plugin may ask a session to start with.
const SESSION_PROMPT_MAX: usize = 2000;
/// The longest name a plugin may give a session it asks for.
const SESSION_NAME_MAX: usize = 60;

/// The sentence a page that may not ask for a session is refused with.
const SESSION_FROM_A_CLICK: &str = "only a panel or a tab can ask for a session, from a click";

/// The sentence a viewer device is refused a session with.
const SESSION_NOT_FOR_VIEWERS: &str =
    "Starting a session takes an operator or admin device, and this device is paired as a viewer.";

/// The calls and asks the pages of every client have open.
pub(crate) struct Pages {
    events: Arc<Events>,
    hosted: Weak<Hosted>,
    activity: ActivityHandle,
    state: Mutex<Open>,
}

#[derive(Default)]
struct Open {
    /// Each call in flight, by its client and the id that client chose.
    calls: HashMap<(ClientId, String), CancelToken>,
    secrets: HashMap<String, SecretAsk>,
    sessions: HashMap<String, SessionAsk>,
}

/// A secret dialog up on one client.
struct SecretAsk {
    client: ClientId,
    closed: oneshot::Sender<()>,
}

/// A session dialog up on one client, with what the host checked.
struct SessionAsk {
    client: ClientId,
    plugin: String,
    asked: AskedSession,
    settled: oneshot::Sender<Settled>,
}

/// What a plugin asked to start, checked.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AskedSession {
    cwd: String,
    name: String,
    prompt: String,
}

/// How a session ask ended.
enum Settled {
    Started,
    Cancelled,
    Failed(String),
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Pages {
    /// Serves `plugins:ui` one client at a time on `events`.
    pub fn new(events: &Arc<Events>, hosted: &Arc<Hosted>, activity: ActivityHandle) -> Self {
        events.serve_per_client::<PluginsUi>();
        Self {
            events: Arc::clone(events),
            hosted: Arc::downgrade(hosted),
            activity,
            state: Mutex::new(Open::default()),
        }
    }

    fn open(&self) -> MutexGuard<'_, Open> {
        lock(&self.state)
    }

    /// Registers `secrets.request`, `sessions.list` and `sessions.start`.
    pub fn register_methods(
        self: &Arc<Self>,
        methods: &Methods,
        secrets: Arc<dyn SecretsAccess>,
        sessions: Arc<PluginSessions>,
    ) {
        let pages = Arc::clone(self);
        methods.register("secrets.request", move |context, args| {
            let pages = Arc::clone(&pages);
            let secrets = Arc::clone(&secrets);
            async move { pages.secret(context, &args, secrets.as_ref()).await }
        });
        methods.register_sync("sessions.list", move |context, _| {
            if !context.manifest.sessions.list {
                return Err(PluginCallError::not_declared(
                    "the manifest's sessions does not list \"list\"",
                ));
            }
            answer(&sessions.list())
        });
        let pages = Arc::clone(self);
        methods.register("sessions.start", move |context, args| {
            let pages = Arc::clone(&pages);
            async move { pages.session(context, &args).await }
        });
    }

    /// Registers the page channels for `caller`.
    pub fn requests<'a>(
        self: &'a Arc<Self>,
        registry: &'a Registry,
        caller: Caller,
        router: &mut Router<'a>,
    ) {
        router
            .handle_later::<PluginsCall>(move |request| {
                Ok(self.call(registry.clone(), caller, request))
            })
            .handle::<PluginsCancel>(move |request| {
                if let Some(cancel) = self.open().calls.get(&(caller.client, request.call_id)) {
                    cancel.cancel();
                }
                Ok(())
            })
            .handle::<PluginsAnswer>(move |request| {
                self.secret_closed(caller.client, &request.request_id)
            })
            .handle::<PluginsSession>(move |request| {
                self.session_answered(
                    caller,
                    &request.request_id,
                    request.start,
                    request.cols,
                    request.rows,
                )
            });
    }

    /// One bridge call from a page `caller` frames, answered once it ends.
    fn call(
        self: &Arc<Self>,
        registry: Registry,
        caller: Caller,
        request: PluginCallRequest,
    ) -> Later<PluginCallOutcome> {
        let key = (caller.client, request.call_id.clone());
        let cancel = CancelToken::new();
        let taken = {
            let mut open = self.open();
            if open.calls.contains_key(&key) {
                true
            } else {
                open.calls.insert(key.clone(), cancel.clone());
                false
            }
        };
        if taken {
            let call_id = request.call_id;
            return Box::pin(async move {
                Err(format!(
                    "Plugin call {call_id} is already in flight from this client: each call needs an id of its own."
                ))
            });
        }
        let held = HeldCall {
            pages: Arc::downgrade(self),
            key,
        };
        let call = PluginCall {
            plugin: request.plugin,
            surface: request.surface,
            method: request.method,
            args: request.args,
            origin: CallOrigin::Client {
                client: caller.client,
                role: caller.role,
            },
            cancel,
        };
        Box::pin(async move {
            let answered = registry.call(call).await;
            drop(held);
            Ok(match answered {
                Ok(value) => PluginCallOutcome::ok(value),
                Err(err) => PluginCallOutcome::failed(err.code, err.message),
            })
        })
    }

    /// `secrets.request`: `ready` at once for a key stored and permitted;
    /// otherwise the secret dialog on the client whose page asked, and the
    /// key's state once it closes. A call from the host's own engine has no
    /// client to ask, so it answers the state as it is.
    async fn secret(
        &self,
        context: CallContext,
        args: &[Payload],
        secrets: &dyn SecretsAccess,
    ) -> Result<Payload, PluginCallError> {
        let named = args
            .first()
            .and_then(|key| key.deserialized::<String>().ok());
        let key = named
            .clone()
            .filter(|key| context.manifest.secrets.contains(key))
            .ok_or_else(|| {
                let named = named.map_or_else(|| "That".to_owned(), |key| format!("\"{key}\""));
                PluginCallError::not_declared(format!(
                    "{named} is not one of the secrets the manifest declares"
                ))
            })?;
        let state_now = || {
            if secrets.state(&context.plugin, &key) == PluginSecretState::Ready {
                PluginPageSecretState::Ready
            } else {
                PluginPageSecretState::Missing
            }
        };
        let ready = state_now();
        let CallOrigin::Client { client, .. } = context.origin else {
            return answer(&ready);
        };
        if ready == PluginPageSecretState::Ready {
            return answer(&ready);
        }
        let request_id = new_conversation_id();
        let (closed, on_close) = oneshot::channel();
        self.open()
            .secrets
            .insert(request_id.clone(), SecretAsk { client, closed });
        let _asking = HeldAsk {
            pages: self,
            request_id: request_id.clone(),
        };
        let asked = PluginUiRequest::Secret {
            request_id,
            plugin: context.plugin.clone(),
            key: key.clone(),
            hosts: context
                .manifest
                .network
                .iter()
                .map(|pattern| pattern.origin.clone())
                .collect(),
        };
        if self.events.emit_to::<PluginsUi>(client, &asked).is_err() {
            return answer(&PluginPageSecretState::Missing);
        }
        tokio::select! {
            _ = on_close => {}
            () = context.cancel.cancelled() => return Err(PluginCallError::aborted()),
        }
        answer(&state_now())
    }

    /// `plugins:answer`: the secret dialog `request_id` closed on `client`.
    fn secret_closed(&self, client: ClientId, request_id: &str) -> Result<(), String> {
        let mut open = self.open();
        match open.secrets.get(request_id) {
            // Answered already, or its call ended: the dialog closing is news
            // to nobody.
            None => Ok(()),
            Some(ask) if ask.client != client => Err(
                "That secret request was sent to another client, so this one cannot answer it."
                    .to_owned(),
            ),
            Some(_) => {
                if let Some(ask) = open.secrets.remove(request_id) {
                    let _ = ask.closed.send(());
                }
                Ok(())
            }
        }
    }

    /// `sessions.start`: checks what the plugin asked for and who asked, and
    /// puts the session dialog up on the client whose page asked.
    async fn session(
        &self,
        context: CallContext,
        args: &[Payload],
    ) -> Result<Payload, PluginCallError> {
        if !context.manifest.sessions.start {
            return Err(PluginCallError::not_declared(
                "the manifest's sessions does not list \"start\"",
            ));
        }
        let client = match context.origin {
            CallOrigin::Host => {
                return Err(PluginCallError::new(
                    PluginErrorCode::NotAllowed,
                    SESSION_FROM_A_CLICK,
                ));
            }
            CallOrigin::Client {
                role: Role::Viewer, ..
            } => {
                return Err(PluginCallError::new(
                    PluginErrorCode::NotAllowed,
                    SESSION_NOT_FOR_VIEWERS,
                ));
            }
            CallOrigin::Client { client, .. } => client,
        };
        if context.surface == PluginSurfaceKind::Background {
            return Err(PluginCallError::new(
                PluginErrorCode::NotAllowed,
                SESSION_FROM_A_CLICK,
            ));
        }
        let asked = read_session_request(args.first())?;
        let request_id = new_conversation_id();
        let (settled, on_settle) = oneshot::channel();
        {
            let mut open = self.open();
            if open
                .sessions
                .values()
                .any(|ask| ask.plugin == context.plugin)
            {
                return Err(PluginCallError::new(
                    PluginErrorCode::Busy,
                    "a session this plugin asked for is already waiting on the user",
                ));
            }
            open.sessions.insert(
                request_id.clone(),
                SessionAsk {
                    client,
                    plugin: context.plugin.clone(),
                    asked: asked.clone(),
                    settled,
                },
            );
        }
        let _asking = HeldAsk {
            pages: self,
            request_id: request_id.clone(),
        };
        let ui = PluginUiRequest::Session {
            request_id,
            plugin: context.plugin.clone(),
            cwd: asked.cwd,
            prompt: asked.prompt,
            name: asked.name,
        };
        if self.events.emit_to::<PluginsUi>(client, &ui).is_err() {
            return Err(PluginCallError::unavailable(
                "the client that asked is not connected",
            ));
        }
        let settled = tokio::select! {
            settled = on_settle => settled.unwrap_or(Settled::Cancelled),
            () = context.cancel.cancelled() => return Err(PluginCallError::aborted()),
        };
        match settled {
            Settled::Started => answer(&"started"),
            Settled::Cancelled => answer(&"cancelled"),
            Settled::Failed(message) => Err(PluginCallError::unavailable(message)),
        }
    }

    /// `plugins:session`: the user's answer on `caller` to the session
    /// dialog `request_id`. A yes starts what the plugin asked for, as the
    /// host checked it, at the client's terminal size.
    fn session_answered(
        &self,
        caller: Caller,
        request_id: &str,
        start: bool,
        cols: u16,
        rows: u16,
    ) -> Result<Option<SessionRecord>, String> {
        let ask = {
            let mut open = self.open();
            match open.sessions.get(request_id) {
                None => {
                    return Err(
                        "That session request is not waiting: it was answered, or its page or plugin went away."
                            .to_owned(),
                    );
                }
                Some(ask) if ask.client != caller.client => {
                    return Err(
                        "That session request was sent to another client, so this one cannot answer it."
                            .to_owned(),
                    );
                }
                Some(_) => open.sessions.remove(request_id).expect("present"),
            }
        };
        if !start {
            let _ = ask.settled.send(Settled::Cancelled);
            return Ok(None);
        }
        if caller.role == Role::Viewer {
            let _ = ask
                .settled
                .send(Settled::Failed(SESSION_NOT_FOR_VIEWERS.to_owned()));
            return Err(SESSION_NOT_FOR_VIEWERS.to_owned());
        }
        let Some(hosted) = self.hosted.upgrade() else {
            let message = "The host is shutting down.".to_owned();
            let _ = ask.settled.send(Settled::Failed(message.clone()));
            return Err(message);
        };
        // What the dialog showed is a `claude` command line, so the session
        // is Claude Code's wherever this host runs it; a host without it
        // (a test's fake agent) starts its default.
        let claude = BackendId::claude_code();
        let request = StartSessionRequest {
            backend: hosted.runs_backend(&claude).then_some(claude),
            cwd: ask.asked.cwd,
            name: Some(ask.asked.name),
            opening_prompt: Some(ask.asked.prompt),
            cols,
            rows,
            ..StartSessionRequest::default()
        };
        match hosted.start(caller.client, request) {
            Ok(launched) => {
                let _ = ask.settled.send(Settled::Started);
                // Every client's lists, and every plugin's, hear of it now
                // rather than at the next pass.
                let activity = self.activity.clone();
                tokio::task::spawn_blocking(move || activity.read_now());
                Ok(Some(launched.session))
            }
            Err(err) => {
                let _ = ask.settled.send(Settled::Failed(err.clone()));
                Err(err)
            }
        }
    }

    /// `client` has gone: every call it holds is cancelled, and every ask
    /// put up on it is withdrawn.
    pub fn client_left(&self, client: ClientId) {
        let (calls, secrets, sessions) = {
            let mut open = self.open();
            let calls: Vec<CancelToken> = open
                .calls
                .iter()
                .filter(|((holder, _), _)| *holder == client)
                .map(|(_, cancel)| cancel.clone())
                .collect();
            let secrets: Vec<String> = open
                .secrets
                .iter()
                .filter(|(_, ask)| ask.client == client)
                .map(|(id, _)| id.clone())
                .collect();
            let sessions: Vec<String> = open
                .sessions
                .iter()
                .filter(|(_, ask)| ask.client == client)
                .map(|(id, _)| id.clone())
                .collect();
            let secrets: Vec<SecretAsk> = secrets
                .iter()
                .filter_map(|id| open.secrets.remove(id))
                .collect();
            let sessions: Vec<SessionAsk> = sessions
                .iter()
                .filter_map(|id| open.sessions.remove(id))
                .collect();
            (calls, secrets, sessions)
        };
        for cancel in calls {
            cancel.cancel();
        }
        drop(secrets);
        for ask in sessions {
            let _ = ask.settled.send(Settled::Cancelled);
        }
    }
}

/// A call in flight; dropped, it is no longer the client's to cancel.
struct HeldCall {
    pages: Weak<Pages>,
    key: (ClientId, String),
}

impl Drop for HeldCall {
    fn drop(&mut self) {
        if let Some(pages) = self.pages.upgrade() {
            pages.open().calls.remove(&self.key);
        }
    }
}

/// An ask waiting on a client; dropped before it was answered (its call
/// ended), it is withdrawn.
struct HeldAsk<'a> {
    pages: &'a Pages,
    request_id: String,
}

impl Drop for HeldAsk<'_> {
    fn drop(&mut self) {
        let withdrawn = {
            let mut open = self.pages.open();
            open.secrets.remove(&self.request_id);
            open.sessions.remove(&self.request_id)
        };
        if let Some(ask) = withdrawn {
            let _ = self.pages.events.emit_to::<PluginsUi>(
                ask.client,
                &PluginUiRequest::SessionWithdrawn {
                    request_id: self.request_id.clone(),
                },
            );
        }
    }
}

/// Whether `text` holds a control character.
fn has_control(text: &str) -> bool {
    text.chars().any(char::is_control)
}

/// What a page asked to start, held to what the dialog can show truthfully
/// and a command line can carry: one line, so it means the same through a
/// `.cmd` shim; no `"`, which a shim's command line cannot carry; and no
/// leading `-`, which the agent would read as a flag rather than a message.
fn read_session_request(value: Option<&Payload>) -> Result<AskedSession, PluginCallError> {
    #[derive(serde::Deserialize)]
    struct Asked {
        cwd: Option<Payload>,
        prompt: Option<Payload>,
        name: Option<Payload>,
    }
    let shape = || PluginCallError::invalid("sessions.start takes { cwd, prompt, name? }");
    let asked: Asked = value
        .filter(|value| matches!(value, Payload::Map(_)))
        .ok_or_else(shape)?
        .deserialized()
        .map_err(|_| shape())?;
    let text = |value: Option<Payload>| value.and_then(|value| value.deserialized::<String>().ok());
    let cwd = text(asked.cwd)
        .filter(|cwd| Path::new(cwd).is_absolute())
        .ok_or_else(|| PluginCallError::invalid("cwd must be an absolute path"))?;
    let folder = PathBuf::from(&cwd);
    if !folder.is_dir() {
        return Err(PluginCallError::invalid(format!(
            "{cwd} is not a folder on this computer"
        )));
    }
    let message = text(asked.prompt)
        .map(|prompt| prompt.trim().to_owned())
        .filter(|prompt| !prompt.is_empty())
        .ok_or_else(|| PluginCallError::invalid("prompt must be a message to start with"))?;
    if message.chars().count() > SESSION_PROMPT_MAX {
        return Err(PluginCallError::invalid(format!(
            "a prompt is at most {SESSION_PROMPT_MAX} characters"
        )));
    }
    if has_control(&message) {
        return Err(PluginCallError::invalid("a prompt is one line"));
    }
    if message.contains('"') {
        return Err(PluginCallError::invalid(
            "a prompt cannot hold a double quote",
        ));
    }
    if message.starts_with('-') {
        return Err(PluginCallError::invalid("a prompt cannot start with -"));
    }
    let called = match asked.name {
        None | Some(Payload::Null) => folder
            .file_name()
            .map_or_else(|| cwd.clone(), |name| name.to_string_lossy().into_owned()),
        Some(name) => text(Some(name))
            .map(|name| name.trim().to_owned())
            .filter(|name| {
                !name.is_empty() && name.chars().count() <= SESSION_NAME_MAX && !has_control(name)
            })
            .ok_or_else(|| {
                PluginCallError::invalid(format!(
                    "a session name is one line of 1-{SESSION_NAME_MAX} characters"
                ))
            })?,
    };
    Ok(AskedSession {
        cwd,
        name: called,
        prompt: message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asked(value: serde_json::Value) -> Result<AskedSession, PluginCallError> {
        let payload = Payload::serialized(&value).expect("encodes");
        read_session_request(Some(&payload))
    }

    #[test]
    fn a_session_request_is_held_to_one_line_in_a_folder_that_exists() {
        let folder = std::env::current_dir().expect("a working folder");
        let cwd = folder.to_string_lossy().into_owned();
        let ok = asked(serde_json::json!({ "cwd": cwd, "prompt": "  look at the build  " }))
            .expect("a good request");
        assert_eq!(ok.prompt, "look at the build");
        assert_eq!(
            ok.name,
            folder.file_name().expect("a name").to_string_lossy()
        );
        let named = asked(serde_json::json!({ "cwd": cwd, "prompt": "go", "name": " Fix " }))
            .expect("a named request");
        assert_eq!(named.name, "Fix");

        let refused = |value: serde_json::Value| asked(value).expect_err("refused").message;
        assert_eq!(
            refused(serde_json::json!({ "cwd": "relative", "prompt": "go" })),
            "cwd must be an absolute path"
        );
        assert_eq!(
            refused(serde_json::json!({ "cwd": cwd, "prompt": "two\nlines" })),
            "a prompt is one line"
        );
        assert_eq!(
            refused(serde_json::json!({ "cwd": cwd, "prompt": "say \"hi\"" })),
            "a prompt cannot hold a double quote"
        );
        assert_eq!(
            refused(serde_json::json!({ "cwd": cwd, "prompt": "--flag" })),
            "a prompt cannot start with -"
        );
        assert_eq!(
            refused(serde_json::json!({ "cwd": cwd, "prompt": "go", "name": "" })),
            "a session name is one line of 1-60 characters"
        );
        assert_eq!(
            refused(serde_json::json!("not an object")),
            "sessions.start takes { cwd, prompt, name? }"
        );
    }
}
