//! Sessions, plain terminals, profiles, history, the archive and usage:
//! `session:*`, `sessions:*`, `pterm:*`, `profile:*`, `profiles:changed`,
//! `history:*`, `archive:*` and `usage:*` in `shared/ipc.ts`.
//!
//! How the ipc.ts channels map onto the protocol:
//!
//! - A session's and a plain terminal's input and output are one byte stream
//!   each, `session:data` and `pterm:data`, opened by the client and needing
//!   the `terminal` capability. Output travels host to client and input
//!   client to host on the same stream; [`CARRIED_ON_STREAMS`] names the
//!   ipc.ts input channels that became their client-to-host direction.
//! - Fire-and-forget sends (`session:resize`, `pterm:resize`, `session:focus`,
//!   `sessions:watch`) and the answer to a confirmation (`session:confirmed`)
//!   are requests, so a client learns when one did not land.
//! - Whole-state pushes (`profiles:changed`, `history:changed`,
//!   `archive:changed`, `usage:changed`, `session:activity`,
//!   `sessions:overview`, `sessions:resources`) are events that carry state:
//!   a subscription starts with a snapshot. `session:activity`,
//!   `sessions:overview` and `sessions:resources` are a request as well as an
//!   event in ipc.ts, for a window that has just mounted; here the
//!   subscription's snapshot is that answer, so each is one event channel.
//! - `session:exit`, `session:activate`, `session:confirm` and `pterm:exit`
//!   are events without state.
//! - Where ipc.ts opened a native dialog (`profile:export`,
//!   `profile:import`), the dialog stays in the client: export returns the
//!   profile document and import takes it.
//!
//! Live-session vocabulary is backend-neutral: Claude Code's session id is a
//! `conversationId`, Floti's own row id a `hostSessionId`, and every session,
//! live session, history session and usage reading names its backend.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::backend::{BackendId, HarnessPart};
use crate::channel::Catalogue;
use crate::channels::common::{PermissionMode, SessionRecord};

mod history;
mod profiles;
mod terminal;
mod usage;

#[cfg(test)]
mod tests;

pub use history::*;
pub use profiles::*;
pub use terminal::*;
pub use usage::*;

/// ipc.ts input channels that are the client-to-host direction of a stream
/// here, as `(ipc.ts channel, stream channel)`.
pub const CARRIED_ON_STREAMS: [(&str, &str); 2] = [
    ("session:input", "session:data"),
    ("pterm:input", "pterm:data"),
];

pub fn declare(catalogue: &mut Catalogue) {
    catalogue
        .request::<SessionStart>()
        .request::<SessionLaunch>()
        .request::<SessionRestorable>()
        .request::<SessionRestore>()
        .request::<SessionClose>()
        .request::<SessionList>()
        .request::<SessionRename>()
        .request::<SessionResize>()
        .request::<SessionFocus>()
        .request::<SessionsWatch>()
        .request::<SessionConfirmed>()
        .event::<SessionActivityChanged>()
        .event::<SessionsOverviewChanged>()
        .event::<SessionResourcesChanged>()
        .event::<SessionExit>()
        .event::<SessionActivate>()
        .event::<SessionConfirm>()
        .stream::<SessionTerminal>();
    terminal::declare(catalogue);
    profiles::declare(catalogue);
    history::declare(catalogue);
    usage::declare(catalogue);
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

request_channel! {
    /// Spawns a hosted agent session. Fails with a sentence when the agent
    /// cannot be found or its terminal will not open.
    SessionStart = "session:start", StartSessionRequest => SessionRecord
}

request_channel! {
    /// The new-session launcher's one call: a folder, a profile, a permission
    /// mode, or a conversation to reopen.
    SessionLaunch = "session:launch", LaunchSessionRequest => LaunchedSession
}

request_channel! {
    /// The sessions the host's last run was hosting when it stopped without
    /// shutting down, or null when there are none or they have been answered
    /// for.
    SessionRestorable = "session:restorable", () => Option<RestoreOffer>
}

request_channel! {
    /// Reopens the sessions asked for and answers the offer; asking for none
    /// is "not now".
    SessionRestore = "session:restore", RestoreSessionsRequest => RestoreSessionsResult
}

request_channel! {
    /// Ends a session and forgets it. Asks first, on `session:confirm`, if
    /// its process is still alive and `force` is not set.
    SessionClose = "session:close", CloseSessionRequest => CloseSessionResult
}

request_channel! {
    /// The sessions the host is running now.
    SessionList = "session:list", () => Vec<SessionRecord>
}

request_channel! {
    /// Renames a session's tab. Answers with the row as the host now holds it.
    SessionRename = "session:rename", RenameSessionRequest => SessionRecord
}

request_channel! {
    /// A session's terminal grid changed.
    SessionResize = "session:resize", SessionResizeRequest => (), needs Terminal
}

request_channel! {
    /// Which sessions this client's user can see now, so the host can judge
    /// whether an exit is worth a notification.
    SessionFocus = "session:focus", SessionFocusRequest => ()
}

request_channel! {
    /// Whether this client is looking at the process-and-ports pass. The pass
    /// runs only while some client is.
    SessionsWatch = "sessions:watch", SessionsWatchRequest => ()
}

request_channel! {
    /// The answer to a `session:confirm`.
    SessionConfirmed = "session:confirmed", SessionConfirmAnswer => ()
}

event_channel! {
    /// What every hosted session is doing, the whole set on every change.
    SessionActivityChanged = "session:activity", state Vec<SessionActivityState>
}

event_channel! {
    /// Every live agent session on the machine, the host's own marked.
    SessionsOverviewChanged = "sessions:overview", state SessionsOverview
}

event_channel! {
    /// What each hosted session holds: its process tree and its ports.
    SessionResourcesChanged = "sessions:resources", state Vec<SessionResources>
}

event_channel! {
    /// A session ended: its finished row, exit code and duration included.
    SessionExit = "session:exit", event SessionRecord
}

event_channel! {
    /// Bring a session forward, such as when its exit notification is
    /// clicked.
    SessionActivate = "session:activate", event SessionActivation
}

event_channel! {
    /// A live session is about to be ended and the user has to agree first.
    /// Answered on `session:confirmed`.
    SessionConfirm = "session:confirm", event SessionConfirmRequest
}

stream_channel! {
    /// A session's terminal: its output host to client, its input client to
    /// host, as raw bytes.
    SessionTerminal = "session:data", opens SessionStreamOpen, needs Terminal
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct StartSessionRequest {
    /// The folder the session runs in.
    pub cwd: String,
    /// The discovered project this is, when it is one. Recorded, not used to
    /// launch.
    #[serde(default)]
    pub project_path: Option<String>,
    /// Basis for the session's name, made unique against running sessions.
    #[serde(default)]
    pub name: Option<String>,
    /// The agent backend to run, or null for the host's default.
    #[serde(default)]
    pub backend: Option<BackendId>,
    /// Initial grid, from the pane that will host it.
    pub cols: u16,
    pub rows: u16,
}

/// A session from the new-session launcher. The profile goes as an id and a
/// conversation to reopen as its id; the host reads both back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LaunchSessionRequest {
    /// The folder the session runs in. Unused when `resume` is set.
    pub cwd: String,
    #[serde(default)]
    pub project_path: Option<String>,
    /// Basis for the session's name; the folder's name when absent.
    #[serde(default)]
    pub name: Option<String>,
    /// The saved profile whose composition the session is given, or null.
    #[ts(type = "number | null")]
    pub profile_id: Option<u64>,
    /// Null passes no permission flag, whatever the profile says.
    pub permission_mode: Option<PermissionMode>,
    /// A conversation in the history index to reopen, or null for a new one.
    pub resume: Option<String>,
    /// The agent backend to run, or null for the host's default. A resumed
    /// conversation runs on the backend that recorded it.
    #[serde(default)]
    pub backend: Option<BackendId>,
    pub cols: u16,
    pub rows: u16,
}

/// What a launch composed, for anything worth saying before the terminal
/// paints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LaunchedSession {
    pub session: SessionRecord,
    /// Plugin namespaces the session was given, such as `["dev", "api"]`.
    pub overlays: Vec<String>,
    /// Whether composed project instructions were passed.
    pub composed_instructions: bool,
    /// Problems that did not stop the launch.
    pub warnings: Vec<String>,
    /// Parts of the harness the session's backend has no equivalent for, and
    /// so did not get, such as commands for an agent without slash commands.
    #[serde(default)]
    pub not_taken: Vec<HarnessPart>,
}

/// A session the host's last run was hosting when it stopped without shutting
/// down.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RestorableSession {
    /// Its row, now `lost`.
    #[ts(type = "number")]
    pub id: u64,
    /// What its tab said.
    pub name: String,
    pub cwd: String,
    pub branch: Option<String>,
    /// The profile it was launched from, by name, or null for none.
    pub profile: Option<String>,
    /// True when its profile has since been deleted. It reopens without.
    pub profile_gone: bool,
    /// When it was last spoken to, epoch ms, or null when not known.
    #[ts(type = "number | null")]
    pub last_at: Option<u64>,
    /// Why it cannot be reopened, as a sentence, or null when it can.
    pub blocked: Option<String>,
}

/// What a crash took, offered back once. Where each session goes on screen is
/// the client's: the layout belongs to the device, not the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOffer {
    /// In the order their tabs were in.
    pub sessions: Vec<RestorableSession>,
    /// How many more were lost whose conversation is still running elsewhere.
    /// Left alone: reopening one would be a second process on one
    /// conversation.
    pub elsewhere: u32,
}

/// One lost session to reopen, at the grid of the pane it goes back to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionToRestore {
    #[ts(type = "number")]
    pub id: u64,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSessionsRequest {
    /// None at all is "not now".
    pub sessions: Vec<SessionToRestore>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RestoredSession {
    /// The lost row the session reopened.
    #[ts(type = "number")]
    pub from: u64,
    pub launched: LaunchedSession,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct UnrestoredSession {
    #[ts(type = "number")]
    pub id: u64,
    pub name: String,
    /// Why it could not be reopened, as a sentence.
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSessionsResult {
    pub restored: Vec<RestoredSession>,
    pub failed: Vec<UnrestoredSession>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CloseSessionRequest {
    #[ts(type = "number")]
    pub id: u64,
    /// Skip the "still running" confirmation, because the caller already
    /// asked.
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CloseSessionResult {
    /// False when the user declined the confirmation.
    pub closed: bool,
}

/// Renaming a session's tab. Null, or only whitespace, clears the label and
/// the tab reads the session's name again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RenameSessionRequest {
    #[ts(type = "number")]
    pub id: u64,
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionResizeRequest {
    #[ts(type = "number")]
    pub id: u64,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionFocusRequest {
    /// The sessions on screen: the front tab of each pane showing one.
    #[ts(type = "number[]")]
    pub ids: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionsWatchRequest {
    /// False means this client is not looking any more.
    pub watching: bool,
}

/// What a confirmation is about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
pub enum SessionConfirmKind {
    CloseSession,
    Quit,
}

/// "This session is still running": asked by the host, answered by a client
/// on `session:confirmed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfirmRequest {
    /// Correlates the answer with the question.
    #[ts(type = "number")]
    pub id: u64,
    pub kind: SessionConfirmKind,
    pub message: String,
    pub detail: String,
    /// What the agreeing button says.
    pub confirm_label: String,
    /// Names of the sessions this ends, for the dialog to list.
    pub session_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfirmAnswer {
    /// The `id` of the `session:confirm` it answers.
    #[ts(type = "number")]
    pub id: u64,
    pub agreed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivation {
    #[ts(type = "number")]
    pub id: u64,
}

/// Which session's terminal a `session:data` stream carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionStreamOpen {
    #[ts(type = "number")]
    pub id: u64,
}

/// What a live session says it is doing, in its backend's own records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum SessionActivity {
    Busy,
    Shell,
    Idle,
    Waiting,
}

/// What one hosted session is doing. Null activity is ordinary: no record
/// yet, a process not proved alive, or a status the host does not know.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivityState {
    /// The host's session row id.
    #[ts(type = "number")]
    pub id: u64,
    pub activity: Option<SessionActivity>,
    /// The agent's own sentence for a `waiting` session. Null otherwise.
    pub waiting_for: Option<String>,
    /// The conversation id the agent reports now. Not necessarily the
    /// record's: a cleared conversation gets a new one in the same process.
    pub conversation_id: Option<String>,
}

/// One live agent session on the machine, whoever started it. Listing is
/// machine-wide; anything richer hangs off `hostSessionId`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct LiveSession {
    /// The host's session row id, or null for a session the host does not
    /// run.
    #[ts(type = "number | null")]
    pub host_session_id: Option<u64>,
    /// The backend whose records list it.
    pub backend: BackendId,
    /// The pid it registered under, or the terminal's pid for a hosted
    /// session with no record yet.
    pub pid: u32,
    /// Whether the backend's record for it was found.
    pub registered: bool,
    pub cwd: Option<String>,
    pub name: Option<String>,
    pub activity: Option<SessionActivity>,
    pub waiting_for: Option<String>,
    /// When the status was last published, epoch ms.
    #[ts(type = "number | null")]
    pub status_since_ms: Option<u64>,
    /// The agent version that wrote the record.
    pub version: Option<String>,
    /// How the agent was run, in its own words, such as `cli`.
    pub entrypoint: Option<String>,
    #[ts(type = "number | null")]
    pub started_at_ms: Option<u64>,
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionsOverview {
    /// Hosted first, then the rest; each group by start time, newest last.
    pub sessions: Vec<LiveSession>,
    /// When the records were read, epoch ms.
    #[ts(type = "number")]
    pub read_at_ms: u64,
}

/// One process in a hosted session's tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionProcess {
    pub pid: u32,
    pub parent_pid: u32,
    /// The image name, such as `docker.exe`.
    pub name: String,
    /// The full command line, or null where the OS would not give it up.
    pub command_line: Option<String>,
    /// How far below the session's own process this sits. The root is 0.
    pub depth: u32,
    /// Listening ports, ascending, or null where the socket query could not
    /// run. Never merged with `[]`.
    pub ports: Option<Vec<u16>>,
}

/// A listening socket held somewhere in a session's process tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionPort {
    pub port: u16,
    pub pid: u32,
    /// The image name of the process holding it.
    pub process: String,
    /// Every local address it is bound to, sorted.
    pub addresses: Vec<String>,
}

/// What one hosted session is holding. "Could not look" is null and "nothing
/// there" is empty, and the two are never merged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionResources {
    #[ts(type = "number")]
    pub id: u64,
    /// The terminal's pid: the root of the tree.
    pub root_pid: u32,
    /// The tree under `rootPid`, root first then breadth-first, or null.
    pub processes: Option<Vec<SessionProcess>>,
    /// Whether `rootPid` was in the enumeration.
    pub root_seen: bool,
    pub ports: Option<Vec<SessionPort>>,
    /// How many processes in the tree would not give up a command line.
    pub opaque: u32,
    /// When the pass ran, epoch ms.
    #[ts(type = "number")]
    pub at_ms: u64,
}
