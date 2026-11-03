use std::sync::Arc;

use floti_protocol::channel::{EventChannel, from_payload};
use floti_protocol::channels::devices::{AttachedDevices, DevicesAttached};
use floti_protocol::noise::{KeyPair, PublicKey};
use jiff::Timestamp;
use tokio::sync::broadcast;

use super::{Attached, Disconnected};
use crate::server::events::{Events, Publication};
use crate::session::ClientId;

struct Fixture {
    attached: Arc<Attached>,
    published: broadcast::Receiver<Publication>,
}

fn fixture() -> Fixture {
    let events = Arc::new(Events::new());
    let attached = Arc::new(Attached::serve(Arc::clone(&events)).unwrap());
    Fixture {
        attached,
        published: events.observe(),
    }
}

fn key() -> PublicKey {
    KeyPair::generate().unwrap().public()
}

impl Fixture {
    /// Who is attached, as each change since the last call left it.
    fn drain(&mut self) -> Vec<AttachedDevices> {
        let mut states = Vec::new();
        while let Ok(published) = self.published.try_recv() {
            if published.channel == <DevicesAttached as EventChannel>::NAME {
                states.push(from_payload(&published.payload).unwrap());
            }
        }
        states
    }
}

fn rows(state: &AttachedDevices) -> Vec<(String, u32, bool)> {
    state
        .devices
        .iter()
        .map(|device| (device.name.clone(), device.connections, device.away))
        .collect()
}

#[test]
fn a_device_attaches_with_its_first_connection_and_detaches_with_its_last() {
    let mut fx = fixture();
    let phone = key();
    let before = Timestamp::now();
    let first = fx.attached.enter(phone, "a phone", ClientId(1), true);
    let second = fx.attached.enter(phone, "a phone", ClientId(2), false);
    let states = fx.drain();
    assert_eq!(
        states.iter().map(rows).collect::<Vec<_>>(),
        [
            vec![("a phone".to_owned(), 1, true)],
            vec![("a phone".to_owned(), 2, true)],
        ]
    );
    let listed = &states[1].devices[0];
    assert_eq!(listed.fingerprint, phone.fingerprint());
    let since: Timestamp = listed.since.parse().unwrap();
    assert!(since >= before && since <= Timestamp::now(), "{since}");

    drop(first);
    assert_eq!(
        rows(&fx.attached.state()),
        [("a phone".to_owned(), 1, false)]
    );
    drop(second);
    assert!(fx.attached.state().devices.is_empty());
    assert_eq!(fx.drain().last().map(|state| state.devices.len()), Some(0));
}

#[test]
fn devices_are_listed_once_each_in_the_order_they_attached() {
    let fx = fixture();
    let (desk, laptop) = (key(), key());
    let _desk = fx.attached.enter(desk, "desk", ClientId(1), false);
    let _laptop = fx.attached.enter(laptop, "laptop", ClientId(2), true);
    let _desk_again = fx.attached.enter(desk, "renamed later", ClientId(3), false);
    assert_eq!(
        rows(&fx.attached.state()),
        [
            ("desk".to_owned(), 2, false),
            ("laptop".to_owned(), 1, true),
        ]
    );
}

#[tokio::test]
async fn disconnect_closes_every_connection_of_the_device_and_detaches_it_at_once() {
    let mut fx = fixture();
    let (phone, desk) = (key(), key());
    let mut one = fx.attached.enter(phone, "a phone", ClientId(1), true);
    let mut two = fx.attached.enter(phone, "a phone", ClientId(2), true);
    let _desk = fx.attached.enter(desk, "desk", ClientId(3), false);
    fx.drain();

    let shown = format!("  {}  ", phone.fingerprint().to_uppercase());
    assert_eq!(
        fx.attached.disconnect(&shown),
        Some(Disconnected {
            name: "a phone".to_owned(),
            connections: 2,
        })
    );
    one.closed().await;
    two.closed().await;
    assert_eq!(
        fx.drain().iter().map(rows).collect::<Vec<_>>(),
        [vec![("desk".to_owned(), 1, false)]]
    );
    // Its connections closing after changes nothing more.
    drop(one);
    drop(two);
    assert!(fx.drain().is_empty());

    // Nothing is remembered: it attaches again as before.
    let _back = fx.attached.enter(phone, "a phone", ClientId(4), true);
    assert_eq!(fx.attached.state().devices.len(), 2);
}

#[test]
fn disconnecting_a_device_not_attached_closes_nothing() {
    let mut fx = fixture();
    let _desk = fx.attached.enter(key(), "desk", ClientId(1), false);
    fx.drain();
    assert_eq!(fx.attached.disconnect(&key().fingerprint()), None);
    assert_eq!(fx.attached.disconnect(""), None);
    assert!(fx.drain().is_empty());
    assert_eq!(fx.attached.state().devices.len(), 1);
}
