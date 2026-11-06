//! The host process itself: `host:stop`, what a client's deliberate quit
//! asks of it (`host:deviceSessions`, `host:quit`), and `host:ping`, which a
//! client times to know its connection's round trip.
//!
//! The host is a process of its own that outlives every client, so stopping
//! it is a request a client makes on purpose. A client quitting is not a
//! stop: it says what becomes of the sessions its device started, and the
//! host decides its own exit.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::channel::Catalogue;

pub fn declare(catalogue: &mut Catalogue) {
    catalogue
        .request::<HostStop>()
        .request::<HostDeviceSessions>()
        .request::<HostQuit>()
        .request::<HostPing>();
}

request_channel! {
    /// Answered at once with nothing, for any client: how long the answer
    /// takes to come back is the round trip of the client's connection, what
    /// a keystroke in a terminal there costs.
    HostPing = "host:ping", () => ()
}

request_channel! {
    /// Stops the host. Answered before the host stops, then every
    /// connection closes.
    HostStop = "host:stop", HostStopRequest => ()
}

request_channel! {
    /// The running sessions the caller's device started, oldest first: what
    /// a quit from that device would end. A device is the key a
    /// connection proved, so every connection a client opens with the same
    /// key counts as one device.
    HostDeviceSessions = "host:deviceSessions", () => Vec<DeviceSession>
}

request_channel! {
    /// The caller's device is quitting on purpose. With `end`, the running
    /// sessions it started end as a plain stop ends one: each row recorded
    /// as exited and its whole process tree ended. Either way the plain
    /// terminals it opened end, since a terminal has no row to come back to.
    /// Sessions other devices started are left as they are. Answered once
    /// the endings are under way; the host exits by itself once nothing
    /// runs and no client is attached, when a desktop started it.
    HostQuit = "host:quit", HostQuitRequest => ()
}

/// Why the host is being stopped, which decides what its sessions become.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum HostStopReason {
    /// The user stopped it: every session's row is recorded as exited and
    /// its whole process tree ended, and none is offered back at the next
    /// start.
    Stop,
    /// It is being replaced by a newer version: the sessions end with their
    /// rows left running, so the next start records them as lost and offers
    /// them back once.
    Update,
    /// It is being restarted for an update: it lets go of its session
    /// keeper and exits, leaving every session and plain terminal running
    /// there for the next host to take back, as a crash would leave them. A
    /// host without a keeper stops as for [`Self::Update`]. What a `restart`
    /// frame asks for.
    Restart,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostStopRequest {
    pub reason: HostStopReason,
}

/// A running session a device started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeviceSession {
    /// The session's row id.
    #[ts(type = "number")]
    pub id: u64,
    /// What its tab says: its label, or its name when it has none.
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostQuitRequest {
    /// Whether the sessions the caller's device started end with the quit.
    pub end: bool,
}
