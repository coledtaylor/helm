//! helm-browser: the agent browser tools, served to the host's sessions on
//! the agent tools listener at `/mcp`, and carried out in the browser pane of
//! an attached client.
//!
//! **Today's tools, under today's names.** The name, route, instructions and
//! every tool's description and input schema come from `browser_tools.json`,
//! the one table the desktop's own listener reads too, so a session lists
//! exactly what it lists with the host out of the way and the user's
//! `mcp__helm-browser__*` permission rules apply unchanged.
//!
//! **The host has no browser.** Each call is relayed ([`BrowserRelay`]) to the
//! attached client that declared `browser`, naming the session whose token
//! made it, and that client's answer, an MCP tool result, is the tool's
//! answer as it is. The client judges which tabs the session may drive and
//! whether a page is within reach, with its own settings
//! (`browserMcpLocalOnly` among them).
//!
//! **No browser, no family.** It is on while the `browserMcp` setting is, and
//! a launch is given it only while a browser client is attached: a session
//! started with none has no `helm-browser` entry in its tool configuration
//! and its token is answered 404 on this route. A session that was given it
//! keeps the route; while no browser is attached its calls fail, saying so.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use floti_protocol::Payload;
use floti_protocol::channel::{from_payload, to_payload};
use floti_protocol::channels::agent_browser::AgentBrowserOutcome;
use serde::Deserialize;

use super::features::BrowserRelay;
use crate::agent_tools::{
    CallToolResult, Caller, ContentBlock, JsonObject, Tool, ToolFamily, ToolFuture,
};

/// The browser tools as the desktop serves them today.
#[derive(Debug, Deserialize)]
struct Table {
    name: String,
    path: String,
    instructions: String,
    tools: Vec<Spec>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spec {
    name: String,
    description: String,
    input_schema: JsonObject,
}

static TABLE: LazyLock<Table> = LazyLock::new(|| {
    serde_json::from_str(include_str!("browser_tools.json"))
        .expect("browser_tools.json is the browser tools' table")
});

/// The answer to a call from a token whose session has not started yet.
const NO_SESSION_YET: &str = "Helm cannot tell which session this call is from yet - it is still starting. Try again in a moment.";

/// The family: its switch, the `browserMcp` setting as last written, and the
/// relay its calls go through.
pub(crate) struct BrowserTools {
    on: AtomicBool,
    relay: Arc<BrowserRelay>,
}

impl BrowserTools {
    /// Off: the host switches it as its settings say once it has read them.
    pub fn new(relay: Arc<BrowserRelay>) -> Self {
        Self {
            on: AtomicBool::new(false),
            relay,
        }
    }

    /// Switches it on or off; a request reads it, so it takes effect at once.
    pub fn switch(&self, on: bool) {
        self.on.store(on, Ordering::SeqCst);
    }
}

impl ToolFamily for BrowserTools {
    fn name(&self) -> &str {
        &TABLE.name
    }

    fn route(&self) -> &str {
        &TABLE.path
    }

    fn instructions(&self) -> &str {
        &TABLE.instructions
    }

    fn is_on(&self) -> bool {
        self.on.load(Ordering::SeqCst)
    }

    fn grantable(&self) -> bool {
        self.relay.has_browser()
    }

    fn tools(&self) -> Vec<Tool> {
        TABLE
            .tools
            .iter()
            .map(|spec| {
                Tool::new(
                    spec.name.clone(),
                    spec.description.clone(),
                    spec.input_schema.clone(),
                )
            })
            .collect()
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
            tool_result(self.relay.call(session, name, arguments).await)
        })
    }
}

/// What the agent reads for what the client answered: its tool result as it
/// is, or the sentence it failed with.
fn tool_result(outcome: AgentBrowserOutcome) -> CallToolResult {
    match outcome {
        AgentBrowserOutcome::Done { value } => answered(&value),
        AgentBrowserOutcome::Failed { message } => problem(&message),
    }
}

fn answered(value: &Payload) -> CallToolResult {
    from_payload::<CallToolResult>(value).unwrap_or_else(|err| {
        problem(&format!(
            "Helm's browser answered with something that is not a tool result: {err}."
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
    fn the_table_is_todays_helm_browser_at_mcp_with_its_sixteen_tools() {
        assert_eq!(TABLE.name, "helm-browser");
        assert_eq!(TABLE.path, "/mcp");
        assert!(TABLE.instructions.contains("browser pane inside Helm"));
        let names: Vec<&str> = TABLE.tools.iter().map(|tool| tool.name.as_str()).collect();
        assert_eq!(names.len(), 16, "{names:?}");
        assert!(names.contains(&"browser_open") && names.contains(&"browser_wait_for"));
    }

    #[test]
    fn a_done_answer_is_handed_back_as_the_tool_result_it_is_image_included() {
        let result = json!({
            "content": [
                { "type": "text", "text": "A screenshot of tab 3." },
                { "type": "image", "data": "iVBORw0KGgo=", "mimeType": "image/png" },
            ],
            "isError": false,
        });
        let value = to_payload(&result).unwrap();
        let answered = tool_result(AgentBrowserOutcome::Done { value });
        assert_eq!(serde_json::to_value(&answered).unwrap(), result);
    }

    #[test]
    fn a_failed_answer_is_an_error_result_with_its_sentence() {
        let answered = tool_result(AgentBrowserOutcome::Failed {
            message: "That page is outside what this session may reach.".into(),
        });
        let value: Value = serde_json::to_value(&answered).unwrap();
        assert_eq!(value["isError"], true);
        assert_eq!(
            value["content"][0]["text"],
            "That page is outside what this session may reach."
        );
    }

    #[test]
    fn an_answer_that_is_no_tool_result_is_an_error_saying_so() {
        let answered = tool_result(AgentBrowserOutcome::Done {
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
