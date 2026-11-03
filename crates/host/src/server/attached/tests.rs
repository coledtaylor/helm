use std::sync::Arc;

use floti_protocol::channel::{EventChannel, from_payload};
use floti_protocol::channels::devices::{
    AttachedDevices, AuditEvent, AuditQuery, DeviceConnected, DeviceRole, DevicesAttached,
    DevicesConnected,
};
use floti_protocol::noise::KeyPair;
use tokio::sync::broadcast;

use super::Attached;
use crate::devices::{Device, DeviceRegistry, Role};
use crate::server::audit::AuditLog;
use crate::server::events::{Events, Publication};
use crate::server::notices::{HostNotices, recorded_notices};
use crate::session::ClientId;
use crate::testkit::TestDirs;

struct Fixture {
    attached: Arc<Attached>,
    audit: Arc<AuditLog>,
    devices: DeviceRegistry,
    published: broadcast::Receiver<Publication>,
    _events: Arc<Events>,
    dirs: TestDirs,
}

fn fixture() -> Fixture {
    let dirs = TestDirs::new();
    let events = Arc::new(Events::new());
    Attached::serve(&events).unwrap();
    let audit = Arc::new(AuditLog::in_data_folder(&dirs.data));
    let attached = Arc::new(Attached::new(
        Arc::clone(&events),
        Arc::clone(&audit),
        Arc::new(HostNotices::for_host(&dirs.data)),
    ));
    Fixture {
        attached,
        audit,
        devices: DeviceRegistry::in_data_folder(&dirs.data),
        published: events.observe(),
        _events: events,
        dirs,
    }
}

impl Fixture {
    fn pair(&self, name: &str, role: Role) -> Device {
        self.devices
            .pair(KeyPair::generate().unwrap().public(), name, role)
            .unwrap()
    }

    /// Every publication since the last call: who is attached, as each
    /// change left it, and each device told as connected.
    fn drain(&mut self) -> (Vec<AttachedDevices>, Vec<DeviceConnected>) {
        let mut states = Vec::new();
        let mut told = Vec::new();
        while let Ok(published) = self.published.try_recv() {
            if published.channel == <DevicesAttached as EventChannel>::NAME {
                states.push(from_payload(&published.payload).unwrap());
            } else if published.channel == <DevicesConnected as EventChannel>::NAME {
                told.push(from_payload(&published.payload).unwrap());
            }
        }
        (states, told)
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
}

fn names(state: &AttachedDevices) -> Vec<(String, u32, bool)> {
    state
        .devices
        .iter()
        .map(|device| (device.name.clone(), device.connections, device.away))
        .collect()
}

#[test]
fn s2_a_device_attaches_with_its_first_connection_and_detaches_with_its_last() {
    let mut fx = fixture();
    let phone = fx.pair("a phone", Role::Operator);
    let first = fx.attached.enter(&phone, ClientId(1), true);
    let second = fx.attached.enter(&phone, ClientId(2), false);
    let (states, told) = fx.drain();
    assert_eq!(
        states.iter().map(names).collect::<Vec<_>>(),
        [
            vec![("a phone".to_owned(), 1, true)],
            vec![("a phone".to_owned(), 2, true)],
        ]
    );
    // S4: told once, for its first connection only.
    assert_eq!(told.len(), 1);
    assert_eq!(told[0].name, "a phone");
    assert_eq!(told[0].role, DeviceRole::Operator);
    assert!(told[0].away);
    assert_eq!(told[0].fingerprint, phone.key.fingerprint());

    drop(first);
    assert_eq!(fx.attached.state().devices.len(), 1);
    drop(second);
    assert!(fx.attached.state().devices.is_empty());
    let (states, told) = fx.drain();
    assert_eq!(states.last().map(|state| state.devices.len()), Some(0));
    assert!(told.is_empty());

    // S7: one entry for attaching and one for detaching, never per connection.
    let recorded = fx.recorded();
    assert_eq!(recorded.len(), 2, "{recorded:?}");
    assert!(
        matches!(&recorded[0], AuditEvent::Connected { device, away: true }
        if device.name.as_deref() == Some("a phone") && device.role == Some(DeviceRole::Operator))
    );
    // Away as its last connection was: the one from this computer.
    assert!(
        matches!(&recorded[1], AuditEvent::Disconnected { device, away: false }
        if device.fingerprint == phone.key.fingerprint())
    );
}

#[test]
fn s10_a_role_change_holds_for_an_attached_device_at_once_and_is_published() {
    let mut fx = fixture();
    let laptop = fx.pair("a laptop", Role::Admin);
    let _held = fx.attached.enter(&laptop, ClientId(1), false);
    fx.drain();
    fx.attached.role_changed(&laptop.key, Role::Viewer);
    assert_eq!(fx.attached.role(&laptop.key), Some(Role::Viewer));
    let (states, _) = fx.drain();
    assert_eq!(states.len(), 1);
    assert_eq!(states[0].devices[0].role, DeviceRole::Viewer);
    // A device that is not attached has no role here: its next connection
    // reads the registry.
    let other = fx.pair("a phone", Role::Operator);
    assert_eq!(fx.attached.role(&other.key), None);
}

#[test]
fn s2_a_revoked_device_is_detached_at_once_and_its_closing_connections_change_nothing() {
    let mut fx = fixture();
    let phone = fx.pair("a phone", Role::Viewer);
    let laptop = fx.pair("a laptop", Role::Admin);
    let held = fx.attached.enter(&phone, ClientId(1), true);
    let _laptop = fx.attached.enter(&laptop, ClientId(2), false);
    fx.drain();
    fx.attached.revoked(&phone.key);
    assert_eq!(
        names(&fx.attached.state()),
        [("a laptop".to_owned(), 1, false)]
    );
    drop(held);
    let (states, _) = fx.drain();
    assert_eq!(states.len(), 1, "the revoke published, the closing did not");
    let recorded = fx.recorded();
    assert_eq!(
        recorded
            .iter()
            .filter(|event| matches!(event, AuditEvent::Disconnected { .. }))
            .count(),
        1
    );
}

#[test]
fn s6_only_a_device_attaching_from_another_computer_is_shown_on_the_host() {
    let fx = fixture();
    let here = fx.pair("this laptop", Role::Admin);
    let away = fx.pair("a phone", Role::Operator);
    let _here = fx.attached.enter(&here, ClientId(1), false);
    let _away = fx.attached.enter(&away, ClientId(2), true);
    // A further connection of the same device shows nothing more.
    let _again = fx.attached.enter(&away, ClientId(3), true);
    // Shown on a thread of its own: wait for the record, bounded.
    let deadline = std::time::Instant::now() + crate::testkit::PATIENCE;
    let notices = loop {
        let notices = recorded_notices(&fx.dirs.data);
        if !notices.is_empty() || std::time::Instant::now() > deadline {
            break notices;
        }
        std::thread::yield_now();
    };
    assert_eq!(notices.len(), 1, "{notices:?}");
    assert_eq!(
        notices[0].title,
        "\"a phone\" connected from another computer"
    );
    assert_eq!(
        notices[0].body,
        "It is paired as an operator with this computer's Floti host."
    );
}
