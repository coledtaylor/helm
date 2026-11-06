//! `helm-plugin-<id>`: each plugin's tool server, served to the host's
//! sessions at `/mcp/plugin/<id>`, from one of two places.
//!
//! **A version 2 plugin's, the host's own** ([`HostPluginTools`]). A plugin
//! whose background module runs in the host's engine, on, error-free and
//! with its tools on, is served from its manifest with no client attached:
//! the provenance line then the manifest's instructions, and each tool's
//! name, description, input schema and `readOnlyHint` as the manifest
//! declares them. Each call goes to the module's handler through
//! [`crate::plugins::Registry::call_tool`], naming the session as the relay names it (the id
//! minted at its launch, its name and its folder), and dropping the call
//! cancels it there. The list of plugins is read again at every change the
//! registry publishes: a plugin turned off, removed or with its tools
//! switched off loses its route at once (404) and is given to no later
//! launch, and is given again once it is back.
//!
//! **A version 1 plugin's, as a client words it** ([`PluginFamilies`]). The
//! name, instructions and every tool's name, description and input schema
//! come from the client's offer, so a session lists exactly what it lists
//! with the host out of the way. Each call is relayed ([`PluginRelay`]) to
//! the client that offered the server, naming the session whose token made
//! it, and that client's answer, an MCP tool result, is the tool's answer as
//! it is. Dropping the call (the session interrupted it, its request went
//! away, or the session ended) withdraws it from the client. A client's
//! offer naming a plugin the host runs itself is passed over.
//!
//! **Offered, given; withdrawn, gone.** A client's server is given to
//! launches while its client is attached; left out of an offer, its route
//! answers 404 to every session at once. A server whose client left is held
//! for the sessions given it, where each call fails at once saying Helm is
//! not connected, and is given to no launch.
//!
//! A tool listed read-only is turned into an allow rule by the listener for
//! the launches given it, whichever place serves it.

use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use floti_protocol::Payload;
use floti_protocol::channel::{from_payload, to_payload};
use floti_protocol::channels::agent_plugin::{AgentPluginCaller, AgentPluginOutcome};
use floti_protocol::channels::plugins::PluginInfo;

use super::features::{PluginRelay, PluginServer};
use crate::agent_tools::{
    CallToolResult, Caller, ContentBlock, FamilySource, JsonObject, Tool, ToolFamily, ToolFuture,
};
use crate::plugins::WeakRegistry;
use crate::plugins::background::{ToolAnswer, ToolCall, ToolCaller};
use crate::plugins::call::CancelToken;

/// The answer to a call from a token whose session has not started yet.
const NO_SESSION_YET: &str = "Helm cannot tell which session this call is from yet - it is still starting. Try again in a moment.";

/// Every plugin tool server the relay has now, as families.
pub(crate) struct PluginFamilies {
    relay: Arc<PluginRelay>,
}

impl PluginFamilies {
    pub fn new(relay: Arc<PluginRelay>) -> Self {
        Self { relay }
    }
}

impl FamilySource for PluginFamilies {
    fn families(&self) -> Vec<Arc<dyn ToolFamily>> {
        self.relay
            .offered()
            .into_iter()
            .map(|offered| {
                Arc::new(PluginTools {
                    server: offered.server,
                    connected: offered.connected,
                    relay: Arc::clone(&self.relay),
                }) as Arc<dyn ToolFamily>
            })
            .collect()
    }
}

/// One plugin's server, as offered now.
pub(crate) struct PluginTools {
    server: Arc<PluginServer>,
    connected: bool,
    relay: Arc<PluginRelay>,
}

impl ToolFamily for PluginTools {
    fn name(&self) -> &str {
        &self.server.name
    }

    fn route(&self) -> &str {
        &self.server.route
    }

    fn instructions(&self) -> &str {
        &self.server.instructions
    }

    /// On while it is offered or held: a server switched off is not here.
    fn is_on(&self) -> bool {
        true
    }

    fn grantable(&self) -> bool {
        self.connected
    }

    fn tools(&self) -> Vec<Tool> {
        self.server.tools.clone()
    }

    fn call<'a>(&'a self, caller: Caller, name: &'a str, arguments: JsonObject) -> ToolFuture<'a> {
        Box::pin(async move {
            let Some(session) = caller
                .session
                .and_then(|session| u64::try_from(session.0).ok())
            else {
                return problem(NO_SESSION_YET);
            };
            let arguments = match to_payload(&arguments) {
                Ok(arguments) => arguments,
                Err(err) => return problem(&format!("Helm could not pass that call on: {err}.")),
            };
            tool_result(
                self.relay
                    .call(session, &self.server.plugin, name, arguments)
                    .await,
            )
        })
    }
}

/// What the agent reads for what the client answered: its tool result as it
/// is, or the sentence it failed with.
fn tool_result(outcome: AgentPluginOutcome) -> CallToolResult {
    match outcome {
        AgentPluginOutcome::Done { value } => answered(&value),
        AgentPluginOutcome::Failed { message } => problem(&message),
    }
}

fn answered(value: &Payload) -> CallToolResult {
    from_payload::<CallToolResult>(value).unwrap_or_else(|err| {
        problem(&format!(
            "Helm's plugin answered with something that is not a tool result: {err}."
        ))
    })
}

fn problem(body: &str) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(body.to_owned())])
}

// ---------------------------------------------------------------------------
// A version 2 plugin's server, the host's own
// ---------------------------------------------------------------------------

/// How a call's session is named to the plugin, by the session's row id.
type CallerOf = Box<dyn Fn(u64) -> Option<AgentPluginCaller> + Send + Sync>;

type Changed = Arc<dyn Fn() + Send + Sync>;

/// The answer to a call that reached a host whose plugins have stopped.
const REGISTRY_GONE: &str = "The host is shutting down.";

/// The tool servers of the plugins whose background module the host runs,
/// as its registry last listed them, and how a call reaches one.
pub(crate) struct HostPluginTools {
    servers: Mutex<Vec<Arc<PluginServer>>>,
    /// Set once the registry is built: it is built after this is.
    registry: OnceLock<WeakRegistry>,
    caller: CallerOf,
    /// Told, with no lock of this held, each time the servers changed.
    changed: Mutex<Option<Changed>>,
}

impl HostPluginTools {
    /// Serves nothing until [`Self::installed`] is told a list; names each
    /// call's session with `caller`, as the relay does.
    pub fn new(caller: impl Fn(u64) -> Option<AgentPluginCaller> + Send + Sync + 'static) -> Self {
        Self {
            servers: Mutex::new(Vec::new()),
            registry: OnceLock::new(),
            caller: Box::new(caller),
            changed: Mutex::new(None),
        }
    }

    /// Calls are answered by `registry` from now on.
    pub fn answer_with(&self, registry: WeakRegistry) {
        let _ = self.registry.set(registry);
    }

    /// Calls `changed` from now on each time the servers change, replacing
    /// whatever was called before.
    pub fn on_change(&self, changed: impl Fn() + Send + Sync + 'static) {
        *lock(&self.changed) = Some(Arc::new(changed));
    }

    /// The registry's list now: each plugin it runs a background module for,
    /// on, error-free and with its tools on, is served from here on, and
    /// every other is gone at once for the sessions given it.
    pub fn installed(&self, list: &[PluginInfo]) {
        let servers: Vec<PluginServer> = list.iter().filter_map(PluginServer::hosted).collect();
        {
            let mut now = lock(&self.servers);
            let same = now.len() == servers.len()
                && now.iter().zip(&servers).all(|(was, is)| **was == *is);
            if same {
                return;
            }
            *now = servers.into_iter().map(Arc::new).collect();
        }
        let changed = lock(&self.changed).clone();
        if let Some(changed) = changed {
            changed();
        }
    }

    /// Hands one call of `tool` with `arguments`, made by session `row`'s
    /// agent, to `plugin`'s background module, and answers what its handler
    /// answered. Dropping the future cancels the call there.
    async fn call(
        &self,
        row: u64,
        plugin: &str,
        tool: &str,
        arguments: JsonObject,
    ) -> CallToolResult {
        let Some(caller) = (self.caller)(row) else {
            return problem(NO_SESSION_YET);
        };
        let Some(registry) = self.registry.get().and_then(WeakRegistry::upgrade) else {
            return problem(REGISTRY_GONE);
        };
        let call = ToolCall {
            plugin: plugin.to_owned(),
            tool: tool.to_owned(),
            args: serde_json::Value::Object(arguments),
            session: ToolCaller {
                id: caller.id,
                name: caller.label,
                cwd: caller.folder,
            },
        };
        let cancel = CancelOnDrop(CancelToken::new());
        hosted_result(registry.call_tool(call, cancel.0.clone()).await)
    }
}

/// Cancels its token when dropped: the session no longer waits on the call.
struct CancelOnDrop(CancelToken);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// What the agent reads for a module's answer: its text, or the sentence it
/// failed with.
fn hosted_result(answer: ToolAnswer) -> CallToolResult {
    match answer {
        Ok(serde_json::Value::String(text)) => {
            CallToolResult::success(vec![ContentBlock::text(text)])
        }
        Ok(other) => CallToolResult::success(vec![ContentBlock::text(other.to_string())]),
        Err(message) => problem(&message),
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Every server the host serves for its own plugins now, as families.
pub(crate) struct HostPluginFamilies {
    tools: Arc<HostPluginTools>,
}

impl HostPluginFamilies {
    pub fn new(tools: Arc<HostPluginTools>) -> Self {
        Self { tools }
    }
}

impl FamilySource for HostPluginFamilies {
    fn families(&self) -> Vec<Arc<dyn ToolFamily>> {
        lock(&self.tools.servers)
            .iter()
            .map(|server| {
                Arc::new(HostPluginFamily {
                    server: Arc::clone(server),
                    tools: Arc::clone(&self.tools),
                }) as Arc<dyn ToolFamily>
            })
            .collect()
    }
}

/// One version 2 plugin's server, as its manifest declares it now.
struct HostPluginFamily {
    server: Arc<PluginServer>,
    tools: Arc<HostPluginTools>,
}

impl ToolFamily for HostPluginFamily {
    fn name(&self) -> &str {
        &self.server.name
    }

    fn route(&self) -> &str {
        &self.server.route
    }

    fn instructions(&self) -> &str {
        &self.server.instructions
    }

    /// On while it is listed: a plugin off, removed or with its tools off
    /// is not.
    fn is_on(&self) -> bool {
        true
    }

    fn tools(&self) -> Vec<Tool> {
        self.server.tools.clone()
    }

    fn call<'a>(&'a self, caller: Caller, name: &'a str, arguments: JsonObject) -> ToolFuture<'a> {
        Box::pin(async move {
            let Some(row) = caller
                .session
                .and_then(|session| u64::try_from(session.0).ok())
            else {
                return problem(NO_SESSION_YET);
            };
            self.tools
                .call(row, &self.server.plugin, name, arguments)
                .await
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn a_done_answer_is_handed_back_as_the_tool_result_it_is() {
        let result = json!({
            "content": [{ "type": "text", "text": "Found 2 notes." }],
            "isError": false,
        });
        let answered = tool_result(AgentPluginOutcome::Done {
            value: to_payload(&result).unwrap(),
        });
        assert_eq!(serde_json::to_value(&answered).unwrap(), result);
    }

    #[test]
    fn a_failed_answer_is_an_error_result_with_its_sentence() {
        let answered = tool_result(AgentPluginOutcome::not_connected("notes"));
        let value: Value = serde_json::to_value(&answered).unwrap();
        assert_eq!(value["isError"], true);
        let text = value["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("Helm's window is not connected"), "{text}");
    }

    #[test]
    fn an_answer_that_is_no_tool_result_is_an_error_saying_so() {
        let answered = tool_result(AgentPluginOutcome::Done {
            value: Payload::Text("not a result".into()),
        });
        let value: Value = serde_json::to_value(&answered).unwrap();
        assert_eq!(value["isError"], true);
        assert!(
            value["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("not a tool result")
        );
    }
}
