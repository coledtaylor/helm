//! Snapshots and numbered events.
//!
//! A subscription to a channel that carries state starts with a snapshot of
//! that state, then numbered events, each one more than the last. A client that
//! sees a number it did not expect has missed something, and resubscribes for
//! a fresh snapshot rather than guessing what it missed.

use std::collections::BTreeSet;

use crate::channel::{EventChannel, to_payload};
use crate::error::ProtocolError;
use crate::message::{Event, Message, Snapshot};

/// The host's side of one event channel that carries state.
#[derive(Debug)]
pub struct Topic<C: EventChannel> {
    state: C::Snapshot,
    seq: u64,
    subscribers: BTreeSet<u64>,
}

impl<C: EventChannel> Topic<C> {
    pub fn new(state: C::Snapshot) -> Self {
        const {
            assert!(
                C::SNAPSHOT,
                "a Topic is for an event channel that carries state"
            )
        };
        Self {
            state,
            seq: 0,
            subscribers: BTreeSet::new(),
        }
    }

    pub fn state(&self) -> &C::Snapshot {
        &self.state
    }

    /// The number of the last event published.
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// Adds a subscriber, or restarts one, and returns its snapshot.
    pub fn subscribe(&mut self, subscription: u64) -> Result<Message, ProtocolError> {
        self.subscribers.insert(subscription);
        Ok(Message::Snapshot(Snapshot {
            subscription,
            seq: self.seq,
            state: to_payload(&self.state)?,
        }))
    }

    pub fn unsubscribe(&mut self, subscription: u64) {
        self.subscribers.remove(&subscription);
    }

    /// Applies an event to the state, numbers it, and returns it for every
    /// subscriber.
    pub fn publish(
        &mut self,
        event: C::Event,
        apply: impl FnOnce(&mut C::Snapshot, &C::Event),
    ) -> Result<Vec<Message>, ProtocolError> {
        apply(&mut self.state, &event);
        self.seq += 1;
        let payload = to_payload(&event)?;
        Ok(self
            .subscribers
            .iter()
            .map(|subscription| {
                Message::Event(Event {
                    subscription: *subscription,
                    seq: self.seq,
                    payload: payload.clone(),
                })
            })
            .collect())
    }
}

/// What a client does with an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// The next one: apply it.
    Apply,
    /// Already covered by the snapshot or an earlier event: drop it.
    Stale,
    /// One or more events were missed: resubscribe for a fresh snapshot.
    Gap { expected: u64, received: u64 },
}

/// The client's check on one subscription's numbering.
#[derive(Debug, Clone, Default)]
pub struct EventCursor {
    /// The number of the last event applied, or `None` before the snapshot.
    last: Option<u64>,
}

impl EventCursor {
    /// A cursor waiting for its snapshot.
    pub fn new() -> Self {
        Self::default()
    }

    /// A cursor for a channel without a snapshot, whose first event is 1.
    pub fn from_start() -> Self {
        Self { last: Some(0) }
    }

    pub fn on_snapshot(&mut self, snapshot: &Snapshot) {
        self.last = Some(snapshot.seq);
    }

    pub fn on_event(&mut self, event: &Event) -> Delivery {
        let Some(last) = self.last else {
            // The host sends the snapshot first; anything before it is
            // covered by the snapshot that follows.
            return Delivery::Stale;
        };
        let expected = last + 1;
        if event.seq == expected {
            self.last = Some(expected);
            Delivery::Apply
        } else if event.seq < expected {
            Delivery::Stale
        } else {
            Delivery::Gap {
                expected,
                received: event.seq,
            }
        }
    }
}
