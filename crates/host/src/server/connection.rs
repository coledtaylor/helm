//! One client's connection: the Noise handshake first, then `hello`, then
//! requests, subscriptions and session terminals, until the client goes, its
//! device is disconnected or the host stops.
//!
//! Whatever reaches the host's socket is served in full once its handshake
//! completes: the socket only the host's OS user can open, on the host's
//! computer or through that user's own ssh login or command running `floti
//! connect`, is the access. The handshake runs on the raw stream within the
//! admission's deadline ([`HANDSHAKE_DEADLINE`](super::HANDSHAKE_DEADLINE) in
//! a host). The device's key arrives, proven, in its first message, and names
//! the device from then on; a key the host has never seen is let in as any
//! other. A connection that is not a handshake, whose first message does not
//! decrypt (it holds the host to another key, or does not prove its own),
//! that ends or that runs out of time is closed without a byte written, and
//! the host's log gets one line naming the client, the reason and, where
//! there is one, the key's fingerprint. Never key material, never the
//! client's bytes. From the host's answer on every frame is sealed on the way
//! out and opened on the way in; one that does not open ends the connection.
//!
//! A connection whose device key is the host's own has proven it can read
//! the host's key file, owner-only in its data folder: it is `floti
//! update-stop`, run by the host's OS user on the host's computer. It is no
//! device: it is served the session list and `host:stop` and nothing else,
//! and is never listed as attached.
//!
//! Once its answer is written, the host gives the client its own deadline
//! to say `hello` ([`HELLO_DEADLINE`](super::HELLO_DEADLINE) in a host). A
//! connection that has not by then is closed without another byte, and the
//! log's line names the device's fingerprint and that no hello came in time.
//!
//! A welcomed client attaches its device (`super::attached`), under the
//! device name its `hello` gave, or its client's name, and the welcome tells
//! it its own fingerprint and whether it came through the relay endpoint
//! that `floti connect` opens (from another computer). Disconnecting a device
//! (`devices:disconnect`) closes every connection of its key at once,
//! detaching it from its sessions and ending none of them.
//!
//! A welcomed client is attached to the host with the device its key
//! proved, which is who the sessions it starts are recorded as started by.
//! A client leaving detaches it from every session it was attached to and
//! ends nothing: the sessions run on for the next client.
//!
//! Most requests are answered as they are read. One a feature answers later
//! (a plugin page's call waiting on the network, a program or the user) is
//! answered when it settles, while the connection reads on; its answer is
//! dropped with the connection, and the feature hears the client left.
//!
//! Of the events published, a connection delivers those for every
//! subscriber and those addressed to its own client, never another's.
//!
//! What is served is the features' to say ([`Features`]); the connection
//! carries requests, subscriptions and streams to them. A channel on the
//! not-yet-served list is refused naming it before anything else looks at
//! it, and the client is served on.

use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use floti_protocol::channel::{RequestChannel, Routed, Router};
use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::devices::DevicesDisconnect;
use floti_protocol::channels::host::{HostPing, HostStop, HostStopReason};
use floti_protocol::channels::sessions::SessionList;
use floti_protocol::message::{
    ErrorCode, ErrorReply, Event, Hello, Request, Snapshot, StreamClose, StreamCredit, StreamData,
    StreamOpen, Subscribe, SubscriptionError,
};
use floti_protocol::noise::{
    KeyPair, NoiseError, Opener, PublicKey, Responder, ResponderStep, Sealer, Transport,
};
use floti_protocol::{
    CapabilitySet, ClientChannels, CreditReceiver, DEFAULT_INITIAL_CREDIT, FrameDecoder,
    HostIdentity, Message, Outbox, ProtocolError, encode_frame,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::sync::{Semaphore, broadcast, mpsc, watch};
use tokio::task::JoinSet;

use super::attached::{Attached, Attachment};
use super::events::{Publication, Start};
use super::features::{Caller, Features, StreamAttachment, StreamOpening};
use super::hosted::Hosted;
use super::stopper::ReservedStop;
use super::{CATALOGUE, Stopper, unserved};
use crate::platform::socket::LocalStream;
use crate::session::{ClientId, SessionOutput};

mod streams;
#[cfg(test)]
mod tests;

use streams::{BEHIND_LIMIT, Carried, Fed, Feed, RESET};

const READ_CHUNK: usize = 64 * 1024;

/// The router that answers `caller`'s requests: every feature's handlers,
/// `devices:disconnect`, answered from `attached`, and `host:stop`, which
/// records the stop asked for in `stop`.
fn router<'a>(
    features: &'a Features,
    capabilities: CapabilitySet,
    caller: Caller,
    stop: &'a mut Option<HostStopReason>,
) -> Router<'a> {
    let mut router = Router::new(&CATALOGUE, capabilities);
    features.requests(caller, &mut router);
    let attached: &Attached = features.attached();
    router
        .handle::<DevicesDisconnect>(move |request| disconnect(attached, &request.fingerprint))
        .handle::<HostStop>(move |request| {
            *stop = Some(request.reason);
            Ok(())
        })
        .handle::<HostPing>(|()| Ok(()));
    router
}

/// Closes every connection of the attached device with `fingerprint` at
/// once, ending none of its sessions. Refused, closing nothing, for a
/// fingerprint no attached device has.
fn disconnect(attached: &Attached, fingerprint: &str) -> Result<(), String> {
    let shown: String = fingerprint
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .collect();
    match attached.disconnect(fingerprint) {
        Some(gone) => {
            log_line!(
                "floti host: disconnected device {shown}; closed its {} connections, and its sessions keep running",
                gone.connections
            );
            Ok(())
        }
        None => Err(format!(
            "No device attached to this host has the fingerprint {shown}; nothing was closed."
        )),
    }
}

/// Every channel the host serves: what a client's requests are routed to,
/// and the features' events and streams.
pub(crate) fn served_channels(features: &Features) -> BTreeSet<&'static str> {
    let mut stop = None;
    let router = router(
        features,
        CapabilitySet::default(),
        Caller::new(ClientId(0)),
        &mut stop,
    );
    let mut served: BTreeSet<&'static str> = router.handled().collect();
    served.extend(features.served_events_and_streams());
    debug_assert!(served.contains(HostStop::NAME));
    served
}

/// What the handshake needs: the host's key, how long a connection has to
/// finish it, and how long it then has to say `hello`.
#[derive(Clone)]
pub(crate) struct Admission {
    pub host_key: Arc<KeyPair>,
    pub deadline: Duration,
    pub hello_deadline: Duration,
}

/// A device the handshake let in.
pub(crate) struct Admitted {
    pub transport: Transport,
    /// Bytes read past the device's first message, which belong to the session.
    pub rest: Vec<u8>,
    /// The key it proved.
    pub device: PublicKey,
    /// What it was let in as.
    pub entry: Entry,
}

/// What a connection was let in as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Entry {
    /// Any key but the host's own: a client's device.
    Device,
    /// The host's own key: `floti update-stop` in a shell on its computer.
    Shell,
}

/// Why a connection was closed before `hello`, as the host's log says it.
enum Refusal {
    Failed(NoiseError),
    TimedOut(Duration),
    /// The device finished the handshake and said no `hello` within the
    /// deadline.
    NoHello(PublicKey, Duration),
    Ended,
    ReadFailed(std::io::Error),
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failed(err) => write!(f, "failed handshake: {err}"),
            Self::TimedOut(deadline) => {
                write!(f, "the handshake did not finish in time ({deadline:?})")
            }
            Self::NoHello(key, deadline) => write!(
                f,
                "device {} did not say hello in time ({deadline:?})",
                key.fingerprint()
            ),
            Self::Ended => write!(f, "the connection ended before the handshake finished"),
            Self::ReadFailed(err) => write!(f, "the handshake could not be read: {err}"),
        }
    }
}

/// What the connection needs from the host.
pub(crate) struct ConnectionContext {
    pub features: Arc<Features>,
    /// Where the client is counted as attached, with its device.
    pub hosted: Arc<Hosted>,
    pub admission: Admission,
    pub identity: Arc<HostIdentity>,
    pub stopper: Stopper,
    pub shutdown: watch::Receiver<bool>,
}

/// One stream open on this connection.
struct OpenStream {
    /// Names this opening of the stream: what a task started for an earlier
    /// one, or for the attachment before a catch-up, sends is dropped.
    token: u64,
    /// The client's credit for input on it.
    input: CreditReceiver,
    carried: Carried,
}

/// Serves one client until it goes, its device is disconnected or the host
/// stops. `away` says it was accepted on the relay endpoint: it reached the
/// host from another computer.
pub(crate) async fn serve(
    mut stream: LocalStream,
    client: ClientId,
    away: bool,
    context: ConnectionContext,
) {
    let mut shutdown = context.shutdown;
    let admitted = admit_within_deadline(&mut stream, &context.admission, &mut shutdown).await;
    let Admitted {
        transport,
        rest,
        device,
        entry,
    } = match admitted {
        Ok(admitted) => admitted,
        Err(refusal) => {
            // A host stopping closes a handshake in flight without a word.
            if let Some(refusal) = refusal {
                log_line!("floti host: refused client {}: {refusal}", client.0);
            }
            return;
        }
    };
    if entry == Entry::Shell {
        if let Some(sealed) = Sealed::new(stream, transport, &rest) {
            let serving = (&*context.identity, &context.admission, &mut shutdown);
            let sessions = || context.hosted.list();
            let control = ShellControl {
                sessions: &sessions,
                stopper: &context.stopper,
            };
            serve_shell(sealed, client, device, serving, control).await;
        }
        return;
    }
    let (sealer, opener) = transport.split();
    let (reader, writer) = tokio::io::split(stream);
    let mut connection = Connection {
        reader,
        writer,
        sealer,
        opener,
        decoder: FrameDecoder::new(),
        client,
        device,
        away,
        features: context.features,
        stopper: context.stopper,
        outbox: Outbox::new(),
        snapshot_seq: HashMap::new(),
        streams: HashMap::new(),
        tokens: 0,
        closing: BTreeSet::new(),
        stop_after_flush: None,
        later: Vec::new(),
    };
    if connection.received(&rest).is_err() {
        return;
    }
    let Some((channels, name)) = connection
        .hello(
            &context.identity,
            device,
            context.admission.hello_deadline,
            &mut shutdown,
        )
        .await
    else {
        return;
    };
    let mut attachment = connection
        .features
        .attached()
        .enter(device, &name, client, away);
    context.hosted.attach_client(client, device);
    connection.run(channels, shutdown, &mut attachment).await;
    drop(attachment);
    connection.detach_all();
    connection.features.events().leave(client);
    connection.features.client_left(client);
    // Last: a host that exits once nobody is attached hears it only when
    // everything the client held has been let go.
    context.hosted.detach_client(client);
}

/// [`admit`], cut off at the admission's deadline.
async fn admit_within_deadline(
    stream: &mut (impl AsyncRead + AsyncWrite + Unpin),
    admission: &Admission,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<Admitted, Option<Refusal>> {
    tokio::time::timeout(admission.deadline, admit(stream, admission, shutdown))
        .await
        .unwrap_or(Err(Some(Refusal::TimedOut(admission.deadline))))
}

/// The responder's half of the handshake, on the raw stream. The error is why
/// the device was refused, or `None` when the host is stopping.
async fn admit(
    stream: &mut (impl AsyncRead + AsyncWrite + Unpin),
    admission: &Admission,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<Admitted, Option<Refusal>> {
    let mut responder =
        Responder::new(&admission.host_key).map_err(|err| Some(Refusal::Failed(err)))?;
    let mut buf = vec![0; READ_CHUNK];
    loop {
        let n = tokio::select! {
            read = stream.read(&mut buf) => match read {
                Ok(0) => return Err(Some(Refusal::Ended)),
                Ok(n) => n,
                Err(err) if is_closed(&err) => return Err(Some(Refusal::Ended)),
                Err(err) => return Err(Some(Refusal::ReadFailed(err))),
            },
            _ = shutdown.changed() => return Err(None),
        };
        match responder.push(&buf[..n]) {
            Ok(ResponderStep::Pending(next)) => responder = next,
            Ok(ResponderStep::Received { device, used }) => {
                let key = device.device_key();
                let entry = if key == admission.host_key.public() {
                    // Only a process that can read the host's key file holds it.
                    Entry::Shell
                } else {
                    Entry::Device
                };
                let (transport, answer) =
                    device.accept().map_err(|err| Some(Refusal::Failed(err)))?;
                stream
                    .write_all(&answer)
                    .await
                    .map_err(|err| Some(Refusal::ReadFailed(err)))?;
                return Ok(Admitted {
                    transport,
                    rest: buf[used..n].to_vec(),
                    device: key,
                    entry,
                });
            }
            Err(err) => return Err(Some(Refusal::Failed(err))),
        }
    }
}

/// [`read_hello`], cut off `deadline` after it starts, which is as soon as
/// the host's answer to `device`'s handshake has been written. The error is
/// why the device was refused, or `None` when it went, sent something other
/// than `hello`, or the host is stopping. Nothing is written either way.
async fn hello_within_deadline(
    reader: &mut (impl AsyncRead + Unpin),
    opener: &mut Opener,
    decoder: &mut FrameDecoder,
    device: PublicKey,
    deadline: Duration,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<Hello, Option<Refusal>> {
    match tokio::time::timeout(deadline, read_hello(reader, opener, decoder, shutdown)).await {
        Ok(Some(hello)) => Ok(hello),
        Ok(None) => Err(None),
        Err(_) => Err(Some(Refusal::NoHello(device, deadline))),
    }
}

/// Reads the client's first message, opened and decoded after whatever
/// `decoder` already holds: its `hello`, or `None` when it went, sent
/// anything else first (a client that does not speak the protocol), sent a
/// frame that does not open, or the host is stopping.
async fn read_hello(
    reader: &mut (impl AsyncRead + Unpin),
    opener: &mut Opener,
    decoder: &mut FrameDecoder,
    shutdown: &mut watch::Receiver<bool>,
) -> Option<Hello> {
    let mut buf = vec![0; READ_CHUNK];
    loop {
        match decoder.next_message() {
            Ok(Some(Message::Hello(hello))) => return Some(hello),
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) => {}
        }
        tokio::select! {
            read = reader.read(&mut buf) => match read {
                Ok(0) | Err(_) => return None,
                Ok(n) => decoder.push(&opener.open(&buf[..n]).ok()?),
            },
            _ = shutdown.changed() => return None,
        }
    }
}

/// What a connection that is not a client's is served with: the host's
/// identity, its admission, and its shutdown.
type Serving<'a> = (
    &'a HostIdentity,
    &'a Admission,
    &'a mut watch::Receiver<bool>,
);

/// A connection's session on a stream of any kind, for the host's own shell,
/// which is not a client's.
struct Sealed<S> {
    reader: ReadHalf<S>,
    writer: WriteHalf<S>,
    sealer: Sealer,
    opener: Opener,
    decoder: FrameDecoder,
}

impl<S: AsyncRead + AsyncWrite> Sealed<S> {
    /// The session on `stream` once `transport`'s handshake is done, with
    /// `rest`, the bytes read past it; `None` when they do not open.
    fn new(stream: S, transport: Transport, rest: &[u8]) -> Option<Self> {
        let (sealer, mut opener) = transport.split();
        let mut decoder = FrameDecoder::new();
        decoder.push(&opener.open(rest).ok()?);
        let (reader, writer) = tokio::io::split(stream);
        Some(Self {
            reader,
            writer,
            sealer,
            opener,
            decoder,
        })
    }

    /// `device`'s `hello`, within `deadline`; `None` when it did not come,
    /// which the log says naming the device when it ran out of time.
    async fn hello(
        &mut self,
        client: ClientId,
        device: PublicKey,
        deadline: Duration,
        shutdown: &mut watch::Receiver<bool>,
    ) -> Option<Hello> {
        match hello_within_deadline(
            &mut self.reader,
            &mut self.opener,
            &mut self.decoder,
            device,
            deadline,
            shutdown,
        )
        .await
        {
            Ok(hello) => Some(hello),
            Err(refusal) => {
                if let Some(refusal) = refusal {
                    log_line!("floti host: refused client {}: {refusal}", client.0);
                }
                None
            }
        }
    }

    async fn write(&mut self, message: &Message) -> std::io::Result<()> {
        let frame = encode_frame(message).map_err(std::io::Error::other)?;
        let sealed = self.sealer.seal(&frame).map_err(std::io::Error::other)?;
        self.writer.write_all(&sealed).await?;
        self.writer.flush().await
    }

    /// The client's next message; `None` once it has gone, its session or
    /// framing failed, or the host is stopping.
    async fn next(&mut self, shutdown: &mut watch::Receiver<bool>) -> Option<Message> {
        let mut buf = vec![0; READ_CHUNK];
        loop {
            match self.decoder.next_message() {
                Ok(Some(message)) => return Some(message),
                Ok(None) => {}
                Err(ProtocolError::FrameTooLarge { .. }) => return None,
                // A frame that did not decode is skipped.
                Err(_) => continue,
            }
            tokio::select! {
                read = self.reader.read(&mut buf) => match read {
                    Ok(0) | Err(_) => return None,
                    Ok(n) => self.decoder.push(&self.opener.open(&buf[..n]).ok()?),
                },
                _ = shutdown.changed() => return None,
            }
        }
    }

    /// Closes the writing side once what was written has gone.
    async fn close(mut self) {
        let _ = self.writer.shutdown().await;
    }
}

/// What the host's own shell is served: the sessions the host runs, which
/// `floti update-stop` counts, and stopping the host, which it asks for an
/// update.
pub(crate) struct ShellControl<'a> {
    pub sessions: &'a (dyn Fn() -> Result<Vec<SessionRecord>, String> + Send + Sync),
    pub stopper: &'a Stopper,
}

/// The channels the host's own shell is served.
const SHELL_CHANNELS: [&str; 2] = [SessionList::NAME, HostStop::NAME];

/// The host's own shell: the session list and `host:stop`, and every other
/// request refused, until it goes. A stop it asks for is carried out once its
/// answer has been written.
async fn serve_shell<S: AsyncRead + AsyncWrite>(
    mut sealed: Sealed<S>,
    client: ClientId,
    device: PublicKey,
    (identity, admission, shutdown): Serving<'_>,
    control: ShellControl<'_>,
) {
    const SERVED: &str = "The host's own shell is served `session:list` and `host:stop` only.";
    let Some(hello) = sealed
        .hello(client, device, admission.hello_deadline, shutdown)
        .await
    else {
        return;
    };
    let (answer, capabilities) = identity.answer(&hello);
    if sealed.write(&answer).await.is_err() {
        return;
    }
    let Some(capabilities) = capabilities else {
        return sealed.close().await;
    };
    while let Some(message) = sealed.next(shutdown).await {
        let mut reserved = None;
        let answer = match message {
            Message::Request(request) => {
                if SHELL_CHANNELS.contains(&request.channel.as_str()) {
                    let mut stop = None;
                    let answer = shell_router(capabilities, &control, &mut stop).dispatch(&request);
                    if matches!(answer, Message::Response(_)) {
                        reserved = stop.and_then(|reason| control.stopper.reserve(reason));
                    }
                    answer
                } else {
                    Message::Error(ErrorReply {
                        id: request.id,
                        channel: request.channel,
                        code: ErrorCode::Unavailable,
                        message: SERVED.to_owned(),
                    })
                }
            }
            Message::Subscribe(subscribe) => Message::SubscriptionError(SubscriptionError {
                subscription: subscribe.subscription,
                channel: subscribe.channel,
                code: ErrorCode::Unavailable,
                message: SERVED.to_owned(),
            }),
            Message::StreamOpen(open) => Message::StreamClose(StreamClose {
                stream: open.stream,
                reason: Some(SERVED.to_owned()),
            }),
            _ => continue,
        };
        let written = sealed.write(&answer).await;
        // Dropping the reserved stop carries it out, once the answer is out.
        drop(reserved);
        if written.is_err() {
            return;
        }
    }
}

/// What answers the host's own shell: the session list, and `host:stop`,
/// which records the stop asked for in `stop`.
fn shell_router<'a>(
    capabilities: CapabilitySet,
    control: &'a ShellControl<'a>,
    stop: &'a mut Option<HostStopReason>,
) -> Router<'a> {
    let mut router = Router::new(&CATALOGUE, capabilities);
    router
        .handle::<SessionList>(|()| (control.sessions)())
        .handle::<HostStop>(move |request| {
            *stop = Some(request.reason);
            Ok(())
        });
    router
}

/// The name a client's device is listed under: the device name its `hello`
/// gave, or its client's name when it gave none or only blanks. Control
/// characters are dropped, so a name cannot draw on a terminal that shows it.
fn device_name(hello: &Hello) -> String {
    let clean = |name: &str| -> String {
        name.chars()
            .filter(|c| !c.is_control())
            .collect::<String>()
            .trim()
            .to_owned()
    };
    hello
        .client
        .device_name
        .as_deref()
        .map(clean)
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| clean(&hello.client.name))
}

/// A read error that is the client having gone: what a pipe reports on
/// Windows where a Unix socket reads as ended.
fn is_closed(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::ConnectionAborted
    )
}

struct Connection {
    reader: ReadHalf<LocalStream>,
    writer: WriteHalf<LocalStream>,
    /// Seals every frame written.
    sealer: Sealer,
    /// Opens every byte read, before the frames in it are decoded.
    opener: Opener,
    decoder: FrameDecoder,
    client: ClientId,
    /// The key its device proved.
    device: PublicKey,
    /// Whether it reached the host from another computer.
    away: bool,
    features: Arc<Features>,
    stopper: Stopper,
    outbox: Outbox,
    /// For each subscription that started with a snapshot, the number of the
    /// last event it included: publications up to it are already covered.
    snapshot_seq: HashMap<u64, u64>,
    streams: HashMap<u64, OpenStream>,
    /// The last token given a stream's opening.
    tokens: u64,
    /// Streams whose session or socket has ended, closed once their output
    /// is sent.
    closing: BTreeSet<u64>,
    /// A stop a client asked for, reserved when it was answered and carried
    /// out once the answer has been sent.
    stop_after_flush: Option<ReservedStop>,
    /// Answers routed to be worked out, not yet handed to the loop that
    /// waits on them.
    later: Vec<LaterAnswer>,
}

/// An answer a feature is still working out: the message it comes to.
type LaterAnswer = std::pin::Pin<Box<dyn std::future::Future<Output = Message> + Send>>;

/// Why the connection ends.
enum End {
    Gone,
}

impl Connection {
    /// Opens `bytes` from the client and decodes the frames in them. An
    /// error is a session that failed: nothing more from it can be trusted.
    fn received(&mut self, bytes: &[u8]) -> Result<(), End> {
        let opened = self.opener.open(bytes).map_err(|_| End::Gone)?;
        self.decoder.push(&opened);
        Ok(())
    }

    /// Waits up to `deadline` for `device`'s `hello` and answers it. The
    /// capabilities the client was welcomed with and the name its device is
    /// listed under, or `None` when it was refused, went away or said nothing
    /// in time, which the log says naming the device.
    async fn hello(
        &mut self,
        identity: &HostIdentity,
        device: PublicKey,
        deadline: Duration,
        shutdown: &mut watch::Receiver<bool>,
    ) -> Option<(ClientChannels<'static>, String)> {
        let hello = match hello_within_deadline(
            &mut self.reader,
            &mut self.opener,
            &mut self.decoder,
            device,
            deadline,
            shutdown,
        )
        .await
        {
            Ok(hello) => hello,
            Err(refusal) => {
                if let Some(refusal) = refusal {
                    log_line!("floti host: refused client {}: {refusal}", self.client.0);
                }
                return None;
            }
        };
        let (mut answer, capabilities) = identity.answer(&hello);
        if let Message::Welcome(welcome) = &mut answer {
            welcome.away = self.away;
            welcome.device = Some(self.device.fingerprint());
        }
        self.write(&answer).await.ok()?;
        let capabilities = capabilities?;
        Some((
            ClientChannels::new(&CATALOGUE, capabilities),
            device_name(&hello),
        ))
    }

    async fn run(
        &mut self,
        mut channels: ClientChannels<'static>,
        mut shutdown: watch::Receiver<bool>,
        attachment: &mut Attachment,
    ) {
        let (feed_tx, mut feed_rx) = mpsc::unbounded_channel::<Feed>();
        let mut events = self.features.events().listen(self.client);
        let mut buf = vec![0; READ_CHUNK];
        // Answers still being worked out. Dropped with the connection, which
        // drops their work with them.
        let mut later = JoinSet::new();
        loop {
            for answer in self.later.drain(..) {
                later.spawn(answer);
            }
            if self.flush().await.is_err() {
                return;
            }
            // Dropping the reserved stop carries it out.
            drop(self.stop_after_flush.take());
            let ended = tokio::select! {
                read = self.reader.read(&mut buf) => match read {
                    Ok(0) | Err(_) => Err(End::Gone),
                    Ok(n) => self
                        .received(&buf[..n])
                        .and_then(|()| self.take_messages(&mut channels, &feed_tx)),
                },
                Some(feed) = feed_rx.recv() => {
                    self.fed(feed, &feed_tx);
                    Ok(())
                }
                Some(answered) = later.join_next(), if !later.is_empty() => {
                    // An answer whose work panicked is lost; the client's
                    // request is the one that waits.
                    if let Ok(answer) = answered {
                        self.outbox.push(answer);
                    }
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
                () = attachment.closed() => {
                    log_line!(
                        "floti host: closed client {}: its device {} was disconnected",
                        self.client.0,
                        self.device.fingerprint()
                    );
                    Err(End::Gone)
                }
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
        feed: &mpsc::UnboundedSender<Feed>,
    ) -> Result<(), End> {
        loop {
            match self.decoder.next_message() {
                Ok(Some(message)) => self.message(channels, message, feed),
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
        feed: &mpsc::UnboundedSender<Feed>,
    ) {
        match message {
            Message::Request(request) => match self.answer(channels, &request) {
                Routed::Now(answer) => self.outbox.push(answer),
                Routed::Later(answer) => self.later.push(answer),
            },
            Message::Subscribe(subscribe) => {
                self.subscribe(channels, &subscribe);
                self.features.subscriptions_changed(self.client, channels);
            }
            Message::Unsubscribe(unsubscribe) => {
                channels.unsubscribe(unsubscribe.subscription);
                self.snapshot_seq.remove(&unsubscribe.subscription);
                self.features.subscriptions_changed(self.client, channels);
            }
            Message::StreamOpen(open) => self.open_stream(channels, &open, feed),
            Message::StreamData(data) => self.input(&data),
            Message::StreamCredit(credit) => self.credit(&credit, feed),
            Message::StreamClose(close) => self.close_stream(close.stream, None, false),
            // A second hello, or a message only a host sends, means nothing
            // from a client.
            _ => {}
        }
    }

    /// The answer to one request: an error naming the channel when it is not
    /// served yet, otherwise the features', now or once its work is done.
    fn answer(&mut self, channels: &ClientChannels<'static>, request: &Request) -> Routed {
        if let Some(later) = unserved::later(&request.channel) {
            return Routed::Now(Message::Error(ErrorReply {
                id: request.id,
                channel: request.channel.clone(),
                code: ErrorCode::Unavailable,
                message: unserved::refusal(&request.channel, later),
            }));
        }
        let mut stop = None;
        let caller = Caller::new(self.client);
        let mut router = router(&self.features, channels.capabilities(), caller, &mut stop);
        let answer = router.route(request);
        drop(router);
        // Taken before the answer is queued, so nothing asked once the client
        // has its answer replaces it. A later stop finds it taken and is
        // answered all the same. `host:stop` is answered at once.
        if matches!(answer, Routed::Now(Message::Response(_)))
            && let Some(reserved) = stop.and_then(|reason| self.stopper.reserve(reason))
        {
            self.stop_after_flush = Some(reserved);
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
    /// channel that its snapshot did not already cover, unless it is
    /// addressed to another client.
    fn publication(&mut self, channels: &ClientChannels<'static>, published: Publication) {
        if !published.is_for(self.client) {
            return;
        }
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

    /// Opens a stream: the feature serving its channel attaches the client
    /// to a terminal, whose screen and then live output the stream carries
    /// and into which what the client sends is typed, or opens a connection
    /// on the host's loopback, which the stream carries both ways. Work that
    /// takes time is waited on while the connection serves on.
    fn open_stream(
        &mut self,
        channels: &ClientChannels<'static>,
        open: &StreamOpen,
        feed: &mpsc::UnboundedSender<Feed>,
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
        let stream = open.stream;
        let features = Arc::clone(&self.features);
        let Some(opening) = features
            .streams()
            .open(decl.name(), self.client, &open.params)
        else {
            return self.outbox.push(refuse(format!(
                "This host does not serve `{}`.",
                decl.name()
            )));
        };
        let token = self.next_token();
        let input = CreditReceiver::new(stream, DEFAULT_INITIAL_CREDIT);
        match opening {
            StreamOpening::Now(Ok(attachment)) => {
                self.carry(stream, token, input, attachment, Vec::new(), feed);
            }
            StreamOpening::Now(Err(why)) => self.outbox.push(refuse(why)),
            StreamOpening::Later(work) => {
                let feed = feed.clone();
                let work = tokio::spawn(async move {
                    let opened = work.await;
                    let _ = feed.send(Feed {
                        stream,
                        token,
                        fed: Fed::Opened(opened),
                    });
                });
                self.streams.insert(
                    stream,
                    OpenStream {
                        token,
                        input,
                        carried: Carried::Opening {
                            work,
                            sent: Vec::new(),
                        },
                    },
                );
            }
        }
    }

    fn next_token(&mut self) -> u64 {
        self.tokens += 1;
        self.tokens
    }

    /// Starts carrying `attachment` on `stream`, with `sent`, what the client
    /// sent while it was being opened.
    fn carry(
        &mut self,
        stream: u64,
        token: u64,
        mut input: CreditReceiver,
        attachment: StreamAttachment,
        sent: Vec<u8>,
        feed: &mpsc::UnboundedSender<Feed>,
    ) {
        self.outbox.open_stream(stream, DEFAULT_INITIAL_CREDIT);
        let carried = match attachment {
            StreamAttachment::Terminal(terminal) => {
                let _ = self.outbox.write(stream, &terminal.redraw);
                if !sent.is_empty() {
                    let _ = terminal.session.input(self.client, &sent);
                    let credit = input.grant(sent.len() as u64);
                    self.outbox.push(Message::StreamCredit(credit));
                }
                Carried::Terminal {
                    session: terminal.session,
                    forward: streams::forward_output(stream, token, terminal.output, feed.clone()),
                    behind: false,
                }
            }
            StreamAttachment::Socket(socket) => {
                let (to_socket, from_client) = mpsc::unbounded_channel();
                let room = Arc::new(Semaphore::new(
                    usize::try_from(DEFAULT_INITIAL_CREDIT).unwrap_or(usize::MAX),
                ));
                let (read, write) = socket.socket.into_split();
                if !sent.is_empty() {
                    let _ = to_socket.send(sent);
                }
                Carried::Socket {
                    to_socket,
                    reader: streams::read_socket(
                        read,
                        Arc::clone(&room),
                        socket.ended,
                        stream,
                        token,
                        feed.clone(),
                    ),
                    room,
                    writer: streams::write_socket(write, from_client, stream, token, feed.clone()),
                }
            }
        };
        self.streams.insert(
            stream,
            OpenStream {
                token,
                input,
                carried,
            },
        );
    }

    /// Bytes the client sent on a stream: keys typed into a terminal, or
    /// bytes for a socket, which are granted back once written.
    fn input(&mut self, data: &StreamData) {
        let client = self.client;
        let Some(open) = self.streams.get_mut(&data.stream) else {
            return;
        };
        if let Err(err) = open.input.accept(data) {
            return self.close_stream(data.stream, Some(err.to_string()), false);
        }
        let typed = match &mut open.carried {
            Carried::Terminal { session, .. } => {
                let typed = session.input(client, &data.data.0);
                let credit: StreamCredit = open.input.grant(data.data.0.len() as u64);
                self.outbox.push(Message::StreamCredit(credit));
                typed.map_err(|err| err.to_string())
            }
            Carried::Opening { sent, .. } => {
                sent.extend_from_slice(&data.data.0);
                Ok(())
            }
            Carried::Socket { to_socket, .. } => {
                let _ = to_socket.send(data.data.0.clone());
                Ok(())
            }
        };
        if let Err(err) = typed {
            self.close_stream(data.stream, Some(err), true);
        }
    }

    /// Credit the client granted on a stream: more a socket may read, and
    /// for a terminal that fell behind, the moment to catch it up.
    fn credit(&mut self, credit: &StreamCredit, feed: &mpsc::UnboundedSender<Feed>) {
        // Credit for a stream already closed is nothing to act on.
        let _ = self.outbox.grant(credit);
        let Some(open) = self.streams.get(&credit.stream) else {
            return;
        };
        match &open.carried {
            Carried::Socket { room, .. } => {
                let most = Semaphore::MAX_PERMITS.saturating_sub(room.available_permits());
                room.add_permits(
                    usize::try_from(credit.bytes)
                        .unwrap_or(usize::MAX)
                        .min(most),
                );
            }
            Carried::Terminal { behind: true, .. } => self.catch_up(credit.stream, feed),
            _ => {}
        }
    }

    /// Catches a terminal stream that fell behind up: it is attached afresh
    /// and sent a reset and the session's current screen, then streams on.
    fn catch_up(&mut self, stream: u64, feed: &mpsc::UnboundedSender<Feed>) {
        let token = self.next_token();
        let client = self.client;
        let Some(open) = self.streams.get_mut(&stream) else {
            return;
        };
        let Carried::Terminal {
            session,
            forward,
            behind,
        } = &mut open.carried
        else {
            return;
        };
        // Attaching again replaces the attachment it fell behind on, whose
        // output stops with it.
        match session.attach(client, session.size()) {
            Ok(attachment) => {
                forward.abort();
                *forward = streams::forward_output(stream, token, attachment.output, feed.clone());
                *behind = false;
                open.token = token;
                let _ = self.outbox.discard(stream);
                let _ = self.outbox.write(stream, RESET);
                let _ = self.outbox.write(stream, &attachment.redraw);
            }
            // The session has ended since: the stream closes as an ended
            // session's does.
            Err(_) => {
                let _ = self.outbox.discard(stream);
                self.closing.insert(stream);
            }
        }
    }

    /// What one of the streams' tasks has for the connection.
    fn fed(&mut self, feed: Feed, sender: &mpsc::UnboundedSender<Feed>) {
        let Feed { stream, token, fed } = feed;
        if self
            .streams
            .get(&stream)
            .is_none_or(|open| open.token != token)
        {
            return;
        }
        match fed {
            Fed::Output(output) => self.session_output(stream, output),
            Fed::Opened(Ok(attachment)) => {
                let Some(open) = self.streams.remove(&stream) else {
                    return;
                };
                let sent = match open.carried {
                    Carried::Opening { sent, .. } => sent,
                    other => {
                        // Opened once only; anything else is left as it is.
                        self.streams.insert(
                            stream,
                            OpenStream {
                                carried: other,
                                ..open
                            },
                        );
                        return;
                    }
                };
                self.carry(stream, token, open.input, attachment, sent, sender);
            }
            Fed::Opened(Err(why)) | Fed::Ended(Some(why)) => {
                self.close_stream(stream, Some(why), true);
            }
            Fed::Received(bytes) => {
                let _ = self.outbox.write(stream, &bytes);
            }
            Fed::Written(bytes) => {
                if let Some(open) = self.streams.get_mut(&stream) {
                    let credit = open.input.grant(bytes);
                    self.outbox.push(Message::StreamCredit(credit));
                }
            }
            // The server closed the connection: the stream closes once what
            // it sent has gone.
            Fed::Ended(None) => {
                self.closing.insert(stream);
            }
        }
    }

    fn session_output(&mut self, stream: u64, output: SessionOutput) {
        let Some(OpenStream {
            carried: Carried::Terminal { behind, .. },
            ..
        }) = self.streams.get_mut(&stream)
        else {
            return;
        };
        match output {
            // A client that fell behind is sent nothing until it has caught
            // up: the screen it is then sent already holds this.
            SessionOutput::Data(_) if *behind => {}
            SessionOutput::Data(bytes) => {
                let _ = self.outbox.write(stream, &bytes);
                if self
                    .outbox
                    .stream(stream)
                    .is_some_and(|sender| sender.held() > BEHIND_LIMIT)
                {
                    let _ = self.outbox.discard(stream);
                    *behind = true;
                }
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
        open.carried.stop();
        if let Some(session) = open.carried.session()
            && !self.streams.values().any(|other| {
                other
                    .carried
                    .session()
                    .is_some_and(|other| Arc::ptr_eq(other, session))
            })
        {
            session.detach(self.client);
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
        let sealed = self.sealer.seal(&frame).map_err(std::io::Error::other)?;
        self.writer.write_all(&sealed).await
    }

    /// The client has gone: its sessions run on without it.
    fn detach_all(&mut self) {
        for (_, open) in self.streams.drain() {
            open.carried.stop();
            if let Some(session) = open.carried.session() {
                session.detach(self.client);
            }
        }
    }
}
