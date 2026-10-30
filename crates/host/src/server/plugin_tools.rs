//! `helm-plugin-<id>`: each plugin tool server a client offers, served to the
//! host's sessions at `/mcp/plugin/<id>` and answered by that client.
//!
//! **Today's servers, as the client words them.** The name, instructions
//! (the provenance line, then the plugin's own words) and every tool's name,
//! description and input schema come from the client's offer, so a session
//! lists exactly what it lists with the host out of the way. A tool offered
//! read-only is listed with `readOnlyHint`, which the listener turns into an
//! allow rule for the launches given it.
//!
//! **The host has no plugins of its own here.** Each call is relayed
//! ([`PluginRelay`]) to the client that offered the server, naming the
//! session whose token made it, and that client's answer, an MCP tool
//! result, is the tool's answer as it is. Dropping the call (the session
//! interrupted it, its request went away, or the session ended) withdraws it
//! from the client.
//!
//! **Offered, given; withdrawn, gone.** A server is given to launches while
//! its client is attached; left out of an offer, its route answers 404 to
//! every session at once. A server whose client left is held for the
//! sessions given it, where each call fails at once saying Helm is not
//! connected, and is given to no launch.

use std::sync::Arc;

use floti_protocol::Payload;
use floti_protocol::channel::{from_payload, to_payload};
use floti_protocol::channels::agent_plugin::AgentPluginOutcome;

use super::features::{PluginRelay, PluginServer};
use crate::agent_tools::{
    CallToolResult, Caller, ContentBlock, FamilySource, JsonObject, Tool, ToolFamily, ToolFuture,
};

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
