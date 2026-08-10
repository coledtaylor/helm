/**
 * The vocabulary every surface shares. Nothing here may reference Electron,
 * the DOM, or a database driver - these are the shapes that cross the IPC wire
 * and get persisted, and both sides have to agree on them.
 *
 * It is also the one module the renderer may import *values* from, so the two
 * config parsers the editor needs before it is allowed to save are re-exported
 * through here. Both files they come from are pure by construction; adding a
 * `node:` import to either would break the renderer bundle at rollup rather
 * than at typecheck (CLAUDE.md, hard rules).
 */

export {
  frontmatterField,
  parseFrontmatter,
  validateJson,
  type Frontmatter,
  type JsonProblem
} from './config/validate'
export {
  settingHint,
  topLevelKey,
  SETTING_HINTS,
  type SettingHint
} from './config/settings-schema'

/** What a discovered directory turned out to be. */
export type ProjectKind =
  /** Has a `harness.yaml`. Its `repos/*` children are projects in their own right. */
  | 'harness'
  /** A repo inside a harness's `repos/` directory. */
  | 'repo'
  /** A directory that is neither, scanned because a root path pointed at it. */
  | 'folder'

/**
 * Counts of what a project's `.claude/` directory actually contains.
 *
 * Counted the way Claude Code resolves them, not the way a file listing would:
 * a skill is a directory holding a `SKILL.md`, and commands and agents are
 * markdown files at any depth (`commands/spec/plan.md` is the `/spec:plan`
 * command, so a top-level count of that tree would report 1 instead of 20).
 */
export interface ClaudeInventory {
  skills: number
  commands: number
  agents: number
  hooks: boolean
  settings: boolean
  claudeMd: boolean
  mcp: boolean
}

export const EMPTY_INVENTORY: ClaudeInventory = {
  skills: 0,
  commands: 0,
  agents: 0,
  hooks: false,
  settings: false,
  claudeMd: false,
  mcp: false
}

/** Working-tree summary for the launcher's per-project chips. */
export interface GitState {
  branch: string | null
  /** Detached HEAD, mid-rebase, or otherwise not on a named branch. */
  detached: boolean
  /** Files with any staged, unstaged, or untracked change. */
  dirty: number
  ahead: number
  behind: number
  /** Set when the directory is a repo but git could not answer. */
  error?: string
}

export interface Project {
  /** Absolute, normalised path. Stable across scans; the identity of a project. */
  path: string
  name: string
  kind: ProjectKind
  /** Path of the harness this project belongs to, if any. */
  harnessPath: string | null
  hasClaudeDir: boolean
  inventory: ClaudeInventory
  git: GitState | null
}

export interface Harness {
  path: string
  name: string
  /** Parsed from `harness.yaml` when present. */
  template: string | null
  version: string | null
  /** Absolute paths of the projects found under `repos/`. */
  repoPaths: string[]
}

export interface DiscoveryResult {
  /** The root paths that were scanned. */
  roots: string[]
  harnesses: Harness[]
  projects: Project[]
  /** Roots that could not be read, with the reason. */
  errors: Array<{ path: string; message: string }>
  scannedAt: string
  durationMs: number
}

/**
 * How a hosted session ended, or that it has not.
 *
 * `lost` is the honest answer for a row that was still `running` when the
 * process that owned it went away - a crash, a kill from Task Manager, a power
 * cut. The alternative, stamping an end time at the next launch, would invent a
 * duration nobody measured.
 */
export type SessionStatus = 'running' | 'exited' | 'lost'

/** One hosted `claude` process, from spawn to exit. */
export interface SessionRecord {
  id: number
  /** The `-n` name handed to the CLI, so the session is identifiable in
   * `/resume` later (SPEC 4.1, and M4 reads these rows). */
  name: string
  cwd: string
  /** The discovered project it was launched against, if it was one. */
  projectPath: string | null
  /** The profile it was launched from, if it was one. Not a foreign key: the
   * session is a record of what happened and outlives a deleted profile. */
  profileId: number | null
  /** Argv after the executable, as spawned. */
  argv: string[]
  status: SessionStatus
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  /** Null while running, and for a session whose exit code was never observed. */
  exitCode: number | null
}

/**
 * One prompt a person submitted, as `~/.claude/history.jsonl` recorded it.
 *
 * This file is Claude Code's own, shared by every session on the machine and
 * appended to whether or not Helm is running. Helm reads it and never writes
 * to it.
 */
export interface HistoryPrompt {
  sessionId: string
  /** Submission order across the whole file. Monotonic, not necessarily dense. */
  seq: number
  /** The prompt as typed, verbatim. */
  text: string
  /** Epoch milliseconds, as recorded. */
  at: number
}

/**
 * A session `history.jsonl` knows about, and whether it can still be resumed.
 *
 * The two facts come from different places and only one of them is durable.
 * The prompts persist indefinitely; the transcript that `--resume` actually
 * needs is reaped on Claude Code's own schedule - 105 of 799 survive on the
 * machine this was built against - so resumability is a property of the disk
 * right now, re-read on every index pass rather than remembered.
 */
export interface HistorySession {
  sessionId: string
  /** Working directory the session ran in, exactly as history recorded it. */
  project: string
  /** Last path segment of `project`, for a list that has no room for the rest. */
  projectName: string
  promptCount: number
  firstAt: number
  lastAt: number
  /** The opening prompt: what identifies a conversation at a glance. */
  firstPrompt: string
  /** The transcript on disk, or null once it has been reaped. */
  transcriptFile: string | null
  transcriptBytes: number | null
  /** False when the recorded working directory is no longer there. */
  projectExists: boolean
  /**
   * The first prompt that matched the search, when the query had one. Absent
   * for an unfiltered listing rather than set to the opening prompt, so the UI
   * can tell "matched here" from "this is just the start of it".
   */
  match?: string | undefined
}

/**
 * Resuming needs both halves: the conversation to restore and the directory to
 * restore it in. `--resume <id>` is resolved against the working directory - a
 * session resumed from anywhere else reports "No conversation found", measured
 * on 2.1.225 - so a project that has been deleted is as fatal as a reaped
 * transcript, and the launcher says which one it is.
 */
export function canResume(session: HistorySession): boolean {
  return session.transcriptFile !== null && session.projectExists
}

/** One recorded working directory, with how much history it holds. */
export interface HistoryProject {
  project: string
  name: string
  sessions: number
  prompts: number
  lastAt: number
  resumable: number
  exists: boolean
}

/** What the index currently holds. Cheap enough to recompute on every change. */
export interface HistorySummary {
  sessions: number
  prompts: number
  projects: number
  /** Sessions that could be resumed right now. */
  resumable: number
  /** Newest prompt in the index, or null when it is empty. */
  latestAt: number | null
  /** The file being indexed, so the UI can say where this came from. */
  historyFile: string
  /** Bytes of it consumed so far; the cursor an incremental pass resumes at. */
  indexedBytes: number
  /** Set when the file could not be read at all. */
  error?: string | undefined
}

export interface HistoryQuery {
  /** Case-insensitive substring of a prompt. Empty means no filter. */
  search?: string | undefined
  /** One recorded working directory, compared case-insensitively. */
  project?: string | undefined
  /** Drop sessions that could not be resumed. */
  resumableOnly?: boolean | undefined
  limit?: number | undefined
}

export interface HistoryPage {
  /** Most recently active first. */
  sessions: HistorySession[]
  /** Sessions the query matched, before `limit` was applied. */
  total: number
  /** How long the query itself took, in milliseconds. */
  tookMs: number
}

/**
 * The launch knobs a profile carries, named as the CLI names them.
 *
 * Both lists are the CLI's own, copied rather than derived: they are the
 * choices `claude --help` prints for `--effort` and `--permission-mode` on the
 * pinned version, and a value outside them is rejected by the CLI after the
 * session has already been spawned. Keeping them here lets a profile be
 * validated at the point it is saved instead.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

export const PERMISSION_MODES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan'
] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

/**
 * A saved launch composition - the core object everything in Helm is organised
 * around (SPEC 3).
 *
 * `overlays` are composed into the session as plugins, so their skills, agents
 * and commands resolve from a cwd that is not theirs. `access` is the separate
 * question of which directories the session may touch. They overlap in practice
 * and are still not the same thing: composing a repo's skills does not grant
 * its files, and granting its files does not compose its skills.
 */
export interface Profile {
  id: number
  name: string
  /** Working directory. Claude Code resolves `.claude/` config from it. */
  root: string
  /** Project paths composed via `--plugin-dir`. */
  overlays: string[]
  /** Project paths passed to `--add-dir`. */
  access: string[]
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode | null
  agent: string | null
  /**
   * MCP server names. Persisted and exported, but not yet placed on the argv:
   * no CLI flag selects already-configured servers by name, and resolving them
   * into a `--mcp-config` document is the config console's job (M5, SPEC 4.2).
   */
  mcp: string[]
  /** Submitted as the session's first message. */
  openingPrompt: string | null
  /** Launcher ordering; null means unpinned. */
  pinnedOrder: number | null
  createdAt: string
  updatedAt: string
}

/** A profile before the store has given it an identity. */
export type ProfileDraft = Omit<Profile, 'id' | 'createdAt' | 'updatedAt'>

/**
 * One synthesised overlay plugin: the directory handed to `--plugin-dir`, and
 * what went into it.
 */
export interface OverlayShim {
  /** The plugin manifest name, and therefore the prefix its skills appear
   * under - `atlas:think`, not `atlas-overlay:think`. */
  name: string
  /** The project this overlay was synthesised from. */
  projectPath: string
  /** The shim directory itself. */
  dir: string
  /** Convention directories that were linked in, e.g. `['skills', 'agents']`. */
  linked: string[]
  /** Junctions need no elevation; `copy` is the fallback when one fails. */
  mode: 'junction' | 'copy'
  /** Whether the source project had a CLAUDE.md to carry. */
  hasClaudeMd: boolean
  /** True when this launch rebuilt the shim rather than reusing it. */
  rebuilt: boolean
}

/** Everything a host needs to spawn a composed session. */
export interface LaunchPlan {
  cwd: string
  name: string
  /** Argv after the executable. */
  argv: string[]
  overlays: OverlayShim[]
  /**
   * The composed project-instructions file passed to
   * `--append-system-prompt-file`, or null when no overlay had a CLAUDE.md.
   */
  memoryFile: string | null
  /** Things the user should know that did not stop the launch. */
  warnings: string[]
}

export type ThemePreference = 'system' | 'light' | 'dark'

/**
 * Persisted application settings. Keys are the column names in `app_settings`;
 * every value is JSON-encoded on the way in, so adding a key here is the only
 * step needed to persist it.
 */
export interface AppSettings {
  theme: ThemePreference
  /** Directories the launcher scans. Empty means "not set up yet". */
  scanRoots: string[]
  /** Window geometry, restored on next launch. */
  windowBounds: { width: number; height: number; x?: number; y?: number } | null
  /** Set once first-run has completed, so M7 can tell a fresh profile apart. */
  firstRunCompletedAt: string | null
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  scanRoots: [],
  windowBounds: null,
  firstRunCompletedAt: null
}

// ---------------------------------------------------------------------------
// Config console (M5)
// ---------------------------------------------------------------------------

/**
 * One `.claude/` tree, and where it sits in the precedence chain.
 *
 * `user` is `~/.claude` itself; the other two are directories that *contain* a
 * `.claude`, which is why `path` is the base rather than the config directory -
 * `CLAUDE.md` and `.mcp.json` live beside `.claude/`, not inside it.
 */
export type ConfigScopeKind = 'user' | 'harness' | 'project'

export interface ConfigScope {
  kind: ConfigScopeKind
  /** The directory config resolves from. For `user`, the home directory. */
  path: string
  /** The `.claude` directory. Equal to `path` for the user scope. */
  claudeDir: string
  label: string
  /** Present so the switcher can say so rather than showing an empty tree. */
  exists: boolean
}

/**
 * What a file in a `.claude` tree is, as Claude Code resolves it.
 *
 * `skill` is the `SKILL.md` inside a skill directory, not the directory: the
 * directory name is the skill's name and the file is what gets edited.
 */
export type ConfigFileKind =
  | 'skill'
  | 'command'
  | 'agent'
  | 'hook'
  | 'settings'
  | 'settings-local'
  | 'claude-md'
  | 'mcp'
  | 'rule'
  | 'other'

export interface ConfigFile {
  path: string
  /** Relative to the scope's base directory, with forward slashes. */
  relPath: string
  kind: ConfigFileKind
  /**
   * How it is addressed: a skill's directory name, a command's `spec:plan`
   * namespace path, or the file name for everything else.
   */
  name: string
  size: number
  mtimeMs: number
  /** `description:` from the frontmatter, when there is one. */
  description: string | null
  /** True for a file Helm will not offer to edit as text. */
  binary: boolean
}

export interface ConfigTree {
  scope: ConfigScope
  files: ConfigFile[]
  /** Directories that could not be read. Not fatal; the rest of the tree stands. */
  errors: string[]
  scannedAt: string
}

/** A file's bytes, with the hash every write is checked against. */
export interface ConfigFileContent {
  path: string
  exists: boolean
  content: string
  /** sha256 of the bytes on disk, hex. The editor's basis for its next write. */
  hash: string
  size: number
  mtimeMs: number
  /** Set when the bytes are not decodable text; the editor refuses these. */
  binary: boolean
}

/** Why a snapshot was taken. Stored on the row and shown in the file's history. */
export type ConfigWriteReason = 'edit' | 'create' | 'restore' | 'mcp' | 'approve'

export interface ConfigSnapshotMeta {
  id: number
  scopePath: string
  /** Relative to `scopePath`, forward-slashed - the same key the index uses. */
  filePath: string
  contentHash: string
  bytes: number
  reason: ConfigWriteReason
  createdAt: string
}

export interface ConfigSnapshot extends ConfigSnapshotMeta {
  content: string
}

export interface WriteConfigRequest {
  /** The scope's base directory. Recorded on the snapshot. */
  scopePath: string
  path: string
  content: string
  /**
   * The hash the editor's content was derived from, or null for a file it knows
   * does not exist yet. A mismatch is an external edit and stops the write.
   */
  expectedHash: string | null
  reason: ConfigWriteReason
}

export interface WriteConfigResult {
  ok: boolean
  /** The file after the write, or as it stands now when the write was refused. */
  file: ConfigFileContent
  /** Null when nothing was written; otherwise the row taken first. */
  snapshotId: number | null
  /** The bytes were already what was asked for, so nothing was written. */
  unchanged: boolean
  /**
   * Set when the file on disk is not what the editor was based on. Carries the
   * current bytes so the editor can show what it would have overwritten.
   */
  conflict?: {
    onDiskHash: string
    onDiskContent: string
    mtimeMs: number
  }
  /** Set when the write was refused for a reason other than a conflict. */
  error?: string
}

// --- Effective view --------------------------------------------------------

/** Where a resolved capability came from. */
export type EffectiveSource = 'user' | 'cwd' | 'overlay'

/**
 * One skill, command or agent as a session would actually address it.
 *
 * The namespace is *predicted*, not observed: the platform prefixes everything
 * an overlay contributes with the plugin's manifest name (Spike A), and Helm
 * chooses that name when it synthesises the shim - so `<overlay>:<skill>` is
 * decidable before anything is launched. Cross-overlay collisions are therefore
 * impossible, and two overlays defining the same skill both appear, each under
 * its own prefix.
 */
export interface EffectiveEntry {
  /** What you type: `atlas:think`, or `think` for an unnamespaced one. */
  invocation: string
  name: string
  source: EffectiveSource
  /** The overlay's plugin name, or null when the entry resolves unprefixed. */
  namespace: string | null
  /** The directory it came from. */
  origin: string
  path: string
  description: string | null
}

export type SettingsLayerKind = 'user' | 'project' | 'local'

export interface SettingsLayer {
  kind: SettingsLayerKind
  file: string
  exists: boolean
  /** Leaf paths the layer defines. */
  keys: number
  /** Set when the file is there but could not be parsed. */
  error: string | null
}

/**
 * One setting, and which layer's value a session would see.
 *
 * Keyed by leaf path (`env.FOO`, `permissions.defaultMode`) rather than by
 * top-level key, because the layers merge per leaf: measured on 2.1.225, a
 * project `settings.json` that sets `env.A` and a `settings.local.json` that
 * sets `env.B` yield a session with both, and where they set the same name the
 * local one wins. A top-level view would have reported `env` as wholly replaced.
 */
export interface EffectiveSetting {
  key: string
  /** JSON encoding of the winning value. */
  value: string
  winner: SettingsLayerKind
  winnerFile: string
  /** Every layer defining this key, highest precedence first. */
  candidates: Array<{ layer: SettingsLayerKind; file: string; value: string }>
  /** True when a lower layer's value is being shadowed. */
  overridden: boolean
}

/** An MCP server as configured, and whether a session would actually load it. */
export interface EffectiveMcpServer {
  name: string
  /** `project` is `.mcp.json`; `local` and `user` live in `~/.claude.json`. */
  scope: 'project' | 'local' | 'user'
  /** The file that defines it. */
  file: string
  /** The server's JSON, pretty-printed. */
  config: string
  transport: string
  /**
   * `.mcp.json` servers gate on first launch unless a settings layer has
   * approved them. Null for scopes where the question does not arise.
   */
  approved: boolean | null
  /** Why `approved` is what it is. */
  approvedBy: string | null
  /** Set when a higher-precedence scope defines the same name. */
  shadowedBy: string | null
}

export interface EffectiveView {
  cwd: string
  /** The profile this was computed for, or null for a plain directory. */
  profileId: number | null
  profileName: string | null
  overlays: Array<{
    /** The plugin manifest name, which is the namespace. */
    name: string
    projectPath: string
    exists: boolean
    skills: number
    commands: number
    agents: number
  }>
  skills: EffectiveEntry[]
  commands: EffectiveEntry[]
  agents: EffectiveEntry[]
  /**
   * Names carried by more than one source, each under its own invocation. Not
   * a collision report - it cannot be one - but the thing a person wants to see
   * when two repos both define `think`.
   */
  sharedNames: Array<{ name: string; invocations: string[] }>
  settingsLayers: SettingsLayer[]
  settings: EffectiveSetting[]
  /** Instruction files the session would be given, in the order they arrive. */
  instructions: Array<{ path: string; source: EffectiveSource; bytes: number; origin: string }>
  mcpServers: EffectiveMcpServer[]
  warnings: string[]
  computedAt: string
}

// --- MCP management --------------------------------------------------------

export type McpScope = 'local' | 'user' | 'project'

export interface McpAddRequest {
  scope: McpScope
  name: string
  /** The server object, as `claude mcp add-json` takes it. */
  json: string
  /** Working directory the CLI resolves `project` and `local` against. */
  cwd: string
}

/**
 * What the file would look like afterwards, computed before anything is run.
 *
 * The write itself is `claude mcp add-json` rather than a JSON edit (SPEC 4.2),
 * so the result cannot be known for certain in advance - this is Helm merging
 * the same object into the same document and showing the diff. The applied
 * result is re-read afterwards and shown too, so a prediction that was wrong is
 * visible rather than assumed.
 */
export interface McpPreview {
  file: string
  before: string
  after: string
  /** Unified-ish diff lines, each tagged. */
  diff: Array<{ sign: ' ' | '+' | '-'; text: string }>
  /** Set when the name is already configured in this scope. */
  replaces: string | null
  /** Set when the JSON the user typed is not usable. */
  error: string | null
}

export interface McpResult {
  ok: boolean
  /** What the CLI printed, trimmed. */
  output: string
  exitCode: number | null
  /** The file after the CLI ran, so the pane can show what actually changed. */
  after: string
  /** The snapshot taken before the subprocess ran. */
  snapshotId: number | null
}

// ---------------------------------------------------------------------------
// Content viewer (M6)
// ---------------------------------------------------------------------------

/**
 * A directory of things worth reading, inside a scope.
 *
 * The four the spec names - `notes/`, `context/`, `.claude/skills/`, `docs/` -
 * are always offered when they exist, in that order, because they are the ones
 * a person goes looking for by name. Everything else is *found*: a top-level
 * directory holding markdown or HTML is content whatever it is called, which is
 * how `lessons/` and `reference/` - full of artifacts Claude produced - end up
 * reachable without this file knowing they exist.
 */
export type ContentRootKind = 'notes' | 'context' | 'skills' | 'docs' | 'root' | 'found'

export interface ContentRoot {
  kind: ContentRootKind
  /** Relative to the scope, forward-slashed. `''` is the scope directory itself. */
  relPath: string
  path: string
  label: string
  files: number
}

/**
 * What Helm will do with a file.
 *
 * `markdown` is rendered, `html` goes to the sandboxed frame, `data` and `text`
 * are shown as source. The distinction is by extension rather than by content
 * because it decides which *surface* opens, and a surface that changed after
 * the read would flash the wrong one first.
 */
export type ContentFileKind = 'markdown' | 'html' | 'data' | 'text'

export interface ContentFile {
  path: string
  /** Relative to the scope, forward-slashed. */
  relPath: string
  /** The `relPath` of the root it was found under. */
  root: string
  rootKind: ContentRootKind
  kind: ContentFileKind
  /** Basename without extension: what `[[a wikilink]]` names. */
  slug: string
  /** Frontmatter `title`, else the first heading, else the slug. */
  title: string
  size: number
  mtimeMs: number
  /** Frontmatter `type`, `date` and `tags` - the vault's own convention. */
  noteType: string | null
  date: string | null
  tags: string[]
}

export interface ContentScope {
  kind: ConfigScopeKind
  path: string
  label: string
}

export interface ContentTree {
  scope: ContentScope
  roots: ContentRoot[]
  files: ContentFile[]
  /** Directories that could not be read. Not fatal; the rest of the tree stands. */
  errors: string[]
  scannedAt: string
  /** How long the walk took, for the pane's own honesty about a cold scope. */
  tookMs: number
}

/** One `key: value` from the frontmatter, as the header chip row shows it. */
export interface ContentChip {
  key: string
  value: string
  /** A list-valued key (`tags`) renders as several chips rather than one. */
  values: string[]
}

export interface ContentHeading {
  depth: number
  text: string
  slug: string
}

/**
 * One `[[wikilink]]`, and whether the vault has anything to point it at.
 *
 * A broken link is not an error here. The vault's own convention is that a link
 * to a note nobody has written yet is a note worth writing, so the renderer
 * marks it and moves on - which is why `resolved` is nullable rather than the
 * link being dropped.
 */
export interface ContentWikilink {
  /** Exactly what was between the brackets, before `|` and `#` were split off. */
  target: string
  label: string
  heading: string | null
  /** Absolute path, or null when nothing in the scope matches. */
  resolved: string | null
}

/** What the source turned out to contain. Counted while rendering, so a check
 * can compare them against its own read of the same file. */
export interface ContentCounts {
  tables: number
  taskItems: number
  taskItemsChecked: number
  codeBlocks: number
  /** Code blocks that got a real grammar rather than plain text. */
  highlightedBlocks: number
  callouts: number
  wikilinks: number
  brokenWikilinks: number
  tags: number
  headings: number
}

export interface RenderedMarkdown {
  /** Sanitised HTML. The renderer injects it; it never evaluates it. */
  html: string
  frontmatter: {
    /** Present at all - a file with no `---` block has none. */
    present: boolean
    fields: ContentChip[]
    raw: string
    /** Set when the block is there and is not parseable YAML. */
    error: string | null
    /** Line the closing fence sits on, 1-based, for the source view. */
    endLine: number
  }
  headings: ContentHeading[]
  links: ContentWikilink[]
  tags: string[]
  words: number
  counts: ContentCounts
  /** Languages a code fence asked for that no grammar was loaded for. */
  unknownLanguages: string[]
  tookMs: number
}

/** A file, its bytes, and - for markdown - what they render to. */
export interface ContentDocument {
  file: ContentFile
  content: ConfigFileContent
  rendered: RenderedMarkdown | null
  /** Set when the file could not be rendered at all; the source still shows. */
  error: string | null
}

export interface ContentSearchLine {
  line: number
  /** The line, trimmed, with the match still inside it. */
  text: string
  /** Offsets of the match within `text`. */
  from: number
  to: number
}

export interface ContentSearchHit {
  path: string
  relPath: string
  root: string
  title: string
  matches: number
  /**
   * The file's own name or title matched, whether or not its text did. Kept
   * separate from `matches` so a search for `journal-2026-08` finds the note
   * whose *filename* says so and the result can say that is why.
   */
  nameMatch: boolean
  /** The first few matching lines. Bounded, so one file cannot fill the pane. */
  lines: ContentSearchLine[]
}

export interface ContentSearchResult {
  query: string
  hits: ContentSearchHit[]
  filesSearched: number
  bytesSearched: number
  totalMatches: number
  /** Measured around the search itself, not around the read. */
  tookMs: number
  /** True when the corpus had to be read from disk rather than served warm. */
  cold: boolean
  truncated: boolean
}

// --- Health ----------------------------------------------------------------

export interface DoctorReport {
  /** `claude doctor` stdout, verbatim. */
  output: string
  /** Parsed `Label: value` lines, in order. */
  rows: Array<{ label: string; value: string }>
  exitCode: number | null
  ranAt: string
  durationMs: number
  /** Set when the CLI could not be run at all. */
  error: string | null
}
