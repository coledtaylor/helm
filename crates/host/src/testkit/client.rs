//! A protocol client for the host's tests: it connects on the local socket,
//! runs the Noise handshake as the testkit's device, paired with the host and
//! pinned to its key, says `hello`, makes typed requests and reads session
//! terminals, granting credit back as it reads, as a real client would.

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use floti_protocol::channel::{RequestChannel, from_payload, to_payload};
use floti_protocol::channels::sessions::{SessionStreamOpen, SessionTerminal};
use floti_protocol::message::{
    ClientInfo, ClientKind, ErrorCode, ErrorReply, Hello, Request, StreamCredit, StreamData,
    StreamOpen, Subscribe, Welcome,
};
use floti_protocol::{Bytes, Message, PROTOCOL_VERSION, Payload, StreamChannel};
use tokio::time::Instant;

use crate::client::{self, ClientError, Connection};
use crate::platform::socket::Endpoint;
use crate::server::host_public_key;

/// How long a test waits for the host before it gives up.
pub const PATIENCE: Duration = Duration::from_secs(20);

/// One client connection.
pub struct TestClient {
    connection: Connection,
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
    /// Connects to the host at `endpoint` as the testkit's device, paired
    /// with that host and pinned to its key, and is welcomed with
    /// `capabilities`, retrying while the host is still starting.
    ///
    /// The host is the one [`RunningHost`](super::RunningHost) started, or
    /// one whose endpoint came from [`TestDirs::endpoint`](super::TestDirs)
    /// or was named to [`pair_test_device`](super::pair_test_device).
    pub async fn connect(endpoint: &Endpoint, capabilities: &[&str]) -> Self {
        let data = super::data_folder_of(endpoint);
        let deadline = Instant::now() + PATIENCE;
        let mut paired = false;
        let connection = loop {
            let waited = match host_public_key(&data) {
                Ok(Some(host)) => {
                    if !paired {
                        super::pair_into(&data);
                        paired = true;
                    }
                    match client::connect(endpoint, super::test_device(), &host).await {
                        Ok(connection) => break connection,
                        Err(err @ ClientError::Unreachable { .. }) => err.to_string(),
                        Err(err) => {
                            panic!("the host at {endpoint} did not let the client in: {err}")
                        }
                    }
                }
                Ok(None) => format!("{} has no host key yet", data.display()),
                Err(err) => err.to_string(),
            };
            assert!(
                Instant::now() < deadline,
                "no host answered at {endpoint} within {PATIENCE:?}: {waited}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        Self::over(connection, capabilities).await
    }

    /// Says `hello` on `connection`, a handshake already done, and is
    /// welcomed with `capabilities`: for a test that connects as a device
    /// of its own.
    pub async fn over(connection: Connection, capabilities: &[&str]) -> Self {
        let mut client = Self {
            connection,
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

    /// The key the host proved in the handshake.
    pub fn host_key(&self) -> floti_protocol::noise::PublicKey {
        self.connection.host_key()
    }

    /// Sends one message, sealed.
    pub async fn send(&mut self, message: &Message) {
        self.connection
            .send(message)
            .await
            .expect("write to the host");
    }

    /// Makes a request on `C` and waits for its answer.
    pub async fn request<C: RequestChannel>(
        &mut self,
        request: &C::Request,
    ) -> Result<C::Response, ErrorReply> {
        let payload = to_payload(request).expect("encode a request");
        self.request_on(C::NAME, payload).await.map(|answer| {
            from_payload(&answer).unwrap_or_else(|why| panic!("`{}` answered with {why}", C::NAME))
        })
    }

    /// Makes a request on `channel` with `payload`, whatever its type, and
    /// waits for its answer.
    pub async fn request_on(
        &mut self,
        channel: &str,
        payload: Payload,
    ) -> Result<Payload, ErrorReply> {
        let id = self.next_request;
        self.next_request += 1;
        self.send(&Message::Request(Request {
            id,
            channel: channel.to_owned(),
            payload,
        }))
        .await;
        let found = self
            .wait_for(
                &format!("an answer to `{channel}`"),
                |message| match message {
                    Message::Response(response) => response.id == id,
                    Message::Error(error) => error.id == id,
                    _ => false,
                },
            )
            .await;
        match found {
            Message::Response(response) => Ok(response.payload),
            Message::Error(error) => Err(error),
            _ => unreachable!(),
        }
    }

    /// Subscribes to `channel` as `subscription` and waits for how the host
    /// starts it: a snapshot, or a subscription error. A channel without
    /// state sends neither, so this is for one that carries state or is
    /// refused.
    pub async fn subscribe_on(&mut self, subscription: u64, channel: &str) -> Message {
        self.subscribe_quietly(subscription, channel).await;
        self.wait_for(
            &format!("the start of a subscription to `{channel}`"),
            |message| match message {
                Message::Snapshot(snapshot) => snapshot.subscription == subscription,
                Message::SubscriptionError(error) => error.subscription == subscription,
                _ => false,
            },
        )
        .await
    }

    /// Subscribes to `channel` as `subscription` without waiting for
    /// anything.
    pub async fn subscribe_quietly(&mut self, subscription: u64, channel: &str) {
        self.send(&Message::Subscribe(Subscribe {
            subscription,
            channel: channel.to_owned(),
        }))
        .await;
    }

    /// Opens `channel` as stream `stream` with `params`, whatever their type.
    pub async fn open_on(&mut self, stream: u64, channel: &str, params: Payload) {
        self.send(&Message::StreamOpen(StreamOpen {
            stream,
            channel: channel.to_owned(),
            params,
        }))
        .await;
    }

    /// Waits for the host to close `stream`, and says why it did.
    pub async fn wait_stream_closed(&mut self, stream: u64) -> Option<String> {
        let deadline = Instant::now() + PATIENCE;
        loop {
            if let Some(reason) = self.closed_streams.get(&stream) {
                return reason.clone();
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(
                !left.is_zero() && self.pump(left).await,
                "the host did not close stream {stream} within {PATIENCE:?}"
            );
        }
    }

    /// The first message other than stream traffic that `wanted` accepts,
    /// leaving the rest for later; panics naming `what` when none comes
    /// within [`PATIENCE`].
    async fn wait_for(&mut self, what: &str, wanted: impl Fn(&Message) -> bool) -> Message {
        let deadline = Instant::now() + PATIENCE;
        loop {
            if let Some(index) = self.pending.iter().position(&wanted) {
                return self.pending.remove(index).expect("the message just found");
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(self.pump(left).await, "no {what} within {PATIENCE:?}");
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

    /// Reads the next message to arrive within `timeout` and files it. False
    /// when nothing came or the connection has ended.
    async fn pump(&mut self, timeout: Duration) -> bool {
        if self.ended {
            return false;
        }
        let message = match tokio::time::timeout(timeout, self.connection.next()).await {
            Err(_) => return false,
            Ok(Ok(Some(message))) => message,
            Ok(Ok(None)) => {
                self.ended = true;
                return false;
            }
            Ok(Err(err @ (ClientError::Protocol(_) | ClientError::Session(_)))) => {
                panic!("the host sent what a client cannot read: {err}")
            }
            Ok(Err(_)) => {
                self.ended = true;
                return false;
            }
        };
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
        true
    }
}

/// Whether `error` is the host refusing an unserved channel, naming it.
pub fn names_unserved_channel(error: &ErrorReply, channel: &str) -> bool {
    error.code == ErrorCode::Unavailable
        && error.channel == channel
        && error.message.contains(&format!("`{channel}`"))
}
