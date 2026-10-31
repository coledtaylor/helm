//! The agent browser tools' relay: `agentBrowser:call` and
//! `agentBrowser:answer`.
//!
//! The host serves helm-browser to its sessions, but the browser pane is a
//! client's. So each call is carried to one attached client that declared
//! `browser` and listens on `agentBrowser:call` ([`browser_client`]), and the
//! tool answers with what that client answers. The call names the session
//! whose token made it: which tabs it may drive, and the reach rule every
//! navigation passes, are the client's to judge, with its own settings.
//!
//! **No timers.** A call ends with its answer, with the client it was sent to
//! leaving or no longer listening (it fails at once, saying no browser is
//! attached), or with the agent hanging up, which forgets it. A call made
//! while no browser client is attached fails at once the same way; a client
//! that attaches later gets later calls.
//!
//! **Only the client a call was sent to answers it.** An answer naming a call
//! sent to another client is refused, and the call goes on waiting for its
//! own client.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use floti_protocol::channel::Router;
use floti_protocol::channels::agent_browser::{
    AgentBrowserAnswer, AgentBrowserCalls, AgentBrowserOutcome, AgentBrowserToolAnswer,
    AgentBrowserToolCall, browser_client,
};
use floti_protocol::{ClientChannels, Payload};
use tokio::sync::oneshot;

use super::{Caller, Feature};
use crate::server::events::Events;
use crate::session::ClientId;

/// The relay: which clients can take a call, and the calls waiting on one.
pub(crate) struct BrowserRelay {
    events: Arc<Events>,
    state: Mutex<Relay>,
}

#[derive(Default)]
struct Relay {
    /// The clients a call may go to, in the order they are preferred: the
    /// longest attached first.
    browsers: BTreeSet<ClientId>,
    /// The number of the last call.
    last_call: u64,
    pending: HashMap<u64, Pending>,
}

/// A call sent to a client and not answered yet.
struct Pending {
    client: ClientId,
    answer: oneshot::Sender<AgentBrowserOutcome>,
}

impl BrowserRelay {
    /// Serves `agentBrowser:call` one client at a time on `events`.
    pub fn new(events: &Arc<Events>) -> Self {
        events.serve_per_client::<AgentBrowserCalls>();
        Self {
            events: Arc::clone(events),
            state: Mutex::new(Relay::default()),
        }
    }

    /// Whether a call made now would go to a client.
    pub fn has_browser(&self) -> bool {
        !self.state().browsers.is_empty()
    }

    /// Carries one call of `tool` with `arguments`, made by `session`'s
    /// agent, to the preferred browser client, and answers what it answers.
    /// Dropping the future forgets the call.
    pub async fn call(&self, session: u64, tool: &str, arguments: Payload) -> AgentBrowserOutcome {
        let (call, client, answered) = {
            let mut state = self.state();
            let Some(client) = state.browsers.first().copied() else {
                return AgentBrowserOutcome::no_browser_client();
            };
            state.last_call += 1;
            let call_id = state.last_call;
            let (answer, answered) = oneshot::channel();
            state.pending.insert(call_id, Pending { client, answer });
            let call = AgentBrowserToolCall {
                call_id,
                session,
                tool: tool.to_owned(),
                arguments,
            };
            (call, client, answered)
        };
        let forget = Forget {
            relay: self,
            call_id: call.call_id,
        };
        // Sent once it is pending: a client leaving from here on fails it.
        if let Err(err) = self.events.emit_to::<AgentBrowserCalls>(client, &call) {
            return AgentBrowserOutcome::Failed {
                message: err.to_string(),
            };
        }
        let outcome = answered
            .await
            .unwrap_or_else(|_| AgentBrowserOutcome::no_browser_client());
        drop(forget);
        outcome
    }

    /// `client`'s answer to one call: refused when the call is not waiting
    /// or was sent to another client.
    fn answered(&self, client: ClientId, answer: AgentBrowserToolAnswer) -> Result<(), String> {
        let mut state = self.state();
        let call_id = answer.call_id;
        match state.pending.get(&call_id) {
            None => Err(format!(
                "Browser tool call {call_id} is not waiting for an answer: it was answered \
                 already, its session stopped waiting, or it was never made."
            )),
            Some(pending) if pending.client != client => Err(format!(
                "Browser tool call {call_id} was sent to another client, so this one cannot \
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

    /// `client` takes calls from now on, or no longer does; when it no
    /// longer does, every call waiting on it fails at once.
    fn listening(&self, client: ClientId, listening: bool) {
        let mut state = self.state();
        if listening {
            state.browsers.insert(client);
            return;
        }
        state.browsers.remove(&client);
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
                    .send(AgentBrowserOutcome::no_browser_client());
            }
        }
    }

    fn state(&self) -> MutexGuard<'_, Relay> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Forgets a call when its caller stops waiting, answered or not.
struct Forget<'a> {
    relay: &'a BrowserRelay,
    call_id: u64,
}

impl Drop for Forget<'_> {
    fn drop(&mut self) {
        self.relay.state().pending.remove(&self.call_id);
    }
}

impl Feature for Arc<BrowserRelay> {
    fn requests<'a>(&'a self, Caller { client, .. }: Caller, router: &mut Router<'a>) {
        router.handle::<AgentBrowserAnswer>(move |answer| self.answered(client, answer));
    }

    fn subscriptions_changed(&self, client: ClientId, channels: &ClientChannels<'_>) {
        self.listening(client, browser_client([(client, channels)]).is_ok());
    }

    fn client_left(&self, client: ClientId) {
        self.listening(client, false);
    }
}

#[cfg(test)]
mod tests {
    use floti_protocol::EventChannel as _;
    use floti_protocol::channel::from_payload;

    use super::*;

    const DESKTOP: ClientId = ClientId(1);
    const OTHER: ClientId = ClientId(2);

    fn relay() -> (Arc<Events>, Arc<BrowserRelay>) {
        let events = Arc::new(Events::new());
        let relay = Arc::new(BrowserRelay::new(&events));
        (events, relay)
    }

    fn done(text: &str) -> AgentBrowserOutcome {
        AgentBrowserOutcome::Done {
            value: Payload::Text(text.to_owned()),
        }
    }

    /// The next call sent to `client`'s connection.
    async fn sent(
        listening: &mut tokio::sync::broadcast::Receiver<crate::server::events::Publication>,
        client: ClientId,
    ) -> AgentBrowserToolCall {
        loop {
            let published = listening.recv().await.expect("a publication");
            if published.channel == AgentBrowserCalls::NAME && published.is_for(client) {
                return from_payload(&published.payload).expect("a call");
            }
        }
    }

    #[tokio::test]
    async fn a_call_with_no_browser_client_fails_at_once_saying_no_browser_is_attached() {
        let (_events, relay) = relay();
        assert!(!relay.has_browser());
        let outcome = relay.call(3, "browser_tabs", Payload::Null).await;
        assert_eq!(outcome, AgentBrowserOutcome::no_browser_client());
        let AgentBrowserOutcome::Failed { message } = outcome else {
            unreachable!()
        };
        assert!(message.contains("No browser is attached"), "{message}");
        assert!(message.contains("Helm"), "{message}");
    }

    #[tokio::test]
    async fn a_call_goes_to_the_browser_client_naming_its_session_and_takes_its_answer() {
        let (events, relay) = relay();
        let mut listening = events.listen(DESKTOP);
        relay.listening(DESKTOP, true);
        let calling = {
            let relay = Arc::clone(&relay);
            tokio::spawn(async move {
                relay
                    .call(7, "browser_open", Payload::Text("args".into()))
                    .await
            })
        };
        let call = sent(&mut listening, DESKTOP).await;
        assert_eq!(call.session, 7);
        assert_eq!(call.tool, "browser_open");
        assert_eq!(call.arguments, Payload::Text("args".into()));
        relay
            .answered(
                DESKTOP,
                AgentBrowserToolAnswer {
                    call_id: call.call_id,
                    outcome: done("opened"),
                },
            )
            .unwrap();
        assert_eq!(calling.await.unwrap(), done("opened"));
        // Answered once: a second answer is refused.
        assert!(
            relay
                .answered(
                    DESKTOP,
                    AgentBrowserToolAnswer {
                        call_id: call.call_id,
                        outcome: done("again"),
                    },
                )
                .is_err()
        );
    }

    #[tokio::test]
    async fn an_answer_from_a_client_the_call_was_not_sent_to_is_refused_and_the_call_waits_on() {
        let (events, relay) = relay();
        let mut listening = events.listen(DESKTOP);
        let _other = events.listen(OTHER);
        relay.listening(DESKTOP, true);
        relay.listening(OTHER, true);
        let calling = {
            let relay = Arc::clone(&relay);
            tokio::spawn(async move { relay.call(1, "browser_tabs", Payload::Null).await })
        };
        let call = sent(&mut listening, DESKTOP).await;
        let refused = relay
            .answered(
                OTHER,
                AgentBrowserToolAnswer {
                    call_id: call.call_id,
                    outcome: done("forged"),
                },
            )
            .unwrap_err();
        assert!(refused.contains("sent to another client"), "{refused}");
        relay
            .answered(
                DESKTOP,
                AgentBrowserToolAnswer {
                    call_id: call.call_id,
                    outcome: done("mine"),
                },
            )
            .unwrap();
        assert_eq!(calling.await.unwrap(), done("mine"));
    }

    #[tokio::test]
    async fn calls_waiting_on_a_client_that_leaves_or_stops_listening_fail_at_once() {
        for leaves in [true, false] {
            let (events, relay) = relay();
            let mut listening = events.listen(DESKTOP);
            relay.listening(DESKTOP, true);
            let calling = {
                let relay = Arc::clone(&relay);
                tokio::spawn(async move { relay.call(1, "browser_wait_for", Payload::Null).await })
            };
            let _call = sent(&mut listening, DESKTOP).await;
            if leaves {
                relay.client_left(DESKTOP);
            } else {
                relay.listening(DESKTOP, false);
            }
            assert_eq!(
                calling.await.unwrap(),
                AgentBrowserOutcome::no_browser_client()
            );
            assert!(!relay.has_browser());
            assert!(relay.state().pending.is_empty());
        }
    }

    #[tokio::test]
    async fn a_client_attached_later_gets_later_calls() {
        let (events, relay) = relay();
        relay.listening(DESKTOP, true);
        relay.client_left(DESKTOP);
        let mut listening = events.listen(OTHER);
        relay.listening(OTHER, true);
        let calling = {
            let relay = Arc::clone(&relay);
            tokio::spawn(async move { relay.call(2, "browser_tabs", Payload::Null).await })
        };
        let call = sent(&mut listening, OTHER).await;
        relay
            .answered(
                OTHER,
                AgentBrowserToolAnswer {
                    call_id: call.call_id,
                    outcome: done("tabs"),
                },
            )
            .unwrap();
        assert_eq!(calling.await.unwrap(), done("tabs"));
    }

    #[tokio::test]
    async fn a_caller_that_stops_waiting_leaves_nothing_pending() {
        let (events, relay) = relay();
        let mut listening = events.listen(DESKTOP);
        relay.listening(DESKTOP, true);
        let calling = {
            let relay = Arc::clone(&relay);
            tokio::spawn(async move { relay.call(1, "browser_wait_for", Payload::Null).await })
        };
        let call = sent(&mut listening, DESKTOP).await;
        calling.abort();
        assert!(calling.await.unwrap_err().is_cancelled());
        assert!(relay.state().pending.is_empty());
        assert!(
            relay
                .answered(
                    DESKTOP,
                    AgentBrowserToolAnswer {
                        call_id: call.call_id,
                        outcome: done("late"),
                    },
                )
                .is_err()
        );
    }
}
