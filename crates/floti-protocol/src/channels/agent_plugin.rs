//! Plugin tools a client answers: `agentPlugin:*`.
//!
//! A plugin's background page may run in a client rather than in the host
//! (Helm's window runs its plugins). The host still serves the plugin's
//! tools to the sessions it runs, so the client offers them on
//! `agentPlugin:offer`, each server as a session should read it; the host
//! carries each call to that client as an event on `agentPlugin:call`, the
//! client answers it on `agentPlugin:answer`, and a call the session stopped
//! waiting for is withdrawn on `agentPlugin:cancel`.
//!
//! No capability is needed: a call goes only to the connection that offered
//! the server it is for, and only that connection may answer it.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::channel::Catalogue;
use crate::message::Payload;

pub fn declare(catalogue: &mut Catalogue) {
    catalogue
        .request::<AgentPluginOffer>()
        .event::<AgentPluginCalls>()
        .request::<AgentPluginAnswer>()
        .event::<AgentPluginCancels>();
}

request_channel!(
    /// Every plugin tool server this client answers, replacing what it
    /// offered before: a server left out is taken from running sessions at
    /// once, and a new one reaches the sessions started after.
    AgentPluginOffer = "agentPlugin:offer",
    AgentPluginServers => ()
);

event_channel!(
    /// A plugin tool call from a session's agent, for the client that
    /// offered the plugin's server to answer.
    AgentPluginCalls = "agentPlugin:call",
    event AgentPluginToolCall
);

request_channel!(
    /// The client's answer to one plugin tool call.
    AgentPluginAnswer = "agentPlugin:answer",
    AgentPluginToolAnswer => ()
);

event_channel!(
    /// Nobody is waiting on a call any more: the session interrupted it, its
    /// request went away, or the session ended.
    AgentPluginCancels = "agentPlugin:cancel",
    event AgentPluginCallCancel
);

/// The plugin tool servers one client answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentPluginServers {
    pub servers: Vec<AgentPluginServer>,
}

/// One plugin's tools, as a session reads them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentPluginServer {
    /// Its name as a session lists it, such as `helm-plugin-trackr`: the
    /// name the user's permission rules use.
    pub name: String,
    /// The plugin's id: lower-case letters, digits and dashes. The server is
    /// served at `/mcp/plugin/<plugin>`.
    pub plugin: String,
    /// What `initialize` tells a session, exactly as it reads it.
    pub instructions: String,
    pub tools: Vec<AgentPluginTool>,
}

/// One tool of a plugin's server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentPluginTool {
    pub name: String,
    pub description: String,
    /// Its arguments' JSON Schema, an object.
    #[schemars(with = "serde_json::Value")]
    #[ts(type = "unknown")]
    pub input_schema: Payload,
    /// Changes nothing: listed with `readOnlyHint`, and allowed without
    /// asking in the sessions launched while it is offered.
    pub read_only: bool,
}

/// One plugin tool call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentPluginToolCall {
    /// Chosen by the host; the answer and a cancel name it.
    #[ts(type = "number")]
    pub call_id: u64,
    /// The id of the hosted session whose agent called the tool.
    #[ts(type = "number")]
    pub session: u64,
    /// That session as the plugin knows it, minted by the host; null while
    /// the host has no running session to name.
    pub caller: Option<AgentPluginCaller>,
    /// The plugin's id.
    pub plugin: String,
    /// The tool's name, as the server lists it.
    pub tool: String,
    /// The tool's arguments, as the agent sent them.
    #[schemars(with = "serde_json::Value")]
    #[ts(type = "unknown")]
    pub arguments: Payload,
}

/// The session a plugin tool call came from, as the plugin is told it: never
/// the host's row id and nothing of the session's conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentPluginCaller {
    /// Minted by the host when the session launched, random, and the same id
    /// the plugin's `sessions.list` and `sessions` event show it under.
    pub id: String,
    /// The session's name.
    pub label: String,
    /// The folder it runs in.
    pub folder: String,
}

/// The client's answer to a plugin tool call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentPluginToolAnswer {
    /// The `callId` of the call it answers.
    #[ts(type = "number")]
    pub call_id: u64,
    pub outcome: AgentPluginOutcome,
}

/// A call nobody waits on any more.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentPluginCallCancel {
    /// The `callId` of the call withdrawn.
    #[ts(type = "number")]
    pub call_id: u64,
}

/// What a plugin tool call came to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum AgentPluginOutcome {
    /// The plugin answered; `value` is the MCP tool result for the agent.
    Done {
        #[schemars(with = "serde_json::Value")]
        #[ts(type = "unknown")]
        value: Payload,
    },
    /// No answer; `message` is the sentence the agent reads.
    Failed { message: String },
}

impl AgentPluginOutcome {
    /// The answer to a call no attached client can take: the client that
    /// offered the plugin's tools is not connected.
    pub fn not_connected(plugin: &str) -> Self {
        Self::Failed {
            message: format!(
                "Helm's window is not connected to the host this session runs in, so the plugin \
                 \"{plugin}\" cannot answer. Open Helm, then try again."
            ),
        }
    }
}
