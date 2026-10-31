//! Plugins and plugin secrets: `plugins:*` and `secrets:*` in
//! `shared/ipc.ts`.
//!
//! How the ipc.ts channels map onto the protocol:
//!
//! - Plugins split along the line they already have. A plugin is registered,
//!   switched and read on the host, and its services and exec run there;
//!   plugin pages render in a client that declared `pluginPages`. So the
//!   channels between a page and the host (`plugins:call`, `plugins:cancel`,
//!   `plugins:answer`), the host's pushes to pages (`plugins:ui`,
//!   `plugins:deliver`) and the page files a client frames (`plugins:file`)
//!   need that capability. A background page's own wires to whatever runs it
//!   never cross the protocol:
//!   [`HOST_INTERNAL`](super::boundary::HOST_INTERNAL).
//! - `plugins:file` is not in ipc.ts: the desktop's main process answered its
//!   frames' page loads from the plugin's folder in its own protocol handler.
//!   A client whose plugins are on the host asks the host for each file
//!   instead, a piece of at most [`PLUGIN_FILE_PIECE_LEN`] bytes at a time,
//!   and keeps it for the plugin's version and the host's revision of its
//!   read.
//! - Fire-and-forget sends (`plugins:cancel`, `plugins:answer`) are requests,
//!   so a client learns when one did not land.
//! - A plugin's `BroadcastChannel`s span every client and its background, so
//!   they need no channel of their own: a page's post is a `plugins:call` of
//!   the bridge's [`PLUGIN_CHANNEL_POST`], and the host hands it on as a
//!   `channel` delivery on `plugins:deliver`.
//! - Whole-state pushes (`plugins:changed`, `secrets:changed`) are events that
//!   carry state: a subscription starts with a snapshot of every plugin, or of
//!   the secrets list.
//! - Where ipc.ts opened a native dialog (`plugins:add`), the dialog stays in
//!   the client and the channel takes the folder it produced.
//! - The theme plugin pages see is the client's own:
//!   [`CLIENT_ONLY`](super::boundary::CLIENT_ONLY).
//!
//! Secret values cross in one direction only: in, on `secrets:save`. No
//! payload here has a field that carries one back.

use std::borrow::Cow;
use std::collections::BTreeMap;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use ts_rs::TS;

use crate::bytes::Bytes;
use crate::channel::Catalogue;
use crate::channels::common::SessionRecord;
use crate::message::Payload;

#[cfg(test)]
mod tests;

pub fn declare(catalogue: &mut Catalogue) {
    catalogue
        .request::<PluginsList>()
        .request::<PluginsAdd>()
        .request::<PluginsRemove>()
        .request::<PluginsSetEnabled>()
        .request::<PluginsSetTools>()
        .request::<PluginsReload>()
        .request::<PluginsSetSetting>()
        .request::<PluginsCall>()
        .request::<PluginsSession>()
        .request::<PluginsCommand>()
        .request::<PluginsMetrics>()
        .request::<PluginsLog>()
        .request::<PluginsOwnSecrets>()
        .request::<PluginsCancel>()
        .request::<PluginsAnswer>()
        .request::<PluginsFile>()
        .event::<PluginsChanged>()
        .event::<PluginsUi>()
        .event::<PluginsDeliver>()
        .request::<SecretsList>()
        .request::<SecretsSave>()
        .request::<SecretsRemove>()
        .event::<SecretsChanged>();
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

request_channel! {
    /// Every registered plugin folder: all a client draws plugins from.
    PluginsList = "plugins:list", () => Vec<PluginInfo>
}
request_channel! {
    /// Registers a plugin folder and reads it. A folder with no manifest is
    /// refused; one whose manifest is wrong is registered and shown with what
    /// is wrong, so it can be fixed in place and reloaded.
    PluginsAdd = "plugins:add", PluginAddRequest => PluginAddResult
}
request_channel! {
    PluginsRemove = "plugins:remove", PluginRemoveRequest => Vec<PluginInfo>
}
request_channel! {
    PluginsSetEnabled = "plugins:setEnabled", PluginSwitchRequest => Vec<PluginInfo>
}
request_channel! {
    /// Whether the sessions the host starts are offered the plugin's tools.
    /// Off takes them from running sessions too; on reaches the sessions
    /// started after it.
    PluginsSetTools = "plugins:setTools", PluginSwitchRequest => Vec<PluginInfo>
}
request_channel! {
    /// Reads the folder again. Every page of the plugin reloads and its
    /// service restarts.
    PluginsReload = "plugins:reload", PluginPathRequest => Vec<PluginInfo>
}
request_channel! {
    /// One value on a plugin's settings page, or null to go back to the
    /// manifest's default.
    PluginsSetSetting = "plugins:setSetting", PluginSetSettingRequest => Vec<PluginInfo>
}
request_channel! {
    /// A bridge call from a plugin page, relayed by the client framing it.
    PluginsCall = "plugins:call", PluginCallRequest => PluginCallOutcome, needs PluginPages
}
request_channel! {
    /// The answer to a plugin's request to start a session: started, with the
    /// session's record, or cancelled, with nothing. The host composes the
    /// launch from what the plugin asked for and it checked, never from this
    /// request.
    PluginsSession = "plugins:session", PluginSessionAnswer => Option<SessionRecord>
}
request_channel! {
    /// A Quick Open command with no tab, for the plugin's background page.
    PluginsCommand = "plugins:command", PluginCommandRequest => ()
}
request_channel! {
    /// Memory and CPU per plugin. Asked while a plugin's settings page is
    /// open, never polled otherwise.
    PluginsMetrics = "plugins:metrics", () => Vec<PluginMetrics>
}
request_channel! {
    /// What the plugin's service printed and what the host noted about it,
    /// oldest first.
    PluginsLog = "plugins:log", PluginPathRequest => Vec<PluginLogLine>
}
request_channel! {
    /// The stored secret keys no other plugin may use: what removing this one
    /// offers to delete.
    PluginsOwnSecrets = "plugins:ownSecrets", PluginPathRequest => Vec<String>
}
request_channel! {
    /// A plugin page aborted a call it made: a fetch's `AbortSignal`, a page
    /// that went away.
    PluginsCancel = "plugins:cancel", PluginCancelRequest => (), needs PluginPages
}
request_channel! {
    /// The secret dialog a plugin asked for has closed; the host answers the
    /// plugin's call.
    PluginsAnswer = "plugins:answer", PluginAnswerRequest => (), needs PluginPages
}
request_channel! {
    /// One file of a plugin's pages, from `offset` on: its status, its
    /// content type, the plugin's version and revision it was read at, and
    /// at most [`PLUGIN_FILE_PIECE_LEN`] bytes of it. A refusal is an answer
    /// with its status, not an error, so a frame sees the 403 and 404 it
    /// always has.
    PluginsFile = "plugins:file", PluginFileRequest => PluginFile, needs PluginPages
}
event_channel! {
    /// Every plugin folder, after anything about any of them moved.
    PluginsChanged = "plugins:changed", state Vec<PluginInfo>
}
event_channel! {
    /// A plugin asked for something only a client can do: open a tab, ask for
    /// a secret, confirm a session, open a link.
    PluginsUi = "plugins:ui", event PluginUiRequest, needs PluginPages
}
event_channel! {
    /// An event for a plugin's pages, which each client delivers to the frames
    /// it holds.
    PluginsDeliver = "plugins:deliver", event PluginDelivery, needs PluginPages
}
request_channel! {
    SecretsList = "secrets:list", () => SecretsState
}
request_channel! {
    /// Fails with the sentence the form shows: an unreadable origin, no
    /// encryption on the host.
    SecretsSave = "secrets:save", SecretInput => SecretsState
}
request_channel! {
    SecretsRemove = "secrets:remove", SecretRemoveRequest => SecretsState
}
event_channel! {
    /// The secrets list moved: a save, a removal, from any client. No values,
    /// ever.
    SecretsChanged = "secrets:changed", state SecretsState
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/// The folder a client's picker produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginAddRequest {
    /// An absolute path on the host.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginAddResult {
    /// The folder asked for.
    pub path: String,
    /// Why it was not added, as a sentence.
    pub error: Option<String>,
    pub plugins: Vec<PluginInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginRemoveRequest {
    pub path: String,
    /// Keys only this plugin could use, which the user chose to delete with it.
    pub delete_secrets: Vec<String>,
}

/// One plugin folder and a switch: enabled, or its tools offered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginSwitchRequest {
    pub path: String,
    pub enabled: bool,
}

/// One plugin folder, as registered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginPathRequest {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginSetSettingRequest {
    /// The plugin's id.
    pub plugin: String,
    pub key: String,
    pub value: PluginSettingValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginCallRequest {
    /// The plugin's id, established by the client from the frame the call came
    /// from; nothing the plugin wrote decides it.
    pub plugin: String,
    pub surface: PluginSurfaceKind,
    pub method: String,
    #[schemars(with = "Vec<serde_json::Value>")]
    #[ts(type = "unknown[]")]
    pub args: Vec<Payload>,
    /// Chosen by the client, so `plugins:cancel` can name the call.
    pub call_id: String,
}

/// What a bridge call came to: its value, or why it failed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum PluginCallOutcome {
    Ok {
        #[ts(type = "true")]
        ok: Flag<true>,
        #[schemars(with = "serde_json::Value")]
        #[ts(type = "unknown")]
        value: Payload,
    },
    Failed {
        #[ts(type = "false")]
        ok: Flag<false>,
        code: PluginErrorCode,
        message: String,
    },
}

impl PluginCallOutcome {
    pub fn ok(value: Payload) -> Self {
        Self::Ok { ok: Flag, value }
    }

    pub fn failed(code: PluginErrorCode, message: impl Into<String>) -> Self {
        Self::Failed {
            ok: Flag,
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginSessionAnswer {
    /// The `requestId` of the `session` UI request this answers.
    pub request_id: String,
    /// Whether the user started it.
    pub start: bool,
    /// The terminal size the client will draw it at.
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommandRequest {
    /// The plugin's id.
    pub plugin: String,
    /// The command's id in the manifest.
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginCancelRequest {
    pub call_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginAnswerRequest {
    pub request_id: String,
}

/// The most body bytes one `plugins:file` answer carries: 4 MiB, a quarter of
/// [`MAX_FRAME_LEN`](crate::MAX_FRAME_LEN), which leaves the rest of the
/// answer and the framing all the room they need.
pub const PLUGIN_FILE_PIECE_LEN: u64 = 4 * 1024 * 1024;

/// A file a plugin page loads, by the plugin and the path on its origin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginFileRequest {
    /// The plugin's id: the host of its `helm-plugin://<id>/` origin, which
    /// the client established from the frame, never from what the page asked.
    pub plugin: String,
    /// The path on that origin, percent-decoded, without its leading `/`:
    /// `panel/index.html`. The host resolves it inside the plugin's folder.
    pub path: String,
    /// Where in the file to start. Left out, it starts at the first byte, so
    /// a file within one piece takes one request.
    #[serde(default)]
    #[ts(type = "number")]
    pub offset: u64,
}

/// One file of a plugin's pages, or the part of it from an offset.
///
/// A client reads from `offset + body.length` until it holds `totalBytes`.
/// An offset at or past the end answers 200 with an empty body. A refusal
/// answers its whole text whatever the offset. A client keeps a file it read
/// for this `version` and `revision`; once either moves, it asks again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginFile {
    /// 200, or the refusal: 403 for a path outside the plugin's folder, 404
    /// for a file that is not there or a plugin that is not on.
    pub status: u16,
    /// What the file is served as, from its extension, or `text/plain` for
    /// a refusal's text.
    pub content_type: String,
    /// The plugin's version, as its manifest says it. Null when it says none
    /// or no plugin that is on has this id.
    pub version: Option<String>,
    /// The host's revision of its read of the plugin's folder, as
    /// `plugins:list` gives it. 0 when no plugin that is on has this id.
    #[ts(type = "number")]
    pub revision: u64,
    /// The length of the whole file, or of the whole refusal.
    #[ts(type = "number")]
    pub total_bytes: u64,
    pub body: Bytes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecretRemoveRequest {
    pub key: String,
}

// ---------------------------------------------------------------------------
// Events to plugin pages
// ---------------------------------------------------------------------------

/// The host asking a client to do something a plugin asked for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PluginUiRequest {
    /// Open one of the plugin's tabs.
    OpenTab {
        plugin: String,
        tab: String,
        params: PluginParams,
        title: Option<String>,
        /// Opened as the preview, which the next one opened that way replaces.
        preview: bool,
    },
    /// Ask the user for a secret. Answered on `plugins:answer` when the
    /// dialog closes.
    Secret {
        request_id: String,
        plugin: String,
        key: String,
        /// The plugin's own origins, offered as the hosts the value may go to.
        hosts: Vec<String>,
    },
    /// Ask the user to start a session. Answered on `plugins:session`.
    Session {
        request_id: String,
        plugin: String,
        /// Checked by the host: an absolute path to a folder that exists.
        cwd: String,
        /// One line, said as the session's first message.
        prompt: String,
        /// What the session is called, before it is made unique among the
        /// running ones.
        name: String,
    },
    /// The request went away before it was answered: its page closed, or the
    /// plugin was turned off.
    SessionWithdrawn { request_id: String },
    /// An `https` address to open in the client's browser, from a click in
    /// the plugin's page. The client holds it to its reach rule like any
    /// other address.
    Link { plugin: String, url: String },
}

/// An event for a plugin's pages, by event name. Each client framing the
/// plugin delivers it to its own frames.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum PluginDelivery {
    /// The user changed the plugin's settings.
    Settings {
        plugin: String,
        data: BTreeMap<String, PluginSettingValue>,
        to: PluginDeliveryTarget,
    },
    /// A secret the manifest declares was stored, permitted, refused or
    /// removed. Every declared key's state.
    Secrets {
        plugin: String,
        data: BTreeMap<String, PluginPageSecretState>,
        to: PluginDeliveryTarget,
    },
    /// A command with no tab was chosen in Quick Open.
    Command {
        plugin: String,
        data: PluginCommandEvent,
        to: PluginDeliveryTarget,
    },
    /// A session started, ended, was renamed or changed what it is doing.
    /// Every session the plugin may see.
    Sessions {
        plugin: String,
        data: Vec<PluginSession>,
        to: PluginDeliveryTarget,
    },
    /// One of the plugin's pages, on any client, or its background posted on
    /// a `BroadcastChannel`. Every page of the plugin hears it on its
    /// channels of that name, except the channel that posted it.
    Channel {
        plugin: String,
        data: PluginChannelMessage,
        to: PluginDeliveryTarget,
    },
}

/// The bridge method a page's `BroadcastChannel.postMessage` is relayed
/// through, on `plugins:call`, with the arguments `[name, message, token]`
/// of [`PluginChannelMessage`]. It is the bridge's own, not part of the API a
/// plugin calls: the host refuses it for anything but a well-formed post and
/// answers `null` once the post is on its way.
pub const PLUGIN_CHANNEL_POST: &str = "channel.post";

/// A message posted on one of a plugin's `BroadcastChannel`s.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginChannelMessage {
    /// The channel's name, as the page opened it.
    pub name: String,
    /// What was posted, limited to what the protocol carries: the bridge
    /// throws a `DataCloneError` for anything else, as structured clone does,
    /// and nothing is sent.
    #[schemars(with = "serde_json::Value")]
    #[ts(type = "unknown")]
    pub message: Payload,
    /// Chosen by the bridge for the channel object that posted, so that one
    /// is skipped and other channels of that name in the same page still
    /// hear it.
    pub token: String,
}

/// Which of a plugin's pages a delivery is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginDeliveryTarget {
    All,
    Background,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommandEvent {
    pub id: String,
}

/// A declared secret's state as the plugin sees it. `missing` covers both
/// not stored and stored without permission for this plugin, which the
/// plugin is not told apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginPageSecretState {
    Ready,
    Missing,
}

/// One session the host started since it opened, as a plugin may see it.
/// Nothing of its conversation: no prompt, no output, no transcript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginSession {
    /// The same id a tool call from this session carries. It means nothing
    /// outside the host and does not survive a restart.
    pub id: String,
    pub name: String,
    pub cwd: String,
    pub state: PluginSessionState,
    /// What the agent says it is doing. Null when it has ended, or the host
    /// cannot tell.
    pub activity: Option<PluginSessionActivity>,
    /// Since when `activity` has held, epoch ms. Null when the host cannot
    /// tell.
    #[ts(type = "number | null")]
    pub activity_since: Option<u64>,
    /// Epoch ms.
    #[ts(type = "number")]
    pub started_at: u64,
    /// Epoch ms, or null while it runs.
    #[ts(type = "number | null")]
    pub ended_at: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginSessionState {
    Running,
    Ended,
}

/// `busy` working, `idle` done and waiting for the user's next message,
/// `waiting` for the user to answer something, `shell` running a command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginSessionActivity {
    Busy,
    Idle,
    Waiting,
    Shell,
}

// ---------------------------------------------------------------------------
// What a client draws of a plugin
// ---------------------------------------------------------------------------

/// One registered plugin folder, as a client draws it.
///
/// A folder whose manifest could not be read is still here, with `error`
/// saying why and every surface empty, so Settings can show it and offer
/// Reload. Only a plugin that is `enabled` with no `error` has surfaces on
/// screen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    /// The folder, as registered. The key Settings acts on.
    pub path: String,
    /// Null when the manifest did not say one the host could read.
    pub id: Option<String>,
    pub name: String,
    pub version: Option<String>,
    pub description: Option<String>,
    pub enabled: bool,
    /// Why it is not loaded: no manifest, an unsupported `apiVersion`, a file
    /// that is not built.
    pub error: Option<String>,
    pub warnings: Vec<String>,
    /// Bumped at every read of the folder. A page whose plugin moved on
    /// reloads.
    #[ts(type = "number")]
    pub revision: u64,
    /// The rail icon as a `data:` URL, drawn as a mask.
    pub icon: Option<String>,
    pub rail: Option<PluginRail>,
    pub panels: BTreeMap<String, PluginPanelInfo>,
    pub tabs: BTreeMap<String, PluginTabInfo>,
    /// Its tabs open as pages in one tab of its own, not a tab each.
    pub page_strip: bool,
    pub background: Option<PluginBackgroundInfo>,
    pub commands: Vec<PluginCommandInfo>,
    pub settings: Vec<PluginSettingSpec>,
    /// The values the page shows: what the user set, else the manifest's
    /// default, else null.
    pub setting_values: BTreeMap<String, PluginSettingValue>,
    /// The origins the plugin's fetch may reach, canonical.
    pub network: Vec<String>,
    pub secrets: Vec<PluginSecretInfo>,
    pub exec: Vec<PluginExecInfo>,
    pub service: Option<PluginServiceInfo>,
    /// It declares a program or a service: what it runs, runs with the user's
    /// rights.
    pub runs_programs: bool,
    /// The tools it offers sessions; null when its manifest declares none.
    pub agent: Option<PluginAgentInfo>,
    /// Its pages may ask to start a session, which the user confirms each
    /// time.
    pub starts_sessions: bool,
    /// Its pages may see the host's sessions: names, folders, and whether each
    /// is working.
    pub sees_sessions: bool,
    pub status: Option<PluginStatusItem>,
    pub badge: Option<u32>,
}

/// The plugin's place on the rail: its title and the panel it opens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginRail {
    pub title: String,
    pub panel: String,
}

/// A sidebar panel: the client's header, the plugin's page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginPanelInfo {
    pub title: String,
    /// The page, on the plugin's own origin.
    pub url: String,
    pub actions: Vec<PluginPanelAction>,
}

/// An icon button in a panel's header. A press arrives as the page's `action`
/// event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginPanelAction {
    pub id: String,
    /// Its tooltip and accessible name.
    pub title: String,
    pub icon: PluginPanelActionIcon,
}

/// The icons a panel action may use: the client's own, so the header looks
/// like every other header.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginPanelActionIcon {
    Refresh,
    Plus,
    Search,
    List,
    Settings,
    External,
    Pin,
    Edit,
    Trash,
    Link,
    Eye,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginTabInfo {
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginBackgroundInfo {
    pub url: String,
    pub state: PluginBackgroundState,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginBackgroundState {
    Stopped,
    Starting,
    Running,
    Crashed,
}

/// A Quick Open command the manifest declares.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommandInfo {
    pub id: String,
    pub title: String,
    /// The tab it opens, or null for a command that arrives as the `command`
    /// event.
    pub tab: Option<String>,
}

/// One field on a plugin's settings page, as its manifest declares it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PluginSettingSpec {
    Text {
        key: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        default: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        placeholder: Option<String>,
    },
    Number {
        key: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        default: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        min: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        max: Option<f64>,
    },
    Toggle {
        key: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        description: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        default: Option<bool>,
    },
    Select {
        key: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        description: Option<String>,
        options: Vec<PluginSelectOption>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        default: Option<String>,
    },
    /// The state of a secret the plugin needs, with a way to add it. Holds no
    /// value of its own.
    Secret {
        key: String,
        label: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        description: Option<String>,
        /// A key from the manifest's `secrets`.
        secret: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginSelectOption {
    pub value: String,
    pub label: String,
}

/// A declared secret and whether the plugin can use it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginSecretInfo {
    pub key: String,
    pub state: PluginSecretState,
}

/// Whether a secret the manifest declares can be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginSecretState {
    Ready,
    Missing,
    NotAllowed,
}

/// A program the manifest names, with its fixed leading arguments.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginExecInfo {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginServiceInfo {
    pub kind: PluginServiceKind,
    pub command: String,
    pub start: PluginServiceStart,
    pub state: PluginServiceState,
    pub pid: Option<u32>,
    pub port: Option<u16>,
    /// Restarts after a crash, this run.
    pub restarts: u32,
    pub error: Option<String>,
}

/// `node`: run by the host's own Node. `command`: any program.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginServiceKind {
    Command,
    Node,
}

/// When the service starts: with the plugin, or on its first request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginServiceStart {
    Enable,
    Demand,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginServiceState {
    Stopped,
    Starting,
    Running,
    Crashed,
    Failed,
}

/// What a plugin offers the sessions the host starts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginAgentInfo {
    /// The user's switch: whether new sessions are offered these tools.
    pub enabled: bool,
    /// The MCP server they appear under in a session.
    pub server: String,
    pub instructions: Option<String>,
    pub tools: Vec<PluginToolInfo>,
}

/// One tool as the manifest declares it: enough for a client whose plugin
/// pages answer its calls to offer it on `agentPlugin:offer`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginToolInfo {
    pub name: String,
    pub description: String,
    /// Its arguments' JSON Schema, an object.
    #[schemars(with = "serde_json::Value")]
    #[ts(type = "unknown")]
    pub input_schema: Payload,
    /// The manifest marks it as changing nothing.
    pub read_only: bool,
}

/// The plugin's item on the status bar. Clicking it opens the plugin's rail
/// panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginStatusItem {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tone: Option<PluginStatusTone>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tooltip: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginStatusTone {
    Neutral,
    Accent,
    Success,
    Warn,
    Danger,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginMetrics {
    pub path: String,
    pub plugin: String,
    /// Working set across the plugin's page processes and its service. Null:
    /// could not look.
    #[ts(type = "number | null")]
    pub memory_kb: Option<u64>,
    /// Null: could not look.
    pub cpu_percent: Option<f64>,
    pub processes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct PluginLogLine {
    /// ISO 8601.
    pub at: String,
    pub stream: PluginLogStream,
    pub text: String,
}

/// Where a log line came from: the service's output, its errors, or the host
/// noting something about it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginLogStream {
    Out,
    Err,
    Host,
}

// ---------------------------------------------------------------------------
// The plugin bridge's vocabulary
// ---------------------------------------------------------------------------

/// Which kind of plugin page a call came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum PluginSurfaceKind {
    Panel,
    Tab,
    Background,
}

/// Why a bridge call failed: the `code` a plugin page's rejected promise
/// carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
pub enum PluginErrorCode {
    /// The URL, command or tab is not declared in the manifest.
    NotDeclared,
    /// A secret is not stored, not permitted for this plugin, or not bound to
    /// the request's host.
    Secret,
    /// The request could not be made or did not complete.
    Network,
    Timeout,
    Aborted,
    /// The arguments were not what the method takes.
    Invalid,
    /// The plugin is disabled, or the host is shutting down.
    Unavailable,
    /// The service is not running and could not be started.
    Service,
    /// A program the manifest names was not found on the host.
    NotFound,
    /// The call needs a click or key press the user just made in the page,
    /// and there was none.
    NotAllowed,
    /// The same request is already waiting on the user, or a link was opened
    /// a moment ago.
    Busy,
}

/// A value on a plugin's settings page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum PluginSettingValue {
    Toggle(bool),
    Number(f64),
    Text(String),
    Unset,
}

/// A tab's parameters: part of its identity, so the same tab with other
/// parameters is another tab.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(transparent)]
pub struct PluginParams(pub BTreeMap<String, PluginParamValue>);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(untagged)]
pub enum PluginParamValue {
    Flag(bool),
    Number(f64),
    Text(String),
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/// A stored secret, without its value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecretInfo {
    pub key: String,
    /// Canonical origins the value may be sent to.
    pub hosts: Vec<String>,
    /// Plugin ids that may use it.
    pub plugins: Vec<String>,
    /// ISO 8601.
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecretInput {
    pub key: String,
    /// Null keeps the stored value: changing who may use a secret is not
    /// typing it again.
    pub value: Option<String>,
    pub hosts: Vec<String>,
    pub plugins: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SecretsState {
    /// Whether the host can encrypt. When it cannot, nothing can be stored.
    pub available: bool,
    pub secrets: Vec<SecretInfo>,
}

// ---------------------------------------------------------------------------
// A boolean that can only be one value
// ---------------------------------------------------------------------------

/// A boolean field that is always `V`: the `ok` of [`PluginCallOutcome`],
/// which tells its two shapes apart on the wire. Decoding the other value
/// fails, so an untagged enum picks the right shape.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Flag<const V: bool>;

impl<const V: bool> Serialize for Flag<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(V)
    }
}

impl<'de, const V: bool> Deserialize<'de> for Flag<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if bool::deserialize(deserializer)? == V {
            Ok(Flag)
        } else {
            Err(serde::de::Error::custom(format_args!("expected `{V}`")))
        }
    }
}

impl<const V: bool> JsonSchema for Flag<V> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        if V { "True".into() } else { "False".into() }
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        json_schema!({ "type": "boolean", "const": V })
    }
}
