//! The plugin tools' relay: `agentPlugin:offer`, `agentPlugin:call`,
//! `agentPlugin:answer` and `agentPlugin:cancel`.
//!
//! A client that runs plugins (Helm's window) offers the tool servers its
//! plugins have on, each as a session should read it. The host serves each
//! one to its sessions as one more agent tool family
//! ([`super::super::plugin_tools`]) and carries every call to the client that
//! offered it, which answers it with its plugin's background page. The call
//! names the session whose token made it; the client tells its plugin an id
//! of its own for that session, never the token.
//!
//! **What a session is given.** A client's servers are offered while it is
//! attached and listening on `agentPlugin:call`. An offer replaces the last:
//! a server left out is gone at once (its route answers 404 to the sessions
//! holding it). A client that leaves takes its servers from launches, but a
//! session already given one keeps its route, where every call fails at once
//! saying Helm is not connected, until a client offers that plugin again.
//!
//! **No timers.** A call ends with its answer, with the client leaving or no
//! longer listening (it fails at once, saying so), or with the session no
//! longer waiting, which withdraws it from the client on
//! `agentPlugin:cancel`. Only the client a call was sent to may answer it.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use floti_protocol::channel::{Router, from_payload};
use floti_protocol::channels::agent_plugin::{
    AgentPluginAnswer, AgentPluginCallCancel, AgentPluginCalls, AgentPluginCancels,
    AgentPluginOffer, AgentPluginOutcome, AgentPluginServer, AgentPluginServers,
    AgentPluginToolAnswer, AgentPluginToolCall,
};
use floti_protocol::{ClientChannels, EventChannel, Payload};
use tokio::sync::oneshot;

use super::Feature;
use crate::agent_tools::{JsonObject, Tool, ToolAnnotations};
use crate::server::events::Events;
use crate::session::ClientId;

/// Where a plugin's server is served.
const ROUTE_PREFIX: &str = "/mcp/plugin/";

/// One plugin tool server, checked and ready to list.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PluginServer {
    /// Its name as a session lists it.
    pub name: String,
    /// The plugin's id.
    pub plugin: String,
    /// `/mcp/plugin/<plugin>`.
    pub route: String,
    pub instructions: String,
    /// Its tools, each read-only one marked with `readOnlyHint`.
    pub tools: Vec<Tool>,
}

/// A server sessions may be given or still hold.
#[derive(Debug, Clone)]
pub(crate) struct Offered {
    pub server: Arc<PluginServer>,
    /// Whether a client that can answer it is attached. A server whose
    /// client left is held for the sessions given it, never given again.
    pub connected: bool,
}

/// The relay: what each client offers, which clients listen for calls, and
/// the calls waiting on one.
pub(crate) struct PluginRelay {
    events: Arc<Events>,
    state: Mutex<Relay>,
}

#[derive(Default)]
struct Relay {
    /// Each client's last offer, in the order the clients attached.
    offers: BTreeMap<ClientId, Vec<Arc<PluginServer>>>,
    /// The clients listening on `agentPlugin:call`.
    listening: BTreeSet<ClientId>,
    /// Servers whose client left, by plugin, until a client offers again.
    orphans: BTreeMap<String, Arc<PluginServer>>,
    last_call: u64,
    pending: HashMap<u64, Pending>,
}

/// A call sent to a client and not answered yet.
struct Pending {
    client: ClientId,
    plugin: String,
    answer: oneshot::Sender<AgentPluginOutcome>,
}

impl Relay {
    /// The client answering `plugin`'s calls now, and its server.
    fn answering(&self, plugin: &str) -> Option<(ClientId, &Arc<PluginServer>)> {
        self.offers
            .iter()
            .filter(|(client, _)| self.listening.contains(client))
            .flat_map(|(client, servers)| servers.iter().map(move |server| (*client, server)))
            .find(|(_, server)| server.plugin == plugin)
    }
}

impl PluginRelay {
    /// Serves `agentPlugin:call` and `agentPlugin:cancel` one client at a
    /// time on `events`.
    pub fn new(events: &Arc<Events>) -> Self {
        events.serve_per_client::<AgentPluginCalls>();
        events.serve_per_client::<AgentPluginCancels>();
        Self {
            events: Arc::clone(events),
            state: Mutex::new(Relay::default()),
        }
    }

    /// Every server now: each a listening client offers, the first client
    /// to offer a plugin answering it, then each held for its sessions
    /// after its client left.
    pub fn offered(&self) -> Vec<Offered> {
        let state = self.state();
        let mut seen = HashSet::new();
        let mut all = Vec::new();
        for (client, servers) in &state.offers {
            if !state.listening.contains(client) {
                continue;
            }
            for server in servers {
                if seen.insert(server.plugin.clone()) {
                    all.push(Offered {
                        server: Arc::clone(server),
                        connected: true,
                    });
                }
            }
        }
        for (plugin, server) in &state.orphans {
            if seen.insert(plugin.clone()) {
                all.push(Offered {
                    server: Arc::clone(server),
                    connected: false,
                });
            }
        }
        all
    }

    /// Carries one call of `tool` with `arguments`, made by `session`'s
    /// agent, to the client offering `plugin`, and answers what it answers.
    /// Dropping the future withdraws the call from the client.
    pub async fn call(
        &self,
        session: u64,
        plugin: &str,
        tool: &str,
        arguments: Payload,
    ) -> AgentPluginOutcome {
        let (call, client, answered) = {
            let mut state = self.state();
            let Some((client, _)) = state.answering(plugin) else {
                return AgentPluginOutcome::not_connected(plugin);
            };
            state.last_call += 1;
            let call_id = state.last_call;
            let (answer, answered) = oneshot::channel();
            state.pending.insert(
                call_id,
                Pending {
                    client,
                    plugin: plugin.to_owned(),
                    answer,
                },
            );
            let call = AgentPluginToolCall {
                call_id,
                session,
                plugin: plugin.to_owned(),
                tool: tool.to_owned(),
                arguments,
            };
            (call, client, answered)
        };
        let withdraw = Withdraw {
            relay: self,
            call_id: call.call_id,
        };
        // Sent once it is pending: a client leaving from here on fails it.
        if let Err(err) = self.events.emit_to::<AgentPluginCalls>(client, &call) {
            return AgentPluginOutcome::Failed {
                message: err.to_string(),
            };
        }
        let outcome = answered
            .await
            .unwrap_or_else(|_| AgentPluginOutcome::not_connected(plugin));
        drop(withdraw);
        outcome
    }

    /// `client`'s servers from now on, replacing what it offered before.
    /// Refused, changing nothing, with the sentence saying what is wrong.
    fn offer(&self, client: ClientId, offer: AgentPluginServers) -> Result<(), String> {
        let servers = checked(offer)?;
        let mut state = self.state();
        state.offers.insert(client, servers);
        // A client speaking for its plugins again: what it left out is gone.
        state.orphans.clear();
        Ok(())
    }

    /// `client`'s answer to one call: refused when the call is not waiting
    /// or was sent to another client.
    fn answered(&self, client: ClientId, answer: AgentPluginToolAnswer) -> Result<(), String> {
        let mut state = self.state();
        let call_id = answer.call_id;
        match state.pending.get(&call_id) {
            None => Err(format!(
                "Plugin tool call {call_id} is not waiting for an answer: it was answered \
                 already, its session stopped waiting, or it was never made."
            )),
            Some(pending) if pending.client != client => Err(format!(
                "Plugin tool call {call_id} was sent to another client, so this one cannot \
                 answer it."
            )),
            Some(_) => {
                if let Some(pending) = state.pending.remove(&call_id) {
                    let _ = pending.answer.send(answer.outcome);
                }
                Ok(())
            }
        }
    }

    /// `client` takes calls from now on, or no longer does. When it no
    /// longer does, every call waiting on it fails at once and its servers
    /// are held for the sessions given them; when it has `left`, its offer
    /// goes too.
    fn listening(&self, client: ClientId, listening: bool, left: bool) {
        let mut state = self.state();
        if listening {
            state.listening.insert(client);
            return;
        }
        let was_listening = state.listening.remove(&client);
        let offered = if left {
            state.offers.remove(&client).unwrap_or_default()
        } else if was_listening {
            state.offers.get(&client).cloned().unwrap_or_default()
        } else {
            Vec::new()
        };
        if was_listening {
            for server in offered {
                if state.answering(&server.plugin).is_none() {
                    state.orphans.insert(server.plugin.clone(), server);
                }
            }
        }
        let gone: Vec<u64> = state
            .pending
            .iter()
            .filter(|(_, pending)| pending.client == client)
            .map(|(call_id, _)| *call_id)
            .collect();
        for call_id in gone {
            if let Some(pending) = state.pending.remove(&call_id) {
                let _ = pending
                    .answer
                    .send(AgentPluginOutcome::not_connected(&pending.plugin));
            }
        }
    }

    fn state(&self) -> MutexGuard<'_, Relay> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Withdraws a call when its caller stops waiting: one still unanswered is
/// cancelled at the client it was sent to.
struct Withdraw<'a> {
    relay: &'a PluginRelay,
    call_id: u64,
}

impl Drop for Withdraw<'_> {
    fn drop(&mut self) {
        let unanswered = self.relay.state().pending.remove(&self.call_id);
        if let Some(pending) = unanswered {
            let _ = self.relay.events.emit_to::<AgentPluginCancels>(
                pending.client,
                &AgentPluginCallCancel {
                    call_id: self.call_id,
                },
            );
        }
    }
}

impl Feature for Arc<PluginRelay> {
    fn requests<'a>(&'a self, client: ClientId, router: &mut Router<'a>) {
        router
            .handle::<AgentPluginOffer>(move |offer| self.offer(client, offer))
            .handle::<AgentPluginAnswer>(move |answer| self.answered(client, answer));
    }

    fn subscriptions_changed(&self, client: ClientId, channels: &ClientChannels<'_>) {
        let listening = !channels.subscriptions_to(AgentPluginCalls::NAME).is_empty();
        self.listening(client, listening, false);
    }

    fn client_left(&self, client: ClientId) {
        self.listening(client, false, true);
    }
}

/// An offer, each server checked and its tools made ready to list.
fn checked(offer: AgentPluginServers) -> Result<Vec<Arc<PluginServer>>, String> {
    let mut names = HashSet::new();
    let mut plugins = HashSet::new();
    let mut servers = Vec::with_capacity(offer.servers.len());
    for server in offer.servers {
        let AgentPluginServer {
            name,
            plugin,
            instructions,
            tools,
        } = server;
        if !is_plugin_id(&plugin) {
            return Err(format!(
                "`{plugin}` is not a plugin id: lower-case letters, digits and dashes, starting \
                 with a letter or digit."
            ));
        }
        if !is_name(&name) {
            return Err(format!(
                "`{name}` is not a tool server name: letters, digits, dashes and underscores."
            ));
        }
        if !names.insert(name.clone()) || !plugins.insert(plugin.clone()) {
            return Err(format!(
                "The plugin tool servers offered name `{name}` or plugin `{plugin}` twice."
            ));
        }
        let mut tool_names = HashSet::new();
        let mut listed = Vec::with_capacity(tools.len());
        for tool in tools {
            if !is_name(&tool.name) || !tool_names.insert(tool.name.clone()) {
                return Err(format!(
                    "`{}` is not a tool name {name} can list: letters, digits, dashes and \
                     underscores, each name once.",
                    tool.name
                ));
            }
            let schema: JsonObject = from_payload(&tool.input_schema).map_err(|_| {
                format!(
                    "The input schema of {name}'s tool `{}` is not a JSON object.",
                    tool.name
                )
            })?;
            let mut listing = Tool::new(tool.name, tool.description, schema);
            if tool.read_only {
                listing = listing.with_annotations(ToolAnnotations::new().read_only(true));
            }
            listed.push(listing);
        }
        servers.push(Arc::new(PluginServer {
            route: format!("{ROUTE_PREFIX}{plugin}"),
            name,
            plugin,
            instructions,
            tools: listed,
        }));
    }
    Ok(servers)
}

/// A plugin id as plugin manifests have them: it goes into a route unescaped.
fn is_plugin_id(id: &str) -> bool {
    let mut bytes = id.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && id.len() <= 63
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// A server or tool name: it goes into an allow rule, `mcp__<server>__<tool>`.
fn is_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[cfg(test)]
mod tests;
