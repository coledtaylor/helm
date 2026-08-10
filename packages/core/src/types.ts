/**
 * The vocabulary every surface shares. Nothing here may reference Electron,
 * the DOM, or a database driver - these are the shapes that cross the IPC wire
 * and get persisted, and both sides have to agree on them.
 */

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
