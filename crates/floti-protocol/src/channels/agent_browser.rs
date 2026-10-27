//! The agent browser tools' relay: `agentBrowser:*`.
//!
//! The browser pane lives in a client, but the agent browser tools are served
//! by the host, where the sessions run. So a tool call travels host to client
//! as an event on `agentBrowser:call`, and the client answers it on
//! `agentBrowser:answer`. Both need the `browser` capability: a client that
//! did not declare it is never sent a call and cannot answer one.
//!
//! A call goes to one client that declared `browser` and is listening on
//! `agentBrowser:call` ([`browser_client`]). With none attached, the tool
//! answers that there is no browser to drive
//! ([`AgentBrowserOutcome::no_browser_client`]).
//!
//! Which tabs a session may drive, and the reach rule every navigation
//! passes, are the client's to enforce, as they are today; the call names the
//! session so it can.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::channel::{Catalogue, EventChannel};
use crate::delivery::ClientChannels;
use crate::message::Payload;

pub fn declare(catalogue: &mut Catalogue) {
    catalogue
        .event::<AgentBrowserCalls>()
        .request::<AgentBrowserAnswer>();
}

event_channel!(
    /// A browser tool call from a session's agent, for the client to carry
    /// out in its browser pane.
    AgentBrowserCalls = "agentBrowser:call",
    event AgentBrowserToolCall,
    needs Browser
);

request_channel!(
    /// The client's answer to one browser tool call.
    AgentBrowserAnswer = "agentBrowser:answer",
    AgentBrowserToolAnswer => (),
    needs Browser
);

/// One browser tool call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserToolCall {
    /// Chosen by the host; the answer names it.
    #[ts(type = "number")]
    pub call_id: u64,
    /// The id of the hosted session whose agent called the tool.
    #[ts(type = "number")]
    pub session: u64,
    /// The tool's name, such as `browser_navigate`.
    pub tool: String,
    /// The tool's arguments, as the agent sent them.
    #[schemars(with = "serde_json::Value")]
    #[ts(type = "unknown")]
    pub arguments: Payload,
}

/// The client's answer to a browser tool call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrowserToolAnswer {
    /// The `callId` of the call it answers.
    #[ts(type = "number")]
    pub call_id: u64,
    pub outcome: AgentBrowserOutcome,
}

/// What a browser tool call came to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AgentBrowserOutcome {
    /// The tool ran; `value` is its result for the agent.
    Done {
        #[schemars(with = "serde_json::Value")]
        #[ts(type = "unknown")]
        value: Payload,
    },
    /// The tool could not run; `message` is the sentence the agent reads.
    Failed { message: String },
}

impl AgentBrowserOutcome {
    /// The answer to a call made while no client with a browser is attached.
    pub fn no_browser_client() -> Self {
        Self::Failed {
            message: "No client with a browser is attached to this Floti host, so there is no \
                      browser to drive. Open Floti on a device with a browser pane and try again."
                .into(),
        }
    }
}

/// The client a browser tool call goes to: the first of `clients`, in the
/// order the host prefers them, that declared `browser` and is listening on
/// `agentBrowser:call`. With none, the answer the tool gives instead.
pub fn browser_client<'c, 'a, K>(
    clients: impl IntoIterator<Item = (K, &'c ClientChannels<'a>)>,
) -> Result<(K, &'c ClientChannels<'a>), AgentBrowserOutcome>
where
    'a: 'c,
{
    clients
        .into_iter()
        .find(|(_, client)| !client.subscriptions_to(AgentBrowserCalls::NAME).is_empty())
        .ok_or_else(AgentBrowserOutcome::no_browser_client)
}
