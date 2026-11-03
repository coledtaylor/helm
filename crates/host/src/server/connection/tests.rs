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
//! comes just inside it is read. A new device cut off there pairs nothing
//! and the next device enrols with the code.
//!
//! Enrolment: while no admin exists, a new device carrying the host's code
//! is answered, once, and paired as the first admin at its `hello`; every
//! other device carrying a code is refused as it would be without one,
//! before a byte. A device that goes before its `hello`, or whose answer is
//! never written, pairs nothing and leaves the code to enrol with.

use std::sync::Arc;
use std::time::Duration;

use floti_protocol::message::{ClientInfo, ClientKind, Hello};
use floti_protocol::noise::{
    EnrolmentCode, Initiator, InitiatorStep, KeyPair, Opener, PublicKey, Transport,
};
use floti_protocol::{FrameDecoder, Message, PROTOCOL_VERSION, encode_frame};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, duplex};
use tokio::sync::watch;
use tokio::time::Instant;

use super::{Admission, Refusal, admit_within_deadline, hello_within_deadline};
use crate::devices::{DeviceRegistry, Role, Standing};
use crate::server::enrolment::{Claim, Enrolment, FIRST_ADMIN_NAME, read_enrolment};
use crate::server::{
    ENROLMENT_FILE, HANDSHAKE_DEADLINE, HELLO_DEADLINE, TEST_HANDSHAKE_DEADLINE_MARKER,
    handshake_deadline, hello_deadline,
};
use crate::testkit::TestDirs;

/// Room for both handshake messages and more.
const PIPE: usize = 64 * 1024;

type Admitted = Result<super::Admitted, Option<Refusal>>;

struct Fixture {
    admission: Admission,
    /// A device paired in the admission's registry: the admin, or, while the
    /// host waits for its first admin, an operator.
    device: KeyPair,
    /// Held so the shutdown never fires: a dropped sender would end the
    /// handshake as a stopping host does.
    shutdown: watch::Sender<bool>,
    /// Last: fields drop in order, and the folder goes only once nothing in it is open.
    dirs: TestDirs,
}

/// A host whose paired device is its admin: it holds no code.
fn fixture() -> Fixture {
    fixture_with(Role::Admin)
}

/// A host waiting for its first admin, with an operator paired.
fn waiting_fixture() -> Fixture {
    let fx = fixture_with(Role::Operator);
    assert!(fx.admission.enrolment.waiting());
    fx
}

fn fixture_with(role: Role) -> Fixture {
    let dirs = TestDirs::new();
    let devices = Arc::new(DeviceRegistry::in_data_folder(&dirs.data));
    let device = KeyPair::generate().unwrap();
    devices.pair(device.public(), "a laptop", role).unwrap();
    let host_key = Arc::new(KeyPair::generate().unwrap());
    let enrolment = Arc::new(Enrolment::prepare(&dirs.data, host_key.public(), &devices));
    Fixture {
        admission: Admission {
            host_key,
            devices,
            enrolment,
            deadline: HANDSHAKE_DEADLINE,
            hello_deadline: HELLO_DEADLINE,
        },
        device,
        shutdown: watch::channel(false).0,
        dirs,
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

    /// The code in the host's enrolment file.
    fn code(&self) -> EnrolmentCode {
        read_enrolment(&self.dirs.data)
            .unwrap()
            .expect("the host is waiting for its first admin")
            .code
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

    fn role_of(&self, key: &PublicKey) -> Option<Role> {
        self.admission
            .devices
            .devices()
            .unwrap()
            .into_iter()
            .find(|device| device.key == *key)
            .map(|device| device.role)
    }
}

/// Everything the host wrote on a pipe it has let go of.
async fn written(client: &mut DuplexStream) -> Vec<u8> {
    let mut bytes = Vec::new();
    client.read_to_end(&mut bytes).await.unwrap();
    bytes
}

fn enrolling(device: &KeyPair, host: &PublicKey, code: &EnrolmentCode) -> (Initiator, Vec<u8>) {
    Initiator::start_enrolling(device, host, code).expect("start an enrolling handshake")
}

/// What the device's `hello` does for a new device the handshake let in:
/// pairs it as the first admin, with the role it was given.
fn say_hello(admitted: Admitted) -> Option<Role> {
    let admitted = admitted.unwrap_or_else(|_| panic!("the device was refused"));
    let claim = admitted.enrolling.expect("the device holds the code");
    claim.commit().unwrap().map(|device| device.role)
}

/// The refusal's log text, or `None` when the device was let in.
fn refusal(admitted: &Admitted) -> Option<String> {
    match admitted {
        Ok(_) => None,
        Err(Some(refusal)) => Some(refusal.to_string()),
        Err(None) => Some("stopping".to_owned()),
    }
}

fn unknown(key: &KeyPair) -> Option<String> {
    Some(format!("unknown device {}", key.public().fingerprint()))
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
async fn a_paired_device_that_finishes_just_inside_the_deadline_is_admitted() {
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
    /// The code the device holds while the host waits for its `hello`.
    enrolling: Option<Claim>,
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
            enrolling: admitted.enrolling,
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
async fn s1_s4_a_paired_device_that_says_no_hello_is_refused_at_the_hello_deadline_by_its_fingerprint()
 {
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
async fn s3_a_hello_just_inside_the_hello_deadline_is_read_and_an_enrolling_device_is_paired_as_the_first_admin()
 {
    let fx = waiting_fixture();
    let desk = KeyPair::generate().unwrap();
    let (initiator, first) = enrolling(&desk, &fx.host(), &fx.code());
    let Answered {
        mut host,
        mut client,
        mut opener,
        mut decoder,
        device,
        enrolling,
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
    let claim = enrolling.expect("the device holds the code");
    assert_eq!(
        claim.commit().unwrap().map(|paired| paired.role),
        Some(Role::Admin)
    );
    assert_eq!(fx.role_of(&desk.public()), Some(Role::Admin));
    assert!(!fx.admission.enrolment.waiting());
}

#[tokio::test(start_paused = true)]
async fn s2_a_new_device_that_says_no_hello_in_time_pairs_nothing_and_another_device_enrols_with_the_code()
 {
    let fx = waiting_fixture();
    let code = fx.code();
    let desk = KeyPair::generate().unwrap();
    let (initiator, first) = enrolling(&desk, &fx.host(), &code);
    let answered = fx.answered(initiator, &first).await;
    let Answered {
        mut host,
        mut opener,
        mut decoder,
        device,
        enrolling,
        ..
    } = answered;

    // While it waits it holds the code: another device is refused.
    let laptop = KeyPair::generate().unwrap();
    let (admitted, _) = fx.admit(&enrolling_first(&laptop, &fx.host(), &code)).await;
    assert_eq!(refusal(&admitted), unknown(&laptop));

    let refused = fx
        .hello_from(&mut host, &mut opener, &mut decoder, device)
        .await;
    assert_eq!(
        refused.err().flatten().map(|refusal| refusal.to_string()),
        no_hello(&desk, HELLO_DEADLINE)
    );
    // The connection ends with the wait, and lets go of the code.
    drop(enrolling);
    drop(host);

    assert_eq!(fx.role_of(&desk.public()), None);
    assert!(fx.admission.enrolment.waiting());
    assert!(fx.dirs.data.join(ENROLMENT_FILE).exists());
    assert!(fx.code().matches(&code));
    let (admitted, _) = fx.admit(&enrolling_first(&laptop, &fx.host(), &code)).await;
    assert_eq!(say_hello(admitted), Some(Role::Admin));
    assert_eq!(fx.role_of(&laptop.public()), Some(Role::Admin));
}

fn enrolling_first(device: &KeyPair, host: &PublicKey, code: &EnrolmentCode) -> Vec<u8> {
    enrolling(device, host, code).1
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
async fn s3_a_new_device_with_the_right_code_is_answered_and_paired_as_the_first_admin_at_its_hello()
 {
    let fx = waiting_fixture();
    let desk = KeyPair::generate().unwrap();
    let (initiator, first) = enrolling(&desk, &fx.host(), &fx.code());

    let (admitted, answer) = fx.admit(&first).await;

    assert_eq!(refusal(&admitted), None);
    match initiator.push(&answer).expect("the host proves its key") {
        InitiatorStep::Done { transport, .. } => assert_eq!(transport.peer(), fx.host()),
        InitiatorStep::Pending(_) => panic!("the host's answer did not finish the handshake"),
    }
    assert_eq!(fx.role_of(&desk.public()), None, "paired before its hello");
    assert_eq!(
        admitted.as_ref().map(|admitted| admitted.role).ok(),
        Some(Role::Admin),
        "its requests are an admin's"
    );
    assert_eq!(say_hello(admitted), Some(Role::Admin));
    let devices = fx.admission.devices.devices().unwrap();
    let enrolled = devices.iter().find(|device| device.key == desk.public());
    let enrolled = enrolled.expect("the device is in the registry");
    assert_eq!(enrolled.role, Role::Admin);
    assert_eq!(enrolled.name, FIRST_ADMIN_NAME);
    assert!(!fx.admission.enrolment.waiting());
    assert!(!fx.dirs.data.join(ENROLMENT_FILE).exists());
}

#[tokio::test]
async fn a_new_device_gone_before_its_hello_pairs_nothing_and_the_code_stays_for_it_to_enrol_again()
{
    let fx = waiting_fixture();
    let code = fx.code();
    let desk = KeyPair::generate().unwrap();

    let (admitted, answer) = fx.admit(&enrolling(&desk, &fx.host(), &code).1).await;
    assert_eq!(refusal(&admitted), None);
    assert!(!answer.is_empty());
    // The device goes without a hello, and its connection with it.
    drop(admitted);

    assert_eq!(fx.role_of(&desk.public()), None);
    assert!(fx.admission.enrolment.waiting());
    assert!(fx.code().matches(&code));
    let (admitted, _) = fx.admit(&enrolling(&desk, &fx.host(), &code).1).await;
    assert_eq!(say_hello(admitted), Some(Role::Admin));
}

#[tokio::test]
async fn a_new_device_whose_answer_cannot_be_written_pairs_nothing_and_the_code_is_kept() {
    let fx = waiting_fixture();
    let code = fx.code();
    let desk = KeyPair::generate().unwrap();
    let (mut client, mut host) = duplex(PIPE);
    client
        .write_all(&enrolling(&desk, &fx.host(), &code).1)
        .await
        .unwrap();
    // The device vanishes once its first message is on the way.
    drop(client);
    let mut shutdown = fx.shutdown.subscribe();

    let admitted = admit_within_deadline(&mut host, &fx.admission, &mut shutdown).await;

    assert!(matches!(admitted, Err(Some(Refusal::ReadFailed(_)))));
    assert_eq!(fx.role_of(&desk.public()), None);
    assert!(fx.admission.enrolment.waiting());
    assert!(fx.dirs.data.join(ENROLMENT_FILE).exists());
    let (admitted, _) = fx.admit(&enrolling(&desk, &fx.host(), &code).1).await;
    assert_eq!(say_hello(admitted), Some(Role::Admin));
}

#[tokio::test(start_paused = true)]
async fn a_new_device_cut_off_at_the_deadline_while_answered_pairs_nothing_and_the_code_is_kept() {
    let fx = waiting_fixture();
    let code = fx.code();
    let desk = KeyPair::generate().unwrap();
    // Smaller than the host's answer: the host's write waits on a device
    // that sent its first message and reads nothing.
    let (mut client, mut host) = duplex(16);
    let first = enrolling(&desk, &fx.host(), &code).1;
    let mut shutdown = fx.shutdown.subscribe();

    let (admitted, ()) = tokio::join!(
        admit_within_deadline(&mut host, &fx.admission, &mut shutdown),
        async { client.write_all(&first).await.unwrap() }
    );

    assert_eq!(timed_out_at(&admitted), Some(HANDSHAKE_DEADLINE));
    assert_eq!(fx.role_of(&desk.public()), None);
    assert!(fx.admission.enrolment.waiting());
    let (admitted, _) = fx.admit(&enrolling(&desk, &fx.host(), &code).1).await;
    assert_eq!(say_hello(admitted), Some(Role::Admin));
}

#[tokio::test]
async fn s4_a_used_code_from_another_device_is_refused_unanswered_and_the_admin_comes_back_pinned()
{
    let fx = waiting_fixture();
    let code = fx.code();
    let desk = KeyPair::generate().unwrap();
    let (admitted, _) = fx.admit(&enrolling(&desk, &fx.host(), &code).1).await;
    assert_eq!(say_hello(admitted), Some(Role::Admin));

    let other = KeyPair::generate().unwrap();
    let (admitted, written) = fx.admit(&enrolling(&other, &fx.host(), &code).1).await;
    assert_eq!(refusal(&admitted), unknown(&other));
    assert!(written.is_empty());
    assert_eq!(fx.role_of(&other.public()), None);

    let again = Initiator::start(&desk, &fx.host()).unwrap().1;
    let (admitted, written) = fx.admit(&again).await;
    assert_eq!(refusal(&admitted), None);
    assert!(!written.is_empty());
}

#[tokio::test]
async fn s5_a_wrong_code_or_none_is_refused_as_unknown_and_the_code_is_kept_for_the_right_client() {
    let fx = waiting_fixture();
    let code = fx.code();

    let guesser = KeyPair::generate().unwrap();
    let wrong = EnrolmentCode::generate().unwrap();
    let (admitted, written) = fx.admit(&enrolling(&guesser, &fx.host(), &wrong).1).await;
    assert_eq!(refusal(&admitted), unknown(&guesser));
    assert!(written.is_empty());

    let silent = KeyPair::generate().unwrap();
    let (admitted, written) = fx
        .admit(&Initiator::start(&silent, &fx.host()).unwrap().1)
        .await;
    assert_eq!(refusal(&admitted), unknown(&silent));
    assert!(written.is_empty());

    // The paired operator is served all along.
    let (admitted, _) = fx.admit(&fx.first_message()).await;
    assert_eq!(refusal(&admitted), None);

    assert!(fx.admission.enrolment.waiting());
    assert!(fx.dirs.data.join(ENROLMENT_FILE).exists());
    let desk = KeyPair::generate().unwrap();
    let (admitted, _) = fx.admit(&enrolling(&desk, &fx.host(), &code).1).await;
    assert_eq!(say_hello(admitted), Some(Role::Admin));
    assert_eq!(fx.role_of(&desk.public()), Some(Role::Admin));
}

#[tokio::test]
async fn s5_a_revoked_device_with_the_right_code_is_refused_as_revoked_and_the_code_is_kept() {
    let fx = waiting_fixture();
    let code = fx.code();
    let lost = KeyPair::generate().unwrap();
    fx.admission
        .devices
        .pair(lost.public(), "a lost phone", Role::Operator)
        .unwrap();
    fx.admission.devices.revoke(&lost.public()).unwrap();

    let (admitted, written) = fx.admit(&enrolling(&lost, &fx.host(), &code).1).await;
    assert_eq!(
        refusal(&admitted),
        Some(format!("revoked device {}", lost.public().fingerprint()))
    );
    assert!(written.is_empty());
    assert_eq!(
        fx.admission.devices.standing(&lost.public()).unwrap(),
        Standing::Revoked
    );
    assert!(fx.admission.enrolment.waiting());
    assert!(fx.dirs.data.join(ENROLMENT_FILE).exists());
}

#[tokio::test]
async fn a_paired_device_carrying_the_code_is_let_in_on_its_pairing_and_the_code_is_kept() {
    let fx = waiting_fixture();
    let (admitted, _) = fx
        .admit(&enrolling(&fx.device, &fx.host(), &fx.code()).1)
        .await;
    assert_eq!(refusal(&admitted), None);
    assert!(
        admitted
            .is_ok_and(|admitted| admitted.enrolling.is_none() && admitted.role == Role::Operator),
        "it is let in as the operator it is paired as"
    );
    assert_eq!(fx.role_of(&fx.device.public()), Some(Role::Operator));
    assert!(fx.admission.enrolment.waiting());
}

#[tokio::test]
async fn a_paired_device_is_let_in_with_the_role_it_is_paired_with() {
    for role in [Role::Viewer, Role::Operator, Role::Admin] {
        let fx = fixture_with(role);
        let (admitted, _) = fx.admit(&fx.first_message()).await;
        assert_eq!(
            admitted.map(|admitted| admitted.role).ok(),
            Some(role),
            "{role:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn s6_of_two_new_devices_with_the_right_code_at_once_exactly_one_is_enrolled() {
    let fx = waiting_fixture();
    let code = fx.code();
    let (one, two) = (KeyPair::generate().unwrap(), KeyPair::generate().unwrap());
    let (first_one, first_two) = (
        enrolling(&one, &fx.host(), &code).1,
        enrolling(&two, &fx.host(), &code).1,
    );

    let ((admitted_one, written_one), (admitted_two, written_two)) =
        tokio::join!(fx.admit(&first_one), fx.admit(&first_two));

    let outcomes = [
        (refusal(&admitted_one), written_one, &one),
        (refusal(&admitted_two), written_two, &two),
    ];
    let let_in: Vec<_> = outcomes.iter().filter(|(r, _, _)| r.is_none()).collect();
    assert_eq!(let_in.len(), 1, "exactly one is enrolled");
    let (_, _, enrolled) = let_in[0];
    let enrolled = enrolled.public();
    let winner = if admitted_one.is_ok() {
        admitted_one
    } else {
        admitted_two
    };
    assert_eq!(say_hello(winner), Some(Role::Admin));
    assert_eq!(fx.role_of(&enrolled), Some(Role::Admin));
    let (refused, written, other) = outcomes
        .iter()
        .find(|(r, _, _)| r.is_some())
        .expect("the other is refused");
    assert_eq!(*refused, unknown(other));
    assert!(written.is_empty());
    assert_eq!(fx.role_of(&other.public()), None);
}

#[tokio::test]
async fn s8_a_host_with_an_admin_enrols_no_device_by_any_code() {
    let fx = fixture();
    assert!(!fx.admission.enrolment.waiting());
    assert!(!fx.dirs.data.join(ENROLMENT_FILE).exists());
    let stranger = KeyPair::generate().unwrap();
    let code = EnrolmentCode::generate().unwrap();
    let (admitted, written) = fx.admit(&enrolling(&stranger, &fx.host(), &code).1).await;
    assert_eq!(refusal(&admitted), unknown(&stranger));
    assert!(written.is_empty());
    assert_eq!(fx.role_of(&stranger.public()), None);
}

#[tokio::test]
async fn s7_a_code_from_before_a_restart_is_refused_as_unknown() {
    let fx = waiting_fixture();
    let old = fx.code();
    // The host starts again on the same folder, before anyone enrolled.
    let restarted = Admission {
        enrolment: Arc::new(Enrolment::prepare(
            &fx.dirs.data,
            fx.host(),
            &fx.admission.devices,
        )),
        ..fx.admission.clone()
    };
    assert!(!fx.code().matches(&old));

    let (mut client, mut host) = duplex(PIPE);
    let device = KeyPair::generate().unwrap();
    client
        .write_all(&enrolling(&device, &fx.host(), &old).1)
        .await
        .unwrap();
    let mut shutdown = fx.shutdown.subscribe();
    let admitted = admit_within_deadline(&mut host, &restarted, &mut shutdown).await;
    drop(host);
    assert_eq!(refusal(&admitted), unknown(&device));
    assert!(written(&mut client).await.is_empty());
    assert!(restarted.enrolment.waiting());
}
