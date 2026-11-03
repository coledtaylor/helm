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
//! An admin changes a paired device's role with `devices:role`; the new role
//! holds on the device's open connections at once.
//!
//! Every device may see who is attached to the host now (`devices:attached`)
//! and is told when another device attaches (`devices:connected`). A device
//! is attached while it holds at least one open connection; only its first
//! connection attaches it and only its last one closing detaches it.
//!
//! The host keeps an append-only audit log of connections, refused
//! attempts, pairings, role changes, revokes, presence and admin actions,
//! read by admin devices with `devices:audit`. The log never holds session
//! content: an entry has only the fixed fields declared here, and a device's
//! name, as it gave it, is its one free text.
//!
//! Nothing here carries a key, a pairing or enrolment code, or any part of a
//! request's contents, a session's input or output, a prompt, a transcript,
//! a file, a note, config text or a plugin secret: a device is named by its
//! key's fingerprint and the name it gave.

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
        .request::<DevicesPresence>()
        .request::<DevicesRole>()
        .request::<DevicesAudit>()
        .event::<DevicesAttached>()
        .event::<DevicesConnected>();
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

request_channel! {
    /// Gives the paired device with `fingerprint` the role `role`, and
    /// answers with it as the registry now holds it. Its open connections
    /// take the new role at once: made a viewer, its keystrokes reach no
    /// session from then on. An admin action. Refused, changing nothing,
    /// when no device has that fingerprint, it is revoked, or it is the
    /// host's last admin and `role` is not admin: a host keeps at least one
    /// admin.
    DevicesRole = "devices:role", ChangeDeviceRole => PairedDevice
}

request_channel! {
    /// A page of the host's audit log, newest first: the entries numbered
    /// below `before` (every entry when it is absent), at most `limit` of
    /// them. Admin devices and `floti devices audit` read it; reading it adds
    /// no entry.
    DevicesAudit = "devices:audit", AuditQuery => AuditPage
}

event_channel! {
    /// Every device attached to the host now, the whole list on every
    /// change: a device attaching, detaching, having its role changed or
    /// being revoked. Served to every role.
    DevicesAttached = "devices:attached", state AttachedDevices
}

event_channel! {
    /// A device has just attached: its first connection was welcomed. Sent
    /// once, to every other attached client; not to the device itself, and
    /// never for a further connection of a device already attached (another
    /// of its pages, a session's screen).
    DevicesConnected = "devices:connected", event DeviceConnected
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChangeDeviceRole {
    /// The device's key's fingerprint, as `devices:list` and `floti
    /// devices` give it.
    pub fingerprint: String,
    /// The role it is to have.
    pub role: DeviceRole,
}

// ---------------------------------------------------------------------------
// Attached devices
// ---------------------------------------------------------------------------

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
    /// Its key's fingerprint.
    pub fingerprint: String,
    /// The name it was paired under.
    pub name: String,
    /// The role it holds now.
    pub role: DeviceRole,
    /// Whether it is connected from another computer, through `floti
    /// connect`, rather than on the host's own.
    pub away: bool,
    /// When its first open connection was welcomed, as RFC 3339 text.
    pub since: String,
    /// How many connections it holds open: its window, its other pages and
    /// its sessions' screens each hold one.
    pub connections: u32,
}

/// A device that has just attached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceConnected {
    /// Its key's fingerprint.
    pub fingerprint: String,
    /// The name it was paired under.
    pub name: String,
    pub role: DeviceRole,
    /// Whether it came from another computer, through `floti connect`.
    pub away: bool,
    /// When its connection was welcomed, as RFC 3339 text.
    pub at: String,
}

// ---------------------------------------------------------------------------
// The audit log
// ---------------------------------------------------------------------------

/// Which page of the audit log to read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AuditQuery {
    /// Read the entries numbered below this one; absent, start from the
    /// newest. A page's last entry's `number` asks for the page after it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub before: Option<u64>,
    /// At most this many entries; absent, 50. The host answers at most 200
    /// whatever is asked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub limit: Option<u32>,
}

/// A page of the audit log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AuditPage {
    /// Newest first.
    pub entries: Vec<AuditEntry>,
    /// Whether older entries remain, below the last one here.
    pub more: bool,
}

/// One entry of the host's audit log. Entries are only ever added: nothing
/// the host serves edits or removes one.
///
/// An entry holds only these fields. It never carries a key, a pairing or
/// enrolment code, a request's contents, a session's input or output, a
/// prompt, a transcript, file, note or config text, or a plugin secret. A
/// device's name, as the device gave it, is its one free text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    /// Its place in the log, counting up from 1 across the host's restarts;
    /// what `devices:audit`'s `before` pages by.
    #[ts(type = "number")]
    pub number: u64,
    /// When it happened, as RFC 3339 text.
    pub at: String,
    /// What happened.
    pub event: AuditEvent,
}

/// What an audit entry records. `away` says whether the connection it is
/// about came from another computer, through `floti connect`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AuditEvent {
    /// A device attached: its first connection was welcomed. Its further
    /// connections while attached add no entry.
    Connected { device: AuditDevice, away: bool },
    /// A device detached: its last open connection closed.
    Disconnected { device: AuditDevice, away: bool },
    /// A connection was refused and closed without a byte. A connection that
    /// closed before sending anything is not recorded.
    Refused {
        /// Why, as one of the host's fixed sentences ("An unknown key", "The
        /// handshake ran out of time"); never anything the connection sent.
        reason: String,
        /// The key's fingerprint, where the handshake proved one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        fingerprint: Option<String>,
        away: bool,
    },
    /// A device the host does not know asked to pair. The code it was shown
    /// is never recorded.
    PairingAsked { device: AuditDevice, away: bool },
    /// A request to pair was approved: `device` holds the role it was paired
    /// with and `by` who approved it.
    PairingApproved {
        device: AuditDevice,
        by: AuditActor,
        /// Whether the approver was connected from another computer.
        away: bool,
    },
    /// A request to pair ended without being approved.
    PairingEnded {
        device: AuditDevice,
        why: PairingEnd,
    },
    /// A device on the host's computer enrolled as the host's first admin.
    /// The enrolment code is never recorded.
    Enrolled { device: AuditDevice },
    /// A paired device's role was changed from `from` to `to`.
    RoleChanged {
        device: AuditDevice,
        from: DeviceRole,
        to: DeviceRole,
        by: AuditActor,
        /// Whether the one who changed it was connected from another
        /// computer.
        away: bool,
    },
    /// A device was revoked, by an admin or by itself.
    Revoked {
        device: AuditDevice,
        by: AuditActor,
        /// Whether the one who revoked it was connected from another
        /// computer.
        away: bool,
    },
    /// A device said the person at it had just confirmed it is them.
    PresenceConfirmed { device: AuditDevice, away: bool },
    /// An admin action was asked for, and done or refused. Listing devices
    /// and reading the audit log are not recorded.
    AdminAction {
        /// The channel it was asked on, such as `plugins:add`.
        channel: String,
        /// What the action does, as the host's fixed sentence ("Changing the
        /// host's settings"); never the request's contents.
        doing: String,
        by: AuditActor,
        /// Whether the one who asked was connected from another computer.
        away: bool,
        outcome: AdminOutcome,
    },
}

/// The device an audit entry is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct AuditDevice {
    /// Its key's fingerprint.
    pub fingerprint: String,
    /// The name it gave, or was paired under; absent where none is known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    /// Its role then; absent where it has none, such as a device still
    /// asking to pair.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub role: Option<DeviceRole>,
}

/// Who asked for what an audit entry records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AuditActor {
    /// A paired device.
    Device { fingerprint: String, name: String },
    /// `floti devices`, run in a shell on the host's computer as the host's
    /// own OS user.
    HostShell,
}

/// Why a request to pair ended without being approved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PairingEnd {
    /// It waited past its time.
    Expired,
    /// The device closed its connection, or asked again with a new request.
    Withdrawn,
}

/// What came of an admin action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum AdminOutcome {
    Done,
    /// Refused: the device's role does not allow it.
    RefusedForRole,
    /// Refused: the device is connected from another computer and has not
    /// confirmed its presence in the last five minutes.
    RefusedForPresence,
}
