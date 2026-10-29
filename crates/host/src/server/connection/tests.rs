//! The handshake's deadline, on tokio's paused clock: a connection that says
//! nothing, or stops partway through its first message, is refused at the
//! deadline exactly, and one that finishes just inside it is admitted. The
//! integration test (`tests/noise_sessions.rs`) shows the same refusals logged
//! by the executable while another client is served, on a short deadline.

use std::sync::Arc;
use std::time::Duration;

use floti_protocol::noise::{Initiator, KeyPair};
use tokio::io::{AsyncWriteExt, duplex};
use tokio::sync::watch;
use tokio::time::Instant;

use super::{Admission, Refusal, admit_within_deadline};
use crate::devices::DeviceRegistry;
use crate::server::{HANDSHAKE_DEADLINE, TEST_HANDSHAKE_DEADLINE_MARKER, handshake_deadline};
use crate::testkit::TestDirs;

/// Room for both handshake messages and more.
const PIPE: usize = 64 * 1024;

struct Fixture {
    admission: Admission,
    /// A device paired in the admission's registry.
    device: KeyPair,
    /// Held so the shutdown never fires: a dropped sender would end the
    /// handshake as a stopping host does.
    shutdown: watch::Sender<bool>,
    /// Last: fields drop in order, and the folder goes only once nothing in it is open.
    _dirs: TestDirs,
}

fn fixture() -> Fixture {
    let dirs = TestDirs::new();
    let devices = Arc::new(DeviceRegistry::in_data_folder(&dirs.data));
    let device = KeyPair::generate().unwrap();
    devices.pair(device.public(), "a laptop").unwrap();
    Fixture {
        admission: Admission {
            host_key: Arc::new(KeyPair::generate().unwrap()),
            devices,
            deadline: HANDSHAKE_DEADLINE,
        },
        device,
        shutdown: watch::channel(false).0,
        _dirs: dirs,
    }
}

impl Fixture {
    fn first_message(&self) -> Vec<u8> {
        Initiator::start(&self.device, &self.admission.host_key.public())
            .expect("start a handshake")
            .1
    }
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
