//! The relay with no listener: offers, calls, answers, cancels and clients
//! leaving, driven on the relay itself.

use floti_protocol::channel::to_payload;
use floti_protocol::channels::agent_plugin::AgentPluginTool;
use serde_json::json;
use tokio::sync::broadcast::Receiver;

use super::*;
use crate::server::events::Publication;

const DESKTOP: ClientId = ClientId(1);
const OTHER: ClientId = ClientId(2);

/// A relay on a host that has the notes and tasks plugins on, with their
/// tools on.
fn relay() -> (Arc<Events>, Arc<PluginRelay>) {
    let events = Arc::new(Events::new());
    let relay = Arc::new(PluginRelay::new(&events));
    relay.installed(&[installed("notes", true), installed("tasks", true)]);
    (events, relay)
}

/// Plugin `id` as this host lists it: on and error-free, with its tools on or
/// off.
fn installed(id: &str, tools_on: bool) -> PluginInfo {
    use floti_protocol::channels::plugins::PluginAgentInfo;
    PluginInfo {
        path: format!("/plugins/{id}"),
        id: Some(id.into()),
        name: id.into(),
        version: Some("1.0.0".into()),
        description: None,
        enabled: true,
        error: None,
        warnings: Vec::new(),
        revision: 1,
        icon: None,
        rail: None,
        panels: BTreeMap::new(),
        tabs: BTreeMap::new(),
        page_strip: false,
        background: None,
        commands: Vec::new(),
        settings: Vec::new(),
        setting_values: BTreeMap::new(),
        network: Vec::new(),
        secrets: Vec::new(),
        exec: Vec::new(),
        service: None,
        runs_programs: false,
        agent: Some(PluginAgentInfo {
            enabled: tools_on,
            server: format!("helm-plugin-{id}"),
            instructions: None,
            tools: Vec::new(),
        }),
        starts_sessions: false,
        sees_sessions: false,
        status: None,
        badge: None,
    }
}

fn tool(name: &str, read_only: bool) -> AgentPluginTool {
    AgentPluginTool {
        name: name.into(),
        description: format!("The {name} tool."),
        input_schema: to_payload(&json!({ "type": "object", "properties": {} })).unwrap(),
        read_only,
    }
}

fn server(plugin: &str) -> AgentPluginServer {
    AgentPluginServer {
        name: format!("helm-plugin-{plugin}"),
        plugin: plugin.into(),
        instructions: format!("These tools come from \"{plugin}\"."),
        tools: vec![tool("find", true), tool("write", false)],
    }
}

fn offer(servers: Vec<AgentPluginServer>) -> AgentPluginServers {
    AgentPluginServers { servers }
}

fn done(text: &str) -> AgentPluginOutcome {
    AgentPluginOutcome::Done {
        value: Payload::Text(text.to_owned()),
    }
}

/// The next event on `channel` sent to `client`'s connection.
async fn sent<T: serde::de::DeserializeOwned>(
    listening: &mut Receiver<Publication>,
    channel: &str,
    client: ClientId,
) -> T {
    loop {
        let published = listening.recv().await.expect("a publication");
        if published.channel == channel && published.is_for(client) {
            return from_payload(&published.payload).expect("an event");
        }
    }
}

fn plugins_offered(relay: &PluginRelay) -> Vec<(String, bool)> {
    relay
        .offered()
        .into_iter()
        .map(|offered| (offered.server.plugin.clone(), offered.connected))
        .collect()
}

#[tokio::test]
async fn s6_a_call_with_no_client_offering_the_plugin_fails_at_once_naming_helm() {
    let (_events, relay) = relay();
    let outcome = relay.call(3, "notes", "find", Payload::Null).await;
    let AgentPluginOutcome::Failed { message } = outcome else {
        panic!("a call with nobody to answer it was answered");
    };
    assert!(
        message.contains("Helm's window is not connected"),
        "{message}"
    );
    assert!(message.contains("notes"), "{message}");
}

#[test]
fn an_offer_is_served_only_while_its_client_listens_and_a_new_offer_replaces_the_last() {
    let (_events, relay) = relay();
    relay
        .offer(DESKTOP, offer(vec![server("notes"), server("tasks")]))
        .unwrap();
    // Offered but not listening for calls: nothing is served.
    assert!(relay.offered().is_empty());
    relay.listening(DESKTOP, true, false);
    assert_eq!(
        plugins_offered(&relay),
        [("notes".to_owned(), true), ("tasks".to_owned(), true)]
    );
    let notes = relay.offered().remove(0).server;
    assert_eq!(notes.name, "helm-plugin-notes");
    assert_eq!(notes.route, "/mcp/plugin/notes");
    // The read-only tool is marked, the other is not.
    let marks: Vec<(String, Option<bool>)> = notes
        .tools
        .iter()
        .map(|tool| {
            (
                tool.name.to_string(),
                tool.annotations
                    .as_ref()
                    .and_then(|notes| notes.read_only_hint),
            )
        })
        .collect();
    assert_eq!(
        marks,
        [("find".to_owned(), Some(true)), ("write".to_owned(), None)]
    );

    // A plugin switched off is left out of the next offer: gone at once.
    relay.offer(DESKTOP, offer(vec![server("tasks")])).unwrap();
    assert_eq!(plugins_offered(&relay), [("tasks".to_owned(), true)]);
}

#[test]
fn whoever_follows_the_offers_is_told_of_each_offer_and_each_client_that_stops_taking_calls_and_can_read_them()
 {
    let (_events, relay) = relay();
    let told = Arc::new(Mutex::new(Vec::new()));
    relay.on_change({
        let told = Arc::clone(&told);
        let reading = Arc::downgrade(&relay);
        // Reads the offers as it is told: no lock of the relay is held.
        move || {
            let now = reading.upgrade().map(|relay| plugins_offered(&relay));
            told.lock().unwrap().push(now.unwrap_or_default());
        }
    });
    relay.listening(DESKTOP, true, false);
    assert!(
        told.lock().unwrap().is_empty(),
        "taking calls changes no offer"
    );
    relay.offer(DESKTOP, offer(vec![server("notes")])).unwrap();
    relay.offer(DESKTOP, offer(Vec::new())).unwrap();
    relay.offer(DESKTOP, offer(vec![server("notes")])).unwrap();
    relay.listening(DESKTOP, false, true);
    assert_eq!(
        *told.lock().unwrap(),
        [
            vec![("notes".to_owned(), true)],
            Vec::new(),
            vec![("notes".to_owned(), true)],
            vec![("notes".to_owned(), false)],
        ]
    );

    // A refused offer changes nothing, so nobody is told.
    let mut wrong = server("notes");
    wrong.plugin = "Not An Id".into();
    assert!(relay.offer(DESKTOP, offer(vec![wrong])).is_err());
    assert_eq!(told.lock().unwrap().len(), 4);
}

#[test]
fn an_offer_with_a_name_an_id_or_a_schema_no_session_can_use_is_refused_and_changes_nothing() {
    let (_events, relay) = relay();
    relay.listening(DESKTOP, true, false);
    relay.offer(DESKTOP, offer(vec![server("notes")])).unwrap();

    let mut bad_id = server("tasks");
    bad_id.plugin = "../tasks".into();
    let mut bad_name = server("tasks");
    bad_name.name = "helm plugin".into();
    let mut bad_tool = server("tasks");
    bad_tool.tools.push(tool("find", false));
    let mut bad_schema = server("tasks");
    bad_schema.tools[0].input_schema = Payload::Text("not an object".into());
    for (wrong, says) in [
        (offer(vec![bad_id]), "is not a plugin id"),
        (offer(vec![bad_name]), "is not a tool server name"),
        (offer(vec![bad_tool]), "is not a tool name"),
        (offer(vec![bad_schema]), "is not a JSON object"),
        (offer(vec![server("tasks"), server("tasks")]), "twice"),
    ] {
        let refused = relay.offer(DESKTOP, wrong).unwrap_err();
        assert!(refused.contains(says), "{refused}");
    }
    assert_eq!(plugins_offered(&relay), [("notes".to_owned(), true)]);
}

#[tokio::test]
async fn s4_a_call_goes_to_the_client_that_offered_the_plugin_naming_its_session_and_takes_its_answer()
 {
    let (events, relay) = relay();
    let mut listening = events.listen(DESKTOP);
    let _other = events.listen(OTHER);
    relay.listening(DESKTOP, true, false);
    relay.listening(OTHER, true, false);
    relay.offer(DESKTOP, offer(vec![server("notes")])).unwrap();
    let calling = {
        let relay = Arc::clone(&relay);
        tokio::spawn(async move {
            relay
                .call(7, "notes", "find", Payload::Text("args".into()))
                .await
        })
    };
    let call: AgentPluginToolCall = sent(&mut listening, AgentPluginCalls::NAME, DESKTOP).await;
    assert_eq!(
        (call.session, call.plugin.as_str(), call.tool.as_str()),
        (7, "notes", "find")
    );
    assert_eq!(call.arguments, Payload::Text("args".into()));

    // Only the client it was sent to answers it.
    let refused = relay
        .answered(
            OTHER,
            AgentPluginToolAnswer {
                call_id: call.call_id,
                outcome: done("forged"),
            },
        )
        .unwrap_err();
    assert!(refused.contains("sent to another client"), "{refused}");
    relay
        .answered(
            DESKTOP,
            AgentPluginToolAnswer {
                call_id: call.call_id,
                outcome: done("found"),
            },
        )
        .unwrap();
    assert_eq!(calling.await.unwrap(), done("found"));
    // Answered once: a second answer is refused.
    assert!(
        relay
            .answered(
                DESKTOP,
                AgentPluginToolAnswer {
                    call_id: call.call_id,
                    outcome: done("again"),
                },
            )
            .is_err()
    );
}

#[tokio::test]
async fn s6_a_call_nobody_waits_on_any_more_is_cancelled_at_its_client_and_cannot_be_answered() {
    let (events, relay) = relay();
    let mut listening = events.listen(DESKTOP);
    relay.listening(DESKTOP, true, false);
    relay.offer(DESKTOP, offer(vec![server("notes")])).unwrap();
    let calling = {
        let relay = Arc::clone(&relay);
        tokio::spawn(async move { relay.call(7, "notes", "write", Payload::Null).await })
    };
    let call: AgentPluginToolCall = sent(&mut listening, AgentPluginCalls::NAME, DESKTOP).await;
    calling.abort();
    let _ = calling.await;
    let cancel: AgentPluginCallCancel =
        sent(&mut listening, AgentPluginCancels::NAME, DESKTOP).await;
    assert_eq!(cancel.call_id, call.call_id);
    assert!(
        relay
            .answered(
                DESKTOP,
                AgentPluginToolAnswer {
                    call_id: call.call_id,
                    outcome: done("late"),
                },
            )
            .is_err()
    );
}

#[tokio::test]
async fn s6_when_the_client_leaves_its_calls_fail_at_once_and_its_servers_are_held_but_never_given()
{
    let (events, relay) = relay();
    let mut listening = events.listen(DESKTOP);
    relay.listening(DESKTOP, true, false);
    relay.offer(DESKTOP, offer(vec![server("notes")])).unwrap();
    let calling = {
        let relay = Arc::clone(&relay);
        tokio::spawn(async move { relay.call(7, "notes", "find", Payload::Null).await })
    };
    let _call: AgentPluginToolCall = sent(&mut listening, AgentPluginCalls::NAME, DESKTOP).await;
    relay.listening(DESKTOP, false, true);
    let AgentPluginOutcome::Failed { message } = calling.await.unwrap() else {
        panic!("a call waiting on a client that left was answered");
    };
    assert!(message.contains("not connected"), "{message}");

    // Held for the sessions given it, as not connected.
    assert_eq!(plugins_offered(&relay), [("notes".to_owned(), false)]);
    let AgentPluginOutcome::Failed { message } =
        relay.call(7, "notes", "find", Payload::Null).await
    else {
        panic!("a call with nobody to answer it was answered");
    };
    assert!(message.contains("not connected"), "{message}");

    // A client offering again speaks for the plugins: what it leaves out is
    // gone, what it offers is served again.
    relay.listening(OTHER, true, false);
    relay.offer(OTHER, offer(vec![server("tasks")])).unwrap();
    assert_eq!(plugins_offered(&relay), [("tasks".to_owned(), true)]);
}

#[tokio::test]
async fn s21_a_plugin_this_host_does_not_have_is_neither_offered_nor_called_whatever_a_client_offers()
 {
    let (events, relay) = relay();
    let mut listening = events.listen(DESKTOP);
    relay.listening(DESKTOP, true, false);
    // The window offers a plugin only This PC has, beside one this host has.
    relay
        .offer(DESKTOP, offer(vec![server("notes"), server("trackr")]))
        .unwrap();
    assert_eq!(plugins_offered(&relay), [("notes".to_owned(), true)]);

    // A call to it is answered here, never sent to the client.
    let outcome = relay.call(3, "trackr", "find", Payload::Null).await;
    assert!(
        matches!(outcome, AgentPluginOutcome::Failed { .. }),
        "{outcome:?}"
    );
    let calls = std::iter::from_fn(|| listening.try_recv().ok())
        .filter(|published| published.channel == AgentPluginCalls::NAME)
        .count();
    assert_eq!(
        calls, 0,
        "a call to a plugin this host lacks reached the client"
    );
}

#[test]
fn s21_a_host_serves_a_plugins_tools_only_while_it_has_the_plugin_on_with_its_tools_on() {
    let (_events, relay) = relay();
    let told = Arc::new(Mutex::new(0));
    relay.on_change({
        let told = Arc::clone(&told);
        move || *told.lock().unwrap() += 1
    });
    relay.listening(DESKTOP, true, false);
    relay
        .offer(DESKTOP, offer(vec![server("notes"), server("tasks")]))
        .unwrap();
    assert_eq!(
        plugins_offered(&relay),
        [("notes".to_owned(), true), ("tasks".to_owned(), true)]
    );

    // Tasks' tools switched off here: gone at once, and whoever follows is told.
    relay.installed(&[installed("notes", true), installed("tasks", false)]);
    assert_eq!(plugins_offered(&relay), [("notes".to_owned(), true)]);
    // Notes switched off, then in error.
    let mut off = installed("notes", true);
    off.enabled = false;
    relay.installed(&[off]);
    assert!(relay.offered().is_empty());
    let mut broken = installed("notes", true);
    broken.error = Some("No manifest.".into());
    relay.installed(&[broken]);
    assert!(relay.offered().is_empty());

    // Back on: served again from the offer the window made.
    relay.installed(&[installed("notes", true)]);
    assert_eq!(plugins_offered(&relay), [("notes".to_owned(), true)]);
    // The same list again changes nothing, so nobody is told.
    let before = *told.lock().unwrap();
    relay.installed(&[installed("notes", true)]);
    assert_eq!(*told.lock().unwrap(), before);

    // Held for its sessions after the window left, but only while the
    // plugin is still on here.
    relay.listening(DESKTOP, false, true);
    assert_eq!(plugins_offered(&relay), [("notes".to_owned(), false)]);
    relay.installed(&[]);
    assert!(relay.offered().is_empty());
}
