//! What the host sends one client, given what it can draw.
//!
//! A client declares its capabilities at connect, and the host sends it only
//! what they cover. [`ClientChannels`] is the host's record of one client:
//! the capabilities it was welcomed with and the subscriptions it holds. A
//! subscription or stream on a channel those capabilities do not cover is
//! refused naming the capability, and an event on such a channel reaches the
//! client by no path, whatever it asked for.

use std::collections::BTreeMap;

use crate::capability::CapabilitySet;
use crate::channel::{Catalogue, ChannelDecl};
use crate::message::{
    ErrorReply, Event, Message, Payload, Request, StreamClose, StreamOpen, Subscribe,
    SubscriptionError,
};

/// One connected client, as the host sees it.
#[derive(Debug, Clone)]
pub struct ClientChannels<'a> {
    catalogue: &'a Catalogue,
    capabilities: CapabilitySet,
    /// Each subscription the client holds, and the channel it is on.
    subscriptions: BTreeMap<u64, &'static str>,
}

impl<'a> ClientChannels<'a> {
    /// A client welcomed with `capabilities`, holding no subscriptions yet.
    pub fn new(catalogue: &'a Catalogue, capabilities: CapabilitySet) -> Self {
        Self {
            catalogue,
            capabilities,
            subscriptions: BTreeMap::new(),
        }
    }

    pub fn capabilities(&self) -> CapabilitySet {
        self.capabilities
    }

    /// Whether anything on `channel` may reach this client: the channel is
    /// declared and the client's capabilities cover it.
    pub fn may_receive(&self, channel: &str) -> bool {
        self.catalogue
            .get(channel)
            .is_some_and(|decl| decl.covered_by(&self.capabilities))
    }

    /// The channel a request names, or the error reply that refuses it.
    pub fn check_request(&self, request: &Request) -> Result<&'a ChannelDecl, ErrorReply> {
        self.catalogue
            .check_request_from(request, &self.capabilities)
    }

    /// Starts a subscription, or restarts one under the same number, or says
    /// why it is refused. A refused subscription is not held.
    pub fn subscribe(
        &mut self,
        subscribe: &Subscribe,
    ) -> Result<&'a ChannelDecl, SubscriptionError> {
        let catalogue = self.catalogue;
        match catalogue.check_subscribe(subscribe, &self.capabilities) {
            Ok(decl) => {
                self.subscriptions
                    .insert(subscribe.subscription, decl.name());
                Ok(decl)
            }
            Err(refusal) => {
                self.subscriptions.remove(&subscribe.subscription);
                Err(refusal)
            }
        }
    }

    pub fn unsubscribe(&mut self, subscription: u64) {
        self.subscriptions.remove(&subscription);
    }

    /// The stream channel a `streamOpen` names, or the close that refuses
    /// it.
    pub fn open_stream(&self, open: &StreamOpen) -> Result<&'a ChannelDecl, StreamClose> {
        self.catalogue.check_stream_open(open, &self.capabilities)
    }

    /// The client's subscriptions to `channel`, in order: where an event on
    /// it goes. None for a channel its capabilities do not cover.
    pub fn subscriptions_to(&self, channel: &str) -> Vec<u64> {
        if !self.may_receive(channel) {
            return Vec::new();
        }
        self.subscriptions
            .iter()
            .filter(|(_, on)| **on == channel)
            .map(|(subscription, _)| *subscription)
            .collect()
    }

    /// The messages that carry event `seq` on `channel` to this client: one
    /// per subscription it holds to the channel, and none when its
    /// capabilities do not cover the channel.
    pub fn event(&self, channel: &str, seq: u64, payload: &Payload) -> Vec<Message> {
        self.subscriptions_to(channel)
            .into_iter()
            .map(|subscription| {
                Message::Event(Event {
                    subscription,
                    seq,
                    payload: payload.clone(),
                })
            })
            .collect()
    }
}
