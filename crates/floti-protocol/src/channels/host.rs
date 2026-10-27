//! The host process itself: `host:stop`.
//!
//! Today the desktop's main process is the host and quitting it ends the
//! sessions. Here the host is a process of its own that outlives every
//! client, so stopping it is a request a client makes on purpose.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::channel::Catalogue;

pub fn declare(catalogue: &mut Catalogue) {
    catalogue.request::<HostStop>();
}

request_channel! {
    /// Stops the host. Answered before the host stops, then every
    /// connection closes.
    HostStop = "host:stop", HostStopRequest => ()
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct HostStopRequest {
    pub reason: HostStopReason,
}
