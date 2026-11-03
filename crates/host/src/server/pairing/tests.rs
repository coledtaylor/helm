//! Requests to pair, on tokio's paused clock: codes, expiry at exactly
//! [`PAIRING_LIFETIME`], approval, withdrawal and the cap.

use std::sync::Arc;
use std::time::Duration;

use floti_protocol::channels::devices::{
    AuditActor, AuditDevice, AuditEvent, AuditQuery, DeviceRole, PairingEnd,
};
use floti_protocol::message::ClientKind;
use floti_protocol::noise::{
    KeyPair, PAIRING_CODE_ALPHABET, PAIRING_CODE_LEN, PairingCode, PublicKey,
};

use super::{Full, MAX_WAITING, Outcome, PAIRING_LIFETIME, Pairing};
use crate::devices::{DeviceRegistry, Role, Standing};
use crate::server::audit::AuditLog;
use crate::server::clock::TEST_HOST_CLOCK_MARKER;
use crate::testkit::TestDirs;

/// Who approves in these tests: the shell on the host's computer.
const SHELL: AuditActor = AuditActor::HostShell;

struct Fixture {
    pairing: Arc<Pairing>,
    devices: Arc<DeviceRegistry>,
    audit: Arc<AuditLog>,
    /// Last: the folder goes once nothing in it is open.
    dirs: TestDirs,
}

fn fixture() -> Fixture {
    let dirs = TestDirs::new();
    let devices = Arc::new(DeviceRegistry::in_data_folder(&dirs.data));
    let audit = Arc::new(AuditLog::in_data_folder(&dirs.data));
    let pairing = Arc::new(Pairing::new(
        &dirs.data,
        Arc::clone(&devices),
        Arc::clone(&audit),
    ));
    Fixture {
        pairing,
        devices,
        audit,
        dirs,
    }
}

fn key() -> PublicKey {
    KeyPair::generate().unwrap().public()
}

impl Fixture {
    fn ask(&self, key: PublicKey, name: &str) -> super::Waiting {
        self.pairing
            .ask(key, name, ClientKind::Phone, false)
            .expect("the request is taken")
    }

    /// The audit log's entries, oldest first.
    fn recorded(&self) -> Vec<AuditEvent> {
        let mut events: Vec<_> = self
            .audit
            .page(&AuditQuery::default())
            .unwrap()
            .entries
            .into_iter()
            .map(|entry| entry.event)
            .collect();
        events.reverse();
        events
    }

    fn standing(&self, key: &PublicKey) -> Standing {
        self.devices.standing(key).unwrap()
    }
}

/// Whether `waiting` has an outcome yet, without waiting for one.
async fn settled(waiting: &mut super::Waiting) -> Option<Option<Outcome>> {
    tokio::select! {
        biased;
        outcome = waiting.outcome() => Some(outcome),
        () = std::future::ready(()) => None,
    }
}

#[tokio::test(start_paused = true)]
async fn s1_a_request_is_answered_with_an_eight_character_code_from_the_alphabet_without_lookalikes()
 {
    let fx = fixture();
    let waiting = fx.ask(key(), "a phone");
    let code = waiting.code();
    assert_eq!(code.as_str().len(), PAIRING_CODE_LEN);
    assert!(
        code.as_str()
            .bytes()
            .all(|byte| PAIRING_CODE_ALPHABET.contains(&byte))
    );
    for lookalike in "01ILOU".chars() {
        assert!(!code.as_str().contains(lookalike));
    }
    assert_eq!(waiting.seconds_left(), PAIRING_LIFETIME.as_secs());
}

#[tokio::test(start_paused = true)]
async fn a_code_already_waiting_is_never_given_to_a_second_request() {
    let fx = fixture();
    let taken: PairingCode = "ABCD2345".parse().unwrap();
    let other: PairingCode = "WXYZ6789".parse().unwrap();
    let first = fx
        .pairing
        .ask_with(key(), "a phone", ClientKind::Phone, false, || taken)
        .unwrap();
    let mut draws = [taken, taken, other].into_iter();
    let second = fx
        .pairing
        .ask_with(key(), "a laptop", ClientKind::Desktop, false, || {
            draws.next().unwrap()
        })
        .unwrap();
    assert!(first.code().matches(&taken));
    assert!(second.code().matches(&other));
}

#[tokio::test(start_paused = true)]
async fn s9_a_request_expires_at_exactly_ten_minutes_and_not_a_tick_before() {
    let fx = fixture();
    let device = key();
    let mut waiting = fx.ask(device, "a phone");
    let code = waiting.code();

    tokio::time::advance(PAIRING_LIFETIME - Duration::from_millis(1)).await;
    assert_eq!(settled(&mut waiting).await, None, "still waiting");
    assert_eq!(fx.pairing.list().len(), 1);
    assert_eq!(fx.pairing.list()[0].seconds_left, 1);

    tokio::time::advance(Duration::from_millis(1)).await;
    assert_eq!(waiting.outcome().await, Some(Outcome::Expired));
    assert!(fx.pairing.list().is_empty());
    assert!(
        fx.pairing
            .approve(code.as_str(), Role::Operator, &SHELL, false)
            .is_err()
    );
    assert_eq!(fx.standing(&device), Standing::Unknown);
}

#[tokio::test(start_paused = true)]
async fn s9_just_short_of_ten_minutes_a_request_still_waits_and_is_approved() {
    let fx = fixture();
    let device = key();
    let mut waiting = fx.ask(device, "a phone");
    tokio::time::advance(PAIRING_LIFETIME - Duration::from_millis(1)).await;

    let paired = fx
        .pairing
        .approve(waiting.code().as_str(), Role::Operator, &SHELL, false)
        .unwrap();
    assert_eq!(paired.key, device);
    assert_eq!(
        waiting.outcome().await,
        Some(Outcome::Approved(Role::Operator))
    );
}

#[tokio::test(start_paused = true)]
async fn s9_a_request_read_after_its_time_is_dropped_and_its_connection_told() {
    let fx = fixture();
    let mut waiting = fx.ask(key(), "a phone");
    // The test build's clock marker moves the host's clock, not tokio's.
    std::fs::write(
        fx.dirs.data.join(TEST_HOST_CLOCK_MARKER),
        PAIRING_LIFETIME.as_millis().to_string(),
    )
    .unwrap();

    assert!(fx.pairing.list().is_empty());
    assert_eq!(waiting.outcome().await, Some(Outcome::Expired));
}

#[tokio::test(start_paused = true)]
async fn s3_s4_approval_pairs_the_device_under_its_name_with_the_role_and_tells_its_connection() {
    let fx = fixture();
    for role in [Role::Viewer, Role::Operator, Role::Admin] {
        let device = key();
        let mut waiting = fx.ask(device, "a phone");
        // Typed back as a person might.
        let typed = waiting.code().as_str().to_lowercase();
        let typed = format!("{}-{}", &typed[..4], &typed[4..]);

        let paired = fx.pairing.approve(&typed, role, &SHELL, false).unwrap();

        assert_eq!((paired.key, paired.role), (device, role));
        assert_eq!(paired.name, "a phone");
        assert_eq!(waiting.outcome().await, Some(Outcome::Approved(role)));
        assert_eq!(fx.standing(&device), Standing::Paired);
        assert!(fx.pairing.list().is_empty());
    }
}

#[tokio::test(start_paused = true)]
async fn s5_a_mistyped_or_used_code_pairs_nothing() {
    let fx = fixture();
    let device = key();
    let waiting = fx.ask(device, "a phone");
    let code = waiting.code();
    let other = loop {
        let other = PairingCode::generate().unwrap();
        if !other.matches(&code) {
            break other;
        }
    };
    for typed in [other.as_str(), "not a code", ""] {
        assert_eq!(
            fx.pairing
                .approve(typed, Role::Operator, &SHELL, false)
                .unwrap_err(),
            "No device is waiting to pair with that code."
        );
    }
    assert_eq!(fx.standing(&device), Standing::Unknown);

    fx.pairing
        .approve(code.as_str(), Role::Operator, &SHELL, false)
        .unwrap();
    assert!(
        fx.pairing
            .approve(code.as_str(), Role::Admin, &SHELL, false)
            .is_err()
    );
    assert_eq!(
        fx.devices.device(&device).unwrap().unwrap().role,
        Role::Operator
    );
}

#[tokio::test(start_paused = true)]
async fn s10_a_device_that_goes_withdraws_its_request_and_its_code_pairs_nothing() {
    let fx = fixture();
    let device = key();
    let waiting = fx.ask(device, "a phone");
    let code = waiting.code();

    drop(waiting);

    assert!(fx.pairing.list().is_empty());
    assert!(
        fx.pairing
            .approve(code.as_str(), Role::Operator, &SHELL, false)
            .is_err()
    );
    assert_eq!(fx.standing(&device), Standing::Unknown);
}

#[tokio::test(start_paused = true)]
async fn a_second_ask_from_the_same_key_withdraws_the_first() {
    let fx = fixture();
    let device = key();
    let mut first = fx.ask(device, "a phone");
    let first_code = first.code();
    let second = fx.ask(device, "a phone, again");

    assert_eq!(first.outcome().await, None, "withdrawn");
    let listed = fx.pairing.list();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "a phone, again");
    if !first_code.matches(&second.code()) {
        assert!(
            fx.pairing
                .approve(first_code.as_str(), Role::Operator, &SHELL, false)
                .is_err()
        );
    }
    drop(first);
    assert_eq!(
        fx.pairing.list().len(),
        1,
        "dropping the first leaves the second"
    );
}

#[tokio::test(start_paused = true)]
async fn s2_a_key_that_connects_without_asking_withdraws_its_request() {
    let fx = fixture();
    let device = key();
    let mut waiting = fx.ask(device, "a phone");

    fx.pairing.withdraw_key(&device);

    assert_eq!(waiting.outcome().await, None);
    assert!(fx.pairing.list().is_empty());
}

#[tokio::test(start_paused = true)]
async fn at_most_sixteen_requests_wait_and_room_comes_back_when_one_goes() {
    let fx = fixture();
    let mut held: Vec<_> = (0..MAX_WAITING).map(|_| fx.ask(key(), "a phone")).collect();
    assert!(!fx.pairing.has_room());
    assert_eq!(
        fx.pairing
            .ask(key(), "one too many", ClientKind::Phone, false)
            .unwrap_err(),
        Full
    );
    held.pop();
    assert!(fx.pairing.has_room());
    held.push(fx.ask(key(), "a phone"));
    assert_eq!(fx.pairing.list().len(), MAX_WAITING);
}

#[tokio::test(start_paused = true)]
async fn the_list_names_each_request_by_fingerprint_with_its_time_left_and_no_code() {
    let fx = fixture();
    let device = key();
    let waiting = fx.ask(device, "a phone");
    tokio::time::advance(Duration::from_secs(61)).await;

    let listed = fx.pairing.list();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].fingerprint, device.fingerprint());
    assert_eq!(listed[0].kind, ClientKind::Phone);
    assert_eq!(listed[0].seconds_left, PAIRING_LIFETIME.as_secs() - 61);
    let printed = format!("{listed:?}");
    assert!(!printed.contains(waiting.code().as_str()), "{printed}");
    assert!(!printed.contains(&device.to_hex()), "{printed}");
}

#[tokio::test(start_paused = true)]
async fn s9_each_request_asked_approved_expired_or_withdrawn_is_recorded_and_never_its_code() {
    let fx = fixture();
    let asked = |device: PublicKey, name: &str| AuditDevice {
        fingerprint: device.fingerprint(),
        name: Some(name.to_owned()),
        role: None,
    };
    let laptop = AuditActor::Device {
        fingerprint: "0123".to_owned(),
        name: "a laptop".to_owned(),
    };

    // Asked from another computer, and approved by an admin there.
    let approved = key();
    let waiting = fx
        .pairing
        .ask(approved, "a phone", ClientKind::Phone, true)
        .unwrap();
    let approved_code = waiting.code();
    fx.pairing
        .approve(approved_code.as_str(), Role::Viewer, &laptop, true)
        .unwrap();
    // Withdrawn by going.
    let gone = key();
    let waiting = fx.ask(gone, "a tablet");
    let gone_code = waiting.code();
    drop(waiting);
    // Expired.
    let late = key();
    let mut waiting = fx.ask(late, "a watch");
    let late_code = waiting.code();
    tokio::time::advance(PAIRING_LIFETIME).await;
    assert_eq!(waiting.outcome().await, Some(Outcome::Expired));

    assert_eq!(
        fx.recorded(),
        [
            AuditEvent::PairingAsked {
                device: asked(approved, "a phone"),
                away: true,
            },
            AuditEvent::PairingApproved {
                device: AuditDevice {
                    role: Some(DeviceRole::Viewer),
                    ..asked(approved, "a phone")
                },
                by: laptop.clone(),
                away: true,
            },
            AuditEvent::PairingAsked {
                device: asked(gone, "a tablet"),
                away: false,
            },
            AuditEvent::PairingEnded {
                device: asked(gone, "a tablet"),
                why: PairingEnd::Withdrawn,
            },
            AuditEvent::PairingAsked {
                device: asked(late, "a watch"),
                away: false,
            },
            AuditEvent::PairingEnded {
                device: asked(late, "a watch"),
                why: PairingEnd::Expired,
            },
        ]
    );
    let text =
        std::fs::read_to_string(fx.dirs.data.join(crate::server::audit::AUDIT_FILE)).unwrap();
    for code in [approved_code, gone_code, late_code] {
        assert!(!text.contains(code.as_str()), "a code was recorded");
    }
}
