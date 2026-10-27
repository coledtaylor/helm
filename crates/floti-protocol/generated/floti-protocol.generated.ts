// Generated from the floti-protocol crate by `cargo run -p floti-protocol --bin generate`. Do not edit.

/** The protocol version these declarations describe. */
export const PROTOCOL_VERSION = { major: 1, minor: 0 } as const;

/** The largest frame body, in bytes. */
export const MAX_FRAME_LEN = 16777216;

/** Credit each direction of a new stream starts with, in bytes. */
export const DEFAULT_INITIAL_CREDIT = 262144;

/**
 * What a browser tool call came to.
 */
export type AgentBrowserOutcome = { "status": "done", value: unknown, } | { "status": "failed", message: string, };

/**
 * The client's answer to a browser tool call.
 */
export type AgentBrowserToolAnswer = { 
/**
 * The `callId` of the call it answers.
 */
callId: number, outcome: AgentBrowserOutcome, };

/**
 * One browser tool call.
 */
export type AgentBrowserToolCall = { 
/**
 * Chosen by the host; the answer names it.
 */
callId: number, 
/**
 * The id of the hosted session whose agent called the tool.
 */
session: number, 
/**
 * The tool's name, such as `browser_navigate`.
 */
tool: string, 
/**
 * The tool's arguments, as the agent sent them.
 */
arguments: unknown, };

/**
 * The host's identity.
 */
export type AppInfo = { version: string, mode: AppMode, dataDir: string, dbFile: string, 
/**
 * Migration tags this build applied or found already applied.
 */
migrations: Array<string>, 
/**
 * The Windows build number of the host's machine, for a terminal
 * renderer's ConPTY quirks; null on any other OS.
 */
windowsBuild: number | null, 
/**
 * The host's home directory, so a long path can be shown from `~`.
 * For showing only; every path the host acts on stays absolute.
 */
home: string, 
/**
 * The releases page, opened by the client and never fetched.
 */
releasesUrl: string, };

/**
 * How the host was started, which decides where its data lives.
 */
export type AppMode = "dev" | "dev-live" | "portable" | "installed";

/**
 * One message of an archived conversation.
 */
export type ArchiveMessage = { uuid: string, role: ArchiveRole, 
/**
 * Epoch ms.
 */
at: number, text: string, };

export type ArchiveRole = "user" | "assistant";

/**
 * What the archive holds for a conversation. "Never captured" is the
 * absence of a value, and is not the same fact as `evicted`.
 */
export type ArchiveSessionState = "archived" | "evicted";

/**
 * What the archive holds.
 */
export type ArchiveStats = { sessions: number, 
/**
 * Conversations the ceiling dropped.
 */
evictedSessions: number, messages: number, rawBytes: number, 
/**
 * Compressed message bodies: what the ceiling is enforced against.
 */
storedBytes: number, 
/**
 * The ceiling in force.
 */
maxBytes: number, 
/**
 * Last-message time of the oldest and newest archived conversation.
 */
oldestAt: number | null, newestAt: number | null, };

/**
 * One archived conversation. `messages` is empty for an evicted one, and the
 * row is still returned.
 */
export type ArchivedConversation = { sessionId: string, 
/**
 * The transcript it was read from. Usually gone by the time this is read.
 */
sourceFile: string, state: ArchiveSessionState, firstAt: number | null, lastAt: number | null, messageCount: number, 
/**
 * Message text as read, before compression.
 */
rawBytes: number, 
/**
 * What it costs in the database now. Zero once evicted.
 */
storedBytes: number, 
/**
 * ISO 8601.
 */
capturedAt: string, 
/**
 * ISO 8601, or null.
 */
evictedAt: string | null, messages: Array<ArchiveMessage>, };

/**
 * Where a frame may load an HTML artifact from.
 */
export type ArtifactLink = { url: string, token: string, };

/**
 * One backend the host can run, and the features it declares.
 */
export type BackendDescriptor = { id: BackendId, 
/**
 * What to call it on screen, such as "Claude Code".
 */
name: string, 
/**
 * What it supports. A feature a newer host names and this version does
 * not know is dropped on decode, so it reads as Unknown here.
 */
features: Array<BackendFeature>, 
/**
 * How it takes a harness: which instruction files it reads, and which
 * parts of a harness reach it and which it has no equivalent for.
 */
harness: HarnessSupport, };

/**
 * Something Floti can do or show for a backend's sessions.
 */
export type BackendFeature = "run" | "status" | "agentTools" | "resume" | "history" | "usage" | "config" | "signInCheck";

/**
 * Names an agent backend, such as `claude-code`.
 *
 * Open-ended on purpose: a new backend on the host must not need a new
 * client to decode the sessions it runs.
 */
export type BackendId = string;

/**
 * What the host found out about one backend's executable.
 *
 * Carries no credential. Whether the backend is signed in is decided from a
 * sign-in artefact existing, never from opening one, and the remedy for "no"
 * is a sentence naming the backend's own command.
 */
export type BackendStatus = { 
/**
 * Whether an executable was found and ran.
 */
installed: boolean, 
/**
 * The executable, or null when there is not one.
 */
path: string | null, source: ExecutableSource | null, 
/**
 * The executable's own version output.
 */
version: string | null, 
/**
 * The `x.y.z` parsed out of it, or null when it carried none.
 */
semver: string | null, 
/**
 * Whether that version is inside `testedRange`.
 */
tested: boolean, testedRange: TestedRange, 
/**
 * The backend's config folder, or null for a backend that has none.
 */
configDir: string | null, configDirExists: boolean, 
/**
 * Signed in, not signed in, or Unknown: a backend that cannot be asked
 * without opening a credential store, or that declares no sign-in check.
 */
signedIn: Knowable<boolean>, 
/**
 * Which signal decided `signedIn`, so a client can say why.
 */
signInSignal: string, 
/**
 * What went wrong locating or running the executable, if anything.
 */
error: string | null, };

/**
 * A project as the last scan left it.
 */
export type CachedProject = { path: string, name: string, kind: ProjectKind, harnessPath: string | null, hasClaudeDir: boolean, inventory: ClaudeInventory, git: GitState | null, 
/**
 * ISO 8601.
 */
lastSeenAt: string, 
/**
 * The harness manifest's `template:`, for a harness row; null otherwise.
 */
template: string | null, };

export type Capability = "terminal" | "files" | "pluginPages" | "browser";

/**
 * What a project's `.claude/` folder holds, counted the way Claude Code
 * resolves it.
 */
export type ClaudeInventory = { skills: number, commands: number, agents: number, hooks: boolean, settings: boolean, claudeMd: boolean, mcp: boolean, };

export type ClientInfo = { 
/**
 * What the client calls itself, such as "Floti desktop 3.0.0".
 */
name: string, kind: ClientKind, };

export type ClientKind = "desktop" | "tui" | "phone" | "website" | "other";

export type CloseSessionRequest = { id: number, 
/**
 * Skip the "still running" confirmation, because the caller already
 * asked.
 */
force: boolean, };

export type CloseSessionResult = { 
/**
 * False when the session is still running because the user has to agree
 * first: the host asked on `session:confirm`, and the session ends only
 * when a client agrees on `session:confirmed`.
 */
closed: boolean, };

/**
 * A file an editor has open was changed by something other than the host.
 */
export type ConfigExternalChange = { path: string, 
/**
 * sha256 of the bytes now on disk, or empty when it was removed.
 */
hash: string, exists: boolean, mtimeMs: Millis, };

export type ConfigFile = { path: string, 
/**
 * Relative to the scope's base folder, forward-slashed.
 */
relPath: string, kind: ConfigFileKind, 
/**
 * How it is addressed: a skill's folder name, a command's namespace
 * path, or the file name.
 */
name: string, size: number, mtimeMs: Millis, 
/**
 * `description:` from the frontmatter, when there is one.
 */
description: string | null, 
/**
 * A file the console will not offer to edit as text.
 */
binary: boolean, };

/**
 * A file's bytes, with the hash every write is checked against.
 */
export type ConfigFileContent = { path: string, exists: boolean, content: string, 
/**
 * sha256 of the bytes on disk, hex.
 */
hash: string, size: number, mtimeMs: Millis, 
/**
 * The bytes are not text; an editor refuses these.
 */
binary: boolean, };

/**
 * What a file in a config tree is, as the agent resolves it.
 */
export type ConfigFileKind = "skill" | "command" | "agent" | "workflow" | "hook" | "settings" | "settings-local" | "claude-md" | "mcp" | "rule" | "other";

/**
 * A file, by absolute path.
 */
export type ConfigPath = { path: string, };

/**
 * A config file rendered as what it is. At most one half is set; both are
 * null for a file that is neither prose nor code.
 */
export type ConfigRendered = { markdown: RenderedMarkdown | null, code: RenderedCode | null, };

/**
 * One config tree.
 */
export type ConfigScope = { kind: ConfigScopeKind, 
/**
 * The folder config resolves from; for `user`, the home folder.
 */
path: string, 
/**
 * The `.claude` folder.
 */
claudeDir: string, label: string, exists: boolean, };

/**
 * Where a config tree sits in the precedence chain.
 */
export type ConfigScopeKind = "user" | "harness" | "project";

/**
 * A config scope, by its base folder.
 */
export type ConfigScopeRef = { scopePath: string, };

export type ConfigSnapshotMeta = { id: number, scopePath: string, 
/**
 * Relative to `scopePath`, forward-slashed.
 */
filePath: string, contentHash: string, bytes: number, reason: ConfigWriteReason, createdAt: string, };

export type ConfigTree = { scope: ConfigScope, files: Array<ConfigFile>, 
/**
 * Folders that could not be read; the rest of the tree stands.
 */
errors: Array<string>, scannedAt: string, };

/**
 * Why a snapshot was taken.
 */
export type ConfigWriteReason = "edit" | "create" | "restore" | "mcp" | "approve" | "rename" | "delete";

/**
 * One frontmatter `key: value`, as a chip.
 */
export type ContentChip = { key: string, value: string, values: Array<string>, };

/**
 * What the source turned out to contain.
 */
export type ContentCounts = { tables: number, taskItems: number, taskItemsChecked: number, codeBlocks: number, highlightedBlocks: number, callouts: number, wikilinks: number, brokenWikilinks: number, tags: number, headings: number, };

/**
 * One entry of a folder listing. Ignored entries are carried, not dropped.
 */
export type ContentDirEntry = { name: string, relPath: string, path: string, directory: boolean, 
/**
 * A symlink or junction: listed, never descended.
 */
link: boolean, 
/**
 * How the file would open; null for a folder.
 */
kind: ContentFileKind | null, ext: string, size: number, mtimeMs: Millis, ignored: boolean, ignoredBy: ContentIgnoreReason | null, };

/**
 * One folder, read on demand.
 */
export type ContentDirListing = { scopePath: string, 
/**
 * Relative to the scope; empty for the scope folder.
 */
relPath: string, entries: Array<ContentDirEntry>, 
/**
 * How many entries are ignored.
 */
ignored: number, 
/**
 * What decided the ignores.
 */
ignoreSource: ContentIgnoreReason, 
/**
 * Set when the folder could not be read at all.
 */
error: string | null, tookMs: Millis, };

export type ContentDocument = { file: ContentFile, content: ConfigFileContent, rendered: RenderedMarkdown | null, 
/**
 * Set when the file could not be rendered; the source still shows.
 */
error: string | null, };

export type ContentFile = { path: string, 
/**
 * Relative to the scope, forward-slashed.
 */
relPath: string, 
/**
 * The `relPath` of the root it was found under.
 */
root: string, rootKind: ContentRootKind, kind: ContentFileKind, 
/**
 * The base name without extension: what a wikilink names.
 */
slug: string, 
/**
 * Lower-cased extension without the dot; empty for none.
 */
ext: string, title: string, size: number, mtimeMs: Millis, 
/**
 * Frontmatter `type`, `date` and `tags`.
 */
noteType: string | null, date: string | null, tags: Array<string>, };

/**
 * How a file opens: rendered, framed, as source, or not at all.
 */
export type ContentFileKind = "markdown" | "html" | "data" | "text" | "source" | "binary";

export type ContentHeading = { depth: number, text: string, slug: string, };

/**
 * Why a listed entry is greyed.
 */
export type ContentIgnoreReason = "gitignore" | "default";

export type ContentRenderRequest = { scopePath: string, path: string, source: string, };

/**
 * Why a folder of content is offered.
 */
export type ContentRootKind = "notes" | "context" | "skills" | "docs" | "root" | "found";

/**
 * A scope whose content can be read.
 */
export type ContentScope = { kind: ConfigScopeKind, path: string, label: string, };

export type ContentSearchHit = { path: string, relPath: string, root: string, title: string, matches: number, 
/**
 * The file's own name or title matched.
 */
nameMatch: boolean, 
/**
 * The first few matching lines.
 */
lines: Array<ContentSearchLine>, };

export type ContentSearchLine = { line: number, 
/**
 * The line, trimmed, with the match inside it.
 */
text: string, 
/**
 * The match's offsets within `text`.
 */
from: number, to: number, };

export type ContentSearchRequest = { scopePath: string, query: string, };

export type ContentSearchResult = { query: string, hits: Array<ContentSearchHit>, filesSearched: number, 
/**
 * The kinds whose text was read; every file is matched on its name.
 */
bodyKinds: Array<ContentFileKind>, filesWithText: number, bytesSearched: number, totalMatches: number, tookMs: Millis, 
/**
 * The corpus was read from disk rather than served warm.
 */
cold: boolean, truncated: boolean, };

/**
 * One `[[wikilink]]`, and what it points at.
 */
export type ContentWikilink = { 
/**
 * Exactly what was between the brackets.
 */
target: string, label: string, heading: string | null, 
/**
 * Absolute path, or null when nothing in the scope matches.
 */
resolved: string | null, };

/**
 * A config file the console can create.
 */
export type CreatableKind = "skill" | "command" | "agent" | "rule" | "settings" | "settings-local" | "claude-md" | "mcp";

export type CreateConfigRequest = { scopePath: string, kind: CreatableKind, 
/**
 * Ignored for the kinds with a fixed name.
 */
name: string, };

export type CreateConfigResult = { ok: boolean, 
/**
 * The file that now exists.
 */
path: string | null, relPath: string | null, snapshotId: number | null, error: string | null, };

export type CreateHarnessOutcome = { 
/**
 * The harness folder, or null when nothing was written.
 */
path: string | null, 
/**
 * Paths written, relative to `path`.
 */
created: Array<string>, 
/**
 * What went wrong, as sentences. With `path` set, a template applied in
 * part: `created` is what landed, and no rollback is claimed.
 */
problems: Array<string>, 
/**
 * The scan roots after the new harness was added to them.
 */
roots: Array<string>, };

export type CreateHarnessRequest = { mode: HarnessMode, dir: string, name: string | null, 
/**
 * For `new` only: `minimal` or absent writes the built-in scaffold, and
 * anything else names a template.
 */
template: string | null, };

export type CreateTemplateRequest = { name: string, label: string | null, description: string | null, };

export type DeleteConfigRequest = { scopePath: string, path: string, };

export type DeleteConfigResult = { ok: boolean, 
/**
 * What came off the disk, each with the snapshot that can put it back.
 */
removed: Array<DeletedConfigFile>, error: string | null, };

export type DeletedConfigFile = { path: string, relPath: string, snapshotId: number, };

/**
 * A shell found on the host's machine.
 */
export type DetectedShell = { 
/**
 * Absolute path to the executable: what is launched and stored.
 */
path: string, 
/**
 * The file name, such as `pwsh.exe`.
 */
name: string, 
/**
 * A human label, such as "PowerShell 7".
 */
label: string, 
/**
 * The arguments the host would launch it with.
 */
args: Array<string>, };

/**
 * A root that could not be read, and why.
 */
export type DiscoveryError = { path: string, message: string, };

export type DiscoveryResult = { 
/**
 * The roots that were scanned.
 */
roots: Array<string>, harnesses: Array<Harness>, projects: Array<Project>, errors: Array<DiscoveryError>, 
/**
 * ISO 8601.
 */
scannedAt: string, durationMs: Millis, };

export type DoctorReport = { 
/**
 * The doctor command's output, verbatim.
 */
output: string, 
/**
 * Parsed `Label: value` lines, in order.
 */
rows: Array<DoctorRow>, exitCode: number | null, ranAt: string, durationMs: Millis, 
/**
 * Set when the command could not be run at all.
 */
error: string | null, };

export type DoctorRow = { label: string, value: string, };

/**
 * A draft, tokenised per line for an editor's underlay.
 */
export type EditorHighlight = { 
/**
 * The inner HTML of each line; empty when `tooLarge`.
 */
lines: Array<string>, language: string, highlighted: boolean, tooLarge: boolean, tookMs: Millis, };

/**
 * One skill, command, agent or workflow as a session would address it.
 */
export type EffectiveEntry = { 
/**
 * What you type: `acme:think`, or `think` unprefixed.
 */
invocation: string, name: string, source: EffectiveSource, 
/**
 * The overlay's namespace, or null when it resolves unprefixed.
 */
namespace: string | null, 
/**
 * The folder it came from.
 */
origin: string, path: string, description: string | null, };

/**
 * An instruction file a session would be given.
 */
export type EffectiveInstruction = { path: string, source: EffectiveSource, bytes: number, origin: string, };

/**
 * An MCP server as configured, and whether a session would load it.
 */
export type EffectiveMcpServer = { name: string, scope: McpScope, 
/**
 * The file that defines it.
 */
file: string, 
/**
 * The server's JSON, pretty-printed.
 */
config: string, transport: string, 
/**
 * Null for scopes where approval does not arise.
 */
approved: boolean | null, approvedBy: string | null, 
/**
 * Set when a higher-precedence scope defines the same name.
 */
shadowedBy: string | null, };

/**
 * An overlay a session would be given, and what it holds.
 */
export type EffectiveOverlay = { 
/**
 * The plugin manifest name, which is the namespace.
 */
name: string, projectPath: string, exists: boolean, skills: number, commands: number, agents: number, workflows: number, };

/**
 * One setting leaf, and which layer's value a session would see.
 */
export type EffectiveSetting = { 
/**
 * The leaf path, such as `env.FOO`.
 */
key: string, 
/**
 * JSON encoding of the winning value.
 */
value: string, winner: SettingsLayerKind, winnerFile: string, 
/**
 * Every layer defining this key, highest precedence first.
 */
candidates: Array<SettingCandidate>, 
/**
 * A lower layer's value is shadowed.
 */
overridden: boolean, };

/**
 * Where a resolved entry came from.
 */
export type EffectiveSource = "user" | "cwd" | "overlay";

export type EffectiveView = { cwd: string, 
/**
 * The profile this was computed for, or null for a plain folder.
 */
profileId: number | null, profileName: string | null, overlays: Array<EffectiveOverlay>, skills: Array<EffectiveEntry>, commands: Array<EffectiveEntry>, agents: Array<EffectiveEntry>, workflows: Array<EffectiveEntry>, sharedNames: Array<SharedName>, settingsLayers: Array<SettingsLayer>, settings: Array<EffectiveSetting>, 
/**
 * Instruction files, in the order they arrive.
 */
instructions: Array<EffectiveInstruction>, mcpServers: Array<EffectiveMcpServer>, warnings: Array<string>, computedAt: string, };

export type EffectiveViewRequest = { 
/**
 * Computed for a saved profile: its root and its overlays.
 */
profileId: number | null, 
/**
 * Or for a plain folder, with the overlays passed alongside.
 */
cwd: string | null, overlays: Array<string>, };

/**
 * How hard the agent thinks, named as the launcher offers it.
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type ErrorCode = "unknownChannel" | "notARequest" | "badPayload" | "unavailable" | "failed" | "missingCapability" | "notAnEvent" | "other";

/**
 * A request that failed. The connection stays open.
 */
export type ErrorReply = { 
/**
 * The request it answers.
 */
id: number, 
/**
 * The channel the request named, as it named it.
 */
channel: string, code: ErrorCode, message: string, };

/**
 * One numbered event. A client that sees a number other than the one it
 * expects has missed one, and resubscribes for a fresh snapshot.
 */
export type Event = { subscription: number, seq: number, payload: unknown, };

/**
 * Where a backend's executable came from.
 */
export type ExecutableSource = "setting" | "discovered";

/**
 * How one file stands against the last commit. "No changes" and "could not
 * look" are different answers.
 */
export type FileChangeState = { "kind": "tracked", lines: LineChanges, } | { "kind": "new" } | { "kind": "ignored" } | { "kind": "outside" } | { "kind": "unknown", reason: string, };

/**
 * Where a file list came from.
 */
export type FileListSource = "git" | "walk";

export type FileListing = { root: string, 
/**
 * Root-relative, forward-slashed.
 */
files: Array<string>, source: FileListSource, 
/**
 * The walk stopped at its ceiling.
 */
truncated: boolean, error: string | null, };

/**
 * One file, read for the Files view.
 */
export type FileView = { root: string, path: string, 
/**
 * Relative to `root`, forward-slashed.
 */
relPath: string, exists: boolean, size: number, mtimeMs: Millis, binary: boolean, 
/**
 * Past the view's ceiling: not read.
 */
tooLarge: boolean, 
/**
 * The text, with line feeds only; how the file ends its lines is `eol`.
 */
content: string, eol: LineEnding | null, changes: FileChangeState, 
/**
 * Set when the file could not be shown at all.
 */
error: string | null, };

/**
 * What changed under a root.
 */
export type FilesChange = { root: string, 
/**
 * Root-relative and forward-slashed, `.git` standing for "the status
 * moved"; null when there were too many to name.
 */
paths: Array<string> | null, };

/**
 * One folder under a root.
 */
export type FilesDirRequest = { root: string, 
/**
 * Relative to the root, forward-slashed; empty for the root itself.
 */
relPath: string, };

/**
 * One file under a root.
 */
export type FilesPathRequest = { root: string, path: string, };

/**
 * A project the Files view shows.
 */
export type FilesRoot = { root: string, };

/**
 * Every changed path under a project.
 *
 * `files` is null when git could not be asked, which is Unknown and never
 * clean, and empty when it answered with nothing changed.
 */
export type FilesStatus = { root: string, 
/**
 * The repository's top level, or null outside one.
 */
repo: string | null, 
/**
 * Root-relative, forward-slashed path to its state.
 */
files: { [key in string]?: GitFileState } | null, error: string | null, };

export type FilesWatchRequest = { roots: Array<string>, };

/**
 * One entry at the top of the folder, and whether it would be copied.
 */
export type FolderEntry = { name: string, directory: boolean, 
/**
 * Files under it that would be copied; `truncated` says the count
 * stopped.
 */
fileCount: number, bytes: number, truncated: boolean, 
/**
 * Ticked when the dialog opens.
 */
included: boolean, 
/**
 * Set when the host will not copy it whatever is ticked, and why.
 */
refused: string | null, 
/**
 * A link. Never followed, never copied.
 */
link: boolean, };

/**
 * Which kind of folder becomes a template. The defaults and the wording
 * differ; nothing else.
 */
export type FolderTemplateKind = "harness" | "folder";

export type FolderTemplatePreview = { dir: string, kind: FolderTemplateKind, entries: Array<FolderEntry>, 
/**
 * Files and bytes of everything ticked by default.
 */
fileCount: number, totalBytes: number, note: string, problems: Array<string>, };

/**
 * A folder to save as a template, as the client's picker produced it.
 */
export type FolderTemplateRequest = { dir: string, kind: FolderTemplateKind, };

/**
 * How git sees one path, against `HEAD` and the index.
 */
export type GitFileState = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

/**
 * A working tree's summary, for a project's chips.
 */
export type GitState = { branch: string | null, 
/**
 * Detached HEAD, mid-rebase, or otherwise not on a named branch.
 */
detached: boolean, 
/**
 * Files with any staged, unstaged or untracked change.
 */
dirty: number, ahead: number, behind: number, 
/**
 * Set when the folder is a repository but git could not answer.
 */
error: string | null, };

export type Harness = { path: string, name: string, 
/**
 * From `harness.yaml` when present.
 */
template: string | null, version: string | null, 
/**
 * The projects found under `repos/`.
 */
repoPaths: Array<string>, };

/**
 * A new harness, or a folder of repositories turned into one.
 */
export type HarnessMode = "new" | "convert";

/**
 * A part of a harness: what a profile's harness can give a session besides
 * its folder.
 */
export type HarnessPart = "instructions" | "skills" | "commands" | "subagents" | "workflows";

/**
 * How a backend takes a harness, declared before a launch so a client can
 * say what an agent will and will not get.
 *
 * The default is a plain tab's: the folder and nothing else, because Floti
 * cannot know where an unknown CLI reads. Every part in [`HarnessPart::ALL`]
 * is in exactly one of `takes` and `cannot_take`.
 */
export type HarnessSupport = { 
/**
 * The instruction file names it reads, such as `CLAUDE.md` and
 * `AGENTS.md`, in the order it reads them.
 */
instructionFiles: Array<string>, 
/**
 * The parts that reach it.
 */
takes: Array<HarnessPart>, 
/**
 * The parts it has no equivalent for. A launch names each one of these a
 * harness holds.
 */
cannotTake: Array<HarnessPart>, };

/**
 * The client's first message. Frozen across majors.
 */
export type Hello = { protocol: ProtocolVersion, client: ClientInfo, 
/**
 * Capability names. Names the host does not know are ignored.
 */
capabilities: Array<string>, };

export type HistoryPage = { 
/**
 * Most recently active first.
 */
sessions: Array<HistorySession>, 
/**
 * Conversations the query matched, before `limit`.
 */
total: number, 
/**
 * How long the query took, in ms.
 */
tookMs: number, };

/**
 * One recorded folder, with how much history it holds.
 */
export type HistoryProject = { project: string, name: string, sessions: number, prompts: number, lastAt: number, resumable: number, exists: boolean, };

/**
 * One prompt a person submitted, as the agent recorded it.
 */
export type HistoryPrompt = { sessionId: string, 
/**
 * Submission order across the whole record. Monotonic, not dense.
 */
seq: number, 
/**
 * The prompt as typed.
 */
text: string, 
/**
 * Epoch ms.
 */
at: number, };

/**
 * Every field may be left out.
 */
export type HistoryQuery = { 
/**
 * Case-insensitive substring. Null or empty means no filter.
 */
search: string | null, 
/**
 * What `search` is matched against. Null means `prompts`.
 */
scope: HistorySearchScope | null, 
/**
 * One recorded folder, compared case-insensitively.
 */
project: string | null, 
/**
 * Drop conversations that could not be resumed.
 */
resumableOnly: boolean | null, limit: number | null, };

/**
 * What a search is over: prompts typed, or every archived message.
 */
export type HistorySearchScope = "prompts" | "messages";

/**
 * A conversation the history index knows about, and whether it can still be
 * resumed.
 */
export type HistorySession = { sessionId: string, 
/**
 * The backend that recorded it, and that a resume runs.
 */
backend: BackendId, 
/**
 * The folder it ran in, exactly as recorded.
 */
project: string, 
/**
 * Last path segment of `project`.
 */
projectName: string, promptCount: number, firstAt: number, lastAt: number, 
/**
 * The opening prompt, verbatim.
 */
firstPrompt: string, 
/**
 * What to call it, derived from its prompts. Never empty.
 */
title: string, 
/**
 * True when `title` is the host's stand-in for a record with no usable
 * prompt.
 */
titleFallback: boolean, 
/**
 * The name given by hand, or null.
 */
label: string | null, 
/**
 * The transcript on disk, or null once it has been reaped.
 */
transcriptFile: string | null, transcriptBytes: number | null, 
/**
 * False when the recorded folder is no longer there.
 */
projectExists: boolean, 
/**
 * What the archive holds for it, or null when it never held anything.
 */
archive: ArchiveSessionState | null, 
/**
 * Messages in the archive for it. Zero once the ceiling dropped them.
 */
archivedMessages: number | null, 
/**
 * The first prompt that matched the search, when the query had one.
 * Null for an unfiltered listing.
 */
match: string | null, };

/**
 * Names one conversation by the id its agent gave it.
 */
export type HistorySessionRef = { sessionId: string, };

/**
 * What the history index holds now.
 */
export type HistorySummary = { sessions: number, prompts: number, projects: number, 
/**
 * Conversations that could be resumed right now.
 */
resumable: number, 
/**
 * Newest prompt in the index, epoch ms, or null when it is empty.
 */
latestAt: number | null, 
/**
 * The record being indexed, so a client can say where this came from.
 */
historyFile: string, 
/**
 * Bytes of it consumed so far.
 */
indexedBytes: number, 
/**
 * Set when the record could not be read at all.
 */
error: string | null, };

/**
 * The host's settings.
 *
 * One set for every client. What belongs to one client's window (theme,
 * layout, the terminal's look, the browser pane) is that client's own.
 */
export type HostSettings = { 
/**
 * Folders discovery scans. Empty means "not set up yet".
 */
scanRoots: Array<string>, 
/**
 * Projects lifted out of their harness group into Pinned, by path.
 */
pinnedProjects: Array<string>, 
/**
 * When setup was finished, ISO 8601, or null while it has not been.
 */
firstRunCompletedAt: string | null, 
/**
 * An executable the user chose for a backend, for a machine where it is
 * not where the host looks. A backend absent here is found by the host.
 */
backendPaths: { [key in BackendId]?: string }, 
/**
 * The program plain terminals open with, or null to detect one.
 */
terminalShell: string | null, 
/**
 * How many bytes of the database the transcript archive may hold.
 */
transcriptArchiveMaxBytes: number, 
/**
 * Whether the host serves its browser tools to the sessions it hosts.
 */
browserMcp: boolean, 
/**
 * Whether those tools are confined to this machine.
 */
browserMcpLocalOnly: boolean, 
/**
 * Whether the host tells a session what other sessions are doing.
 */
sessionMcp: boolean, 
/**
 * Reopen the sessions a crash took without asking first.
 */
restoreWithoutAsking: boolean, };

/**
 * A change to some settings. A field left out is unchanged; a nullable
 * field sent as null is cleared.
 */
export type HostSettingsPatch = { scanRoots?: Array<string>, pinnedProjects?: Array<string>, firstRunCompletedAt?: string | null, 
/**
 * Replaces the whole map.
 */
backendPaths?: { [key in BackendId]?: string }, terminalShell?: string | null, transcriptArchiveMaxBytes?: number, browserMcp?: boolean, browserMcpLocalOnly?: boolean, sessionMcp?: boolean, restoreWithoutAsking?: boolean, };

/**
 * Why the host is being stopped, which decides what its sessions become.
 */
export type HostStopReason = "stop" | "update";

export type HostStopRequest = { reason: HostStopReason, };

export type ImportIntoTemplateRequest = { template: string, 
/**
 * The config scope the entries are in.
 */
scopePath: string, 
/**
 * Paths as `config:tree` reports them for that scope.
 */
paths: Array<string>, };

export type ImportProfileResult = { 
/**
 * The profile added, or null when the document was not one.
 */
profile: Profile | null, 
/**
 * Why the document was not a profile, or null.
 */
error: string | null, 
/**
 * The name it was given because its own was taken, or null.
 */
renamedTo: string | null, };

/**
 * A value Floti either has or could not get.
 *
 * "Could not look" and "nothing there" are never merged: `Known([])` is an
 * answer, `Unknown` is the absence of one.
 */
export type Knowable<T> = { "state": "known", "value": T } | { "state": "unknown" };

/**
 * Launching a profile: the profile supplies the folder, the overlays and
 * every flag, so the client sends an id and a grid and nothing else.
 */
export type LaunchProfileRequest = { profileId: number, cols: number, rows: number, };

/**
 * A session from the new-session launcher. The profile goes as an id and a
 * conversation to reopen as its id; the host reads both back.
 */
export type LaunchSessionRequest = { 
/**
 * The folder the session runs in. Unused when `resume` is set.
 */
cwd: string, projectPath: string | null, 
/**
 * Basis for the session's name; the folder's name when absent.
 */
name: string | null, 
/**
 * The saved profile whose composition the session is given, or null.
 */
profileId: number | null, 
/**
 * Null passes no permission flag, whatever the profile says.
 */
permissionMode: PermissionMode | null, 
/**
 * A conversation in the history index to reopen, or null for a new one.
 */
resume: string | null, 
/**
 * The agent backend to run, or null for the host's default. A resumed
 * conversation runs on the backend that recorded it.
 */
backend: BackendId | null, cols: number, rows: number, };

/**
 * What a profile launch composed, for the pane to report before the terminal
 * paints.
 */
export type LaunchedProfile = { session: SessionRecord, profile: Profile, 
/**
 * Plugin namespaces the session was given.
 */
overlays: Array<string>, 
/**
 * Whether composed project instructions were passed.
 */
composedInstructions: boolean, 
/**
 * Problems that did not stop the launch.
 */
warnings: Array<string>, };

/**
 * What a launch composed, for anything worth saying before the terminal
 * paints.
 */
export type LaunchedSession = { session: SessionRecord, 
/**
 * Plugin namespaces the session was given, such as `["dev", "api"]`.
 */
overlays: Array<string>, 
/**
 * Whether composed project instructions were passed.
 */
composedInstructions: boolean, 
/**
 * Problems that did not stop the launch.
 */
warnings: Array<string>, 
/**
 * Parts of the harness the session's backend has no equivalent for, and
 * so did not get, such as commands for an agent without slash commands.
 */
notTaken: Array<HarnessPart>, };

/**
 * The lines of a file that differ from the last commit, numbered in the file
 * as it is now. Ranges are inclusive and 1-based.
 */
export type LineChanges = { changed: Array<[number, number]>, 
/**
 * Lines with something removed directly below them; 0 is above the
 * first line.
 */
removedAfter: Array<number>, changedCount: number, removedCount: number, };

/**
 * How a file ends its lines.
 */
export type LineEnding = "LF" | "CRLF" | "mixed";

/**
 * One live agent session on the machine, whoever started it. Listing is
 * machine-wide; anything richer hangs off `hostSessionId`.
 */
export type LiveSession = { 
/**
 * The host's session row id, or null for a session the host does not
 * run.
 */
hostSessionId: number | null, 
/**
 * The backend whose records list it.
 */
backend: BackendId, 
/**
 * The pid it registered under, or the terminal's pid for a hosted
 * session with no record yet.
 */
pid: number, 
/**
 * Whether the backend's record for it was found.
 */
registered: boolean, cwd: string | null, name: string | null, activity: SessionActivity | null, waitingFor: string | null, 
/**
 * When the status was last published, epoch ms.
 */
statusSinceMs: number | null, 
/**
 * The agent version that wrote the record.
 */
version: string | null, 
/**
 * How the agent was run, in its own words, such as `cli`.
 */
entrypoint: string | null, startedAtMs: number | null, conversationId: string | null, };

/**
 * An executable for a backend, as the client's file picker produced it.
 */
export type LocateBackendRequest = { backend: BackendId, path: string, };

export type McpAddRequest = { scope: McpScope, name: string, 
/**
 * The server object, as JSON.
 */
json: string, 
/**
 * The folder `project` and `local` resolve against.
 */
cwd: string, };

export type McpApproveRequest = { cwd: string, name: string, approved: boolean, };

export type McpDiffLine = { sign: McpDiffSign, text: string, };

/**
 * Whether a diff line is kept, added or removed.
 */
export type McpDiffSign = " " | "+" | "-";

export type McpListRequest = { cwd: string, };

/**
 * What the file would look like afterwards, computed before anything runs.
 */
export type McpPreview = { file: string, before: string, after: string, diff: Array<McpDiffLine>, 
/**
 * Set when the name is already configured in this scope.
 */
replaces: string | null, 
/**
 * Set when the JSON is not usable.
 */
error: string | null, };

export type McpRemoveRequest = { name: string, scope: McpScope, cwd: string, };

export type McpResult = { ok: boolean, 
/**
 * What the agent's command printed, trimmed.
 */
output: string, exitCode: number | null, 
/**
 * The file after the command ran.
 */
after: string, 
/**
 * The snapshot taken before the command ran.
 */
snapshotId: number | null, };

export type McpScope = "local" | "user" | "project";

export type Message = { "type": "hello" } & Hello | { "type": "welcome" } & Welcome | { "type": "refused" } & Refused | { "type": "request" } & Request | { "type": "response" } & Response | { "type": "error" } & ErrorReply | { "type": "subscribe" } & Subscribe | { "type": "unsubscribe" } & Unsubscribe | { "type": "subscriptionError" } & SubscriptionError | { "type": "snapshot" } & Snapshot | { "type": "event" } & Event | { "type": "streamOpen" } & StreamOpen | { "type": "streamData" } & StreamData | { "type": "streamCredit" } & StreamCredit | { "type": "streamClose" } & StreamClose;

/**
 * Milliseconds, as a number that may have a fraction: a file's modification
 * time, or how long something took.
 *
 * Decodes from a CBOR float or integer, because a JavaScript client encodes
 * a whole number as an integer.
 */
export type Millis = number;

export type MovedFile = { from: string, to: string, };

/**
 * How a session asks before it acts. The values are the ones the launcher
 * offers; each backend maps them to its own flags.
 */
export type PermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "manual" | "dontAsk" | "plan";

export type PinProfilesRequest = { 
/**
 * The pinned profiles, in order.
 */
ids: number[], };

/**
 * The folder a client's picker produced.
 */
export type PluginAddRequest = { 
/**
 * An absolute path on the host.
 */
path: string, };

export type PluginAddResult = { 
/**
 * The folder asked for.
 */
path: string, 
/**
 * Why it was not added, as a sentence.
 */
error: string | null, plugins: Array<PluginInfo>, };

/**
 * What a plugin offers the sessions the host starts.
 */
export type PluginAgentInfo = { 
/**
 * The user's switch: whether new sessions are offered these tools.
 */
enabled: boolean, 
/**
 * The MCP server they appear under in a session.
 */
server: string, instructions: string | null, tools: Array<PluginToolInfo>, };

export type PluginAnswerRequest = { requestId: string, };

export type PluginBackgroundInfo = { url: string, state: PluginBackgroundState, error: string | null, };

export type PluginBackgroundState = "stopped" | "starting" | "running" | "crashed";

/**
 * What a bridge call came to: its value, or why it failed.
 */
export type PluginCallOutcome = { ok: true, value: unknown, } | { ok: false, code: PluginErrorCode, message: string, };

export type PluginCallRequest = { 
/**
 * The plugin's id, established by the client from the frame the call came
 * from; nothing the plugin wrote decides it.
 */
plugin: string, surface: PluginSurfaceKind, method: string, args: unknown[], 
/**
 * Chosen by the client, so `plugins:cancel` can name the call.
 */
callId: string, };

export type PluginCancelRequest = { callId: string, };

export type PluginCommandEvent = { id: string, };

/**
 * A Quick Open command the manifest declares.
 */
export type PluginCommandInfo = { id: string, title: string, 
/**
 * The tab it opens, or null for a command that arrives as the `command`
 * event.
 */
tab: string | null, };

export type PluginCommandRequest = { 
/**
 * The plugin's id.
 */
plugin: string, 
/**
 * The command's id in the manifest.
 */
id: string, };

/**
 * An event for a plugin's pages, by event name. Each client framing the
 * plugin delivers it to its own frames.
 */
export type PluginDelivery = { "event": "settings", plugin: string, data: { [key in string]?: PluginSettingValue }, to: PluginDeliveryTarget, } | { "event": "secrets", plugin: string, data: { [key in string]?: PluginPageSecretState }, to: PluginDeliveryTarget, } | { "event": "command", plugin: string, data: PluginCommandEvent, to: PluginDeliveryTarget, } | { "event": "sessions", plugin: string, data: Array<PluginSession>, to: PluginDeliveryTarget, };

/**
 * Which of a plugin's pages a delivery is for.
 */
export type PluginDeliveryTarget = "all" | "background";

/**
 * Why a bridge call failed: the `code` a plugin page's rejected promise
 * carries.
 */
export type PluginErrorCode = "not-declared" | "secret" | "network" | "timeout" | "aborted" | "invalid" | "unavailable" | "service" | "not-found" | "not-allowed" | "busy";

/**
 * A program the manifest names, with its fixed leading arguments.
 */
export type PluginExecInfo = { name: string, command: string, args: Array<string>, };

/**
 * One registered plugin folder, as a client draws it.
 *
 * A folder whose manifest could not be read is still here, with `error`
 * saying why and every surface empty, so Settings can show it and offer
 * Reload. Only a plugin that is `enabled` with no `error` has surfaces on
 * screen.
 */
export type PluginInfo = { 
/**
 * The folder, as registered. The key Settings acts on.
 */
path: string, 
/**
 * Null when the manifest did not say one the host could read.
 */
id: string | null, name: string, version: string | null, description: string | null, enabled: boolean, 
/**
 * Why it is not loaded: no manifest, an unsupported `apiVersion`, a file
 * that is not built.
 */
error: string | null, warnings: Array<string>, 
/**
 * Bumped at every read of the folder. A page whose plugin moved on
 * reloads.
 */
revision: number, 
/**
 * The rail icon as a `data:` URL, drawn as a mask.
 */
icon: string | null, rail: PluginRail | null, panels: { [key in string]?: PluginPanelInfo }, tabs: { [key in string]?: PluginTabInfo }, 
/**
 * Its tabs open as pages in one tab of its own, not a tab each.
 */
pageStrip: boolean, background: PluginBackgroundInfo | null, commands: Array<PluginCommandInfo>, settings: Array<PluginSettingSpec>, 
/**
 * The values the page shows: what the user set, else the manifest's
 * default, else null.
 */
settingValues: { [key in string]?: PluginSettingValue }, 
/**
 * The origins the plugin's fetch may reach, canonical.
 */
network: Array<string>, secrets: Array<PluginSecretInfo>, exec: Array<PluginExecInfo>, service: PluginServiceInfo | null, 
/**
 * It declares a program or a service: what it runs, runs with the user's
 * rights.
 */
runsPrograms: boolean, 
/**
 * The tools it offers sessions; null when its manifest declares none.
 */
agent: PluginAgentInfo | null, 
/**
 * Its pages may ask to start a session, which the user confirms each
 * time.
 */
startsSessions: boolean, 
/**
 * Its pages may see the host's sessions: names, folders, and whether each
 * is working.
 */
seesSessions: boolean, status: PluginStatusItem | null, badge: number | null, };

export type PluginLogLine = { 
/**
 * ISO 8601.
 */
at: string, stream: PluginLogStream, text: string, };

/**
 * Where a log line came from: the service's output, its errors, or the host
 * noting something about it.
 */
export type PluginLogStream = "out" | "err" | "host";

export type PluginMetrics = { path: string, plugin: string, 
/**
 * Working set across the plugin's page processes and its service. Null:
 * could not look.
 */
memoryKb: number | null, 
/**
 * Null: could not look.
 */
cpuPercent: number | null, processes: number, };

/**
 * A declared secret's state as the plugin sees it. `missing` covers both
 * not stored and stored without permission for this plugin, which the
 * plugin is not told apart.
 */
export type PluginPageSecretState = "ready" | "missing";

/**
 * An icon button in a panel's header. A press arrives as the page's `action`
 * event.
 */
export type PluginPanelAction = { id: string, 
/**
 * Its tooltip and accessible name.
 */
title: string, icon: PluginPanelActionIcon, };

/**
 * The icons a panel action may use: the client's own, so the header looks
 * like every other header.
 */
export type PluginPanelActionIcon = "refresh" | "plus" | "search" | "list" | "settings" | "external" | "pin" | "edit" | "trash" | "link" | "eye";

/**
 * A sidebar panel: the client's header, the plugin's page.
 */
export type PluginPanelInfo = { title: string, 
/**
 * The page, on the plugin's own origin.
 */
url: string, actions: Array<PluginPanelAction>, };

export type PluginParamValue = boolean | number | string;

/**
 * A tab's parameters: part of its identity, so the same tab with other
 * parameters is another tab.
 */
export type PluginParams = { [key in string]?: PluginParamValue };

/**
 * One plugin folder, as registered.
 */
export type PluginPathRequest = { path: string, };

/**
 * The plugin's place on the rail: its title and the panel it opens.
 */
export type PluginRail = { title: string, panel: string, };

export type PluginRemoveRequest = { path: string, 
/**
 * Keys only this plugin could use, which the user chose to delete with it.
 */
deleteSecrets: Array<string>, };

/**
 * A declared secret and whether the plugin can use it.
 */
export type PluginSecretInfo = { key: string, state: PluginSecretState, };

/**
 * Whether a secret the manifest declares can be used.
 */
export type PluginSecretState = "ready" | "missing" | "not-allowed";

export type PluginSelectOption = { value: string, label: string, };

export type PluginServiceInfo = { kind: PluginServiceKind, command: string, start: PluginServiceStart, state: PluginServiceState, pid: number | null, port: number | null, 
/**
 * Restarts after a crash, this run.
 */
restarts: number, error: string | null, };

/**
 * `node`: run by the host's own Node. `command`: any program.
 */
export type PluginServiceKind = "command" | "node";

/**
 * When the service starts: with the plugin, or on its first request.
 */
export type PluginServiceStart = "enable" | "demand";

export type PluginServiceState = "stopped" | "starting" | "running" | "crashed" | "failed";

/**
 * One session the host started since it opened, as a plugin may see it.
 * Nothing of its conversation: no prompt, no output, no transcript.
 */
export type PluginSession = { 
/**
 * The same id a tool call from this session carries. It means nothing
 * outside the host and does not survive a restart.
 */
id: string, name: string, cwd: string, state: PluginSessionState, 
/**
 * What the agent says it is doing. Null when it has ended, or the host
 * cannot tell.
 */
activity: PluginSessionActivity | null, 
/**
 * Since when `activity` has held, epoch ms. Null when the host cannot
 * tell.
 */
activitySince: number | null, 
/**
 * Epoch ms.
 */
startedAt: number, 
/**
 * Epoch ms, or null while it runs.
 */
endedAt: number | null, };

/**
 * `busy` working, `idle` done and waiting for the user's next message,
 * `waiting` for the user to answer something, `shell` running a command.
 */
export type PluginSessionActivity = "busy" | "idle" | "waiting" | "shell";

export type PluginSessionAnswer = { 
/**
 * The `requestId` of the `session` UI request this answers.
 */
requestId: string, 
/**
 * Whether the user started it.
 */
start: boolean, 
/**
 * The terminal size the client will draw it at.
 */
cols: number, rows: number, };

export type PluginSessionState = "running" | "ended";

export type PluginSetSettingRequest = { 
/**
 * The plugin's id.
 */
plugin: string, key: string, value: PluginSettingValue, };

/**
 * One field on a plugin's settings page, as its manifest declares it.
 */
export type PluginSettingSpec = { "type": "text", key: string, label: string, description?: string, default?: string, placeholder?: string, } | { "type": "number", key: string, label: string, description?: string, default?: number, min?: number, max?: number, } | { "type": "toggle", key: string, label: string, description?: string, default?: boolean, } | { "type": "select", key: string, label: string, description?: string, options: Array<PluginSelectOption>, default?: string, } | { "type": "secret", key: string, label: string, description?: string, 
/**
 * A key from the manifest's `secrets`.
 */
secret: string, };

/**
 * A value on a plugin's settings page.
 */
export type PluginSettingValue = boolean | number | string | null;

/**
 * The plugin's item on the status bar. Clicking it opens the plugin's rail
 * panel.
 */
export type PluginStatusItem = { text: string, tone?: PluginStatusTone, tooltip?: string, };

export type PluginStatusTone = "neutral" | "accent" | "success" | "warn" | "danger";

/**
 * Which kind of plugin page a call came from.
 */
export type PluginSurfaceKind = "panel" | "tab" | "background";

/**
 * One plugin folder and a switch: enabled, or its tools offered.
 */
export type PluginSwitchRequest = { path: string, enabled: boolean, };

export type PluginTabInfo = { title: string, url: string, };

export type PluginToolInfo = { name: string, description: string, };

/**
 * The host asking a client to do something a plugin asked for.
 */
export type PluginUiRequest = { "kind": "openTab", plugin: string, tab: string, params: PluginParams, title: string | null, 
/**
 * Opened as the preview, which the next one opened that way replaces.
 */
preview: boolean, } | { "kind": "secret", requestId: string, plugin: string, key: string, 
/**
 * The plugin's own origins, offered as the hosts the value may go to.
 */
hosts: Array<string>, } | { "kind": "session", requestId: string, plugin: string, 
/**
 * Checked by the host: an absolute path to a folder that exists.
 */
cwd: string, 
/**
 * One line, said as the session's first message.
 */
prompt: string, 
/**
 * What the session is called, before it is made unique among the
 * running ones.
 */
name: string, } | { "kind": "sessionWithdrawn", requestId: string, } | { "kind": "link", plugin: string, url: string, };

/**
 * A saved launch composition. `overlays` are composed into the session so
 * their skills and agents resolve; `access` is which folders the session
 * may touch. The two are not the same thing.
 */
export type Profile = { id: number, name: string, 
/**
 * The folder the session runs in.
 */
root: string, 
/**
 * Project paths composed into the session as plugins.
 */
overlays: Array<string>, 
/**
 * Folders the session may also touch.
 */
access: Array<string>, model: string | null, effort: EffortLevel | null, permissionMode: PermissionMode | null, agent: string | null, 
/**
 * MCP server names.
 */
mcp: Array<string>, 
/**
 * Submitted as the session's first message.
 */
openingPrompt: string | null, 
/**
 * Launcher ordering; null means unpinned.
 */
pinnedOrder: number | null, 
/**
 * ISO 8601.
 */
createdAt: string, 
/**
 * ISO 8601.
 */
updatedAt: string, };

export type ProfileDeleted = { deleted: boolean, };

/**
 * A profile as a portable document: what `profile:export` returns and
 * `profile:import` takes.
 */
export type ProfileDocument = { 
/**
 * From export, the file name to suggest; on import, the name of the file
 * it was read from, so an error can name it.
 */
fileName: string, 
/**
 * The profile, as YAML.
 */
yaml: string, };

/**
 * A profile before the host has given it an identity.
 */
export type ProfileDraft = { name: string, root: string, overlays: Array<string>, access: Array<string>, model: string | null, effort: EffortLevel | null, permissionMode: PermissionMode | null, agent: string | null, mcp: Array<string>, openingPrompt: string | null, pinnedOrder: number | null, };

/**
 * Names one profile.
 */
export type ProfileRef = { id: number, };

export type Project = { 
/**
 * Absolute and normalised; a project's identity across scans.
 */
path: string, name: string, kind: ProjectKind, 
/**
 * The harness this project belongs to, if any.
 */
harnessPath: string | null, hasClaudeDir: boolean, inventory: ClaudeInventory, git: GitState | null, };

/**
 * What a discovered folder turned out to be.
 */
export type ProjectKind = "harness" | "repo" | "folder";

/**
 * A protocol version: `major.minor`.
 */
export type ProtocolVersion = { major: number, minor: number, };

export type PtermCloseRequest = { id: number, };

export type PtermExited = { id: number, exitCode: number, };

export type PtermOpenRequest = { 
/**
 * The folder the shell starts in.
 */
path: string, cols: number, rows: number, 
/**
 * The executable to run. Null means the terminal-shell setting, and
 * failing that whatever the host detects.
 */
shell: string | null, 
/**
 * A shell of its own, for a terminal tab, rather than the folder's one.
 */
separate: boolean, };

export type PtermOpened = { id: number, 
/**
 * The executable actually running.
 */
shell: string, 
/**
 * What was asked for when that is not what runs; null when they agree.
 */
requested: string | null, 
/**
 * A sentence about what went wrong, or null.
 */
problem: string | null, };

export type PtermResizeRequest = { id: number, cols: number, rows: number, };

/**
 * Which plain terminal a `pterm:data` stream carries.
 */
export type PtermStreamOpen = { id: number, };

/**
 * The host's answer to a `hello` it cannot accept. Frozen across majors.
 */
export type Refused = { 
/**
 * The host's version.
 */
host: ProtocolVersion, 
/**
 * The version the client said.
 */
client: ProtocolVersion, update: UpdateSide, 
/**
 * A sentence naming both versions and which side to update.
 */
message: string, };

export type RenameConfigRequest = { scopePath: string, 
/**
 * The addressed file: a skill's `SKILL.md`, not its folder.
 */
path: string, name: string, };

export type RenameConfigResult = { ok: boolean, 
/**
 * The addressed file at its new place, or null when nothing moved.
 */
path: string | null, relPath: string | null, 
/**
 * Every file that moved.
 */
moved: Array<MovedFile>, snapshotIds: Array<number>, 
/**
 * The moved file's frontmatter `name:` was updated to match.
 */
frontmatterRenamed: boolean, error: string | null, };

/**
 * Naming a conversation in history. Null, or only whitespace, restores the
 * title derived from its prompts.
 */
export type RenameHistorySessionRequest = { sessionId: string, name: string | null, };

/**
 * Renaming a session's tab. Null, or only whitespace, clears the label and
 * the tab reads the session's name again.
 */
export type RenameSessionRequest = { id: number, label: string | null, };

export type RenameTemplateRequest = { template: string, name: string, };

/**
 * Highlighted source, for a config file a session runs.
 */
export type RenderedCode = { html: string, language: string, 
/**
 * False when there is no grammar for it, which is not the same as
 * highlighted as plain text.
 */
highlighted: boolean, };

export type RenderedFrontmatter = { 
/**
 * A file with no `---` block has none.
 */
present: boolean, fields: Array<ContentChip>, raw: string, 
/**
 * Set when the block is not parseable YAML.
 */
error: string | null, 
/**
 * The line the closing fence sits on, 1-based.
 */
endLine: number, };

export type RenderedMarkdown = { 
/**
 * Sanitised HTML. A client injects it and never evaluates it.
 */
html: string, frontmatter: RenderedFrontmatter, headings: Array<ContentHeading>, links: Array<ContentWikilink>, tags: Array<string>, words: number, counts: ContentCounts, 
/**
 * Languages a code fence asked for that had no grammar.
 */
unknownLanguages: Array<string>, tookMs: Millis, };

/**
 * A call on a request channel.
 */
export type Request = { 
/**
 * Chosen by the client, unique among its requests in flight.
 */
id: number, channel: string, payload: unknown, };

/**
 * The answer to a request.
 */
export type Response = { id: number, payload: unknown, };

/**
 * A session the host's last run was hosting when it stopped without shutting
 * down.
 */
export type RestorableSession = { 
/**
 * Its row, now `lost`.
 */
id: number, 
/**
 * What its tab said.
 */
name: string, cwd: string, branch: string | null, 
/**
 * The profile it was launched from, by name, or null for none.
 */
profile: string | null, 
/**
 * True when its profile has since been deleted. It reopens without.
 */
profileGone: boolean, 
/**
 * When it was last spoken to, epoch ms, or null when not known.
 */
lastAt: number | null, 
/**
 * Why it cannot be reopened, as a sentence, or null when it can.
 */
blocked: string | null, };

/**
 * What a crash took, offered back once. Where each session goes on screen is
 * the client's: the layout belongs to the device, not the host.
 */
export type RestoreOffer = { 
/**
 * In the order their tabs were in.
 */
sessions: Array<RestorableSession>, 
/**
 * How many more were lost whose conversation is still running elsewhere.
 * Left alone: reopening one would be a second process on one
 * conversation.
 */
elsewhere: number, };

export type RestoreSessionsRequest = { 
/**
 * None at all is "not now".
 */
sessions: Array<SessionToRestore>, };

export type RestoreSessionsResult = { restored: Array<RestoredSession>, failed: Array<UnrestoredSession>, };

/**
 * Puts a snapshot's bytes back at `path`.
 */
export type RestoreSnapshotRequest = { id: number, path: string, };

export type RestoredSession = { 
/**
 * The lost row the session reopened.
 */
from: number, launched: LaunchedSession, };

/**
 * Reopening a conversation: an id and a grid. The folder and the command are
 * decided by the host from its own index.
 */
export type ResumeSessionRequest = { sessionId: string, cols: number, rows: number, };

export type ResumedSession = { session: SessionRecord, 
/**
 * The history row it came from.
 */
history: HistorySession, };

/**
 * A scan root.
 */
export type RootPath = { path: string, };

export type SaveFolderAsTemplateRequest = { dir: string, kind: FolderTemplateKind, name: string, label: string, description: string, 
/**
 * The top-level entries to copy.
 */
include: Array<string>, };

export type SaveFolderAsTemplateResult = { ok: boolean, template: string | null, problems: Array<string>, 
/**
 * What landed, relative to the template.
 */
created: Array<string>, fileCount: number, totalBytes: number, };

export type SaveProfileRequest = { 
/**
 * Null to create; an id to update that profile in place.
 */
id: number | null, draft: ProfileDraft, };

export type SaveProfileResult = { profile: Profile | null, 
/**
 * Field-level problems. Non-empty means nothing was written.
 */
problems: Array<string>, };

export type ScanRequest = { 
/**
 * Read git state during the scan. A first paint skips it and refreshes
 * after.
 */
includeGit: boolean | null, };

export type ScanStatus = { running: boolean, 
/**
 * Set when the last scan failed outright rather than returning errors.
 */
error: string | null, };

/**
 * One file in a scope: whose versions to list, or which file to open.
 */
export type ScopedFile = { scopePath: string, path: string, };

/**
 * A stored secret, without its value.
 */
export type SecretInfo = { key: string, 
/**
 * Canonical origins the value may be sent to.
 */
hosts: Array<string>, 
/**
 * Plugin ids that may use it.
 */
plugins: Array<string>, 
/**
 * ISO 8601.
 */
updatedAt: string, };

export type SecretInput = { key: string, 
/**
 * Null keeps the stored value: changing who may use a secret is not
 * typing it again.
 */
value: string | null, hosts: Array<string>, plugins: Array<string>, };

export type SecretRemoveRequest = { key: string, };

export type SecretsState = { 
/**
 * Whether the host can encrypt. When it cannot, nothing can be stored.
 */
available: boolean, secrets: Array<SecretInfo>, };

export type SessionActivation = { id: number, };

/**
 * What a live session says it is doing, in its backend's own records.
 */
export type SessionActivity = "busy" | "shell" | "idle" | "waiting";

/**
 * What one hosted session is doing. Null activity is ordinary: no record
 * yet, a process not proved alive, or a status the host does not know.
 */
export type SessionActivityState = { 
/**
 * The host's session row id.
 */
id: number, activity: SessionActivity | null, 
/**
 * The agent's own sentence for a `waiting` session. Null otherwise.
 */
waitingFor: string | null, 
/**
 * The conversation id the agent reports now. Not necessarily the
 * record's: a cleared conversation gets a new one in the same process.
 */
conversationId: string | null, };

export type SessionConfirmAnswer = { 
/**
 * The `id` of the `session:confirm` it answers.
 */
id: number, agreed: boolean, };

/**
 * What a confirmation is about.
 */
export type SessionConfirmKind = "close-session" | "quit";

/**
 * "This session is still running": asked by the host, answered by a client
 * on `session:confirmed`.
 */
export type SessionConfirmRequest = { 
/**
 * Correlates the answer with the question.
 */
id: number, kind: SessionConfirmKind, message: string, detail: string, 
/**
 * What the agreeing button says.
 */
confirmLabel: string, 
/**
 * Names of the sessions this ends, for the dialog to list.
 */
sessionNames: Array<string>, };

export type SessionFocusRequest = { 
/**
 * The sessions on screen: the front tab of each pane showing one.
 */
ids: number[], };

/**
 * A listening socket held somewhere in a session's process tree.
 */
export type SessionPort = { port: number, pid: number, 
/**
 * The image name of the process holding it.
 */
process: string, 
/**
 * Every local address it is bound to, sorted.
 */
addresses: Array<string>, };

/**
 * One process in a hosted session's tree.
 */
export type SessionProcess = { pid: number, parentPid: number, 
/**
 * The image name, such as `docker.exe`.
 */
name: string, 
/**
 * The full command line, or null where the OS would not give it up.
 */
commandLine: string | null, 
/**
 * How far below the session's own process this sits. The root is 0.
 */
depth: number, 
/**
 * Listening ports, ascending, or null where the socket query could not
 * run. Never merged with `[]`.
 */
ports: Array<number> | null, };

/**
 * One hosted agent process, from spawn to exit.
 */
export type SessionRecord = { id: number, 
/**
 * The name handed to the agent, so the session can be found in its own
 * resume list later. Never rewritten; a rename writes `label`.
 */
name: string, 
/**
 * What Floti calls it on screen, or null for "use `name`".
 */
label: string | null, cwd: string, 
/**
 * The branch `cwd` was on when this was spawned. Null for a folder that
 * is not a repository, a detached HEAD, or a read that failed.
 */
branch: string | null, 
/**
 * The discovered project it was launched against, if it was one.
 */
projectPath: string | null, 
/**
 * The profile it was launched from, if it was one. The session outlives
 * a deleted profile.
 */
profileId: number | null, 
/**
 * Arguments after the executable, as spawned.
 */
argv: Array<string>, 
/**
 * The agent's own id for the conversation this session is having, or
 * null. Assigned at launch where the backend lets Floti pick it (Claude
 * Code's `--session-id`); a resumed session carries the id it resumed.
 */
conversationId: string | null, 
/**
 * The agent backend running it. Claude Code is `claude-code`.
 */
backend: BackendId, status: SessionStatus, 
/**
 * ISO 8601.
 */
startedAt: string, 
/**
 * ISO 8601, or null while running and for a lost session.
 */
endedAt: string | null, durationMs: number | null, 
/**
 * Null while running, and for a session whose exit code was never
 * observed.
 */
exitCode: number | null, };

export type SessionResizeRequest = { id: number, cols: number, rows: number, };

/**
 * What one hosted session is holding. "Could not look" is null and "nothing
 * there" is empty, and the two are never merged.
 */
export type SessionResources = { id: number, 
/**
 * The terminal's pid: the root of the tree.
 */
rootPid: number, 
/**
 * The tree under `rootPid`, root first then breadth-first, or null.
 */
processes: Array<SessionProcess> | null, 
/**
 * Whether `rootPid` was in the enumeration.
 */
rootSeen: boolean, ports: Array<SessionPort> | null, 
/**
 * How many processes in the tree would not give up a command line.
 */
opaque: number, 
/**
 * When the pass ran, epoch ms.
 */
atMs: number, };

/**
 * How a hosted session ended, or that it has not.
 *
 * `lost` is a row that was still `running` when the process that owned it
 * went away: a crash, a kill, a power cut. Stamping an end time later would
 * invent a duration nobody measured.
 */
export type SessionStatus = "running" | "exited" | "lost";

/**
 * Which session's terminal a `session:data` stream carries.
 */
export type SessionStreamOpen = { id: number, };

/**
 * One lost session to reopen, at the grid of the pane it goes back to.
 */
export type SessionToRestore = { id: number, cols: number, rows: number, };

export type SessionsOverview = { 
/**
 * Hosted first, then the rest; each group by start time, newest last.
 */
sessions: Array<LiveSession>, 
/**
 * When the records were read, epoch ms.
 */
readAtMs: number, };

export type SessionsWatchRequest = { 
/**
 * False means this client is not looking any more.
 */
watching: boolean, };

/**
 * One layer's value for a setting.
 */
export type SettingCandidate = { layer: SettingsLayerKind, file: string, 
/**
 * JSON encoding of the value.
 */
value: string, };

export type SettingsLayer = { kind: SettingsLayerKind, file: string, exists: boolean, 
/**
 * Leaf paths the layer defines.
 */
keys: number, 
/**
 * Set when the file is there but could not be parsed.
 */
error: string | null, };

export type SettingsLayerKind = "user" | "project" | "local";

/**
 * What setup found for each agent backend the host can run.
 */
export type SetupStatus = { backends: { [key in BackendId]?: BackendStatus }, };

/**
 * A name carried by more than one source, each under its own invocation.
 */
export type SharedName = { name: string, invocations: Array<string>, };

/**
 * The whole current state of a channel that carries state, sent first on
 * every subscription.
 */
export type Snapshot = { subscription: number, 
/**
 * The number of the last event this state includes. The next event is
 * `seq + 1`.
 */
seq: number, state: unknown, };

export type SnapshotContent = { content: string, };

/**
 * A snapshot, by id.
 */
export type SnapshotRef = { id: number, };

/**
 * Text to render or highlight as the file at `path` would be. The text is
 * what is in the editor, which may not be on disk.
 */
export type SourceToRender = { path: string, source: string, };

/**
 * A new session with everything it is launched with, short of Floti's
 * agent tools, which the host registers for each launch itself.
 *
 * The composition starts from the saved profile `profile_id` names, or from
 * nothing. Each composition field that is set replaces the profile's; a null
 * one keeps it. The folder is always `cwd`, never the profile's root.
 */
export type StartSessionRequest = { 
/**
 * The folder the session runs in.
 */
cwd: string, 
/**
 * The discovered project this is, when it is one. Recorded, not used to
 * launch.
 */
projectPath: string | null, 
/**
 * Basis for the session's name, made unique against running sessions.
 */
name: string | null, 
/**
 * The agent backend to run, or null for the host's default.
 */
backend: BackendId | null, 
/**
 * The saved profile whose composition the session starts from, or null.
 */
profileId: number | null, 
/**
 * Project paths composed into the session as overlays.
 */
overlays: Array<string> | null, 
/**
 * Further folders the session may work in: a profile's access.
 */
extraFolders: Array<string> | null, model: string | null, effort: EffortLevel | null, 
/**
 * A named agent definition to run as.
 */
agent: string | null, permissionMode: PermissionMode | null, 
/**
 * Submitted as the session's first message.
 */
openingPrompt: string | null, 
/**
 * Initial grid, from the pane that will host it.
 */
cols: number, rows: number, };

export type StreamClose = { stream: number, 
/**
 * Why, when it did not end normally.
 */
reason: string | null, };

/**
 * More credit from a stream's receiver: the sender may send `bytes` more.
 */
export type StreamCredit = { stream: number, bytes: number, };

/**
 * Bytes on a stream, never more than the receiver's credit allows.
 */
export type StreamData = { stream: number, data: Uint8Array, };

/**
 * Open a byte stream on a stream channel. Each direction starts with
 * `DEFAULT_INITIAL_CREDIT` bytes of credit.
 */
export type StreamOpen = { 
/**
 * Chosen by the side that opens it.
 */
stream: number, channel: string, 
/**
 * What to open, typed by the channel.
 */
params: unknown, };

/**
 * Start receiving an event channel.
 */
export type Subscribe = { 
/**
 * Chosen by the client; every snapshot and event for it carries it.
 */
subscription: number, channel: string, };

/**
 * A subscription the host did not start, and why. Nothing is ever sent for
 * it; the client may subscribe again under the same number.
 */
export type SubscriptionError = { 
/**
 * The subscription it refuses.
 */
subscription: number, 
/**
 * The channel the subscription named, as it named it.
 */
channel: string, code: ErrorCode, message: string, };

/**
 * One row of the template picker.
 */
export type TemplateChoice = { 
/**
 * The folder name, and what a harness records. `minimal` for the
 * built-in scaffold.
 */
id: string, label: string, description: string | null, 
/**
 * `order:` from `template.yaml`; null sorts last.
 */
order: number | null, 
/**
 * The built-in scaffold, which has no folder behind it.
 */
builtIn: boolean, };

export type TemplateDeleteResult = { ok: boolean, 
/**
 * The template that is gone, or null when nothing was removed.
 */
template: string | null, problems: Array<string>, };

export type TemplateDetail = { id: string, dir: string, label: string, description: string, 
/**
 * Whether there is a `template.yaml` at all; absent is legal.
 */
hasManifest: boolean, 
/**
 * Everything but `template.yaml`, by path.
 */
files: Array<TemplateFile>, fileCount: number, totalBytes: number, 
/**
 * The newest modification time in the tree.
 */
modifiedAtMs: Millis, problems: Array<string>, };

/**
 * One file in a template, and what a harness would receive it as.
 */
export type TemplateFile = { 
/**
 * Relative to the template folder, forward-slashed.
 */
relPath: string, 
/**
 * The path a new harness gets; empty when the file is not written.
 */
target: string, size: number, mtimeMs: Millis, 
/**
 * A `.tpl`, whose placeholders are filled in on the way out.
 */
substituted: boolean, 
/**
 * A link, which is refused. Listed so the author can see why.
 */
link: boolean, };

/**
 * One file inside a template.
 */
export type TemplateFileRequest = { template: string, path: string, };

export type TemplateImportResult = { ok: boolean, 
/**
 * Targets that did not exist before, relative to the template.
 */
created: Array<string>, 
/**
 * Targets that did, and were replaced.
 */
replaced: Array<string>, problems: Array<string>, };

export type TemplateListing = { templates: Array<TemplateChoice>, 
/**
 * Where the user's templates live.
 */
dir: string, 
/**
 * One sentence per template that could not be read.
 */
problems: Array<string>, };

export type TemplateMetadataRequest = { template: string, label: string, description: string, };

/**
 * What a new harness's "What gets written" lists.
 */
export type TemplatePreview = { template: string, 
/**
 * The manifest first, then everything else by path.
 */
entries: Array<string>, 
/**
 * The sentence under the list.
 */
note: string, problems: Array<string>, };

export type TemplatePreviewRequest = { template: string, mode: HarnessMode | null, };

/**
 * A template, by id.
 */
export type TemplateRef = { template: string, };

export type TemplateWriteResult = { ok: boolean, 
/**
 * The template's id afterwards, or null when nothing was written.
 */
template: string | null, 
/**
 * What went wrong, as sentences.
 */
problems: Array<string>, };

/**
 * The versions of a backend this host was tested against, inclusive.
 */
export type TestedRange = { min: string, max: string, };

export type UnrestoredSession = { id: number, name: string, 
/**
 * Why it could not be reopened, as a sentence.
 */
reason: string, };

export type Unsubscribe = { subscription: number, };

/**
 * Which side has to be updated for two versions to talk.
 */
export type UpdateSide = "client" | "host";

/**
 * The two windows a limit is measured over.
 */
export type UsageGroup = "session" | "weekly";

/**
 * One plan limit, after every field has been checked.
 */
export type UsageLimit = { 
/**
 * The provider's name for it, such as `session` or `weekly_all`.
 */
kind: string, group: UsageGroup, 
/**
 * 0 to 100 as the provider reported it. Not rounded, not derived.
 */
percent: number, severity: UsageSeverity, 
/**
 * Epoch ms, or null when the provider sent no reset time.
 */
resetsAtMs: number | null, 
/**
 * The model a scoped limit applies to, or null.
 */
scope: string | null, 
/**
 * Whether this is the limit currently binding.
 */
isActive: boolean, };

export type UsageProblem = { kind: UsageProblemKind, 
/**
 * One sentence.
 */
detail: string, };

/**
 * Why there is no number to show. Every one of these paints nothing.
 */
export type UsageProblemKind = "no-file" | "unreadable" | "not-json" | "missing-key" | "unrecognised" | "stale" | "rolled-over";

/**
 * The provider's own judgement of how close a limit is.
 */
export type UsageSeverity = "normal" | "warning" | "critical";

/**
 * One backend's usage reading.
 */
export type UsageSnapshot = { 
/**
 * The backend this measures, such as `claude-code`.
 */
backend: BackendId, 
/**
 * The file it came from, so the number is traceable.
 */
file: string, 
/**
 * When the agent last had these figures from its provider, epoch ms.
 */
fetchedAtMs: number | null, limits: Array<UsageLimit>, 
/**
 * Set exactly when `limits` is empty and something was wrong.
 */
problem: UsageProblem | null, 
/**
 * The estimated-dollars half, or null where it has not been built.
 */
spend: UsageSpend | null, };

/**
 * Estimated spend, always an estimate and labelled as one.
 */
export type UsageSpend = { 
/**
 * The session window, aligned with the session limit's reset.
 */
session: UsageWindowCost, 
/**
 * Local midnight to now.
 */
today: UsageWindowCost, 
/**
 * A rolling 7 days.
 */
week: UsageWindowCost, 
/**
 * Version of the price table, such as `2026-08-10`.
 */
pricedAt: string, 
/**
 * Models seen with no entry in the price table.
 */
unpricedModels: Array<string>, 
/**
 * How long the last incremental pass took, in ms.
 */
indexMs: number, };

/**
 * The four token classes, priced separately.
 */
export type UsageTokens = { input: number, output: number, cacheWrite: number, cacheRead: number, };

export type UsageWindowCost = { tokens: UsageTokens, 
/**
 * US dollars, estimated from the price table.
 */
dollars: number, 
/**
 * Assistant messages the figure is a sum over.
 */
messages: number, };

/**
 * Which file the client's editor has open, or null to release the watch.
 */
export type WatchConfigRequest = { path: string | null, };

/**
 * The host's answer to an accepted `hello`.
 */
export type Welcome = { 
/**
 * The version this connection speaks.
 */
protocol: ProtocolVersion, 
/**
 * The host program's own version, such as "0.4.1".
 */
hostVersion: string, 
/**
 * The capabilities the host accepted: those the client declared that
 * the host knows.
 */
capabilities: Array<Capability>, 
/**
 * Every backend the host can run, with the features it declares.
 */
backends: Array<BackendDescriptor>, };

export type WikilinkRequest = { scopePath: string, target: string, 
/**
 * The artifact the link was clicked in, which `[[index]]` prefers to
 * resolve beside.
 */
from: string, };

export type WikilinkTarget = { 
/**
 * The file, or null when nothing matches.
 */
path: string | null, };

export type WriteConfigRequest = { 
/**
 * The scope's base folder, recorded on the snapshot.
 */
scopePath: string, path: string, content: string, 
/**
 * The hash the editor's content came from, or null for a file it knows
 * does not exist yet. A mismatch stops the write.
 */
expectedHash: string | null, reason: ConfigWriteReason, };

export type WriteConfigResult = { ok: boolean, 
/**
 * The file after the write, or as it stands when the write was refused.
 */
file: ConfigFileContent, 
/**
 * The snapshot taken first, or null when nothing was written.
 */
snapshotId: number | null, 
/**
 * The bytes were already what was asked for.
 */
unchanged: boolean, 
/**
 * Set when the file on disk is not what the editor was based on.
 */
conflict: WriteConflict | null, 
/**
 * Set when the write was refused for another reason.
 */
error: string | null, };

/**
 * The file on disk is not what the editor was based on.
 */
export type WriteConflict = { onDiskHash: string, onDiskContent: string, mtimeMs: Millis, };

/** Every request channel: what it takes, what it answers and the capability it needs. */
export interface RequestChannels {
  "agentBrowser:answer": { request: AgentBrowserToolAnswer; response: null; capability: "browser" };
  "app:info": { request: null; response: AppInfo; capability: null };
  "archive:conversation": { request: HistorySessionRef; response: ArchivedConversation | null; capability: null };
  "archive:stats": { request: null; response: ArchiveStats; capability: null };
  "config:create": { request: CreateConfigRequest; response: CreateConfigResult; capability: null };
  "config:delete": { request: DeleteConfigRequest; response: DeleteConfigResult; capability: null };
  "config:doctor": { request: null; response: DoctorReport; capability: null };
  "config:effective": { request: EffectiveViewRequest; response: EffectiveView; capability: null };
  "config:mcpAdd": { request: McpAddRequest; response: McpResult; capability: null };
  "config:mcpApprove": { request: McpApproveRequest; response: WriteConfigResult; capability: null };
  "config:mcpList": { request: McpListRequest; response: McpResult; capability: null };
  "config:mcpPreview": { request: McpAddRequest; response: McpPreview; capability: null };
  "config:mcpRemove": { request: McpRemoveRequest; response: McpResult; capability: null };
  "config:read": { request: ConfigPath; response: ConfigFileContent; capability: null };
  "config:rename": { request: RenameConfigRequest; response: RenameConfigResult; capability: null };
  "config:render": { request: SourceToRender; response: ConfigRendered; capability: null };
  "config:restore": { request: RestoreSnapshotRequest; response: WriteConfigResult; capability: null };
  "config:scopes": { request: null; response: Array<ConfigScope>; capability: null };
  "config:snapshot": { request: SnapshotRef; response: SnapshotContent | null; capability: null };
  "config:snapshots": { request: ScopedFile; response: Array<ConfigSnapshotMeta>; capability: null };
  "config:tree": { request: ConfigScopeRef; response: ConfigTree; capability: null };
  "config:watch": { request: WatchConfigRequest; response: null; capability: null };
  "config:write": { request: WriteConfigRequest; response: WriteConfigResult; capability: null };
  "content:artifact": { request: ScopedFile; response: ArtifactLink; capability: "files" };
  "content:document": { request: ScopedFile; response: ContentDocument; capability: "files" };
  "content:render": { request: ContentRenderRequest; response: RenderedMarkdown; capability: "files" };
  "content:restore": { request: RestoreSnapshotRequest; response: WriteConfigResult; capability: "files" };
  "content:scopes": { request: null; response: Array<ContentScope>; capability: "files" };
  "content:search": { request: ContentSearchRequest; response: ContentSearchResult; capability: "files" };
  "content:snapshots": { request: ScopedFile; response: Array<ConfigSnapshotMeta>; capability: "files" };
  "content:wikilink": { request: WikilinkRequest; response: WikilinkTarget; capability: "files" };
  "content:write": { request: WriteConfigRequest; response: WriteConfigResult; capability: "files" };
  "discovery:cached": { request: null; response: Array<CachedProject>; capability: null };
  "discovery:scan": { request: ScanRequest; response: DiscoveryResult; capability: null };
  "editor:highlight": { request: SourceToRender; response: EditorHighlight; capability: null };
  "files:dir": { request: FilesDirRequest; response: ContentDirListing; capability: "files" };
  "files:list": { request: FilesRoot; response: FileListing; capability: "files" };
  "files:read": { request: FilesPathRequest; response: FileView; capability: "files" };
  "files:status": { request: FilesRoot; response: FilesStatus; capability: "files" };
  "files:watch": { request: FilesWatchRequest; response: null; capability: "files" };
  "harness:create": { request: CreateHarnessRequest; response: CreateHarnessOutcome; capability: null };
  "history:projects": { request: null; response: Array<HistoryProject>; capability: null };
  "history:prompts": { request: HistorySessionRef; response: Array<HistoryPrompt>; capability: null };
  "history:refresh": { request: null; response: HistorySummary; capability: null };
  "history:rename": { request: RenameHistorySessionRequest; response: HistorySession | null; capability: null };
  "history:resume": { request: ResumeSessionRequest; response: ResumedSession; capability: null };
  "history:sessions": { request: HistoryQuery; response: HistoryPage; capability: null };
  "history:summary": { request: null; response: HistorySummary; capability: null };
  "host:stop": { request: HostStopRequest; response: null; capability: null };
  "plugins:add": { request: PluginAddRequest; response: PluginAddResult; capability: null };
  "plugins:answer": { request: PluginAnswerRequest; response: null; capability: "pluginPages" };
  "plugins:call": { request: PluginCallRequest; response: PluginCallOutcome; capability: "pluginPages" };
  "plugins:cancel": { request: PluginCancelRequest; response: null; capability: "pluginPages" };
  "plugins:command": { request: PluginCommandRequest; response: null; capability: null };
  "plugins:list": { request: null; response: Array<PluginInfo>; capability: null };
  "plugins:log": { request: PluginPathRequest; response: Array<PluginLogLine>; capability: null };
  "plugins:metrics": { request: null; response: Array<PluginMetrics>; capability: null };
  "plugins:ownSecrets": { request: PluginPathRequest; response: Array<string>; capability: null };
  "plugins:reload": { request: PluginPathRequest; response: Array<PluginInfo>; capability: null };
  "plugins:remove": { request: PluginRemoveRequest; response: Array<PluginInfo>; capability: null };
  "plugins:session": { request: PluginSessionAnswer; response: SessionRecord | null; capability: null };
  "plugins:setEnabled": { request: PluginSwitchRequest; response: Array<PluginInfo>; capability: null };
  "plugins:setSetting": { request: PluginSetSettingRequest; response: Array<PluginInfo>; capability: null };
  "plugins:setTools": { request: PluginSwitchRequest; response: Array<PluginInfo>; capability: null };
  "profile:delete": { request: ProfileRef; response: ProfileDeleted; capability: null };
  "profile:export": { request: ProfileRef; response: ProfileDocument; capability: null };
  "profile:import": { request: ProfileDocument; response: ImportProfileResult; capability: null };
  "profile:launch": { request: LaunchProfileRequest; response: LaunchedProfile; capability: null };
  "profile:list": { request: null; response: Array<Profile>; capability: null };
  "profile:pin": { request: PinProfilesRequest; response: Array<Profile>; capability: null };
  "profile:save": { request: SaveProfileRequest; response: SaveProfileResult; capability: null };
  "pterm:close": { request: PtermCloseRequest; response: null; capability: "terminal" };
  "pterm:open": { request: PtermOpenRequest; response: PtermOpened; capability: "terminal" };
  "pterm:resize": { request: PtermResizeRequest; response: null; capability: "terminal" };
  "pterm:shells": { request: null; response: Array<DetectedShell>; capability: null };
  "roots:accept": { request: RootPath; response: Array<string>; capability: null };
  "roots:remove": { request: RootPath; response: Array<string>; capability: null };
  "roots:suggest": { request: null; response: Array<string>; capability: null };
  "secrets:list": { request: null; response: SecretsState; capability: null };
  "secrets:remove": { request: SecretRemoveRequest; response: SecretsState; capability: null };
  "secrets:save": { request: SecretInput; response: SecretsState; capability: null };
  "session:close": { request: CloseSessionRequest; response: CloseSessionResult; capability: null };
  "session:confirmed": { request: SessionConfirmAnswer; response: null; capability: null };
  "session:focus": { request: SessionFocusRequest; response: null; capability: null };
  "session:launch": { request: LaunchSessionRequest; response: LaunchedSession; capability: null };
  "session:list": { request: null; response: Array<SessionRecord>; capability: null };
  "session:rename": { request: RenameSessionRequest; response: SessionRecord; capability: null };
  "session:resize": { request: SessionResizeRequest; response: null; capability: "terminal" };
  "session:restorable": { request: null; response: RestoreOffer | null; capability: null };
  "session:restore": { request: RestoreSessionsRequest; response: RestoreSessionsResult; capability: null };
  "session:start": { request: StartSessionRequest; response: SessionRecord; capability: null };
  "sessions:watch": { request: SessionsWatchRequest; response: null; capability: null };
  "settings:read": { request: null; response: HostSettings; capability: null };
  "settings:write": { request: HostSettingsPatch; response: HostSettings; capability: null };
  "setup:complete": { request: null; response: HostSettings; capability: null };
  "setup:locateBackend": { request: LocateBackendRequest; response: BackendStatus; capability: null };
  "setup:status": { request: null; response: SetupStatus; capability: null };
  "template:create": { request: CreateTemplateRequest; response: TemplateWriteResult; capability: null };
  "template:delete": { request: TemplateRef; response: TemplateDeleteResult; capability: null };
  "template:detail": { request: TemplateRef; response: TemplateDetail; capability: null };
  "template:folderPreview": { request: FolderTemplateRequest; response: FolderTemplatePreview; capability: null };
  "template:fromFolder": { request: SaveFolderAsTemplateRequest; response: SaveFolderAsTemplateResult; capability: null };
  "template:import": { request: ImportIntoTemplateRequest; response: TemplateImportResult; capability: null };
  "template:list": { request: null; response: TemplateListing; capability: null };
  "template:metadata": { request: TemplateMetadataRequest; response: TemplateWriteResult; capability: null };
  "template:preview": { request: TemplatePreviewRequest; response: TemplatePreview; capability: null };
  "template:rename": { request: RenameTemplateRequest; response: TemplateWriteResult; capability: null };
  "template:substitute": { request: TemplateFileRequest; response: TemplateWriteResult; capability: null };
  "usage:read": { request: null; response: Array<UsageSnapshot>; capability: null };
}

/** Every event channel: its events, its snapshot (null when it carries no state) and the capability it needs. */
export interface EventChannels {
  "agentBrowser:call": { event: AgentBrowserToolCall; snapshot: null; capability: "browser" };
  "archive:changed": { event: ArchiveStats; snapshot: ArchiveStats; capability: null };
  "config:externalChange": { event: ConfigExternalChange; snapshot: null; capability: null };
  "discovery:updated": { event: DiscoveryResult; snapshot: DiscoveryResult | null; capability: null };
  "files:changed": { event: FilesChange; snapshot: null; capability: "files" };
  "git:updated": { event: { [key in string]?: GitState | null }; snapshot: { [key in string]?: GitState | null }; capability: null };
  "history:changed": { event: HistorySummary; snapshot: HistorySummary; capability: null };
  "plugins:changed": { event: Array<PluginInfo>; snapshot: Array<PluginInfo>; capability: null };
  "plugins:deliver": { event: PluginDelivery; snapshot: null; capability: "pluginPages" };
  "plugins:ui": { event: PluginUiRequest; snapshot: null; capability: "pluginPages" };
  "profiles:changed": { event: Array<Profile>; snapshot: Array<Profile>; capability: null };
  "pterm:exit": { event: PtermExited; snapshot: null; capability: "terminal" };
  "scan:status": { event: ScanStatus; snapshot: ScanStatus; capability: null };
  "secrets:changed": { event: SecretsState; snapshot: SecretsState; capability: null };
  "session:activate": { event: SessionActivation; snapshot: null; capability: null };
  "session:activity": { event: Array<SessionActivityState>; snapshot: Array<SessionActivityState>; capability: null };
  "session:confirm": { event: SessionConfirmRequest; snapshot: null; capability: null };
  "session:exit": { event: SessionRecord; snapshot: null; capability: null };
  "session:notify": { event: SessionRecord; snapshot: null; capability: null };
  "sessions:overview": { event: SessionsOverview; snapshot: SessionsOverview; capability: null };
  "sessions:resources": { event: Array<SessionResources>; snapshot: Array<SessionResources>; capability: null };
  "settings:changed": { event: HostSettings; snapshot: HostSettings; capability: null };
  "usage:changed": { event: Array<UsageSnapshot>; snapshot: Array<UsageSnapshot>; capability: null };
}

/** Every stream channel: what opening it names and the capability it needs. Its data is bytes. */
export interface StreamChannels {
  "pterm:data": { open: PtermStreamOpen; capability: "terminal" };
  "session:data": { open: SessionStreamOpen; capability: "terminal" };
}

/** Every channel, by name. */
export const CHANNELS = [
  { name: "agentBrowser:answer", kind: "request", capability: "browser" },
  { name: "agentBrowser:call", kind: "event", capability: "browser" },
  { name: "app:info", kind: "request", capability: null },
  { name: "archive:changed", kind: "event", capability: null },
  { name: "archive:conversation", kind: "request", capability: null },
  { name: "archive:stats", kind: "request", capability: null },
  { name: "config:create", kind: "request", capability: null },
  { name: "config:delete", kind: "request", capability: null },
  { name: "config:doctor", kind: "request", capability: null },
  { name: "config:effective", kind: "request", capability: null },
  { name: "config:externalChange", kind: "event", capability: null },
  { name: "config:mcpAdd", kind: "request", capability: null },
  { name: "config:mcpApprove", kind: "request", capability: null },
  { name: "config:mcpList", kind: "request", capability: null },
  { name: "config:mcpPreview", kind: "request", capability: null },
  { name: "config:mcpRemove", kind: "request", capability: null },
  { name: "config:read", kind: "request", capability: null },
  { name: "config:rename", kind: "request", capability: null },
  { name: "config:render", kind: "request", capability: null },
  { name: "config:restore", kind: "request", capability: null },
  { name: "config:scopes", kind: "request", capability: null },
  { name: "config:snapshot", kind: "request", capability: null },
  { name: "config:snapshots", kind: "request", capability: null },
  { name: "config:tree", kind: "request", capability: null },
  { name: "config:watch", kind: "request", capability: null },
  { name: "config:write", kind: "request", capability: null },
  { name: "content:artifact", kind: "request", capability: "files" },
  { name: "content:document", kind: "request", capability: "files" },
  { name: "content:render", kind: "request", capability: "files" },
  { name: "content:restore", kind: "request", capability: "files" },
  { name: "content:scopes", kind: "request", capability: "files" },
  { name: "content:search", kind: "request", capability: "files" },
  { name: "content:snapshots", kind: "request", capability: "files" },
  { name: "content:wikilink", kind: "request", capability: "files" },
  { name: "content:write", kind: "request", capability: "files" },
  { name: "discovery:cached", kind: "request", capability: null },
  { name: "discovery:scan", kind: "request", capability: null },
  { name: "discovery:updated", kind: "event", capability: null },
  { name: "editor:highlight", kind: "request", capability: null },
  { name: "files:changed", kind: "event", capability: "files" },
  { name: "files:dir", kind: "request", capability: "files" },
  { name: "files:list", kind: "request", capability: "files" },
  { name: "files:read", kind: "request", capability: "files" },
  { name: "files:status", kind: "request", capability: "files" },
  { name: "files:watch", kind: "request", capability: "files" },
  { name: "git:updated", kind: "event", capability: null },
  { name: "harness:create", kind: "request", capability: null },
  { name: "history:changed", kind: "event", capability: null },
  { name: "history:projects", kind: "request", capability: null },
  { name: "history:prompts", kind: "request", capability: null },
  { name: "history:refresh", kind: "request", capability: null },
  { name: "history:rename", kind: "request", capability: null },
  { name: "history:resume", kind: "request", capability: null },
  { name: "history:sessions", kind: "request", capability: null },
  { name: "history:summary", kind: "request", capability: null },
  { name: "host:stop", kind: "request", capability: null },
  { name: "plugins:add", kind: "request", capability: null },
  { name: "plugins:answer", kind: "request", capability: "pluginPages" },
  { name: "plugins:call", kind: "request", capability: "pluginPages" },
  { name: "plugins:cancel", kind: "request", capability: "pluginPages" },
  { name: "plugins:changed", kind: "event", capability: null },
  { name: "plugins:command", kind: "request", capability: null },
  { name: "plugins:deliver", kind: "event", capability: "pluginPages" },
  { name: "plugins:list", kind: "request", capability: null },
  { name: "plugins:log", kind: "request", capability: null },
  { name: "plugins:metrics", kind: "request", capability: null },
  { name: "plugins:ownSecrets", kind: "request", capability: null },
  { name: "plugins:reload", kind: "request", capability: null },
  { name: "plugins:remove", kind: "request", capability: null },
  { name: "plugins:session", kind: "request", capability: null },
  { name: "plugins:setEnabled", kind: "request", capability: null },
  { name: "plugins:setSetting", kind: "request", capability: null },
  { name: "plugins:setTools", kind: "request", capability: null },
  { name: "plugins:ui", kind: "event", capability: "pluginPages" },
  { name: "profile:delete", kind: "request", capability: null },
  { name: "profile:export", kind: "request", capability: null },
  { name: "profile:import", kind: "request", capability: null },
  { name: "profile:launch", kind: "request", capability: null },
  { name: "profile:list", kind: "request", capability: null },
  { name: "profile:pin", kind: "request", capability: null },
  { name: "profile:save", kind: "request", capability: null },
  { name: "profiles:changed", kind: "event", capability: null },
  { name: "pterm:close", kind: "request", capability: "terminal" },
  { name: "pterm:data", kind: "stream", capability: "terminal" },
  { name: "pterm:exit", kind: "event", capability: "terminal" },
  { name: "pterm:open", kind: "request", capability: "terminal" },
  { name: "pterm:resize", kind: "request", capability: "terminal" },
  { name: "pterm:shells", kind: "request", capability: null },
  { name: "roots:accept", kind: "request", capability: null },
  { name: "roots:remove", kind: "request", capability: null },
  { name: "roots:suggest", kind: "request", capability: null },
  { name: "scan:status", kind: "event", capability: null },
  { name: "secrets:changed", kind: "event", capability: null },
  { name: "secrets:list", kind: "request", capability: null },
  { name: "secrets:remove", kind: "request", capability: null },
  { name: "secrets:save", kind: "request", capability: null },
  { name: "session:activate", kind: "event", capability: null },
  { name: "session:activity", kind: "event", capability: null },
  { name: "session:close", kind: "request", capability: null },
  { name: "session:confirm", kind: "event", capability: null },
  { name: "session:confirmed", kind: "request", capability: null },
  { name: "session:data", kind: "stream", capability: "terminal" },
  { name: "session:exit", kind: "event", capability: null },
  { name: "session:focus", kind: "request", capability: null },
  { name: "session:launch", kind: "request", capability: null },
  { name: "session:list", kind: "request", capability: null },
  { name: "session:notify", kind: "event", capability: null },
  { name: "session:rename", kind: "request", capability: null },
  { name: "session:resize", kind: "request", capability: "terminal" },
  { name: "session:restorable", kind: "request", capability: null },
  { name: "session:restore", kind: "request", capability: null },
  { name: "session:start", kind: "request", capability: null },
  { name: "sessions:overview", kind: "event", capability: null },
  { name: "sessions:resources", kind: "event", capability: null },
  { name: "sessions:watch", kind: "request", capability: null },
  { name: "settings:changed", kind: "event", capability: null },
  { name: "settings:read", kind: "request", capability: null },
  { name: "settings:write", kind: "request", capability: null },
  { name: "setup:complete", kind: "request", capability: null },
  { name: "setup:locateBackend", kind: "request", capability: null },
  { name: "setup:status", kind: "request", capability: null },
  { name: "template:create", kind: "request", capability: null },
  { name: "template:delete", kind: "request", capability: null },
  { name: "template:detail", kind: "request", capability: null },
  { name: "template:folderPreview", kind: "request", capability: null },
  { name: "template:fromFolder", kind: "request", capability: null },
  { name: "template:import", kind: "request", capability: null },
  { name: "template:list", kind: "request", capability: null },
  { name: "template:metadata", kind: "request", capability: null },
  { name: "template:preview", kind: "request", capability: null },
  { name: "template:rename", kind: "request", capability: null },
  { name: "template:substitute", kind: "request", capability: null },
  { name: "usage:changed", kind: "event", capability: null },
  { name: "usage:read", kind: "request", capability: null },
] as const;
