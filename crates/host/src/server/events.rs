//! The event channels the host serves, and what each subscriber is sent.
//!
//! A feature serves an event channel by declaring it here, then publishing
//! on it. A channel that carries state ([`Events::serve_state`]) holds its
//! whole state: a subscription to it starts with that state as its snapshot,
//! and every change sends the whole state again as the next numbered event.
//! A channel without state ([`Events::serve_events`]) sends nothing on
//! subscribe and broadcasts each event to every subscription from then on.
//!
//! A channel without state can instead be served one client at a time
//! ([`Events::serve_per_client`]): each event on it is addressed to one
//! client ([`Events::emit_to`]) and goes only to that client's
//! subscriptions. Its events are numbered per client, so a client's numbers
//! run on without a gap however many went to others, and a gap still means
//! only that this client missed some. A channel is one or the other, never
//! both.
//!
//! Every connection listens to one broadcast of every publication and picks
//! out its own subscriptions' channels, and of a per-client channel only the
//! events addressed to it. A connection that falls too far behind misses
//! publications; the gap in the numbers tells its client to subscribe again
//! for a fresh snapshot.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Mutex, MutexGuard, PoisonError};

use floti_protocol::Payload;
use floti_protocol::channel::{EventChannel, to_payload};
use serde::Serialize;
use tokio::sync::broadcast;

use crate::session::ClientId;

/// How many publications a connection may fall behind before it misses some.
const BACKLOG: usize = 256;

/// One event on one channel, for every connection to deliver to its
/// subscriptions on that channel, or for one connection's only.
#[derive(Debug, Clone)]
pub(crate) struct Publication {
    pub channel: &'static str,
    /// The one client this is for, or `None` for every subscriber.
    pub to: Option<ClientId>,
    pub seq: u64,
    pub payload: Payload,
}

impl Publication {
    /// Whether `client`'s subscriptions are sent this.
    pub fn is_for(&self, client: ClientId) -> bool {
        self.to.is_none_or(|to| to == client)
    }
}

/// How a subscription to a served channel starts.
#[derive(Debug, Clone)]
pub(crate) enum Start {
    /// The channel's state, which includes every event up to `seq`.
    Snapshot { seq: u64, state: Payload },
    /// Nothing until the next event: the channel carries no state.
    Quiet,
}

/// How one served channel numbers its events.
enum Numbering {
    /// One sequence every subscriber shares: the number of the last event.
    Shared(u64),
    /// One sequence per listening client: the number of the last event
    /// addressed to each.
    PerClient(HashMap<ClientId, u64>),
}

/// One served channel: how its events are numbered, and its state when it
/// carries one.
struct Channel {
    numbering: Numbering,
    state: Option<Payload>,
}

impl Channel {
    /// The next number on a channel every subscriber shares.
    fn next_shared(&mut self, name: &str) -> u64 {
        match &mut self.numbering {
            Numbering::Shared(seq) => {
                *seq += 1;
                *seq
            }
            Numbering::PerClient(_) => {
                panic!("event channel `{name}` is served one client at a time")
            }
        }
    }

    /// The next number on a channel served one client at a time, for
    /// `client`.
    fn next_for(&mut self, name: &str, client: ClientId) -> u64 {
        let Numbering::PerClient(seqs) = &mut self.numbering else {
            panic!("event channel `{name}` is served to every subscriber alike")
        };
        let seq = seqs.entry(client).or_insert(0);
        *seq += 1;
        *seq
    }
}

struct Served {
    channels: HashMap<&'static str, Channel>,
    /// The clients listening now.
    clients: BTreeSet<ClientId>,
}

/// Every event channel the host serves.
pub(crate) struct Events {
    served: Mutex<Served>,
    published: broadcast::Sender<Publication>,
}

impl Events {
    pub fn new() -> Self {
        let (published, _) = broadcast::channel(BACKLOG);
        Self {
            served: Mutex::new(Served {
                channels: HashMap::new(),
                clients: BTreeSet::new(),
            }),
            published,
        }
    }

    /// Serves `C`, a channel that carries state, starting from `state`.
    pub fn serve_state<C, S>(&self, state: &S) -> crate::Result<()>
    where
        C: EventChannel<Event = S, Snapshot = S>,
        S: Serialize,
    {
        const {
            assert!(
                C::SNAPSHOT,
                "serve_state is for a channel that carries state"
            )
        };
        let state = encode::<C, S>(state)?;
        self.declare(C::NAME, Numbering::Shared(0), Some(state));
        Ok(())
    }

    /// Serves `C`, a channel that carries state whose snapshot is not its
    /// events' type (one that is null until the first event, say), starting
    /// from `snapshot`. Publish on it with [`Self::set_state_as`].
    pub fn serve_state_from<C: EventChannel>(&self, snapshot: &C::Snapshot) -> crate::Result<()> {
        const {
            assert!(
                C::SNAPSHOT,
                "serve_state_from is for a channel that carries state"
            )
        };
        let state = encode::<C, C::Snapshot>(snapshot)?;
        self.declare(C::NAME, Numbering::Shared(0), Some(state));
        Ok(())
    }

    /// `C`'s state is now `snapshot`, which later subscriptions start with,
    /// and `event`, which says the same, goes to every subscription now as
    /// the next event.
    pub fn set_state_as<C: EventChannel>(
        &self,
        event: &C::Event,
        snapshot: &C::Snapshot,
    ) -> crate::Result<()> {
        let payload = encode::<C, C::Event>(event)?;
        let state = encode::<C, C::Snapshot>(snapshot)?;
        let mut served = self.lock();
        let channel = channel(&mut served, C::NAME);
        channel.state = Some(state);
        let seq = channel.next_shared(C::NAME);
        let _ = self.published.send(Publication {
            channel: C::NAME,
            to: None,
            seq,
            payload,
        });
        Ok(())
    }

    /// Serves `C`, a channel whose events carry no state, to every
    /// subscriber alike.
    pub fn serve_events<C: EventChannel>(&self) {
        const { assert!(!C::SNAPSHOT, "serve_events is for a channel without state") };
        self.declare(C::NAME, Numbering::Shared(0), None);
    }

    /// Serves `C`, a channel whose events carry no state, one client at a
    /// time: each event is for one client and numbered for that client alone.
    pub fn serve_per_client<C: EventChannel>(&self) {
        const {
            assert!(
                !C::SNAPSHOT,
                "serve_per_client is for a channel without state"
            )
        };
        self.declare(C::NAME, Numbering::PerClient(HashMap::new()), None);
    }

    fn declare(&self, name: &'static str, numbering: Numbering, state: Option<Payload>) {
        let previous = self
            .lock()
            .channels
            .insert(name, Channel { numbering, state });
        assert!(previous.is_none(), "event channel `{name}` is served twice");
    }

    /// `C`'s state is now `state`: it becomes the snapshot later
    /// subscriptions start with, and goes to every subscription now as the
    /// next event.
    pub fn set_state<C, S>(&self, state: &S) -> crate::Result<()>
    where
        C: EventChannel<Event = S, Snapshot = S>,
        S: Serialize,
    {
        let payload = encode::<C, S>(state)?;
        let mut served = self.lock();
        let channel = channel(&mut served, C::NAME);
        channel.state = Some(payload.clone());
        let seq = channel.next_shared(C::NAME);
        // Sent under the lock, so publications go out in their numbers'
        // order and a snapshot is never behind an event already sent.
        // Nobody listening is not a failure.
        let _ = self.published.send(Publication {
            channel: C::NAME,
            to: None,
            seq,
            payload,
        });
        Ok(())
    }

    /// One event on `C`, a channel without state served to every subscriber
    /// alike, to every subscription to it now.
    pub fn emit<C: EventChannel>(&self, event: &C::Event) -> crate::Result<()> {
        let payload = encode::<C, C::Event>(event)?;
        let mut served = self.lock();
        let seq = channel(&mut served, C::NAME).next_shared(C::NAME);
        let _ = self.published.send(Publication {
            channel: C::NAME,
            to: None,
            seq,
            payload,
        });
        Ok(())
    }

    /// One event on `C`, a channel served one client at a time, to
    /// `client`'s subscriptions to it and nobody else's. A client that is not
    /// listening is sent nothing, and nothing is numbered for it.
    pub fn emit_to<C: EventChannel>(
        &self,
        client: ClientId,
        event: &C::Event,
    ) -> crate::Result<()> {
        let payload = encode::<C, C::Event>(event)?;
        let mut served = self.lock();
        let listening = served.clients.contains(&client);
        let channel = channel(&mut served, C::NAME);
        assert!(
            matches!(channel.numbering, Numbering::PerClient(_)),
            "event channel `{}` is served to every subscriber alike",
            C::NAME
        );
        if !listening {
            return Ok(());
        }
        let seq = channel.next_for(C::NAME, client);
        let _ = self.published.send(Publication {
            channel: C::NAME,
            to: Some(client),
            seq,
            payload,
        });
        Ok(())
    }

    /// How a subscription to `channel` starts, or `None` when the host does
    /// not serve it.
    pub fn start(&self, channel: &str) -> Option<Start> {
        let served = self.lock();
        let channel = served.channels.get(channel)?;
        Some(match (&channel.state, &channel.numbering) {
            (Some(state), Numbering::Shared(seq)) => Start::Snapshot {
                seq: *seq,
                state: state.clone(),
            },
            _ => Start::Quiet,
        })
    }

    /// Every publication from now on, for `client`'s connection, which is
    /// listening until it [leaves](Self::leave).
    pub fn listen(&self, client: ClientId) -> broadcast::Receiver<Publication> {
        let mut served = self.lock();
        served.clients.insert(client);
        // Under the lock, so nothing is numbered for the client before it
        // can hear it.
        self.published.subscribe()
    }

    /// `client` has gone: nothing more is addressed to it, and its numbers
    /// are forgotten.
    pub fn leave(&self, client: ClientId) {
        let mut served = self.lock();
        served.clients.remove(&client);
        for channel in served.channels.values_mut() {
            if let Numbering::PerClient(seqs) = &mut channel.numbering {
                seqs.remove(&client);
            }
        }
    }

    /// The clients listening now.
    pub fn clients(&self) -> Vec<ClientId> {
        self.lock().clients.iter().copied().collect()
    }

    /// The event channels served.
    pub fn served(&self) -> BTreeSet<&'static str> {
        self.lock().channels.keys().copied().collect()
    }

    fn lock(&self) -> MutexGuard<'_, Served> {
        self.served.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn channel<'a>(served: &'a mut Served, name: &str) -> &'a mut Channel {
    served
        .channels
        .get_mut(name)
        .unwrap_or_else(|| panic!("event channel `{name}` is published on but not served"))
}

fn encode<C: EventChannel, T: Serialize + ?Sized>(value: &T) -> crate::Result<Payload> {
    to_payload(value).map_err(|err| {
        crate::Error::Refused(format!("Could not encode an event on `{}`: {err}", C::NAME))
    })
}

#[cfg(test)]
mod tests {
    use floti_protocol::channel::from_payload;
    use floti_protocol::channels::sessions::{
        SessionActivate, SessionActivation, SessionActivityChanged, SessionExit,
    };

    use super::*;

    type Value = serde_json::Value;

    const A: ClientId = ClientId(1);
    const B: ClientId = ClientId(2);

    fn activation(id: u64) -> SessionActivation {
        SessionActivation { id }
    }

    fn drain(listening: &mut broadcast::Receiver<Publication>) -> Vec<Publication> {
        std::iter::from_fn(|| listening.try_recv().ok()).collect()
    }

    #[test]
    fn a_state_channel_starts_with_its_state_and_sends_the_whole_state_on_each_change() {
        let events = Events::new();
        events
            .serve_state::<SessionActivityChanged, _>(&Vec::new())
            .unwrap();
        let mut listening = events.listen(A);

        let Some(Start::Snapshot { seq: 0, state }) = events.start(SessionActivityChanged::NAME)
        else {
            panic!("a state channel starts with a snapshot");
        };
        assert_eq!(
            from_payload::<Vec<Value>>(&state).unwrap(),
            Vec::<Value>::new()
        );

        events
            .set_state::<SessionActivityChanged, _>(&Vec::new())
            .unwrap();
        let published = listening.try_recv().unwrap();
        assert_eq!(
            (published.channel, published.seq, published.to),
            (SessionActivityChanged::NAME, 1, None)
        );
        let Some(Start::Snapshot { seq: 1, .. }) = events.start(SessionActivityChanged::NAME)
        else {
            panic!("a later subscription starts from the latest state");
        };
    }

    #[test]
    fn a_channel_without_state_starts_quiet_and_numbers_each_event() {
        let events = Events::new();
        events.serve_events::<SessionActivate>();
        let mut listening = events.listen(A);
        assert!(matches!(
            events.start(SessionActivate::NAME),
            Some(Start::Quiet)
        ));

        events.emit::<SessionActivate>(&activation(1)).unwrap();
        events.emit::<SessionActivate>(&activation(2)).unwrap();
        let published = drain(&mut listening);
        let seqs: Vec<u64> = published.iter().map(|p| p.seq).collect();
        assert_eq!(seqs, [1, 2]);
        assert!(published.iter().all(|p| p.is_for(A) && p.is_for(B)));
    }

    #[test]
    fn a_channel_nobody_serves_has_no_start() {
        assert!(Events::new().start(SessionExit::NAME).is_none());
    }

    #[test]
    fn an_event_for_one_client_reaches_only_it_and_each_clients_numbers_run_without_a_gap() {
        let events = Events::new();
        events.serve_per_client::<SessionActivate>();
        let mut listening = events.listen(A);
        let _also_listening = events.listen(B);
        assert!(matches!(
            events.start(SessionActivate::NAME),
            Some(Start::Quiet)
        ));

        for to in [A, B, B, A, B] {
            events
                .emit_to::<SessionActivate>(to, &activation(1))
                .unwrap();
        }
        let published = drain(&mut listening);
        let numbers = |client: ClientId| -> Vec<u64> {
            published
                .iter()
                .filter(|publication| publication.is_for(client))
                .map(|publication| publication.seq)
                .collect()
        };
        assert_eq!(numbers(A), [1, 2]);
        assert_eq!(numbers(B), [1, 2, 3]);
    }

    #[test]
    fn a_client_that_left_is_sent_nothing_and_starts_from_one_when_it_listens_again() {
        let events = Events::new();
        events.serve_per_client::<SessionActivate>();
        let mut listening = events.listen(A);
        events
            .emit_to::<SessionActivate>(A, &activation(1))
            .unwrap();
        assert_eq!(events.clients(), [A]);

        events.leave(A);
        assert!(events.clients().is_empty());
        events
            .emit_to::<SessionActivate>(A, &activation(2))
            .unwrap();
        let published = drain(&mut listening);
        assert_eq!(published.len(), 1, "nothing for a client that has gone");

        let mut again = events.listen(A);
        events
            .emit_to::<SessionActivate>(A, &activation(3))
            .unwrap();
        assert_eq!(again.try_recv().unwrap().seq, 1);
    }

    #[test]
    #[should_panic(expected = "served one client at a time")]
    fn a_channel_served_one_client_at_a_time_is_never_sent_to_everyone() {
        let events = Events::new();
        events.serve_per_client::<SessionActivate>();
        let _ = events.emit::<SessionActivate>(&activation(1));
    }

    #[test]
    #[should_panic(expected = "served to every subscriber alike")]
    fn a_channel_served_to_everyone_is_never_sent_to_one_client() {
        let events = Events::new();
        events.serve_events::<SessionActivate>();
        let _ = events.emit_to::<SessionActivate>(A, &activation(1));
    }
}
