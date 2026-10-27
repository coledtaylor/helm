//! The event channels the host serves, and what each subscriber is sent.
//!
//! A feature serves an event channel by declaring it here, then publishing
//! on it. A channel that carries state ([`Events::serve_state`]) holds its
//! whole state: a subscription to it starts with that state as its snapshot,
//! and every change sends the whole state again as the next numbered event.
//! A channel without state ([`Events::serve_events`]) sends nothing on
//! subscribe and broadcasts each event to every subscription from then on.
//!
//! Every connection listens to one broadcast of every publication and picks
//! out its own subscriptions' channels. A connection that falls too far
//! behind misses publications; the gap in the numbers tells its client to
//! subscribe again for a fresh snapshot.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Mutex, MutexGuard, PoisonError};

use floti_protocol::Payload;
use floti_protocol::channel::{EventChannel, to_payload};
use serde::Serialize;
use tokio::sync::broadcast;

/// How many publications a connection may fall behind before it misses some.
const BACKLOG: usize = 256;

/// One event on one channel, for every connection to deliver to its
/// subscriptions on that channel.
#[derive(Debug, Clone)]
pub(crate) struct Publication {
    pub channel: &'static str,
    pub seq: u64,
    pub payload: Payload,
}

/// How a subscription to a served channel starts.
#[derive(Debug, Clone)]
pub(crate) enum Start {
    /// The channel's state, which includes every event up to `seq`.
    Snapshot { seq: u64, state: Payload },
    /// Nothing until the next event: the channel carries no state.
    Quiet,
}

/// One served channel: the number of its last event, and its state when it
/// carries one.
struct Channel {
    seq: u64,
    state: Option<Payload>,
}

/// Every event channel the host serves.
pub(crate) struct Events {
    channels: Mutex<HashMap<&'static str, Channel>>,
    published: broadcast::Sender<Publication>,
}

impl Events {
    pub fn new() -> Self {
        let (published, _) = broadcast::channel(BACKLOG);
        Self {
            channels: Mutex::new(HashMap::new()),
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
        self.declare(C::NAME, Some(state));
        Ok(())
    }

    /// Serves `C`, a channel whose events carry no state.
    pub fn serve_events<C: EventChannel>(&self) {
        const { assert!(!C::SNAPSHOT, "serve_events is for a channel without state") };
        self.declare(C::NAME, None);
    }

    fn declare(&self, name: &'static str, state: Option<Payload>) {
        let previous = self.lock().insert(name, Channel { seq: 0, state });
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
        let mut channels = self.lock();
        let channel = served(&mut channels, C::NAME);
        channel.state = Some(payload.clone());
        channel.seq += 1;
        // Sent under the lock, so publications go out in their numbers'
        // order and a snapshot is never behind an event already sent.
        // Nobody listening is not a failure.
        let _ = self.published.send(Publication {
            channel: C::NAME,
            seq: channel.seq,
            payload,
        });
        Ok(())
    }

    /// One event on `C`, a channel without state, to every subscription to
    /// it now.
    pub fn emit<C: EventChannel>(&self, event: &C::Event) -> crate::Result<()> {
        let payload = encode::<C, C::Event>(event)?;
        let mut channels = self.lock();
        let channel = served(&mut channels, C::NAME);
        channel.seq += 1;
        let _ = self.published.send(Publication {
            channel: C::NAME,
            seq: channel.seq,
            payload,
        });
        Ok(())
    }

    /// How a subscription to `channel` starts, or `None` when the host does
    /// not serve it.
    pub fn start(&self, channel: &str) -> Option<Start> {
        let channels = self.lock();
        let served = channels.get(channel)?;
        Some(match &served.state {
            Some(state) => Start::Snapshot {
                seq: served.seq,
                state: state.clone(),
            },
            None => Start::Quiet,
        })
    }

    /// Every publication from now on, for one connection.
    pub fn listen(&self) -> broadcast::Receiver<Publication> {
        self.published.subscribe()
    }

    /// The event channels served.
    pub fn served(&self) -> BTreeSet<&'static str> {
        self.lock().keys().copied().collect()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<&'static str, Channel>> {
        self.channels.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn served<'a>(channels: &'a mut HashMap<&'static str, Channel>, name: &str) -> &'a mut Channel {
    channels
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

    #[test]
    fn a_state_channel_starts_with_its_state_and_sends_the_whole_state_on_each_change() {
        let events = Events::new();
        events
            .serve_state::<SessionActivityChanged, _>(&Vec::new())
            .unwrap();
        let mut listening = events.listen();

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
            (published.channel, published.seq),
            (SessionActivityChanged::NAME, 1)
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
        let mut listening = events.listen();
        assert!(matches!(
            events.start(SessionActivate::NAME),
            Some(Start::Quiet)
        ));

        events
            .emit::<SessionActivate>(&SessionActivation { id: 1 })
            .unwrap();
        events
            .emit::<SessionActivate>(&SessionActivation { id: 2 })
            .unwrap();
        let seqs = [
            listening.try_recv().unwrap().seq,
            listening.try_recv().unwrap().seq,
        ];
        assert_eq!(seqs, [1, 2]);
    }

    #[test]
    fn a_channel_nobody_serves_has_no_start() {
        assert!(Events::new().start(SessionExit::NAME).is_none());
    }
}
