//! One client's connection: `hello` first, then requests, subscriptions and
//! session terminals, until the client goes or the host stops.
//!
//! A client leaving detaches it from every session it was attached to and
//! ends nothing: the sessions run on for the next client.
//!
//! What is served is the features' to say ([`Features`]); the connection
//! carries requests, subscriptions and streams to them. A channel on the
//! not-yet-served list is refused naming it before anything else looks at
//! it, and the client is served on.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use floti_protocol::channel::{RequestChannel, Router};
use floti_protocol::channels::host::{HostStop, HostStopReason};
use floti_protocol::message::{
    ErrorCode, ErrorReply, Event, Request, Snapshot, StreamClose, StreamCredit, StreamData,
    StreamOpen, Subscribe, SubscriptionError,
};
use floti_protocol::{
    CapabilitySet, ClientChannels, CreditReceiver, DEFAULT_INITIAL_CREDIT, FrameDecoder,
    HostIdentity, Message, Outbox, ProtocolError, encode_frame,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::sync::{broadcast, mpsc, watch};
use tokio::task::JoinHandle;

use super::events::{Publication, Start};
use super::features::Features;
use super::{CATALOGUE, Stopper, unserved};
use crate::platform::socket::LocalStream;
use crate::session::{ClientId, Session, SessionOutput};

const READ_CHUNK: usize = 64 * 1024;

/// The router that answers `client`'s requests: every feature's handlers,
/// and `host:stop`, which records the stop asked for in `stop`.
fn router<'a>(
    features: &'a Features,
    capabilities: CapabilitySet,
    client: ClientId,
    stop: &'a mut Option<HostStopReason>,
) -> Router<'a> {
    let mut router = Router::new(&CATALOGUE, capabilities);
    features.requests(client, &mut router);
    router.handle::<HostStop>(move |request| {
        *stop = Some(request.reason);
        Ok(())
    });
    router
}

/// Every channel the host serves: what a client's requests are routed to,
/// and the features' events and streams.
pub(crate) fn served_channels(features: &Features) -> BTreeSet<&'static str> {
    let mut stop = None;
    let router = router(features, CapabilitySet::default(), ClientId(0), &mut stop);
    let mut served: BTreeSet<&'static str> = router.handled().collect();
    served.extend(features.served_events_and_streams());
    debug_assert!(served.contains(HostStop::NAME));
    served
}

/// What the connection needs from the host.
pub(crate) struct ConnectionContext {
    pub features: Arc<Features>,
    pub identity: Arc<HostIdentity>,
    pub stopper: Stopper,
    pub shutdown: watch::Receiver<bool>,
}

/// One session terminal open on this connection.
struct OpenStream {
    session: Arc<Session>,
    /// The client's credit for input on it.
    input: CreditReceiver,
    forward: JoinHandle<()>,
}

/// Serves one client until it disconnects or the host stops.
pub(crate) async fn serve(stream: LocalStream, client: ClientId, context: ConnectionContext) {
    let (reader, writer) = tokio::io::split(stream);
    let mut connection = Connection {
        reader,
        writer,
        decoder: FrameDecoder::new(),
        client,
        features: context.features,
        stopper: context.stopper,
        outbox: Outbox::new(),
        snapshot_seq: HashMap::new(),
        streams: HashMap::new(),
        closing: BTreeSet::new(),
        stop_after_flush: None,
    };
    let mut shutdown = context.shutdown;
    let Some(channels) = connection.handshake(&context.identity, &mut shutdown).await else {
        return;
    };
    connection.run(channels, shutdown).await;
    connection.detach_all();
    connection.features.client_left(client);
}

struct Connection {
    reader: ReadHalf<LocalStream>,
    writer: WriteHalf<LocalStream>,
    decoder: FrameDecoder,
    client: ClientId,
    features: Arc<Features>,
    stopper: Stopper,
    outbox: Outbox,
    /// For each subscription that started with a snapshot, the number of the
    /// last event it included: publications up to it are already covered.
    snapshot_seq: HashMap<u64, u64>,
    streams: HashMap<u64, OpenStream>,
    /// Streams whose session has ended, closed once their output is sent.
    closing: BTreeSet<u64>,
    /// A stop a client asked for, made once its answer has been sent.
    stop_after_flush: Option<HostStopReason>,
}

/// Why the connection ends.
enum End {
    Gone,
}

impl Connection {
    /// Waits for `hello` and answers it. The capabilities the client was
    /// welcomed with, or `None` when it was refused or went away.
    async fn handshake(
        &mut self,
        identity: &HostIdentity,
        shutdown: &mut watch::Receiver<bool>,
    ) -> Option<ClientChannels<'static>> {
        let mut buf = vec![0; READ_CHUNK];
        loop {
            match self.decoder.next_message() {
                Ok(Some(Message::Hello(hello))) => {
                    let (answer, capabilities) = identity.answer(&hello);
                    self.write(&answer).await.ok()?;
                    return capabilities.map(|caps| ClientChannels::new(&CATALOGUE, caps));
                }
                // Anything before hello is a client that does not speak the
                // protocol; it is not answered.
                Ok(Some(_)) | Err(_) => return None,
                Ok(None) => {}
            }
            tokio::select! {
                read = self.reader.read(&mut buf) => match read {
                    Ok(0) | Err(_) => return None,
                    Ok(n) => self.decoder.push(&buf[..n]),
                },
                _ = shutdown.changed() => return None,
            }
        }
    }

    async fn run(
        &mut self,
        mut channels: ClientChannels<'static>,
        mut shutdown: watch::Receiver<bool>,
    ) {
        let (output_tx, mut output_rx) = mpsc::unbounded_channel::<(u64, SessionOutput)>();
        let mut events = self.features.events().listen();
        let mut buf = vec![0; READ_CHUNK];
        loop {
            if self.flush().await.is_err() {
                return;
            }
            if let Some(reason) = self.stop_after_flush.take() {
                self.stopper.stop(reason);
            }
            let ended = tokio::select! {
                read = self.reader.read(&mut buf) => match read {
                    Ok(0) | Err(_) => Err(End::Gone),
                    Ok(n) => {
                        self.decoder.push(&buf[..n]);
                        self.take_messages(&mut channels, &output_tx)
                    }
                },
                Some((stream, output)) = output_rx.recv() => {
                    self.session_output(stream, output);
                    Ok(())
                }
                published = events.recv() => {
                    match published {
                        Ok(published) => self.publication(&channels, published),
                        // Missed events: the client sees a gap in the numbers
                        // and subscribes again.
                        Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => {}
                    }
                    Ok(())
                }
                _ = shutdown.changed() => Err(End::Gone),
            };
            if ended.is_err() {
                // Whatever is already queued, such as the answer to a stop,
                // still goes out.
                let _ = self.flush().await;
                return;
            }
        }
    }

    /// Handles every whole message received so far.
    fn take_messages(
        &mut self,
        channels: &mut ClientChannels<'static>,
        output_tx: &mpsc::UnboundedSender<(u64, SessionOutput)>,
    ) -> Result<(), End> {
        loop {
            match self.decoder.next_message() {
                Ok(Some(message)) => self.message(channels, message, output_tx),
                Ok(None) => return Ok(()),
                // The framing is lost for good: nothing more can be read.
                Err(ProtocolError::FrameTooLarge { .. }) => return Err(End::Gone),
                // A frame that did not decode is skipped; the next one
                // starts where its length said.
                Err(_) => {}
            }
        }
    }

    fn message(
        &mut self,
        channels: &mut ClientChannels<'static>,
        message: Message,
        output_tx: &mpsc::UnboundedSender<(u64, SessionOutput)>,
    ) {
        match message {
            Message::Request(request) => {
                let answer = self.answer(channels, &request);
                self.outbox.push(answer);
            }
            Message::Subscribe(subscribe) => self.subscribe(channels, &subscribe),
            Message::Unsubscribe(unsubscribe) => {
                channels.unsubscribe(unsubscribe.subscription);
                self.snapshot_seq.remove(&unsubscribe.subscription);
            }
            Message::StreamOpen(open) => self.open_stream(channels, &open, output_tx),
            Message::StreamData(data) => self.input(&data),
            Message::StreamCredit(credit) => {
                // Credit for a stream already closed is nothing to act on.
                let _ = self.outbox.grant(&credit);
            }
            Message::StreamClose(close) => self.close_stream(close.stream, None, false),
            // A second hello, or a message only a host sends, means nothing
            // from a client.
            _ => {}
        }
    }

    /// The answer to one request: an error naming the channel when it is not
    /// served yet, otherwise the features'.
    fn answer(&mut self, channels: &ClientChannels<'static>, request: &Request) -> Message {
        if let Some(later) = unserved::later(&request.channel) {
            return Message::Error(ErrorReply {
                id: request.id,
                channel: request.channel.clone(),
                code: ErrorCode::Unavailable,
                message: unserved::refusal(&request.channel, later),
            });
        }
        let mut stop = None;
        let answer = router(
            &self.features,
            channels.capabilities(),
            self.client,
            &mut stop,
        )
        .dispatch(request);
        if matches!(answer, Message::Response(_)) && stop.is_some() {
            self.stop_after_flush = stop;
        }
        answer
    }

    /// Starts a subscription: with its channel's state when it carries one,
    /// with nothing until the next event when it does not.
    fn subscribe(&mut self, channels: &mut ClientChannels<'static>, subscribe: &Subscribe) {
        let subscription = subscribe.subscription;
        self.snapshot_seq.remove(&subscription);
        let refuse = |message: String| {
            Message::SubscriptionError(SubscriptionError {
                subscription,
                channel: subscribe.channel.clone(),
                code: ErrorCode::Unavailable,
                message,
            })
        };
        if let Some(later) = unserved::later(&subscribe.channel) {
            // A number reused for this one ends what it was before.
            channels.unsubscribe(subscription);
            return self
                .outbox
                .push(refuse(unserved::refusal(&subscribe.channel, later)));
        }
        let decl = match channels.subscribe(subscribe) {
            Ok(decl) => decl,
            Err(refusal) => return self.outbox.push(Message::SubscriptionError(refusal)),
        };
        match self.features.events().start(decl.name()) {
            Some(Start::Snapshot { seq, state }) => {
                self.snapshot_seq.insert(subscription, seq);
                self.outbox.push(Message::Snapshot(Snapshot {
                    subscription,
                    seq,
                    state,
                }));
            }
            Some(Start::Quiet) => {}
            None => {
                channels.unsubscribe(subscription);
                self.outbox.push(refuse(format!(
                    "This host does not serve `{}`.",
                    decl.name()
                )));
            }
        }
    }

    /// One publication, to each of this client's subscriptions to its
    /// channel that its snapshot did not already cover.
    fn publication(&mut self, channels: &ClientChannels<'static>, published: Publication) {
        for subscription in channels.subscriptions_to(published.channel) {
            if self
                .snapshot_seq
                .get(&subscription)
                .is_some_and(|covered| published.seq <= *covered)
            {
                continue;
            }
            self.outbox.push(Message::Event(Event {
                subscription,
                seq: published.seq,
                payload: published.payload.clone(),
            }));
        }
    }

    /// Opens a terminal stream: the feature serving its channel attaches the
    /// client, and the stream carries the screen, then the live output; what
    /// the client sends on it is typed.
    fn open_stream(
        &mut self,
        channels: &ClientChannels<'static>,
        open: &StreamOpen,
        output_tx: &mpsc::UnboundedSender<(u64, SessionOutput)>,
    ) {
        let refuse = |reason: String| {
            Message::StreamClose(StreamClose {
                stream: open.stream,
                reason: Some(reason),
            })
        };
        if let Some(later) = unserved::later(&open.channel) {
            return self
                .outbox
                .push(refuse(unserved::refusal(&open.channel, later)));
        }
        let decl = match channels.open_stream(open) {
            Ok(decl) => decl,
            Err(close) => return self.outbox.push(Message::StreamClose(close)),
        };
        // A stream number reused while open replaces the earlier stream.
        self.close_stream(open.stream, None, false);
        let features = Arc::clone(&self.features);
        let attachment = match features
            .streams()
            .open(decl.name(), self.client, &open.params)
        {
            Some(Ok(attachment)) => attachment,
            Some(Err(why)) => return self.outbox.push(refuse(why)),
            None => {
                return self.outbox.push(refuse(format!(
                    "This host does not serve `{}`.",
                    decl.name()
                )));
            }
        };
        self.outbox.open_stream(open.stream, DEFAULT_INITIAL_CREDIT);
        let _ = self.outbox.write(open.stream, &attachment.redraw);

        let stream = open.stream;
        let forwarding = output_tx.clone();
        let mut output = attachment.output;
        let forward = tokio::spawn(async move {
            while let Some(item) = output.recv().await {
                if forwarding.send((stream, item)).is_err() {
                    return;
                }
            }
        });
        self.streams.insert(
            stream,
            OpenStream {
                session: attachment.session,
                input: CreditReceiver::new(stream, DEFAULT_INITIAL_CREDIT),
                forward,
            },
        );
    }

    /// Keys the client typed on a session's stream.
    fn input(&mut self, data: &StreamData) {
        let Some(open) = self.streams.get_mut(&data.stream) else {
            return;
        };
        if let Err(err) = open.input.accept(data) {
            return self.close_stream(data.stream, Some(err.to_string()), false);
        }
        let typed = open.session.input(self.client, &data.data.0);
        let credit: StreamCredit = open.input.grant(data.data.0.len() as u64);
        self.outbox.push(Message::StreamCredit(credit));
        if let Err(err) = typed {
            self.close_stream(data.stream, Some(err.to_string()), true);
        }
    }

    fn session_output(&mut self, stream: u64, output: SessionOutput) {
        if !self.streams.contains_key(&stream) {
            return;
        }
        match output {
            SessionOutput::Data(bytes) => {
                let _ = self.outbox.write(stream, &bytes);
            }
            // The protocol has no message for a size change yet; the client
            // that typed set it and already knows.
            SessionOutput::Resized(_) => {}
            // Closed once the output before it has gone; the exit code
            // travels on `session:exit`.
            SessionOutput::Exited(_) => {
                self.closing.insert(stream);
            }
        }
    }

    /// Ends one stream. With `tell`, the client is sent the close, after any
    /// output still queued for it.
    fn close_stream(&mut self, stream: u64, reason: Option<String>, tell: bool) {
        let Some(open) = self.streams.remove(&stream) else {
            return;
        };
        open.forward.abort();
        if !self
            .streams
            .values()
            .any(|other| Arc::ptr_eq(&other.session, &open.session))
        {
            open.session.detach(self.client);
        }
        self.closing.remove(&stream);
        self.outbox.close_stream(stream);
        if tell || reason.is_some() {
            self.outbox
                .push(Message::StreamClose(StreamClose { stream, reason }));
        }
    }

    /// Sends everything the client's credit allows, then closes the streams
    /// of ended sessions whose output has all gone.
    async fn flush(&mut self) -> std::io::Result<()> {
        loop {
            while let Some(message) = self.outbox.next_message() {
                self.write(&message).await?;
            }
            let drained: Vec<u64> = self
                .closing
                .iter()
                .copied()
                .filter(|stream| {
                    self.outbox
                        .stream(*stream)
                        .is_none_or(|sender| sender.held() == 0)
                })
                .collect();
            if drained.is_empty() {
                return Ok(());
            }
            for stream in drained {
                self.close_stream(stream, None, true);
            }
        }
    }

    async fn write(&mut self, message: &Message) -> std::io::Result<()> {
        let frame = encode_frame(message).map_err(std::io::Error::other)?;
        self.writer.write_all(&frame).await
    }

    /// The client has gone: its sessions run on without it.
    fn detach_all(&mut self) {
        for (_, open) in self.streams.drain() {
            open.forward.abort();
            open.session.detach(self.client);
        }
    }
}
