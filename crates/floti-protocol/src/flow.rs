//! Credit-based flow control for byte streams.
//!
//! A slow phone on a bad connection must never stall the host or another
//! client. So each stream's receiver grants credit in bytes, and its sender
//! sends at most that much, holding the rest until more is granted. A sender
//! that goes past its credit has broken the protocol. Streams are independent
//! of each other and of requests: one stream out of credit holds back only its
//! own bytes.

use std::collections::{BTreeMap, VecDeque};

use crate::bytes::Bytes;
use crate::error::ProtocolError;
use crate::message::{Message, StreamCredit, StreamData};

/// Credit each direction of a new stream starts with: 256 KiB.
pub const DEFAULT_INITIAL_CREDIT: u64 = 256 * 1024;

/// The largest `streamData` an [`Outbox`] sends at once, so one busy stream
/// cannot fill a frame the others are waiting behind.
pub const MAX_DATA_CHUNK: usize = 64 * 1024;

/// The sending side of one stream.
#[derive(Debug)]
pub struct CreditSender {
    stream: u64,
    credit: u64,
    held: VecDeque<u8>,
}

impl CreditSender {
    pub fn new(stream: u64, initial_credit: u64) -> Self {
        Self {
            stream,
            credit: initial_credit,
            held: VecDeque::new(),
        }
    }

    pub fn stream(&self) -> u64 {
        self.stream
    }

    /// Credit left: how many bytes may still be sent.
    pub fn credit(&self) -> u64 {
        self.credit
    }

    /// Bytes waiting for credit.
    pub fn held(&self) -> usize {
        self.held.len()
    }

    /// Queues bytes to send.
    pub fn write(&mut self, bytes: &[u8]) {
        self.held.extend(bytes);
    }

    /// Adds credit the receiver granted.
    pub fn grant(&mut self, bytes: u64) {
        self.credit = self.credit.saturating_add(bytes);
    }

    /// The next `streamData`, at most `max` bytes and never more than the
    /// credit left, or `None` when nothing can be sent.
    pub fn next_data(&mut self, max: usize) -> Option<StreamData> {
        let allowed = usize::try_from(self.credit).unwrap_or(usize::MAX);
        let len = self.held.len().min(allowed).min(max);
        if len == 0 {
            return None;
        }
        self.credit -= len as u64;
        let data: Vec<u8> = self.held.drain(..len).collect();
        Some(StreamData {
            stream: self.stream,
            data: Bytes(data),
        })
    }
}

/// The receiving side of one stream.
#[derive(Debug)]
pub struct CreditReceiver {
    stream: u64,
    credit: u64,
}

impl CreditReceiver {
    pub fn new(stream: u64, initial_credit: u64) -> Self {
        Self {
            stream,
            credit: initial_credit,
        }
    }

    /// Credit the sender still has.
    pub fn credit(&self) -> u64 {
        self.credit
    }

    /// Takes data off the credit, or refuses data beyond it.
    pub fn accept(&mut self, data: &StreamData) -> Result<(), ProtocolError> {
        if data.stream != self.stream {
            return Err(ProtocolError::UnknownStream(data.stream));
        }
        let len = data.data.len() as u64;
        if len > self.credit {
            return Err(ProtocolError::CreditExceeded {
                stream: self.stream,
                len,
                credit: self.credit,
            });
        }
        self.credit -= len;
        Ok(())
    }

    /// Grants the sender `bytes` more: the message to send it.
    pub fn grant(&mut self, bytes: u64) -> StreamCredit {
        self.credit = self.credit.saturating_add(bytes);
        StreamCredit {
            stream: self.stream,
            bytes,
        }
    }
}

/// Everything one side has to send on a connection, in the order it may go.
///
/// Messages other than stream data (responses, events, credit) are never held
/// back by credit and go first. Stream data goes round-robin among the streams
/// that have both bytes and credit.
#[derive(Debug, Default)]
pub struct Outbox {
    messages: VecDeque<Message>,
    streams: BTreeMap<u64, CreditSender>,
    /// The stream that sent last, so the next turn starts after it.
    last_stream: Option<u64>,
}

impl Outbox {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queues a message that is not stream data.
    pub fn push(&mut self, message: Message) {
        self.messages.push_back(message);
    }

    pub fn open_stream(&mut self, stream: u64, initial_credit: u64) {
        self.streams
            .insert(stream, CreditSender::new(stream, initial_credit));
    }

    pub fn close_stream(&mut self, stream: u64) -> Option<CreditSender> {
        self.streams.remove(&stream)
    }

    pub fn stream(&self, stream: u64) -> Option<&CreditSender> {
        self.streams.get(&stream)
    }

    pub fn write(&mut self, stream: u64, bytes: &[u8]) -> Result<(), ProtocolError> {
        self.streams
            .get_mut(&stream)
            .ok_or(ProtocolError::UnknownStream(stream))?
            .write(bytes);
        Ok(())
    }

    /// Applies credit the peer granted.
    pub fn grant(&mut self, credit: &StreamCredit) -> Result<(), ProtocolError> {
        self.streams
            .get_mut(&credit.stream)
            .ok_or(ProtocolError::UnknownStream(credit.stream))?
            .grant(credit.bytes);
        Ok(())
    }

    /// The next message that may be sent now, or `None` when everything left
    /// is waiting for credit.
    pub fn next_message(&mut self) -> Option<Message> {
        if let Some(message) = self.messages.pop_front() {
            return Some(message);
        }
        let after = self.last_stream;
        let order = self
            .streams
            .keys()
            .copied()
            .filter(|id| after.is_none_or(|last| *id > last))
            .chain(
                self.streams
                    .keys()
                    .copied()
                    .filter(|id| after.is_some_and(|last| *id <= last)),
            )
            .collect::<Vec<_>>();
        for id in order {
            if let Some(data) = self
                .streams
                .get_mut(&id)
                .and_then(|sender| sender.next_data(MAX_DATA_CHUNK))
            {
                self.last_stream = Some(id);
                return Some(Message::StreamData(data));
            }
        }
        None
    }

    /// Everything that may be sent now.
    pub fn drain(&mut self) -> Vec<Message> {
        std::iter::from_fn(|| self.next_message()).collect()
    }
}
