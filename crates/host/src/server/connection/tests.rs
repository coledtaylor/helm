//! The handshake's admission, over in-memory pipes.
//!
//! The deadline, on tokio's paused clock: a connection that says nothing, or
//! stops partway through its first message, is refused at the deadline
//! exactly, and one that finishes just inside it is admitted. The
//! integration test (`tests/noise_sessions.rs`) shows the same refusals logged
//! by the executable while another client is served, on a short deadline.
//!
//! The wait for `hello` after it, on the same clock: a device that finished
//! the handshake and says nothing is refused at the hello deadline exactly,
//! counted from the host's answer, naming its fingerprint; one whose hello
//! comes just inside it is read.
//!
//! Access: any device key that completes the handshake is let in as a
//! device, one the host has never seen included; a client that holds the
//! host to another key is closed without a byte, and the log names no key.
//! The host's own key is its shell, served the session list and `host:stop`
//! only.

use std::sync::Arc;
use std::time::Duration;

use floti_protocol::channel::{RequestChannel, from_payload, to_payload};
use floti_protocol::channels::common::SessionRecord;
use floti_protocol::channels::host::{HostStop, HostStopReason, HostStopRequest};
use floti_protocol::channels::sessions::SessionList;
use floti_protocol::message::{ClientInfo, ClientKind, ErrorCode, Hello, Request};
use floti_protocol::noise::{Initiator, InitiatorStep, KeyPair, Opener, PublicKey, Transport};
use floti_protocol::{
    FrameDecoder, HostIdentity, Message, PROTOCOL_VERSION, Payload, encode_frame,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, duplex};
use tokio::sync::watch;
use tokio::time::Instant;

use super::{
    Admission, Entry, Refusal, Sealed, ShellControl, admit_within_deadline, device_name,
    hello_within_deadline, serve_shell,
};
use crate::server::{
    HANDSHAKE_DEADLINE, HELLO_DEADLINE, Stopper, TEST_HANDSHAKE_DEADLINE_MARKER,
    handshake_deadline, hello_deadline,
};
use crate::session::ClientId;
use crate::testkit::TestDirs;

/// Room for both handshake messages and more.
const PIPE: usize = 64 * 1024;

type Admitted = Result<super::Admitted, Option<Refusal>>;

struct Fixture {
    admission: Admission,
    /// A device the host has never seen: every device is one, to begin with.
    device: KeyPair,
    /// Held so the shutdown never fires: a dropped sender would end the
    /// handshake as a stopping host does.
    shutdown: watch::Sender<bool>,
    /// What the host's own shell stops the host through, and the stop it
    /// asked for.
    stopper: Stopper,
    stop_asked: watch::Receiver<Option<HostStopReason>>,
}

fn fixture() -> Fixture {
    let (stopper, stop_asked) = Stopper::new();
    Fixture {
        admission: Admission {
            host_key: Arc::new(KeyPair::generate().unwrap()),
            deadline: HANDSHAKE_DEADLINE,
            hello_deadline: HELLO_DEADLINE,
        },
        device: KeyPair::generate().unwrap(),
        shutdown: watch::channel(false).0,
        stopper,
        stop_asked,
    }
}

impl Fixture {
    fn first_message(&self) -> Vec<u8> {
        Initiator::start(&self.device, &self.admission.host_key.public())
            .expect("start a handshake")
            .1
    }

    fn host(&self) -> PublicKey {
        self.admission.host_key.public()
    }

    /// Runs `first` against the host on a pipe of its own: how the host
    /// admitted it, and every byte it wrote before letting go of the pipe.
    async fn admit(&self, first: &[u8]) -> (Admitted, Vec<u8>) {
        let (mut client, mut host) = duplex(PIPE);
        client.write_all(first).await.unwrap();
        let mut shutdown = self.shutdown.subscribe();
        let admitted = admit_within_deadline(&mut host, &self.admission, &mut shutdown).await;
        drop(host);
        (admitted, written(&mut client).await)
    }
}

/// Everything the host wrote on a pipe it has let go of.
async fn written(client: &mut DuplexStream) -> Vec<u8> {
    let mut bytes = Vec::new();
    client.read_to_end(&mut bytes).await.unwrap();
    bytes
}

/// The refusal's log text, or `None` when the device was let in.
fn refusal(admitted: &Admitted) -> Option<String> {
    match admitted {
        Ok(_) => None,
        Err(Some(refusal)) => Some(refusal.to_string()),
        Err(None) => Some("stopping".to_owned()),
    }
}

fn timed_out_at(refused: &Admitted) -> Option<Duration> {
    match refused {
        Err(Some(Refusal::TimedOut(deadline))) => Some(*deadline),
        _ => None,
    }
}

#[tokio::test(start_paused = true)]
async fn a_connection_that_says_nothing_is_refused_at_the_deadline() {
    let fx = fixture();
    let (_client, mut host) = duplex(PIPE);
    let mut shutdown = fx.shutdown.subscribe();

    let started = Instant::now();
    let refused = admit_within_deadline(&mut host, &fx.admission, &mut shutdown).await;

    assert_eq!(started.elapsed(), HANDSHAKE_DEADLINE);
    assert_eq!(timed_out_at(&refused), Some(HANDSHAKE_DEADLINE));
}

#[tokio::test(start_paused = true)]
async fn a_connection_that_stops_partway_through_its_first_message_is_refused_at_the_deadline() {
    let fx = fixture();
    let (mut client, mut host) = duplex(PIPE);
    client.write_all(&fx.first_message()[..40]).await.unwrap();
    let mut shutdown = fx.shutdown.subscribe();

    let started = Instant::now();
    let refused = admit_within_deadline(&mut host, &fx.admission, &mut shutdown).await;

    assert_eq!(started.elapsed(), HANDSHAKE_DEADLINE);
    assert_eq!(timed_out_at(&refused), Some(HANDSHAKE_DEADLINE));
}

#[tokio::test(start_paused = true)]
async fn a_device_that_finishes_just_inside_the_deadline_is_admitted() {
    let fx = fixture();
    let (mut client, mut host) = duplex(PIPE);
    let first = fx.first_message();
    let mut shutdown = fx.shutdown.subscribe();

    let send_late = async {
        tokio::time::sleep(HANDSHAKE_DEADLINE - Duration::from_millis(1)).await;
        client.write_all(&first).await.unwrap();
    };
    let (admitted, ()) = tokio::join!(
        admit_within_deadline(&mut host, &fx.admission, &mut shutdown),
        send_late
    );

    let admitted = admitted.unwrap_or_else(|_| panic!("the device was refused"));
    assert!(admitted.rest.is_empty());
}

#[test]
fn the_log_names_the_deadline_a_connection_ran_out_of() {
    assert_eq!(
        Refusal::TimedOut(Duration::from_millis(1500)).to_string(),
        "the handshake did not finish in time (1.5s)"
    );
}

#[test]
fn a_host_gives_the_real_deadlines_unless_a_test_build_finds_its_marker() {
    let dirs = TestDirs::new();
    assert_eq!(handshake_deadline(&dirs.data), HANDSHAKE_DEADLINE);
    assert_eq!(hello_deadline(&dirs.data), HELLO_DEADLINE);
    std::fs::write(dirs.data.join(TEST_HANDSHAKE_DEADLINE_MARKER), "250").unwrap();
    assert_eq!(handshake_deadline(&dirs.data), Duration::from_millis(250));
    assert_eq!(hello_deadline(&dirs.data), Duration::from_millis(250));
}

/// A device's handshake with the host, answered, on a pipe both ends keep
/// open: the host's side as it stands once its answer is written, and the
/// device's session.
struct Answered {
    host: DuplexStream,
    client: DuplexStream,
    /// Opens what the device sends, as the host's connection does.
    opener: Opener,
    decoder: FrameDecoder,
    device: PublicKey,
    /// The device's half of the session.
    transport: Transport,
}

impl Fixture {
    /// Runs `initiator`'s handshake, whose first message is `first`, to the
    /// host's answer, and finishes it on the device's side.
    async fn answered(&self, initiator: Initiator, first: &[u8]) -> Answered {
        let (mut client, mut host) = duplex(PIPE);
        client.write_all(first).await.unwrap();
        let mut shutdown = self.shutdown.subscribe();
        let admitted = admit_within_deadline(&mut host, &self.admission, &mut shutdown)
            .await
            .unwrap_or_else(|_| panic!("the device was refused"));
        let (_, opener) = admitted.transport.split();
        let mut decoder = FrameDecoder::new();
        decoder.push(&admitted.rest);
        let transport = finish_handshake(&mut client, initiator).await;
        Answered {
            host,
            client,
            opener,
            decoder,
            device: admitted.device,
            transport,
        }
    }

    /// Waits for `device`'s hello on `host` as the host's connection does,
    /// from now.
    async fn hello_from(
        &self,
        host: &mut DuplexStream,
        opener: &mut Opener,
        decoder: &mut FrameDecoder,
        device: PublicKey,
    ) -> Result<Hello, Option<Refusal>> {
        let mut shutdown = self.shutdown.subscribe();
        hello_within_deadline(
            host,
            opener,
            decoder,
            device,
            self.admission.hello_deadline,
            &mut shutdown,
        )
        .await
        .map(|first| match first {
            super::First::Hello(hello) => hello,
            super::First::RestartAsk(_) | super::First::Restart(_) => {
                panic!("a restart frame, not hello")
            }
        })
    }
}

/// Reads the host's answer on `client` until it finishes `initiator`'s
/// handshake: the device's session.
async fn finish_handshake(client: &mut DuplexStream, mut initiator: Initiator) -> Transport {
    let mut buf = vec![0; PIPE];
    loop {
        let n = client.read(&mut buf).await.unwrap();
        assert_ne!(n, 0, "the host closed the connection instead of answering");
        match initiator.push(&buf[..n]).expect("the host proves its key") {
            InitiatorStep::Done { transport, .. } => return transport,
            InitiatorStep::Pending(next) => initiator = next,
        }
    }
}

/// A client's `hello`, sealed under its session's keys.
fn sealed_hello(transport: &mut Transport) -> Vec<u8> {
    let hello = encode_frame(&Message::Hello(Hello {
        protocol: PROTOCOL_VERSION,
        client: ClientInfo {
            name: "a late client".to_owned(),
            kind: ClientKind::Tui,
            device_name: None,
        },
        capabilities: vec!["terminal".to_owned()],
    }))
    .unwrap();
    transport.seal(&hello).unwrap()
}

fn no_hello(device: &KeyPair, deadline: Duration) -> Option<String> {
    Some(format!(
        "device {} did not say hello in time ({deadline:?})",
        device.public().fingerprint()
    ))
}

#[tokio::test(start_paused = true)]
async fn a_device_that_says_no_hello_is_refused_at_the_hello_deadline_by_its_fingerprint() {
    let fx = fixture();
    let (initiator, first) = Initiator::start(&fx.device, &fx.host()).unwrap();
    let Answered {
        mut host,
        mut client,
        mut opener,
        mut decoder,
        device,
        ..
    } = fx.answered(initiator, &first).await;

    let answered_at = Instant::now();
    let refused = fx
        .hello_from(&mut host, &mut opener, &mut decoder, device)
        .await;

    assert_eq!(
        answered_at.elapsed(),
        HELLO_DEADLINE,
        "closed at the deadline, not before"
    );
    let line = refused
        .as_ref()
        .err()
        .and_then(|refusal| refusal.as_ref())
        .map(ToString::to_string);
    assert_eq!(line, no_hello(&fx.device, HELLO_DEADLINE));
    let line = line.unwrap();
    assert!(!line.contains(&fx.device.public().to_hex()), "{line}");
    drop(host);
    assert!(
        written(&mut client).await.is_empty(),
        "nothing written after the answer"
    );
}

#[tokio::test(start_paused = true)]
async fn a_hello_just_inside_the_hello_deadline_is_read() {
    let fx = fixture();
    let (initiator, first) = Initiator::start(&fx.device, &fx.host()).unwrap();
    let Answered {
        mut host,
        mut client,
        mut opener,
        mut decoder,
        device,
        mut transport,
    } = fx.answered(initiator, &first).await;

    let hello = sealed_hello(&mut transport);
    let say_late = async {
        tokio::time::sleep(HELLO_DEADLINE - Duration::from_millis(1)).await;
        client.write_all(&hello).await.unwrap();
    };
    let (heard, ()) = tokio::join!(
        fx.hello_from(&mut host, &mut opener, &mut decoder, device),
        say_late
    );

    let heard = heard.unwrap_or_else(|_| panic!("the hello in time was refused"));
    assert_eq!(heard.client.name, "a late client");
}

#[test]
fn the_log_names_the_device_that_said_no_hello_in_time_by_its_fingerprint() {
    let device = KeyPair::generate().unwrap();
    assert_eq!(
        Refusal::NoHello(device.public(), Duration::from_millis(1500)).to_string(),
        format!(
            "device {} did not say hello in time (1.5s)",
            device.public().fingerprint()
        )
    );
}

#[tokio::test]
async fn s1_a_device_key_the_host_has_never_seen_is_let_in_as_a_device_and_answered() {
    let fx = fixture();
    let (initiator, first) = Initiator::start(&fx.device, &fx.host()).unwrap();
    let (admitted, written) = fx.admit(&first).await;
    let admitted = admitted.unwrap_or_else(|_| panic!("a new device was refused"));
    assert_eq!(admitted.entry, Entry::Device);
    assert_eq!(admitted.device, fx.device.public());
    // The answer proves the host's key to the device.
    match initiator.push(&written).unwrap() {
        InitiatorStep::Done { transport, .. } => assert_eq!(transport.peer(), fx.host()),
        InitiatorStep::Pending(_) => panic!("the host's answer was not whole"),
    }

    // Any number of devices, each new to the host, the same way.
    for _ in 0..3 {
        let another = KeyPair::generate().unwrap();
        let (admitted, written) = fx
            .admit(&Initiator::start(&another, &fx.host()).unwrap().1)
            .await;
        assert_eq!(
            admitted
                .map(|admitted| (admitted.entry, admitted.device))
                .ok(),
            Some((Entry::Device, another.public()))
        );
        assert!(!written.is_empty());
    }
}

#[tokio::test]
async fn s3_a_client_holding_the_host_to_another_key_is_closed_without_a_byte_and_no_key_is_logged()
{
    let fx = fixture();
    let another_host = KeyPair::generate().unwrap();
    let (_, first) = Initiator::start(&fx.device, &another_host.public()).unwrap();
    let (admitted, written) = fx.admit(&first).await;
    assert!(written.is_empty(), "the host wrote {} bytes", written.len());
    let line = refusal(&admitted).expect("the client was let in");
    assert_eq!(
        line,
        "failed handshake: the first handshake message does not decrypt"
    );
    for key in [fx.device.public(), another_host.public(), fx.host()] {
        assert!(!line.contains(&key.to_hex()), "{line}");
        assert!(!line.contains(&key.fingerprint()), "{line}");
    }
}

#[tokio::test]
async fn s3_bytes_that_are_not_a_handshake_are_closed_without_a_byte() {
    let fx = fixture();
    // A length no first handshake message has.
    let (admitted, written) = fx.admit(&[0, 5, 1, 2, 3, 4, 5]).await;
    assert!(written.is_empty());
    assert!(refusal(&admitted).is_some_and(|line| line.starts_with("failed handshake")));
}

#[test]
fn a_device_is_named_by_the_device_name_its_hello_gives_else_its_clients_name() {
    let hello = |name: &str, device_name: Option<&str>| Hello {
        protocol: PROTOCOL_VERSION,
        client: ClientInfo {
            name: name.to_owned(),
            kind: ClientKind::Desktop,
            device_name: device_name.map(str::to_owned),
        },
        capabilities: Vec::new(),
    };
    assert_eq!(
        device_name(&hello("Floti desktop 3.0.0", Some("build-box"))),
        "build-box"
    );
    assert_eq!(
        device_name(&hello("Floti desktop 3.0.0", None)),
        "Floti desktop 3.0.0"
    );
    assert_eq!(
        device_name(&hello("Floti desktop 3.0.0", Some("  "))),
        "Floti desktop 3.0.0"
    );
    assert_eq!(
        device_name(&hello("x", Some("lap\u{1b}[2Jtop\n"))),
        "lap[2Jtop"
    );
}

// ---------------------------------------------------------------------------
// The host's own shell
// ---------------------------------------------------------------------------

fn identity() -> HostIdentity {
    HostIdentity {
        protocol: PROTOCOL_VERSION,
        host_version: "0.0.0".to_owned(),
        backends: Vec::new(),
    }
}

/// The next message the host sends on `client`, opened with the device's
/// half of the session; `None` once the host has closed the pipe.
async fn next_from_host(
    client: &mut DuplexStream,
    transport: &mut Transport,
    decoder: &mut FrameDecoder,
) -> Option<Message> {
    let mut buf = vec![0; PIPE];
    loop {
        if let Some(message) = decoder.next_message().unwrap() {
            return Some(message);
        }
        let n = client.read(&mut buf).await.unwrap();
        if n == 0 {
            return None;
        }
        decoder.push(&transport.open(&buf[..n]).unwrap());
    }
}

fn request(id: u64, channel: &str, payload: Payload) -> Message {
    Message::Request(Request {
        id,
        channel: channel.to_owned(),
        payload,
    })
}

/// A device's side of a connection the host let in, and the host's side
/// served on a task of its own.
struct Served {
    client: DuplexStream,
    transport: Transport,
    decoder: FrameDecoder,
    serving: tokio::task::JoinHandle<()>,
}

impl Served {
    async fn next(&mut self) -> Option<Message> {
        next_from_host(&mut self.client, &mut self.transport, &mut self.decoder).await
    }

    async fn send(&mut self, message: &Message) {
        let sealed = self
            .transport
            .seal(&encode_frame(message).unwrap())
            .unwrap();
        self.client.write_all(&sealed).await.unwrap();
    }
}

impl Fixture {
    /// Runs `initiator`'s handshake for `device`, which must be let in as
    /// `entry`, says hello, and serves the host's side as that.
    async fn served(
        &self,
        device: &KeyPair,
        initiator: Initiator,
        first: &[u8],
        entry: Entry,
    ) -> Served {
        let (mut client, mut host) = duplex(PIPE);
        client.write_all(first).await.unwrap();
        let mut shutdown = self.shutdown.subscribe();
        let admitted = admit_within_deadline(&mut host, &self.admission, &mut shutdown)
            .await
            .unwrap_or_else(|_| panic!("the device was refused"));
        assert_eq!(admitted.entry, entry);
        assert_eq!(admitted.device, device.public());
        let mut transport = finish_handshake(&mut client, initiator).await;
        client
            .write_all(&sealed_hello(&mut transport))
            .await
            .unwrap();
        let sealed = Sealed::new(host, admitted.transport, &admitted.rest).unwrap();
        let admission = self.admission.clone();
        let key = device.public();
        let stopper = self.stopper.clone();
        assert_eq!(entry, Entry::Shell, "a client is served by its connection");
        let serving = tokio::spawn(async move {
            let identity = identity();
            let serving = (&identity, &admission, &mut shutdown);
            let sessions = || Ok(Vec::new());
            let control = ShellControl {
                sessions: &sessions,
                stopper: &stopper,
            };
            serve_shell(sealed, ClientId(1), key, serving, control).await;
        });
        Served {
            client,
            transport,
            decoder: FrameDecoder::new(),
            serving,
        }
    }
}

#[tokio::test]
async fn the_shell_is_let_in_only_for_the_hosts_own_key() {
    let fx = fixture();
    let host_key = &*fx.admission.host_key;
    let (admitted, written) = fx
        .admit(&Initiator::start(host_key, &fx.host()).unwrap().1)
        .await;
    assert_eq!(
        admitted.map(|admitted| admitted.entry).ok(),
        Some(Entry::Shell)
    );
    assert!(!written.is_empty());
    let (admitted, _) = fx.admit(&fx.first_message()).await;
    assert_eq!(
        admitted.map(|admitted| admitted.entry).ok(),
        Some(Entry::Device)
    );
}

#[tokio::test]
async fn the_shell_is_served_the_session_list_and_host_stop_and_nothing_else() {
    let fx = fixture();
    let host_key = &*fx.admission.host_key;
    let (initiator, first) = Initiator::start(host_key, &fx.host()).unwrap();
    let mut shell = fx.served(host_key, initiator, &first, Entry::Shell).await;
    assert!(matches!(shell.next().await, Some(Message::Welcome(_))));

    for (id, channel) in [
        (1, "session:start"),
        (2, "devices:attached"),
        (3, "devices:list"),
    ] {
        shell
            .send(&request(id, channel, to_payload(&()).unwrap()))
            .await;
        match shell.next().await {
            Some(Message::Error(error)) => {
                assert_eq!((error.id, error.code), (id, ErrorCode::Unavailable));
            }
            other => panic!("the shell was served {channel}: {other:?}"),
        }
    }
    drop(shell.client);
    shell.serving.await.unwrap();
}

#[tokio::test]
async fn the_shell_lists_the_sessions_and_stops_the_host_for_an_update_once_answered() {
    let mut fx = fixture();
    let host_key = &*fx.admission.host_key;
    let (initiator, first) = Initiator::start(host_key, &fx.host()).unwrap();
    let mut shell = fx.served(host_key, initiator, &first, Entry::Shell).await;
    assert!(matches!(shell.next().await, Some(Message::Welcome(_))));

    shell
        .send(&request(1, SessionList::NAME, to_payload(&()).unwrap()))
        .await;
    let Some(Message::Response(listed)) = shell.next().await else {
        panic!("the shell's session list was not answered");
    };
    let sessions: Vec<SessionRecord> = from_payload(&listed.payload).unwrap();
    assert!(sessions.is_empty());
    assert_eq!(*fx.stop_asked.borrow(), None, "listing stops nothing");

    let stop = HostStopRequest {
        reason: HostStopReason::Update,
    };
    shell
        .send(&request(2, HostStop::NAME, to_payload(&stop).unwrap()))
        .await;
    assert!(matches!(shell.next().await, Some(Message::Response(_))));
    fx.stop_asked.changed().await.unwrap();
    assert_eq!(*fx.stop_asked.borrow(), Some(HostStopReason::Update));
    drop(shell.client);
    shell.serving.await.unwrap();
}
