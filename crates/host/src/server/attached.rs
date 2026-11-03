//! Who is attached to the host now: every paired device holding at least
//! one welcomed connection, served on `devices:attached` to every role, and
//! each new one told on `devices:connected`.
//!
//! A device attaches with its first welcomed connection and detaches when
//! its last one closes; its other pages and its sessions' screens are more
//! connections of the same device and change only its count. The host's
//! own shell (`floti devices`) and a device asking to pair are not devices
//! here: neither is ever entered.
//!
//! `devices:attached` carries the whole list on every change: a device
//! attaching or detaching, a connection more or fewer, a role changed, a
//! device revoked. `devices:connected` is sent once per attach, to every
//! client listening then. The attaching device's own connections are never
//! among them: its first connection is entered before it listens to
//! anything, and it has no other.
//!
//! Attaching and detaching each add one entry to the audit log, and a
//! device attaching from another computer is shown on the host's own
//! ([`HostNotices`]).
//!
//! The role each attached device has now is kept here too: a role change
//! applies to the device's open connections at once, because each reads its
//! role from here at every request, subscription, publication and keystroke
//! rather than the role its handshake read.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use floti_protocol::channels::devices::{
    AttachedDevice, AttachedDevices, AuditDevice, AuditEvent, DeviceConnected, DevicesAttached,
    DevicesConnected,
};
use floti_protocol::noise::PublicKey;
use jiff::Timestamp;

use super::audit::AuditLog;
use super::events::Events;
use super::notices::HostNotices;
use crate::devices::{Device, Role};
use crate::session::ClientId;

/// One attached device.
struct Entry {
    key: PublicKey,
    name: String,
    role: Role,
    since: Timestamp,
    /// Each open connection, and whether it reached the host from another
    /// computer.
    connections: HashMap<ClientId, bool>,
}

impl Entry {
    /// Whether any of its connections came from another computer.
    fn away(&self) -> bool {
        self.connections.values().any(|away| *away)
    }

    fn listed(&self) -> AttachedDevice {
        AttachedDevice {
            fingerprint: self.key.fingerprint(),
            name: self.name.clone(),
            role: self.role.into(),
            away: self.away(),
            since: self.since.to_string(),
            connections: u32::try_from(self.connections.len()).unwrap_or(u32::MAX),
        }
    }

    fn audited(&self) -> AuditDevice {
        AuditDevice {
            fingerprint: self.key.fingerprint(),
            name: Some(self.name.clone()),
            role: Some(self.role.into()),
        }
    }
}

/// Every device attached to the host now.
pub(crate) struct Attached {
    events: Arc<Events>,
    audit: Arc<AuditLog>,
    notices: Arc<HostNotices>,
    /// In the order they attached.
    devices: Mutex<Vec<Entry>>,
}

/// A connection's place among the attached: dropping it takes the
/// connection out, detaching its device when it was the last.
pub(crate) struct Attachment {
    attached: Arc<Attached>,
    key: PublicKey,
    client: ClientId,
}

impl Attached {
    /// Serves `devices:attached`, with nobody attached, and
    /// `devices:connected` on `events`.
    pub(crate) fn serve(events: &Events) -> crate::Result<()> {
        events.serve_state::<DevicesAttached, _>(&AttachedDevices {
            devices: Vec::new(),
        })?;
        events.serve_events::<DevicesConnected>();
        Ok(())
    }

    /// Nobody attached yet, publishing on `events`, which [`Self::serve`]
    /// declared the channels on.
    pub(crate) fn new(
        events: Arc<Events>,
        audit: Arc<AuditLog>,
        notices: Arc<HostNotices>,
    ) -> Self {
        Self {
            events,
            audit,
            notices,
            devices: Mutex::new(Vec::new()),
        }
    }

    fn devices(&self) -> MutexGuard<'_, Vec<Entry>> {
        self.devices.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Every attached device now.
    pub(crate) fn state(&self) -> AttachedDevices {
        listed(&self.devices())
    }

    /// Enters `client`, a welcomed connection of the paired `device` that
    /// came from another computer when `away`, until the returned place is
    /// dropped. Its device's first connection attaches it: that is recorded,
    /// told to every client listening, and shown on the host's computer when
    /// it came from another one.
    pub(crate) fn enter(
        self: &Arc<Self>,
        device: &Device,
        client: ClientId,
        away: bool,
    ) -> Attachment {
        let mut devices = self.devices();
        let attached_now = match devices.iter_mut().find(|entry| entry.key == device.key) {
            Some(entry) => {
                entry.connections.insert(client, away);
                None
            }
            None => {
                let entry = Entry {
                    key: device.key,
                    name: device.name.clone(),
                    role: device.role,
                    since: Timestamp::now(),
                    connections: HashMap::from([(client, away)]),
                };
                let attached = entry.audited();
                let told = DeviceConnected {
                    fingerprint: device.key.fingerprint(),
                    name: device.name.clone(),
                    role: device.role.into(),
                    away,
                    at: entry.since.to_string(),
                };
                devices.push(entry);
                Some((attached, told))
            }
        };
        // Under the lock, so the list each subscriber holds changes in the
        // order the connections came and went.
        self.publish(&devices);
        if let Some((attached, told)) = attached_now {
            self.audit.record(AuditEvent::Connected {
                device: attached,
                away,
            });
            if let Err(err) = self.events.emit::<DevicesConnected>(&told) {
                log_line!("floti host: could not tell clients a device attached: {err}");
            }
            if away {
                self.notices
                    .device_attached_from_away(&device.name, device.role, &device.key);
            }
        }
        drop(devices);
        Attachment {
            attached: Arc::clone(self),
            key: device.key,
            client,
        }
    }

    /// Takes `client` out; its device detaches when it was its last.
    fn leave(&self, key: &PublicKey, client: ClientId) {
        let mut devices = self.devices();
        let Some(index) = devices.iter().position(|entry| entry.key == *key) else {
            // Revoked already, and detached then.
            return;
        };
        let entry = &mut devices[index];
        let away = entry.away();
        if entry.connections.remove(&client).is_none() {
            return;
        }
        if entry.connections.is_empty() {
            let gone = devices.remove(index);
            self.audit.record(AuditEvent::Disconnected {
                device: gone.audited(),
                away,
            });
        }
        self.publish(&devices);
    }

    /// The role `key`'s device has now, when it is attached.
    pub(crate) fn role(&self, key: &PublicKey) -> Option<Role> {
        self.devices()
            .iter()
            .find(|entry| entry.key == *key)
            .map(|entry| entry.role)
    }

    /// `key`'s device, when it is attached, as an audit entry names it.
    pub(crate) fn audit_device(&self, key: &PublicKey) -> Option<AuditDevice> {
        self.devices()
            .iter()
            .find(|entry| entry.key == *key)
            .map(Entry::audited)
    }

    /// `key`'s device now has `role`: its open connections take it from
    /// their next request, and every client is told.
    pub(crate) fn role_changed(&self, key: &PublicKey, role: Role) {
        let mut devices = self.devices();
        let Some(entry) = devices.iter_mut().find(|entry| entry.key == *key) else {
            return;
        };
        entry.role = role;
        self.publish(&devices);
    }

    /// `key`'s device was revoked: it is detached at once, before its
    /// connections have finished closing, and every client is told.
    pub(crate) fn revoked(&self, key: &PublicKey) {
        let mut devices = self.devices();
        let Some(index) = devices.iter().position(|entry| entry.key == *key) else {
            return;
        };
        let gone = devices.remove(index);
        let away = gone.away();
        self.audit.record(AuditEvent::Disconnected {
            device: gone.audited(),
            away,
        });
        self.publish(&devices);
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
