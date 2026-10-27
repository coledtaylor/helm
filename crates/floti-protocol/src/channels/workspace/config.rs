//! The config console: `config:*` and `editor:highlight`.
//!
//! Every write is snapshotted first and checked against the hash the editor
//! read, so an edit made outside the console is a conflict rather than lost.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{Millis, RenderedMarkdown};

request_channel!(ListConfigScopes = "config:scopes", () => Vec<ConfigScope>);
request_channel!(ReadConfigTree = "config:tree", ConfigScopeRef => ConfigTree);
request_channel!(ReadConfigFile = "config:read", ConfigPath => ConfigFileContent);
request_channel!(
    /// The same bytes rendered: markdown as HTML, a hook highlighted. Takes
    /// the source, so one channel serves the file on disk and a draft.
    RenderConfigFile = "config:render", SourceToRender => ConfigRendered
);
request_channel!(WriteConfigFile = "config:write", WriteConfigRequest => WriteConfigResult);
request_channel!(
    /// Versions of one file, newest first, without their contents.
    ListConfigSnapshots = "config:snapshots", ScopedFile => Vec<ConfigSnapshotMeta>
);
request_channel!(
    /// The bytes of one version, or null when there is no such version.
    ReadConfigSnapshot = "config:snapshot", SnapshotRef => Option<SnapshotContent>
);
request_channel!(
    RestoreConfigSnapshot = "config:restore", RestoreSnapshotRequest => WriteConfigResult
);
request_channel!(
    /// Which file the client's editor has open, so a change made outside it
    /// arrives on `config:externalChange` before the user saves over it.
    WatchConfigFile = "config:watch", WatchConfigRequest => ()
);
request_channel!(CreateConfigFile = "config:create", CreateConfigRequest => CreateConfigResult);
request_channel!(
    /// Moves a skill's whole folder, or a command across its namespace path.
    RenameConfigFile = "config:rename", RenameConfigRequest => RenameConfigResult
);
request_channel!(
    /// Snapshots first, then removes. Each row is restorable.
    DeleteConfigFile = "config:delete", DeleteConfigRequest => DeleteConfigResult
);
request_channel!(
    /// What a session started here would actually be given.
    ReadEffectiveView = "config:effective", EffectiveViewRequest => EffectiveView
);
request_channel!(
    /// What the file would look like after adding a server, before anything
    /// runs.
    PreviewMcpServer = "config:mcpPreview", McpAddRequest => McpPreview
);
request_channel!(AddMcpServer = "config:mcpAdd", McpAddRequest => McpResult);
request_channel!(RemoveMcpServer = "config:mcpRemove", McpRemoveRequest => McpResult);
request_channel!(
    /// Approves or revokes a `.mcp.json` server for a project.
    ApproveMcpServer = "config:mcpApprove", McpApproveRequest => WriteConfigResult
);
request_channel!(
    /// Lists the servers with a health check of each, so it is slow.
    ListMcpServers = "config:mcpList", McpListRequest => McpResult
);
request_channel!(RunDoctor = "config:doctor", () => DoctorReport);
event_channel!(
    /// The file the client's editor has open changed on disk, and the host
    /// did not change it.
    ConfigChangedOutside = "config:externalChange", event ConfigExternalChange
);
request_channel!(
    /// A draft, tokenised per line for an editor's underlay. Opens no file
    /// and writes none.
    HighlightSource = "editor:highlight", SourceToRender => EditorHighlight
);

/// Where a config tree sits in the precedence chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ConfigScopeKind {
    User,
    Harness,
    Project,
}

/// One config tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConfigScope {
    pub kind: ConfigScopeKind,
    /// The folder config resolves from; for `user`, the home folder.
    pub path: String,
    /// The `.claude` folder.
    pub claude_dir: String,
    pub label: String,
    pub exists: bool,
}

/// A config scope, by its base folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConfigScopeRef {
    pub scope_path: String,
}

/// A file, by absolute path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConfigPath {
    pub path: String,
}

/// What a file in a config tree is, as the agent resolves it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
pub enum ConfigFileKind {
    Skill,
    Command,
    Agent,
    Workflow,
    Hook,
    Settings,
    SettingsLocal,
    ClaudeMd,
    Mcp,
    Rule,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFile {
    pub path: String,
    /// Relative to the scope's base folder, forward-slashed.
    pub rel_path: String,
    pub kind: ConfigFileKind,
    /// How it is addressed: a skill's folder name, a command's namespace
    /// path, or the file name.
    pub name: String,
    #[ts(type = "number")]
    pub size: u64,
    pub mtime_ms: Millis,
    /// `description:` from the frontmatter, when there is one.
    pub description: Option<String>,
    /// A file the console will not offer to edit as text.
    pub binary: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConfigTree {
    pub scope: ConfigScope,
    pub files: Vec<ConfigFile>,
    /// Folders that could not be read; the rest of the tree stands.
    pub errors: Vec<String>,
    pub scanned_at: String,
}

/// A file's bytes, with the hash every write is checked against.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFileContent {
    pub path: String,
    pub exists: bool,
    pub content: String,
    /// sha256 of the bytes on disk, hex.
    pub hash: String,
    #[ts(type = "number")]
    pub size: u64,
    pub mtime_ms: Millis,
    /// The bytes are not text; an editor refuses these.
    pub binary: bool,
}

/// Why a snapshot was taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum ConfigWriteReason {
    Edit,
    Create,
    Restore,
    Mcp,
    Approve,
    Rename,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshotMeta {
    #[ts(type = "number")]
    pub id: u64,
    pub scope_path: String,
    /// Relative to `scopePath`, forward-slashed.
    pub file_path: String,
    pub content_hash: String,
    #[ts(type = "number")]
    pub bytes: u64,
    pub reason: ConfigWriteReason,
    pub created_at: String,
}

/// One file in a scope: whose versions to list, or which file to open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ScopedFile {
    pub scope_path: String,
    pub path: String,
}

/// A snapshot, by id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRef {
    #[ts(type = "number")]
    pub id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotContent {
    pub content: String,
}

/// Puts a snapshot's bytes back at `path`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSnapshotRequest {
    #[ts(type = "number")]
    pub id: u64,
    pub path: String,
}

/// Text to render or highlight as the file at `path` would be. The text is
/// what is in the editor, which may not be on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SourceToRender {
    pub path: String,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WriteConfigRequest {
    /// The scope's base folder, recorded on the snapshot.
    pub scope_path: String,
    pub path: String,
    pub content: String,
    /// The hash the editor's content came from, or null for a file it knows
    /// does not exist yet. A mismatch stops the write.
    pub expected_hash: Option<String>,
    pub reason: ConfigWriteReason,
}

/// The file on disk is not what the editor was based on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WriteConflict {
    pub on_disk_hash: String,
    pub on_disk_content: String,
    pub mtime_ms: Millis,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WriteConfigResult {
    pub ok: bool,
    /// The file after the write, or as it stands when the write was refused.
    pub file: ConfigFileContent,
    /// The snapshot taken first, or null when nothing was written.
    #[ts(type = "number | null")]
    pub snapshot_id: Option<u64>,
    /// The bytes were already what was asked for.
    pub unchanged: bool,
    /// Set when the file on disk is not what the editor was based on.
    #[serde(default)]
    pub conflict: Option<WriteConflict>,
    /// Set when the write was refused for another reason.
    #[serde(default)]
    pub error: Option<String>,
}

/// A config file the console can create.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "kebab-case")]
pub enum CreatableKind {
    Skill,
    Command,
    Agent,
    Rule,
    Settings,
    SettingsLocal,
    ClaudeMd,
    Mcp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateConfigRequest {
    pub scope_path: String,
    pub kind: CreatableKind,
    /// Ignored for the kinds with a fixed name.
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct CreateConfigResult {
    pub ok: bool,
    /// The file that now exists.
    pub path: Option<String>,
    pub rel_path: Option<String>,
    #[ts(type = "number | null")]
    pub snapshot_id: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RenameConfigRequest {
    pub scope_path: String,
    /// The addressed file: a skill's `SKILL.md`, not its folder.
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct MovedFile {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RenameConfigResult {
    pub ok: bool,
    /// The addressed file at its new place, or null when nothing moved.
    pub path: Option<String>,
    pub rel_path: Option<String>,
    /// Every file that moved.
    pub moved: Vec<MovedFile>,
    #[ts(type = "Array<number>")]
    pub snapshot_ids: Vec<u64>,
    /// The moved file's frontmatter `name:` was updated to match.
    pub frontmatter_renamed: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeleteConfigRequest {
    pub scope_path: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeletedConfigFile {
    pub path: String,
    pub rel_path: String,
    #[ts(type = "number")]
    pub snapshot_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct DeleteConfigResult {
    pub ok: bool,
    /// What came off the disk, each with the snapshot that can put it back.
    pub removed: Vec<DeletedConfigFile>,
    pub error: Option<String>,
}

/// Which file the client's editor has open, or null to release the watch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct WatchConfigRequest {
    pub path: Option<String>,
}

/// A file an editor has open was changed by something other than the host.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConfigExternalChange {
    pub path: String,
    /// sha256 of the bytes now on disk, or empty when it was removed.
    pub hash: String,
    pub exists: bool,
    pub mtime_ms: Millis,
}

/// Where a resolved entry came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum EffectiveSource {
    User,
    Cwd,
    Overlay,
}

/// One skill, command, agent or workflow as a session would address it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveEntry {
    /// What you type: `acme:think`, or `think` unprefixed.
    pub invocation: String,
    pub name: String,
    pub source: EffectiveSource,
    /// The overlay's namespace, or null when it resolves unprefixed.
    pub namespace: Option<String>,
    /// The folder it came from.
    pub origin: String,
    pub path: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum SettingsLayerKind {
    User,
    Project,
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SettingsLayer {
    pub kind: SettingsLayerKind,
    pub file: String,
    pub exists: bool,
    /// Leaf paths the layer defines.
    pub keys: u32,
    /// Set when the file is there but could not be parsed.
    pub error: Option<String>,
}

/// One layer's value for a setting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SettingCandidate {
    pub layer: SettingsLayerKind,
    pub file: String,
    /// JSON encoding of the value.
    pub value: String,
}

/// One setting leaf, and which layer's value a session would see.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveSetting {
    /// The leaf path, such as `env.FOO`.
    pub key: String,
    /// JSON encoding of the winning value.
    pub value: String,
    pub winner: SettingsLayerKind,
    pub winner_file: String,
    /// Every layer defining this key, highest precedence first.
    pub candidates: Vec<SettingCandidate>,
    /// A lower layer's value is shadowed.
    pub overridden: bool,
}

/// An MCP server as configured, and whether a session would load it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveMcpServer {
    pub name: String,
    pub scope: McpScope,
    /// The file that defines it.
    pub file: String,
    /// The server's JSON, pretty-printed.
    pub config: String,
    pub transport: String,
    /// Null for scopes where approval does not arise.
    pub approved: Option<bool>,
    pub approved_by: Option<String>,
    /// Set when a higher-precedence scope defines the same name.
    pub shadowed_by: Option<String>,
}

/// An overlay a session would be given, and what it holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveOverlay {
    /// The plugin manifest name, which is the namespace.
    pub name: String,
    pub project_path: String,
    pub exists: bool,
    pub skills: u32,
    pub commands: u32,
    pub agents: u32,
    pub workflows: u32,
}

/// A name carried by more than one source, each under its own invocation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SharedName {
    pub name: String,
    pub invocations: Vec<String>,
}

/// An instruction file a session would be given.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveInstruction {
    pub path: String,
    pub source: EffectiveSource,
    #[ts(type = "number")]
    pub bytes: u64,
    pub origin: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveViewRequest {
    /// Computed for a saved profile: its root and its overlays.
    #[serde(default)]
    #[ts(type = "number | null")]
    pub profile_id: Option<u64>,
    /// Or for a plain folder, with the overlays passed alongside.
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub overlays: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveView {
    pub cwd: String,
    /// The profile this was computed for, or null for a plain folder.
    #[ts(type = "number | null")]
    pub profile_id: Option<u64>,
    pub profile_name: Option<String>,
    pub overlays: Vec<EffectiveOverlay>,
    pub skills: Vec<EffectiveEntry>,
    pub commands: Vec<EffectiveEntry>,
    pub agents: Vec<EffectiveEntry>,
    pub workflows: Vec<EffectiveEntry>,
    pub shared_names: Vec<SharedName>,
    pub settings_layers: Vec<SettingsLayer>,
    pub settings: Vec<EffectiveSetting>,
    /// Instruction files, in the order they arrive.
    pub instructions: Vec<EffectiveInstruction>,
    pub mcp_servers: Vec<EffectiveMcpServer>,
    pub warnings: Vec<String>,
    pub computed_at: String,
}

/// Highlighted source, for a config file a session runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RenderedCode {
    pub html: String,
    pub language: String,
    /// False when there is no grammar for it, which is not the same as
    /// highlighted as plain text.
    pub highlighted: bool,
}

/// A config file rendered as what it is. At most one half is set; both are
/// null for a file that is neither prose nor code.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ConfigRendered {
    pub markdown: Option<RenderedMarkdown>,
    pub code: Option<RenderedCode>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum McpScope {
    Local,
    User,
    Project,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpAddRequest {
    pub scope: McpScope,
    pub name: String,
    /// The server object, as JSON.
    pub json: String,
    /// The folder `project` and `local` resolve against.
    pub cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpRemoveRequest {
    pub name: String,
    pub scope: McpScope,
    pub cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpApproveRequest {
    pub cwd: String,
    pub name: String,
    pub approved: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpListRequest {
    pub cwd: String,
}

/// Whether a diff line is kept, added or removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
pub enum McpDiffSign {
    #[serde(rename = " ")]
    Kept,
    #[serde(rename = "+")]
    Added,
    #[serde(rename = "-")]
    Removed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpDiffLine {
    pub sign: McpDiffSign,
    pub text: String,
}

/// What the file would look like afterwards, computed before anything runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpPreview {
    pub file: String,
    pub before: String,
    pub after: String,
    pub diff: Vec<McpDiffLine>,
    /// Set when the name is already configured in this scope.
    pub replaces: Option<String>,
    /// Set when the JSON is not usable.
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct McpResult {
    pub ok: bool,
    /// What the agent's command printed, trimmed.
    pub output: String,
    pub exit_code: Option<i32>,
    /// The file after the command ran.
    pub after: String,
    /// The snapshot taken before the command ran.
    #[ts(type = "number | null")]
    pub snapshot_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct DoctorRow {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct DoctorReport {
    /// The doctor command's output, verbatim.
    pub output: String,
    /// Parsed `Label: value` lines, in order.
    pub rows: Vec<DoctorRow>,
    pub exit_code: Option<i32>,
    pub ran_at: String,
    pub duration_ms: Millis,
    /// Set when the command could not be run at all.
    pub error: Option<String>,
}

/// A draft, tokenised per line for an editor's underlay.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct EditorHighlight {
    /// The inner HTML of each line; empty when `tooLarge`.
    pub lines: Vec<String>,
    pub language: String,
    pub highlighted: bool,
    pub too_large: bool,
    pub took_ms: Millis,
}
