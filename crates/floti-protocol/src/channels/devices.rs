//! The devices attached to a host now: `devices:attached` and
//! `devices:disconnect`.
//!
//! Whatever reaches the host's socket and completes its Noise handshake is
//! served in full; the socket only the host's OS user can open, on the
//! host's computer or through that user's own ssh login or command, is the
//! access. A device is named by its key, which it proves in the handshake,
//! and is attached while it holds at least one open connection: its first
//! welcomed connection attaches it and the last one closing detaches it.
//!
//! Every client sees who is attached and may disconnect any device: that
//! closes every open connection of its key at once, ends none of its
//! sessions and remembers nothing, so the device may connect again. Keeping
//! a device out for good is the login's job (its ssh key taken out of
//! `authorized_keys`), not the host's.
//!
//! Nothing here carries a key: a device is named by its key's fingerprint
//! and the name its client gave.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::channel::Catalogue;

pub fn declare(catalogue: &mut Catalogue) {
    catalogue
        .event::<DevicesAttached>()
        .request::<DevicesDisconnect>();
}

event_channel! {
    /// Every device attached to the host now, the whole list on every
    /// change: a device attaching or detaching.
    DevicesAttached = "devices:attached", state AttachedDevices
}

request_channel! {
    /// Closes every open connection of the device with `fingerprint` at
    /// once, this one's included when it names this device. Its sessions keep
    /// running and the host remembers nothing: the device may connect again.
    /// Refused, closing nothing, when no device with that fingerprint is
    /// attached.
    DevicesDisconnect = "devices:disconnect", DisconnectDevice => ()
}

/// Every device attached to the host now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachedDevices {
    /// Each attached device once, however many connections it holds, in the
    /// order they attached.
    pub devices: Vec<AttachedDevice>,
}

/// A device holding at least one open connection to the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AttachedDevice {
    /// Its key's fingerprint, as `welcome.device` gives each connection its
    /// own.
    pub fingerprint: String,
    /// The name its client gave in `hello` when it attached: its device name,
    /// or the client's own name when it gave none.
    pub name: String,
    /// Whether it is connected from another computer, through `floti
    /// connect`, rather than on the host's own.
    pub away: bool,
    /// When its first open connection was welcomed, by the host's clock, as
    /// RFC 3339 text.
    pub since: String,
    /// How many connections it holds open: its window, its other pages and
    /// its sessions' screens each hold one.
    pub connections: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectDevice {
    /// The device's key's fingerprint, as `devices:attached` gives it.
    pub fingerprint: String,
}
