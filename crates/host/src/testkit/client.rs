//! A protocol client for the host's tests: it connects on the local socket,
//! says `hello`, makes typed requests and reads session terminals, granting
//! credit back as it reads, as a real client would.

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use floti_protocol::channel::{RequestChannel, from_payload, to_payload};
use floti_protocol::channels::sessions::{SessionStreamOpen, SessionTerminal};
use floti_protocol::message::{
    ClientInfo, ClientKind, ErrorCode, ErrorReply, Hello, Request, StreamCredit, StreamData,
    StreamOpen, Welcome,
};
use floti_protocol::{Bytes, FrameDecoder, Message, PROTOCOL_VERSION, StreamChannel, encode_frame};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::Instant;

use crate::platform::socket::{Endpoint, LocalSocket, LocalStream, Native};

/// How long a test waits for the host before it gives up.
pub const PATIENCE: Duration = Duration::from_secs(20);

/// One client connection.
pub struct TestClient {
    stream: LocalStream,
    decoder: FrameDecoder,
    next_request: u64,
    /// Messages read while waiting for something else.
    pending: VecDeque<Message>,
    /// Every byte received on each stream.
    stream_bytes: HashMap<u64, Vec<u8>>,
    /// Streams the host closed, and why.
    closed_streams: HashMap<u64, Option<String>>,
    /// Whether the host has closed the connection.
    ended: bool,
    pub welcome: Welcome,
}

impl TestClient {
    /// Connects to the host at `endpoint` and is welcomed with
    /// `capabilities`, retrying while the host is still starting.
    pub async fn connect(endpoint: &Endpoint, capabilities: &[&str]) -> Self {
        let deadline = Instant::now() + PATIENCE;
        let stream = loop {
            match Native.connect(endpoint).await {
                Ok(stream) => break stream,
                Err(err) => {
                    assert!(
                        Instant::now() < deadline,
                        "no host answered at {endpoint} within {PATIENCE:?}: {err}"
                    );
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
        };
        let mut client = Self {
            stream,
            decoder: FrameDecoder::new(),
            next_request: 1,
            pending: VecDeque::new(),
            stream_bytes: HashMap::new(),
            closed_streams: HashMap::new(),
            ended: false,
            welcome: Welcome {
                protocol: PROTOCOL_VERSION,
                host_version: String::new(),
                capabilities: Vec::new(),
                backends: Vec::new(),
            },
        };
        client
            .send(&Message::Hello(Hello {
                protocol: PROTOCOL_VERSION,
                client: ClientInfo {
                    name: "floti host tests".to_owned(),
                    kind: ClientKind::Tui,
                },
                capabilities: capabilities.iter().map(|name| (*name).to_owned()).collect(),
            }))
            .await;
        match client.next(PATIENCE).await {
            Some(Message::Welcome(welcome)) => client.welcome = welcome,
            other => panic!("the host did not welcome the client: {other:?}"),
        }
        client
    }

    /// Sends one message.
    pub async fn send(&mut self, message: &Message) {
        let frame = encode_frame(message).expect("encode a message");
        self.stream
            .write_all(&frame)
            .await
            .expect("write to the host");
    }

    /// Makes a request on `C` and waits for its answer.
    pub async fn request<C: RequestChannel>(
        &mut self,
        request: &C::Request,
    ) -> Result<C::Response, ErrorReply> {
        let id = self.next_request;
        self.next_request += 1;
        self.send(&Message::Request(Request {
            id,
            channel: C::NAME.to_owned(),
            payload: to_payload(request).expect("encode a request"),
        }))
        .await;
        let deadline = Instant::now() + PATIENCE;
        loop {
            let found = self.pending.iter().position(|message| match message {
                Message::Response(response) => response.id == id,
                Message::Error(error) => error.id == id,
                _ => false,
            });
            if let Some(index) = found {
                return match self.pending.remove(index) {
                    Some(Message::Response(response)) => Ok(from_payload(&response.payload)
                        .unwrap_or_else(|why| panic!("`{}` answered with {why}", C::NAME))),
                    Some(Message::Error(error)) => Err(error),
                    _ => unreachable!(),
                };
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(
                self.pump(left).await,
                "no answer to `{}` within {PATIENCE:?}",
                C::NAME
            );
        }
    }

    /// Opens a terminal on session `id` as stream `stream`.
    pub async fn attach(&mut self, stream: u64, id: u64) {
        self.send(&Message::StreamOpen(StreamOpen {
            stream,
            channel: SessionTerminal::NAME.to_owned(),
            params: to_payload(&SessionStreamOpen { id }).expect("encode stream params"),
        }))
        .await;
    }

    /// Types `bytes` into the session on `stream`.
    pub async fn type_into(&mut self, stream: u64, bytes: &[u8]) {
        self.send(&Message::StreamData(StreamData {
            stream,
            data: Bytes(bytes.to_vec()),
        }))
        .await;
    }

    /// Every byte received on `stream` once `done` accepts them, waiting up
    /// to [`PATIENCE`]; panics showing what came when it never does.
    pub async fn read_stream_until(
        &mut self,
        stream: u64,
        done: impl Fn(&[u8]) -> bool,
    ) -> Vec<u8> {
        let deadline = Instant::now() + PATIENCE;
        loop {
            let bytes = self.stream_bytes.get(&stream).cloned().unwrap_or_default();
            if done(&bytes) {
                return bytes;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(
                !left.is_zero() && self.pump(left).await,
                "stream {stream} did not show what was expected within {PATIENCE:?}; it had: {:?}",
                String::from_utf8_lossy(&bytes)
            );
        }
    }

    /// Whether the host closed `stream`, and why.
    pub fn stream_closed(&self, stream: u64) -> Option<&Option<String>> {
        self.closed_streams.get(&stream)
    }

    /// The next message other than stream traffic, within `timeout`.
    pub async fn next(&mut self, timeout: Duration) -> Option<Message> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(message) = self.pending.pop_front() {
                return Some(message);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() || !self.pump(left).await {
                return None;
            }
        }
    }

    /// Waits for the host to close the connection.
    pub async fn wait_closed(&mut self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while !self.ended {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            self.pump(left).await;
        }
        true
    }

    /// Reads what arrives within `timeout` and files it. False when nothing
    /// came or the connection has ended.
    async fn pump(&mut self, timeout: Duration) -> bool {
        if self.ended {
            return false;
        }
        let mut buf = vec![0; 64 * 1024];
        let read = tokio::time::timeout(timeout, self.stream.read(&mut buf)).await;
        let n = match read {
            Err(_) => return false,
            Ok(Ok(0) | Err(_)) => {
                self.ended = true;
                return false;
            }
            Ok(Ok(n)) => n,
        };
        self.decoder.push(&buf[..n]);
        while let Some(message) = self.decoder.next_message().expect("a well-formed frame") {
            match message {
                Message::StreamData(data) => {
                    let len = data.data.0.len() as u64;
                    self.stream_bytes
                        .entry(data.stream)
                        .or_default()
                        .extend_from_slice(&data.data.0);
                    self.send(&Message::StreamCredit(StreamCredit {
                        stream: data.stream,
                        bytes: len,
                    }))
                    .await;
                }
                Message::StreamClose(close) => {
                    self.closed_streams.insert(close.stream, close.reason);
                }
                Message::StreamCredit(_) => {}
                other => self.pending.push_back(other),
            }
        }
        true
    }
}

/// Whether `error` is the host refusing an unserved channel, naming it.
pub fn names_unserved_channel(error: &ErrorReply, channel: &str) -> bool {
    error.code == ErrorCode::Unavailable
        && error.channel == channel
        && error.message.contains(&format!("`{channel}`"))
}
