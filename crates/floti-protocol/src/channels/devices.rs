//! The devices paired with a host, and the requests to pair waiting on it:
//! `devices:list` and `devices:approve`.
//!
//! A device the host does not know asks to pair in its handshake and shows
//! the code the host answers with. Approving that code pairs it. Both
//! channels are served only to `floti devices`, run in a shell on the host's
//! computer as the host's own OS user: it proves the host's own key, which
//! only a process that can read the host's owner-only key file holds. Every
//! paired device asking either is refused, an admin's included.
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
        .request::<DevicesApprove>();
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
