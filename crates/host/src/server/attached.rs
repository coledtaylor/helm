//! Who is attached to the host now: every device holding at least one
//! welcomed connection, served on `devices:attached` to every client, and
//! `devices:disconnect`, which closes every connection of one device.
//!
//! A device is its key, proven in the Noise handshake. It attaches with its
//! first welcomed connection and detaches when its last one closes; its
//! other pages and its sessions' screens are more connections of the same
//! device and change only its count. The host's own shell (`floti
//! update-stop`) is not a device here: it is never entered.
//!
//! `devices:attached` carries the whole list on every change: a device
//! attaching or detaching, a connection more or fewer.
//!
//! Disconnecting a device closes each of its connections at once and takes
//! it off the list; its sessions keep running and nothing is remembered, so
//! it may connect again. Keeping it out is its login's job.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use floti_protocol::channels::devices::{AttachedDevice, AttachedDevices, DevicesAttached};
use floti_protocol::noise::PublicKey;
use jiff::Timestamp;
use tokio::sync::oneshot;

use super::events::Events;
use crate::session::ClientId;

/// One open connection of an attached device.
struct Connection {
    /// Whether it reached the host from another computer.
    away: bool,
    /// Sent to close it.
    close: oneshot::Sender<()>,
}

/// One attached device.
struct Entry {
    key: PublicKey,
    name: String,
    since: Timestamp,
    connections: HashMap<ClientId, Connection>,
}

impl Entry {
    /// Whether any of its connections came from another computer.
    fn away(&self) -> bool {
        self.connections.values().any(|connection| connection.away)
    }

    fn listed(&self) -> AttachedDevice {
        AttachedDevice {
            fingerprint: self.key.fingerprint(),
            name: self.name.clone(),
            away: self.away(),
            since: self.since.to_string(),
            connections: u32::try_from(self.connections.len()).unwrap_or(u32::MAX),
        }
    }
}

/// Every device attached to the host now.
pub(crate) struct Attached {
    events: Arc<Events>,
    /// In the order they attached.
    devices: Mutex<Vec<Entry>>,
}

/// A connection's place among the attached: [`Attachment::closed`] resolves
/// when its device is disconnected, and dropping it takes the connection
/// out, detaching its device when it was the last.
pub(crate) struct Attachment {
    attached: Arc<Attached>,
    key: PublicKey,
    client: ClientId,
    closed: Option<oneshot::Receiver<()>>,
}

/// What a disconnect found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Disconnected {
    /// The device's name, as the list showed it.
    pub name: String,
    /// How many connections were closed.
    pub connections: usize,
}

impl Attached {
    /// Nobody attached, serving `devices:attached` on `events`.
    pub(crate) fn serve(events: Arc<Events>) -> crate::Result<Self> {
        events.serve_state::<DevicesAttached, _>(&AttachedDevices {
            devices: Vec::new(),
        })?;
        Ok(Self {
            events,
            devices: Mutex::new(Vec::new()),
        })
    }

    fn devices(&self) -> MutexGuard<'_, Vec<Entry>> {
        self.devices.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Every attached device now.
    #[cfg(test)]
    pub(crate) fn state(&self) -> AttachedDevices {
        listed(&self.devices())
    }

    /// Enters `client`, a welcomed connection of the device holding `key`,
    /// which came from another computer when `away`, until the returned
    /// place is dropped. The device's first connection attaches it, under
    /// `name`, at the host's clock now.
    pub(crate) fn enter(
        self: &Arc<Self>,
        key: PublicKey,
        name: &str,
        client: ClientId,
        away: bool,
    ) -> Attachment {
        let (close, closed) = oneshot::channel();
        let connection = Connection { away, close };
        let mut devices = self.devices();
        match devices.iter_mut().find(|entry| entry.key == key) {
            Some(entry) => {
                entry.connections.insert(client, connection);
            }
            None => devices.push(Entry {
                key,
                name: name.to_owned(),
                since: Timestamp::now(),
                connections: HashMap::from([(client, connection)]),
            }),
        }
        // Under the lock, so the list each subscriber holds changes in the
        // order the connections came and went.
        self.publish(&devices);
        drop(devices);
        Attachment {
            attached: Arc::clone(self),
            key,
            client,
            closed: Some(closed),
        }
    }

    /// Takes `client` out; its device detaches when it was its last.
    fn leave(&self, key: &PublicKey, client: ClientId) {
        let mut devices = self.devices();
        let Some(index) = devices.iter().position(|entry| entry.key == *key) else {
            // Disconnected already, and detached then.
            return;
        };
        if devices[index].connections.remove(&client).is_none() {
            return;
        }
        if devices[index].connections.is_empty() {
            devices.remove(index);
        }
        self.publish(&devices);
    }

    /// Closes every connection of the attached device whose key has
    /// `fingerprint`, as the list gives it, and detaches it at once. `None`
    /// when no attached device has it.
    pub(crate) fn disconnect(&self, fingerprint: &str) -> Option<Disconnected> {
        let wanted = fingerprint.trim();
        let mut devices = self.devices();
        let index = devices
            .iter()
            .position(|entry| entry.key.fingerprint().eq_ignore_ascii_case(wanted))?;
        let gone = devices.remove(index);
        self.publish(&devices);
        drop(devices);
        let connections = gone.connections.len();
        for (_, connection) in gone.connections {
            let _ = connection.close.send(());
        }
        Some(Disconnected {
            name: gone.name,
            connections,
        })
    }

    fn publish(&self, devices: &[Entry]) {
        if let Err(err) = self
            .events
            .set_state::<DevicesAttached, _>(&listed(devices))
        {
            log_line!("floti host: could not tell clients who is attached: {err}");
        }
    }
}

impl Attachment {
    /// Resolves once its device is disconnected; never, once it has.
    pub(crate) async fn closed(&mut self) {
        match self.closed.as_mut() {
            Some(closed) => {
                // A sender dropped without a send is the list going with the
                // host: it closes the connection all the same.
                let _ = closed.await;
                self.closed = None;
            }
            None => std::future::pending().await,
        }
    }
}

impl Drop for Attachment {
    fn drop(&mut self) {
        self.attached.leave(&self.key, self.client);
    }
}

fn listed(devices: &[Entry]) -> AttachedDevices {
    AttachedDevices {
        devices: devices.iter().map(Entry::listed).collect(),
    }
}

#[cfg(test)]
mod tests;
