//! The handshake's admission, over in-memory pipes.
//!
//! The deadline, on tokio's paused clock: a connection that says nothing, or
//! stops partway through its first message, is refused at the deadline
//! exactly, and one that finishes just inside it is admitted. The
//! integration test (`tests/noise_sessions.rs`) shows the same refusals logged
//! by the executable while another client is served, on a short deadline.
//!
//! Enrolment: while no admin exists, a new device carrying the host's code
//! is paired as the first admin and answered, once; every other device
//! carrying a code is refused as it would be without one, before a byte.

use std::sync::Arc;
use std::time::Duration;

use floti_protocol::noise::{
    EnrolmentCode, Initiator, InitiatorStep, KeyPair, PublicKey, Transport,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, duplex};
use tokio::sync::watch;
use tokio::time::Instant;

use super::{Admission, Refusal, admit_within_deadline};
use crate::devices::{DeviceRegistry, Role, Standing};
use crate::server::enrolment::{Enrolment, FIRST_ADMIN_NAME, read_enrolment};
use crate::server::{
    ENROLMENT_FILE, HANDSHAKE_DEADLINE, TEST_HANDSHAKE_DEADLINE_MARKER, handshake_deadline,
};
use crate::testkit::TestDirs;

/// Room for both handshake messages and more.
const PIPE: usize = 64 * 1024;

type Admitted = Result<(Transport, Vec<u8>), Option<Refusal>>;

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

fn timed_out_at(
    refused: &Result<(floti_protocol::noise::Transport, Vec<u8>), Option<Refusal>>,
) -> Option<Duration> {
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

    let (_, rest) = admitted.unwrap_or_else(|_| panic!("the device was refused"));
    assert!(rest.is_empty());
}

#[test]
fn the_log_names_the_deadline_a_connection_ran_out_of() {
    assert_eq!(
        Refusal::TimedOut(Duration::from_millis(1500)).to_string(),
        "the handshake did not finish in time (1.5s)"
    );
}

#[test]
fn a_host_gives_the_real_deadline_unless_a_test_build_finds_its_marker() {
    let dirs = TestDirs::new();
    assert_eq!(handshake_deadline(&dirs.data), HANDSHAKE_DEADLINE);
    std::fs::write(dirs.data.join(TEST_HANDSHAKE_DEADLINE_MARKER), "250").unwrap();
    assert_eq!(handshake_deadline(&dirs.data), Duration::from_millis(250));
}

#[tokio::test]
async fn s3_a_new_device_with_the_right_code_is_paired_as_the_first_admin_then_answered() {
    let fx = waiting_fixture();
    let desk = KeyPair::generate().unwrap();
    let (initiator, first) = enrolling(&desk, &fx.host(), &fx.code());

    let (admitted, answer) = fx.admit(&first).await;

    assert_eq!(refusal(&admitted), None);
    match initiator.push(&answer).expect("the host proves its key") {
        InitiatorStep::Done { transport, .. } => assert_eq!(transport.peer(), fx.host()),
        InitiatorStep::Pending(_) => panic!("the host's answer did not finish the handshake"),
    }
    let devices = fx.admission.devices.devices().unwrap();
    let enrolled = devices.iter().find(|device| device.key == desk.public());
    let enrolled = enrolled.expect("the device is in the registry");
    assert_eq!(enrolled.role, Role::Admin);
    assert_eq!(enrolled.name, FIRST_ADMIN_NAME);
    assert!(!fx.admission.enrolment.waiting());
    assert!(!fx.dirs.data.join(ENROLMENT_FILE).exists());
}

#[tokio::test]
async fn s4_a_used_code_from_another_device_is_refused_unanswered_and_the_admin_comes_back_pinned()
{
    let fx = waiting_fixture();
    let code = fx.code();
    let desk = KeyPair::generate().unwrap();
    let (admitted, _) = fx.admit(&enrolling(&desk, &fx.host(), &code).1).await;
    assert_eq!(refusal(&admitted), None);

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
    assert_eq!(refusal(&admitted), None);
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
    assert_eq!(fx.role_of(&fx.device.public()), Some(Role::Operator));
    assert!(fx.admission.enrolment.waiting());
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
    assert_eq!(fx.role_of(&enrolled.public()), Some(Role::Admin));
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
