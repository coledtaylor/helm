//! Plain terminals: a shell in a project's folder, not a session. No row, no
//! history, no notification.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::channel::Catalogue;

pub(super) fn declare(catalogue: &mut Catalogue) {
    catalogue
        .request::<PtermOpen>()
        .request::<PtermClose>()
        .request::<PtermShells>()
        .request::<PtermResize>()
        .event::<PtermExit>()
        .stream::<PtermTerminal>();
}

request_channel! {
    /// Opens a shell in a folder. Opening a folder that already has one
    /// reattaches to it, unless `separate` asks for a shell of its own.
    PtermOpen = "pterm:open", PtermOpenRequest => PtermOpened, needs Terminal
}

request_channel! {
    /// Kills the shell.
    PtermClose = "pterm:close", PtermCloseRequest => (), needs Terminal
}

request_channel! {
    /// The shells the host's machine has, for the shell pickers.
    PtermShells = "pterm:shells", () => Vec<DetectedShell>
}

request_channel! {
    /// A plain terminal's grid changed.
    PtermResize = "pterm:resize", PtermResizeRequest => (), needs Terminal
}

event_channel! {
    /// A plain terminal's shell exited.
    PtermExit = "pterm:exit", event PtermExited, needs Terminal
}

stream_channel! {
    /// A plain terminal: its output host to client, its input client to host,
    /// as raw bytes.
    PtermTerminal = "pterm:data", opens PtermStreamOpen, needs Terminal
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PtermOpenRequest {
    /// The folder the shell starts in.
    pub path: String,
    pub cols: u16,
    pub rows: u16,
    /// The executable to run. Null means the terminal-shell setting, and
    /// failing that whatever the host detects.
    #[serde(default)]
    pub shell: Option<String>,
    /// A shell of its own, for a terminal tab, rather than the folder's one.
    #[serde(default)]
    pub separate: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PtermOpened {
    #[ts(type = "number")]
    pub id: u64,
    /// The executable actually running.
    pub shell: String,
    /// What was asked for when that is not what runs; null when they agree.
    pub requested: Option<String>,
    /// A sentence about what went wrong, or null.
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PtermCloseRequest {
    #[ts(type = "number")]
    pub id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PtermResizeRequest {
    #[ts(type = "number")]
    pub id: u64,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PtermExited {
    #[ts(type = "number")]
    pub id: u64,
    pub exit_code: i32,
}

/// Which plain terminal a `pterm:data` stream carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PtermStreamOpen {
    #[ts(type = "number")]
    pub id: u64,
}

/// A shell found on the host's machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct DetectedShell {
    /// Absolute path to the executable: what is launched and stored.
    pub path: String,
    /// The file name, such as `pwsh.exe`.
    pub name: String,
    /// A human label, such as "PowerShell 7".
    pub label: String,
    /// The arguments the host would launch it with.
    pub args: Vec<String>,
}
