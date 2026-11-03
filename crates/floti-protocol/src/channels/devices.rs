//! The devices paired with a host, and the requests to pair waiting on it:
//! `devices:list`, `devices:approve`, `devices:revoke` and
//! `devices:presence`.
//!
//! A device the host does not know asks to pair in its handshake and shows
//! the code the host answers with. Approving that code, with the role
//! chosen, pairs it. Listing, approving and revoking are served to admin
//! devices and to `floti devices`, run in a shell on the host's computer as
//! the host's own OS user (it proves the host's own key, which only a
//! process that can read the host's owner-only key file holds). An operator
//! or a viewer is refused them, but any device may revoke itself.
//!
//! An admin connected from another computer (through `floti connect`, on the
//! host's relay endpoint) is asked to be present for each admin action: it
//! confirms the person with its own OS check and says so with
//! `devices:presence`, and the host takes admin actions from it for five
//! minutes after. A device on the host's own computer, and the shell, are
//! never asked. Presence never lets a device do what its role does not.
//!
//! Revoking a device closes every live connection of its key at once and
//! ends none of its sessions; its key is closed without a byte from then on.
//!
//! Nothing here carries a key or a pairing code that is waiting: a device is
//! named by its key's fingerprint.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::channel::Catalogue;
use crate::message::ClientKind;

pub fn declare(catalogue: &mut Catalogue) {
    catalogue
        .request::<DevicesList>()
        .request::<DevicesApprove>()
        .request::<DevicesRevoke>()
        .request::<DevicesPresence>();
}

request_channel! {
    /// Every device paired with the host, revoked ones included, in the
    /// order they were paired, and every request to pair still waiting.
    DevicesList = "devices:list", () => DeviceListing
}

request_channel! {
    /// Pairs the device whose request waits under `code`, with `role`, and
    /// tells it so. Refused, pairing nothing, when no request waits under
    /// that code: mistyped, approved already, withdrawn or expired.
    DevicesApprove = "devices:approve", ApproveDevice => PairedDevice
}

request_channel! {
    /// Revokes the device with `fingerprint`: answered with it, now revoked,
    /// once every live connection of its key is closed. Its sessions keep
    /// running. Refused, changing nothing, when no device has that
    /// fingerprint or it is revoked already.
    DevicesRevoke = "devices:revoke", RevokeDevice => PairedDevice
}

request_channel! {
    /// Says the person at this device has just confirmed it is them, with
    /// the device's own OS check (Windows Hello, Touch ID or the account
    /// password). The host takes admin actions from this device, when it is
    /// connected from another computer, for five minutes after.
    DevicesPresence = "devices:presence", () => ()
}

/// What a device may do with the host. Each role can do all the one before
/// it can: a viewer sees, an operator also types into and runs sessions, an
/// admin also pairs and revokes devices and changes the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum DeviceRole {
    Viewer,
    Operator,
    Admin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceListing {
    pub paired: Vec<PairedDevice>,
    pub waiting: Vec<WaitingDevice>,
}

/// A device in the host's registry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PairedDevice {
    /// The name it was paired under: the name it gave when it asked.
    pub name: String,
    pub role: DeviceRole,
    /// When it was paired, as RFC 3339 text.
    pub paired_at: String,
    /// When it was revoked, as RFC 3339 text; absent while it is not.
    pub revoked_at: Option<String>,
    /// Its key's fingerprint.
    pub fingerprint: String,
}

/// A request to pair that waits for approval.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WaitingDevice {
    /// The name the device gave in its `hello`.
    pub name: String,
    /// What kind of client it said it is.
    pub kind: ClientKind,
    /// Its key's fingerprint.
    pub fingerprint: String,
    /// How long the request waits before it expires.
    #[ts(type = "number")]
    pub seconds_left: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ApproveDevice {
    /// The code the device shows, as typed: case, spaces and hyphens do not
    /// matter.
    pub code: String,
    pub role: DeviceRole,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RevokeDevice {
    /// The device's key's fingerprint, as `devices:list` and `floti
    /// devices` give it.
    pub fingerprint: String,
}
