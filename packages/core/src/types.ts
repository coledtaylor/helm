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

// Imported as well as re-exported: `AppSettings` below names it, and a
// re-export alone does not bring a name into this file's scope.
import type { UsageDisplayMode } from './usage/shape'
// The same, for `CreateConfigRequest` below.
import type { CreatableKind } from './config/names'
// The same, for a value: `DEFAULT_SETTINGS` reads the polling default off it.
import { PR_POLL_MINUTES, PR_STALE_DAYS, type PrCheckoutMode } from './github/types'
// And for the review template's default, which is the prompt module's to state.
import { DEFAULT_PR_REVIEW_PROMPT } from './github/prompt'

export {
  frontmatterField,
  parseFrontmatter,
  validateJson,
  type Frontmatter,
  type JsonProblem
} from './config/validate'
/**
 * The naming rules, for the same reason and by the same argument: the New and
 * Rename dialogs have to refuse a name the CLI could not address *as it is
 * typed*, which means the check runs in the renderer. `create-rename-delete.ts`
 * runs it again on the main side, where it is the guarantee rather than the
 * courtesy.
 */
export {
  checkConfigName,
  configUnit,
  isRenamable,
  planConfigFile,
  renameRefusal,
  CREATABLE_KINDS,
  RENAMABLE_KINDS,
  type ConfigFilePlan,
  type CreatableKind,
  type CreatableKindSpec,
  type NameCheck,
  type PlanInput,
  type PlanResult
} from './config/names'
export {
  settingHint,
  topLevelKey,
  SETTING_HINTS,
  type SettingHint
} from './config/settings-schema'
/**
 * And the join between a `.claude` tree and what a session would do with it.
 * Pure by the same rule: it reads no file, only an `EffectiveView` that has
 * already been computed, so the window can ask it about a row without a
 * round trip and without a second answer to the question the Effective tab
 * already answers.
 */
export {
  computeConfigLive,
  configFileNote,
  hookBindings,
  isRedactedConfigFile,
  samePath,
  settingReferences,
  settingsDeclaredBy
} from './config/live'
/**
 * The usage reader's pure half, re-exported for the same reason: the status bar
 * re-derives what it may paint on a timer, from the same functions the main
 * process parsed with. Two implementations of "is this reading still good" is
 * exactly the bug this file exists to prevent.
 */
export {
  describeAge,
  nextUsageMode,
  offerableUsageModes,
  parseUsage,
  usageProblem,
  usageView,
  COST_MODE_UNAVAILABLE,
  USAGE_DISPLAY_MODES,
  USAGE_STALE_AFTER_MS,
  type UsageBucket,
  type UsageDisplayMode,
  type UsageGroup,
  type UsageLimit,
  type UsageProblem,
  type UsageProblemKind,
  type UsageSeverity,
  type UsageSnapshot,
  type UsageSpend,
  type UsageTokens,
  type UsageView,
  type UsageWindowCost
} from './usage/shape'
export {
  costOfTokens,
  priceFor,
  priceTableAgeDays,
  PRICES,
  PRICE_TABLE_DATE,
  PRICE_TABLE_FRESH_FOR_DAYS,
  type ModelPrice,
  type TokenPrice
} from './usage/prices'
/**
 * The pull-request vocabulary, re-exported for the same reason: the Pulls pane
 * and the sidebar are renderer code, and `github/types.ts` is pure by
 * construction while the rest of `github/` spawns a subprocess.
 */
export {
  isRepoIgnored,
  isRepoSlug,
  withRepoIgnored,
  PR_CHECKOUT_MODES,
  PR_IGNORED_REPOS_MAX,
  PR_POLL_MINUTES,
  PR_STALE_DAYS,
  type GhProblem,
  type GhProblemKind,
  type GhStatus,
  type IgnoredRepo,
  type LaunchedReviewPlan,
  type PrCheckoutMode,
  type PullChecks,
  type PullComment,
  type PullCommit,
  type PullConversationEntry,
  type PullConversationItem,
  type PullDetail,
  type PullDetailView,
  type PullDiff,
  type PullDiffHunk,
  type PullDiffLine,
  type PullFile,
  type PullFileDiff,
  type PullFileStatus,
  type PullFileView,
  type PullPatch,
  type PullRepo,
  type PullReview,
  type PullReviewDecision,
  type PullReviewThread,
  type PullSummary,
  type PullsSnapshot,
  type PullThreadComment,
  type PullThreadEntry,
  type RenderedPullEntry,
  type RenderedPullItem,
  type RenderedPullThread,
  type RenderedThreadComment,
  type RepoRemote
} from './github/types'
/**
 * The per-file line ceiling, re-exported because the pane that stops painting
 * at it is the pane that has to name it: the sentence under a cut-short file
 * says how many lines it kept, and a renderer holding its own copy of the
 * number would eventually say a number the parser does not use. Pure - `diff.ts`
 * imports nothing but types.
 */
export { MAX_FILE_LINES } from './github/diff'
/**
 * The thread-to-diff-row join, re-exported for the same reason and under the
 * same guarantee: `diff.ts` is pure and imports nothing but types, so this
 * reaches the browser bundle without dragging `launch/` or `store/` into it.
 *
 * In core rather than in the pane because it is the one part of the Files
 * view's thread markers that is a *decision* rather than a rendering - what to
 * do when the patch and the threads, fetched separately, disagree about where a
 * line is - and a decision belongs where it can be unit-tested.
 */
export { anchorThreadsToFile } from './github/diff'
export type { AnchoredThreads, ThreadLooseReason, ThreadPosition } from './github/diff'
/**
 * The review prompt's template renderer, re-exported for the same reason again:
 * the detail pane's disclosure sentence names the exact prompt the button will
 * run, so it renders the template itself. The prompt that is actually launched
 * is composed in the main process - see `desktop/src/main/pulls.ts` - and this
 * side never sends one.
 */
export {
  renderPullPrompt,
  DEFAULT_PR_REVIEW_PROMPT,
  PR_PROMPT_PLACEHOLDERS,
  PR_REVIEW_PROMPT_MAX_LENGTH,
  type PullPromptFacts,
  type PullPromptPlaceholder
} from './github/prompt'

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
   * `/resume` later (SPEC 4.1, and the session index reads these rows). Never
   * rewritten - a rename writes `label`. See the column comment in `schema.ts`. */
  name: string
  /** What Helm calls it on screen, or null for "use `name`". `sessionLabel`. */
  label: string | null
  cwd: string
  /** The branch `cwd` was on when this was spawned. Null for a non-repo cwd, a
   * detached HEAD, or a read that failed. Captured, never followed. */
  branch: string | null
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
 * What to call a session on screen: its label if it has one, its `-n` name if
 * not.
 *
 * One function rather than `label ?? name` at each call site, and that is the
 * whole reason it exists. A session is named in four places - the tab, the tab's
 * hover hint, the sidebar's live-session tooltip, and the confirmation before it
 * is ended - and the failure a shared helper prevents is the one where the tab
 * says "PR review", the dialog asking to end it says "dev 2", and the user has
 * to work out that those are the same session before answering a question whose
 * cost is whatever the session had not finished saying.
 *
 * In `types.ts` because the renderer imports it, and a value import into the
 * browser bundle comes from `@helm/core/types` and not the package root
 * (CLAUDE.md "Boundaries").
 */
export function sessionLabel(session: Pick<SessionRecord, 'name' | 'label'>): string {
  return session.label ?? session.name
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
   * What Helm's own archive holds for this session, or null when it has never
   * held anything.
   *
   * The third fact about a session, alongside the transcript and the folder,
   * and it does not follow from either: a conversation Claude Code reaped can
   * still be readable here, and one that is still on disk may never have been
   * captured. `'evicted'` is deliberately not folded into null - see
   * `ArchiveSessionState`.
   */
  archive: ArchiveSessionState | null
  /** Messages in the archive for it. Zero once the ceiling has dropped them. */
  archivedMessages: number | null
  /**
   * The first prompt that matched the search, when the query had one. Absent
   * for an unfiltered listing rather than set to the opening prompt, so the UI
   * can tell "matched here" from "this is just the start of it".
   */
  match?: string | undefined
}

// ---------------------------------------------------------------------------
// Transcript archive
// ---------------------------------------------------------------------------

/**
 * What Helm's archive holds for a session.
 *
 * Two values and no third for "never captured", which is the absence of a row.
 * The distinction that has to survive every refactor is `'evicted'` against
 * null: "we had this conversation and dropped it to stay under your limit" and
 * "this was reaped before Helm ever saw it" are different facts about the same
 * missing text, and only one of them is something the user chose.
 */
export type ArchiveSessionState = 'archived' | 'evicted'

/** One message of an archived conversation, as the viewer renders it. */
export interface ArchiveMessage {
  uuid: string
  role: 'user' | 'assistant'
  /** Epoch ms. */
  at: number
  text: string
}

/**
 * One archived conversation.
 *
 * `messages` is empty for an evicted one, and the row is still returned: the
 * pane has something to say about a conversation Helm dropped, and nothing to
 * say about one it never had.
 */
export interface ArchivedConversation {
  sessionId: string
  /** The transcript it was read from. Usually gone by the time this is read. */
  sourceFile: string
  state: ArchiveSessionState
  firstAt: number | null
  lastAt: number | null
  messageCount: number
  /** Message text as read, before compression. */
  rawBytes: number
  /** What it costs in the database now. Zero once evicted. */
  storedBytes: number
  capturedAt: string
  evictedAt: string | null
  messages: ArchiveMessage[]
}

/** What the archive holds, for the settings pane to state rather than imply. */
export interface ArchiveStats {
  sessions: number
  /** Sessions the ceiling dropped. Counted separately; they are not gone-gone. */
  evictedSessions: number
  messages: number
  rawBytes: number
  /** Compressed message bodies. The figure the ceiling is enforced against. */
  storedBytes: number
  /** The ceiling in force, from `transcriptArchiveMaxBytes`. */
  maxBytes: number
  /** Last-message time of the oldest and newest archived conversation. */
  oldestAt: number | null
  newestAt: number | null
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

/**
 * What a search is over.
 *
 * `prompts` is the historic behaviour and the default: a substring of a prompt
 * or a project path, matched with `LIKE`. `messages` is the archive - every
 * word of every conversation Helm captured, through FTS5.
 *
 * Two scopes rather than one box that searches both, and that is a decision.
 * They answer different questions and return wildly different counts, and the
 * counts are the point: "sessions where I typed this" and "conversations where
 * this was said" are not the same list, and a box that quietly returned the
 * union would make the smaller of the two unreachable.
 */
export const HISTORY_SEARCH_SCOPES = ['prompts', 'messages'] as const
export type HistorySearchScope = (typeof HISTORY_SEARCH_SCOPES)[number]

export interface HistoryQuery {
  /** Case-insensitive substring of a prompt. Empty means no filter. */
  search?: string | undefined
  /** What `search` is matched against. Defaults to `prompts`. */
  scope?: HistorySearchScope | undefined
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
   * into a `--mcp-config` document is the config console's job (SPEC 4.2).
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
   * under - `acme:think`, not `acme-overlay:think`. */
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

/** The three, as a value, so a validator and a control can share one list. */
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']

/** xterm's three cursor shapes, restated here so a validator and a control can
 * share one list without either of them importing xterm. */
export const TERMINAL_CURSOR_STYLES = ['block', 'underline', 'bar'] as const
export type TerminalCursorStyle = (typeof TERMINAL_CURSOR_STYLES)[number]

/**
 * The bounds on the two numeric terminal settings.
 *
 * The font size ceiling is not taste. A pane is a few hundred pixels wide, and
 * a grid narrow enough stops being a terminal: Claude Code's composer and
 * status line assume they have columns to lay out in, and every check that
 * asserts a pane came back with a usable grid is only loose because this is
 * tight. The floor is the point below which the glyphs stop being legible on a
 * 100% display.
 */
export const TERMINAL_FONT_SIZE = { min: 8, max: 32, default: 14 } as const

/** Lines of history a terminal keeps. The ceiling is memory: a line is roughly
 * a kilobyte of cell data, so a million of them per pane is not a setting. */
export const TERMINAL_SCROLLBACK = { min: 500, max: 200_000, default: 10_000 } as const

/**
 * How much of the project page's column the shell may take, as a percentage.
 *
 * The default is where the shell used to be pinned, and the argument that put
 * it there is still the argument for the default: about a third of the page
 * gives a tall display 15+ rows - PSReadLine's ListView threshold - while a
 * small window keeps most of its height for the project pane. What that
 * argument never justified was being the *only* value, which is what a fixed
 * class made it.
 *
 * The ceiling is half, and it is the user's own ask: past half the project
 * pane would be the smaller part of the page it names. The floor here is
 * proportional and is deliberately not the whole floor - the pane carries a
 * pixel floor too (`PROJECT_SHELL_MIN_PX`), which is the binding one on any
 * window this app opens. This bound is what stops a percentage chosen on a
 * short window describing a four-row terminal on a tall one.
 */
export const PROJECT_SHELL_HEIGHT_PCT = { min: 10, max: 50, default: 30 } as const

/**
 * How much of the window's width the sessions column takes, as a percentage.
 *
 * The other axis of the same idea as `PROJECT_SHELL_HEIGHT_PCT`, and the same
 * bounds the divider has always enforced in its handler - 20% to 80% - now said
 * once here rather than as two literals inside a `mousemove`.
 *
 * The default is 45 because that is the number the split has silently opened at
 * since it was written, and this key is only being introduced to stop it
 * forgetting: somebody who never touches the divider must not have the app move
 * on them the first time they upgrade.
 */
export const SESSION_SPLIT_PCT = { min: 20, max: 80, default: 45 } as const

/**
 * How much of `helm.db` the transcript archive may take, in bytes.
 *
 * A gigabyte by default, and both halves of that are deliberate. Unbounded is
 * not an option: `helm.db` is the user's file, and a feature that grows it
 * without limit is one they find out about from their disk rather than from
 * Helm. A gigabyte is enormous for what this actually stores - the conversation
 * text out of one 3.9 MB transcript on this machine is 54 KB before
 * compression, a 71x difference, because tool traffic is not archived - so on
 * any ordinary machine the ceiling is a guard rail rather than a budget.
 *
 * The floor is a kilobyte rather than something respectable, because a bound
 * that no check can drive past is a bound nothing has ever tested: the eviction
 * rule is the interesting part of this feature, and `pnpm transcript-check`
 * makes it fire by setting a ceiling smaller than what it just archived. The
 * settings pane offers sensible sizes; the validator only enforces the shape.
 */
export const TRANSCRIPT_ARCHIVE_BYTES = {
  min: 1024,
  max: 64 * 1024 ** 3,
  default: 1024 ** 3
} as const

/**
 * A shell Helm found on this machine, offered in the shell pickers.
 *
 * `path` is what gets launched and what gets stored, and it is absolute for the
 * same reason `claudePath` is: a bare `pwsh.exe` means whatever the process's
 * PATH happened to resolve it to, which is not necessarily what the user saw in
 * the picker.
 */
export interface DetectedShell {
  /** Absolute path to the executable. */
  path: string
  /** The file name - `pwsh.exe`. What the picker shows as machine data. */
  name: string
  /** A human label - "PowerShell 7". */
  label: string
  /** The arguments Helm would launch it with, from the per-shell table. */
  args: string[]
}

/**
 * One pane on the workspace tab strip, in the form it is written down in.
 *
 * A record and not the strip's `project:C:\...` id string, deliberately: a
 * Windows path can contain a `#` and a `:`, so a tab id is an identity to
 * compare and never a thing to take apart again. Restoring the strip needs the
 * path and the number back, so what is persisted is the fields rather than the
 * id built from them.
 *
 * The renderer's `PaneRef` is this type - one definition, because the shape a
 * pane has and the shape it is stored in must not be free to drift apart.
 */
export type WorkspaceTab =
  | { kind: 'project'; path: string }
  | { kind: 'history' }
  | { kind: 'pulls' }
  | { kind: 'pr'; repoPath: string; number: number }
  | { kind: 'config' }
  | { kind: 'content' }
  | { kind: 'settings' }

/** How many tabs are worth writing down. Past this the list is a bug, not a
 * workspace, and a settings row nobody can shrink is worse than a truncation. */
export const WORKSPACE_TABS_MAX = 100

/**
 * How many projects the pinned list may name.
 *
 * A ceiling on a value that is JSON in one row and is rewritten whole on every
 * toggle, exactly as `PR_IGNORED_REPOS_MAX` is - not a statement about how many
 * anybody pins. A list past a screenful has stopped being a shortlist and the
 * tree is what it wanted, but that is the user's call and not a validator's.
 */
export const PINNED_PROJECTS_MAX = 200

/**
 * How two project paths are compared, everywhere this list is read or written.
 *
 * Case folding and nothing else. The sidebar's own grouping already keys its
 * harness map with a bare `path.toLowerCase()`, and a second normalisation here
 * - trailing separators, `resolve`, short-name expansion - would be a way for
 * the pinned section and the group it lifts a project out of to disagree about
 * whether they are looking at the same project, which is how the same row ends
 * up printed twice.
 */
function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Whether this project has been lifted into the sidebar's Pinned section. */
export function isProjectPinned(pinned: readonly string[], path: string): boolean {
  return pinned.some((entry) => samePath(entry, path))
}

/**
 * The pinned list with one project switched on or off.
 *
 * The whole list every time, because that is how the setting is written, and
 * the comparison is the case-insensitive one above - so pinning `C:\Repos\Api`
 * when the list already holds `c:\repos\api` replaces that entry rather than
 * adding a second spelling of one project. Sorted by path so the stored value
 * does not depend on the order somebody clicked; what the sidebar *shows* is
 * sorted by name instead, which is a different question and answered there.
 */
export function withProjectPinned(
  pinned: readonly string[],
  path: string,
  on: boolean
): string[] {
  const without = pinned.filter((entry) => !samePath(entry, path))
  const next = on ? [...without, path] : without
  return next.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
}

/**
 * Persisted application settings. Keys are the column names in `app_settings`;
 * every value is JSON-encoded on the way in, so adding a key here is the only
 * step needed to persist it.
 */
export interface AppSettings {
  theme: ThemePreference
  /** Directories the launcher scans. Empty means "not set up yet". */
  scanRoots: string[]
  /**
   * Projects lifted out of their harness group into the sidebar's Pinned
   * section, as absolute paths.
   *
   * Keyed by **path**, and that is a decision rather than the only option that
   * occurred to anybody - see the validator in `store/settings.ts`, which is
   * where the consequence is written down. Matching is case-insensitive, the
   * same comparison the sidebar's own grouping already makes on these paths.
   *
   * Projects only. A harness is not pinnable: the tree already gives every
   * harness a collapse state, which is most of what pinning one would be, and
   * one pin kind means there is no rule to invent for a pinned project inside a
   * pinned harness.
   *
   * A path that no longer resolves keeps its entry. Discovery will not return
   * it, so the sidebar paints it as gone rather than dropping it - pinning is a
   * deliberate act, and an unplugged drive is not a decision to un-pin.
   * Bounded by `PINNED_PROJECTS_MAX`.
   */
  pinnedProjects: string[]
  /** Window geometry, restored on next launch. */
  windowBounds: { width: number; height: number; x?: number; y?: number } | null
  /**
   * The workspace tab strip, restored on next launch: which panes are open, in
   * the order they were arranged, and which one was in front.
   *
   * State rather than a preference, so it sits beside `windowBounds` and not in
   * the settings pane - it is something Helm remembers, not something anyone
   * chose. Null means nothing has been written yet, which is not the same as an
   * empty strip: a user who closed every tab gets an empty strip back.
   *
   * The **session** strip is deliberately not here. `before-quit` calls
   * `sessions.shutdown()`, so no session survives a restart, and a strip of
   * tabs pointing at processes that no longer exist is not a workspace
   * restored - it is a strip of dead tabs to close.
   *
   * `activeId` is a tab id, which is only ever compared: a saved id that no
   * longer matches an open pane falls back to the last tab, the same rule that
   * governs `requestedId` while the app is running.
   */
  workspaceTabs: { panes: WorkspaceTab[]; activeId: string | null } | null
  /**
   * When the first-run flow was finished. Null means it has not been, which is
   * what puts the setup pane on screen instead of the launcher.
   */
  firstRunCompletedAt: string | null
  /**
   * A `claude` executable the user picked by hand, for the machine where it is
   * not on PATH and not in the usual install directory. Null means "find it".
   *
   * A path, never a credential: Helm locates the CLI and hands it a pty, and
   * signing in stays entirely between the user and `claude`.
   */
  claudePath: string | null
  /**
   * What the status bar's usage segment shows. Set in the settings pane's
   * Appearance group; clicking the segment itself still cycles it, because a
   * quick accessor beside the thing it changes is worth keeping.
   */
  usageDisplay: UsageDisplayMode

  /**
   * A font family for the terminal panes, or null for the built-in stack.
   *
   * Whatever is named here is **prepended** to the default stack, never
   * substituted for it. A monospace font chosen for its letterforms is rarely
   * chosen for its box-drawing, CJK or emoji coverage, and Claude Code's TUI is
   * made of box-drawing characters - so a font with holes in it has to degrade
   * one glyph at a time rather than take the whole interface down with it.
   */
  terminalFontFamily: string | null
  /** Point size for the terminal panes. Bounded by `TERMINAL_FONT_SIZE`. */
  terminalFontSize: number
  /** Cursor shape in the terminal panes. */
  terminalCursorStyle: TerminalCursorStyle
  terminalCursorBlink: boolean
  /** Lines of history a terminal pane keeps. Bounded by `TERMINAL_SCROLLBACK`. */
  terminalScrollback: number
  /**
   * The executable new project shells are opened with, or null to let Helm
   * detect one. An absolute path, for the reason `DetectedShell.path` gives.
   *
   * Project shells only. A Claude session is not a shell - Helm hands the
   * `claude` executable its own pty and this setting never reaches it.
   */
  terminalShell: string | null
  /**
   * How tall a project page's shell is, as a percentage of that page's column.
   * Bounded by `PROJECT_SHELL_HEIGHT_PCT`, dragged by the handle above the
   * shell, and settable in the Terminal group for when a drag lands somewhere
   * silly.
   *
   * **One value for every project rather than one per project.** The question
   * being answered is "how much terminal do I want", and that is about the
   * person and the monitor in front of them, not about the repository: someone
   * who wants a tall shell to read a `pnpm dev` in wants it in every checkout
   * they read one in. Per-project heights would also mean the page's
   * proportions moved as you moved between projects, which is furniture
   * rearranging itself.
   *
   * Not a terminal preference, whatever the settings group it is shown in says:
   * it never reaches `applyPrefs` and no session pane has one. It is the
   * project page's layout.
   */
  projectShellHeightPct: number
  /**
   * How wide the sessions column is, as a percentage of the window, when a
   * workspace pane and a session are both on screen. Bounded by
   * `SESSION_SPLIT_PCT` and dragged by the divider between them.
   *
   * **One value for every project**, the same answer `projectShellHeightPct`
   * gives and for the same reason: this is "how much terminal do I want beside
   * my work", which is a fact about the person and the monitor rather than
   * about a repository. It is also the stronger case of the two - this divider
   * does not move when you switch tabs, so a per-project value would make the
   * boundary jump every time somebody changed pane.
   *
   * A percentage, not the fraction the renderer holds. The pane's other
   * remembered size is a percentage, the settings row wants a number a person
   * can retype, and `0.45` in a database column that its neighbour writes `30`
   * into is the kind of difference nobody remembers on the day it matters.
   */
  sessionSplitPct: number

  /**
   * How many bytes of `helm.db` the transcript archive may occupy.
   *
   * The archive itself has no on/off switch, and that is the decision rather
   * than an omission. 91% of the conversations behind `history.jsonl` were
   * already gone when this was measured, and a default-off setting would go on
   * losing them while it sat off - the cost of capturing is a few kilobytes per
   * conversation and the cost of not capturing is the conversation. What *is*
   * a setting is the ceiling, because that is the part with a real trade-off in
   * it: bounded by `TRANSCRIPT_ARCHIVE_BYTES`, enforced after every pass by
   * dropping the oldest archived session whole. See `evictToCeiling` - the
   * ceiling is adjustable and the eviction rule is not.
   */
  transcriptArchiveMaxBytes: number
  /**
   * A `gh` executable the user picked by hand, for the machine where it is not
   * on PATH and not in the usual install directory. Null means "find it".
   *
   * A path, never a credential - the exact parity with `claudePath`, and the
   * same hard rule behind it: Helm locates the CLI and runs it, and the GitHub
   * sign-in stays entirely between the user and `gh auth login`.
   */
  ghPath: string | null
  /**
   * How often Helm sweeps the discovered repositories for open pull requests,
   * in minutes. `0` is off - manual and focus refreshes still work.
   *
   * On by default, which is a deliberate change to Helm's network posture and
   * not an oversight: periodic scanning is what the surface is for. Helm itself
   * still makes no direct request; `gh` does, on the user's own token, on this
   * schedule. Bounded by `PR_POLL_MINUTES`.
   */
  prPollMinutes: number
  /**
   * How long a pull request may go untouched before the Pulls pane files it
   * under STALE rather than ACTIVE, in days. `0` is off - one flat Open list,
   * exactly as that section rendered before the split existed.
   *
   * A **preference** rather than a constant, and it is the only piece of that
   * pane's triage controls that is one: where a pull request stops being work
   * in flight is a judgement about the user's own working rhythm, and a week's
   * silence on a repository with one contributor means something different from
   * a week's silence on a busy one. The filter and the grouping beside it are
   * the opposite - reactions to a list that changes hourly - so they live in
   * the pane's own state and deliberately not here. Bounded by `PR_STALE_DAYS`,
   * whose comment argues the default.
   */
  prStaleDays: number
  /**
   * Repositories whose pull requests Helm does not fetch or show, as
   * `owner/name` slugs.
   *
   * A denylist rather than an allowlist, because a repository appearing on this
   * surface is what discovery already means - a new clone should show up
   * without anybody enrolling it, and going quiet should take a deliberate act.
   *
   * Keyed by **slug**, not by directory. The slug is what the surface fetches
   * by (one `gh` per distinct remote, however many checkouts of it are on the
   * machine), it is what the user is actually choosing about, and it survives a
   * repository being re-cloned somewhere else. Matching is case-insensitive -
   * see `isRepoIgnored`.
   *
   * An ignored repository is skipped **before the fetch**, so this is a smaller
   * network posture rather than a filter over the same calls. Its cached rows
   * are left in the database untouched: they are true facts about the last time
   * anybody looked, and deleting them would make un-ignoring a repository show
   * an empty list rather than a stale one with its age on it - which is the
   * opposite of how the rest of this surface degrades.
   */
  prIgnoredRepos: string[]
  /**
   * The opening prompt a "Review with Claude" launch starts its session with.
   *
   * A template - `{number} {url} {branch} {title} {slug}` are substituted and
   * anything else in braces is left as written. Rendered in the **main
   * process** from the cached pull request; the window renders the same
   * template only to show what the button will run.
   *
   * `{branch}` names `headRefName`, which on a pull request opened from a fork
   * does not exist in the local checkout unless `prCheckout` is `'checkout'`.
   * The default uses `{number}` alone for exactly that reason.
   */
  prReviewPrompt: string
  /**
   * Whether a review launch checks the pull request out first.
   *
   * `'none'` reviews from the pull request's refs and never touches the working
   * tree. `'checkout'` runs `gh pr checkout <n>` in the repository before
   * spawning, and is refused with a count of the changed files when the tree is
   * dirty - Helm does not stash. See `PR_CHECKOUT_MODES`.
   */
  prCheckout: PrCheckoutMode
  /**
   * The model a review launch runs on; null is the CLI's own default.
   *
   * A setting rather than a fixed choice because a review is the one launch
   * Helm composes on the user's behalf, and reading a diff is not the task they
   * necessarily want their default model spent on - in either direction. Null
   * passes **no** `--model` at all rather than passing a name Helm decided,
   * which keeps a Helm nobody has configured launching exactly what `claude`
   * would have launched.
   *
   * Not validated against a list of names. The CLI's aliases and its full model
   * ids both move faster than a desktop app's release does, and a setting that
   * refused `claude-opus-5` on the day it shipped would be a setting the user
   * cannot use for exactly as long as it takes Helm to catch up. What is
   * enforced is the shape - one bare token, no spaces or dashes to lead with -
   * because this becomes an argv word.
   */
  prReviewModel: string | null
  /**
   * The reasoning effort a review launch runs at; null is the CLI's default.
   *
   * Bounded by `EFFORT_LEVELS`, unlike the model: these five are the CLI's own
   * flag values rather than a naming scheme that moves, and a select is a better
   * control than a text field for a closed set of five.
   */
  prReviewEffort: EffortLevel | null

  /**
   * Whether Helm asks GitHub, once per launch, if there is a newer release.
   *
   * A deliberate amendment to the network posture and the reason README, SPEC
   * 5, PACKAGING and the `update:check` comment all moved together: until this,
   * Helm's own process opened no connection at all unless somebody invoked the
   * channel by hand. It now opens one, at most once a day, on a launch.
   *
   * The reasoning that made "only when asked" right is untouched, because it
   * was never about the request - it was about the *download*. Helm still
   * fetches nothing, replaces nothing and restarts nothing; the whole outcome
   * is a version number, and a line in the status bar when it is higher. What
   * "only when asked" actually cost was the person who would have to think to
   * ask, which is nobody: an update you have to remember to look for is an
   * update you run without for months.
   *
   * On by default and off in one tick, because a machine that must not talk to
   * anything is a real requirement and not an exotic one.
   */
  updateCheck: boolean
  /**
   * When the last check actually reached GitHub, ISO 8601, or null.
   *
   * Internal state and deliberately not in the settings pane, the same as
   * `windowBounds` and `firstRunCompletedAt`: it is something Helm remembers,
   * not something anyone chose. It exists to throttle - `UPDATE_CHECK_EVERY_MS`
   * - so that restarting the app twenty times in an afternoon, which is what
   * developing it looks like, is still one request.
   */
  lastUpdateCheckAt: string | null
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  scanRoots: [],
  pinnedProjects: [],
  windowBounds: null,
  workspaceTabs: null,
  firstRunCompletedAt: null,
  claudePath: null,
  usageDisplay: 'percent',
  // The four defaults below are the values Spike C measured and `terminal.ts`
  // was built around. They are the documented baseline, not a starting point
  // someone picked: a setting left alone must produce the configuration the
  // fidelity checks measure.
  terminalFontFamily: null,
  terminalFontSize: TERMINAL_FONT_SIZE.default,
  terminalCursorStyle: 'block',
  terminalCursorBlink: true,
  terminalScrollback: TERMINAL_SCROLLBACK.default,
  terminalShell: null,
  projectShellHeightPct: PROJECT_SHELL_HEIGHT_PCT.default,
  sessionSplitPct: SESSION_SPLIT_PCT.default,
  transcriptArchiveMaxBytes: TRANSCRIPT_ARCHIVE_BYTES.default,
  ghPath: null,
  prPollMinutes: PR_POLL_MINUTES.default,
  prStaleDays: PR_STALE_DAYS.default,
  prIgnoredRepos: [],
  prReviewPrompt: DEFAULT_PR_REVIEW_PROMPT,
  prCheckout: 'none',
  prReviewModel: null,
  prReviewEffort: null,
  updateCheck: true,
  lastUpdateCheckAt: null
}

/**
 * How long a launch waits before asking about releases again.
 *
 * A day. The question changes about as often as a release happens, and the
 * throttle is what keeps "once per launch" from meaning "once per restart" on
 * the machine Helm is being written on.
 */
export const UPDATE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Config console
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

/**
 * Why a snapshot was taken. Stored on the row and shown in the file's history.
 *
 * `rename` and `delete` are ordinary rows and are deliberately not a second
 * mechanism: a `delete` row holds the bytes that were there, so restoring it
 * puts the file back the same way restoring an `edit` row does. That is what
 * makes "undo this delete" and "restore this version" the same button.
 */
export type ConfigWriteReason =
  | 'edit'
  | 'create'
  | 'restore'
  | 'mcp'
  | 'approve'
  | 'rename'
  | 'delete'

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

// --- Create, rename, delete -------------------------------------------------

/**
 * The three things a directory supports that replacing one file's bytes does
 * not. All three take the scope by path and the entry by absolute path, the
 * same way `config:write` does, and all three are answered with a structured
 * result rather than a throw: every one of them has failure modes the *user*
 * caused - a name the CLI could not address, a collision, a bundled file Helm
 * cannot record - and those have to be shown in the dialog that asked.
 */
export interface CreateConfigRequest {
  scopePath: string
  kind: CreatableKind
  /** Ignored for the fixed-name kinds; see `CREATABLE_KINDS`. */
  name: string
}

export interface CreateConfigResult {
  ok: boolean
  /** Absolute path of the file that now exists, so the console can open it. */
  path: string | null
  /** Relative to the scope base, forward-slashed - the tree's own key. */
  relPath: string | null
  /** The `create` row taken before the file was touched. */
  snapshotId: number | null
  error: string | null
}

export interface RenameConfigRequest {
  scopePath: string
  /** The addressed file - a skill's `SKILL.md`, not its directory. */
  path: string
  name: string
}

export interface RenameConfigResult {
  ok: boolean
  /** The addressed file at its new location. Null when nothing moved. */
  path: string | null
  relPath: string | null
  /** Every file that moved. A skill's whole directory, one file for the rest. */
  moved: Array<{ from: string; to: string }>
  /** Every row taken - the destinations' `create`s and the sources' `rename`s. */
  snapshotIds: number[]
  /**
   * The moved file's frontmatter `name:` was updated to match.
   *
   * Only ever true when it named the *old* address exactly - a file declaring
   * anything else is not claiming to be the thing being renamed, and Helm does
   * not edit a field somebody set on purpose.
   */
  frontmatterRenamed: boolean
  error: string | null
}

export interface DeleteConfigRequest {
  scopePath: string
  path: string
}

export interface DeletedConfigFile {
  path: string
  /** Relative to the scope base - the key this file's history is listed under. */
  relPath: string
  snapshotId: number
}

export interface DeleteConfigResult {
  ok: boolean
  /** What came off the disk, each with the row that can put it back. */
  removed: DeletedConfigFile[]
  error: string | null
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
  /** What you type: `acme:think`, or `think` for an unnamespaced one. */
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

// --- Live state, per file --------------------------------------------------

/**
 * What a resolution has to say about one file in a `.claude` tree.
 *
 * Six states rather than live/dead, because "not live" is three different
 * situations wearing one word: outranked by another layer, empty, or simply
 * not part of the resolution being looked at. They call for three different
 * reactions, so they are three different states.
 *
 *   - `live` - everything in it reaches a session
 *   - `partial` - it contributes, and something in it is outranked
 *   - `shadowed` - it contributes nothing that survives
 *   - `inert` - it is read, and has nothing to say
 *   - `absent` - this resolution never looks at it
 *   - `none` - Helm has no claim to make about it, and makes none
 */
export type ConfigLiveState = 'live' | 'partial' | 'shadowed' | 'inert' | 'absent' | 'none'

/** One settings leaf as one file declares it, and what outranked it. */
export interface ConfigSettingLive {
  key: string
  /** JSON encoding of *this file's* value, which may not be the winning one. */
  value: string
  layer: SettingsLayerKind
  wins: boolean
  outrankedBy: { layer: SettingsLayerKind; file: string; value: string } | null
}

/** One reason a hook file runs: the event, the matcher, and the layer saying so. */
export interface HookBinding {
  /** `PreToolUse`, `Stop`, ... - the key under `hooks`. */
  event: string
  /** The tool pattern the block matches, or null for a block with none. */
  matcher: string | null
  command: string
  layer: SettingsLayerKind
  /** The settings file the block is written in. */
  file: string
}

export interface ConfigLive {
  state: ConfigLiveState
  /** One line for a row. Null when there is nothing to say. */
  note: string | null
  /** The whole sentence, for the pill's title. Empty when the state is `none`. */
  reason: string
  /** What a session types to reach it: `dev:think`, `/spec:plan`. */
  invocation: string | null
  /** Other files resolving under the same name, each with its own invocation. */
  alsoDefinedBy: Array<{
    invocation: string
    source: EffectiveSource
    origin: string
    path: string
  }>
  /** Two unprefixed sources landed on one name, so which one wins is unpredicted. */
  contested: boolean
  settings: ConfigSettingLive[]
  hooks: HookBinding[]
  /** Settings leaves naming this file - a status line's command, and so on. */
  references: Array<{ key: string; layer: SettingsLayerKind; file: string; value: string }>
}

/**
 * A config file rendered as what it is, rather than as its bytes.
 *
 * Exactly one half is ever set: markdown for the kinds a session reads as
 * prose, highlighted source for the ones it runs. Both are null when the file
 * is neither, which is the case the pane draws as plain mono - and `code` is
 * null too when shiki has no grammar for the extension, so "not highlighted"
 * and "highlighted as plain text" stay different answers.
 */
export interface ConfigRendered {
  markdown: RenderedMarkdown | null
  code: { html: string; language: string; highlighted: boolean } | null
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
// Content viewer
// ---------------------------------------------------------------------------

/**
 * A directory of things worth reading, inside a scope.
 *
 * The four the spec names - `notes/`, `context/`, `.claude/skills/`, `docs/` -
 * are always offered when they exist, in that order, because they are the ones
 * a person goes looking for by name. Everything else is *found*: a top-level
 * directory holding anything readable is content whatever it is called, which is
 * how `lessons/` and `reference/` - full of artifacts Claude produced - end up
 * reachable without this file knowing they exist.
 */
export type ContentRootKind = 'notes' | 'context' | 'skills' | 'docs' | 'root' | 'found'

/**
 * *Why* a root is on screen, which is the thing the curated model was hiding.
 *
 * `named` is "offered by rule" - the four the spec names, plus the scope
 * directory itself, all of which are listed whether or not they turned out to
 * hold anything. `discovered` is "offered because walking it found content".
 * The badge is data rather than a UI inference from `kind` so that the pane and
 * a check are reading the same answer.
 */
export type ContentRootOffer = 'named' | 'discovered'

export interface ContentRoot {
  kind: ContentRootKind
  offer: ContentRootOffer
  /** Relative to the scope, forward-slashed. `''` is the scope directory itself. */
  relPath: string
  path: string
  label: string
  files: number
}

/**
 * What Helm will do with a file.
 *
 * `markdown` is rendered, `html` goes to the sandboxed frame, `data`, `text`
 * and `source` are shown as source, and `binary` is listed but not opened. The
 * distinction is by extension rather than by content because it decides which
 * *surface* opens, and a surface that changed after the read would flash the
 * wrong one first.
 *
 * A kind decides how a file **opens**, never whether it is **shown**. The
 * config tree already draws that line with `TEXT_EXT`, and the curated view
 * used to draw it in the wrong place: `contentFileKind` returned null for a
 * script and the walk then dropped it, so an agent's own `tools/` was invisible
 * in the pane meant for reading what the agent wrote.
 */
export type ContentFileKind = 'markdown' | 'html' | 'data' | 'text' | 'source' | 'binary'

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
  /** Lower-cased extension without the dot, `''` for a file that has none. */
  ext: string
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

/**
 * How the content pane is listing a scope.
 *
 * `curated` is the vault reading: the named roots, the discovered ones, newest
 * first inside each. `tree` is an ordinary file tree - every file, read one
 * directory at a time, with the repository's own ignore rules drawn rather than
 * applied silently.
 *
 * A scope's *kind* picks which one a scope opens on and nothing more. Both work
 * from either kind, because "a harness with a big `tools/` directory should
 * still be walkable" and "a project's `docs/` is still a vault" are both true,
 * and a mode locked to a kind cannot say so.
 */
export type ContentViewMode = 'curated' | 'tree'

/** Why a tree entry is greyed. `null` for one that is not. */
export type ContentIgnoreReason = 'gitignore' | 'default'

/**
 * One line of a directory listing in the tree view.
 *
 * Ignored entries are carried rather than dropped: the complaint this whole
 * surface answers is "nothing on screen says what was left out", and a tree
 * that hid `node_modules/` would be making exactly that omission at the top
 * level of every repository.
 */
export interface ContentDirEntry {
  name: string
  /** Relative to the scope, forward-slashed. */
  relPath: string
  path: string
  directory: boolean
  /**
   * A symlink or junction. Listed, never descended - an overlay shim's junction
   * points back into a real repository, and a tree that walked one would list
   * another project's files as this scope's.
   */
  link: boolean
  /** How the file would open. `null` for a directory. */
  kind: ContentFileKind | null
  /** Lower-cased extension without the dot. `''` for a directory or no extension. */
  ext: string
  size: number
  mtimeMs: number
  ignored: boolean
  ignoredBy: ContentIgnoreReason | null
}

/** One directory, read on demand. */
export interface ContentDirListing {
  scopePath: string
  /** Relative to the scope, forward-slashed. `''` is the scope directory. */
  relPath: string
  entries: ContentDirEntry[]
  /** How many of `entries` are ignored, so a header can count them. */
  ignored: number
  /**
   * What decided the ignores: the repository's own rules, or Helm's built-in
   * list where there is no git to ask.
   */
  ignoreSource: ContentIgnoreReason
  /** Set when this directory could not be read at all. */
  error: string | null
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

/**
 * A file shown as source, highlighted.
 *
 * The source view is what every kind that is not markdown or HTML opens in, and
 * once source files are listed at all - which is the point of the split - that
 * view is where an agent's `tools/` scripts are read. A `<pre>` of undifferen-
 * tiated grey is a worse answer than the one the markdown renderer already
 * gives a fenced block, and it is the same machinery: one `highlightCode` call,
 * both themes in the output as custom properties.
 */
export interface ContentSource {
  /** Shiki's HTML, or `''` when there is none and the plain text should show. */
  html: string
  /** The grammar used. `plaintext` when nothing matched the extension. */
  language: string
  highlighted: boolean
  /** True when the file was past the ceiling; `html` is empty and that is why. */
  tooLarge: boolean
}

/** A file, its bytes, and - for markdown - what they render to. */
export interface ContentDocument {
  file: ContentFile
  content: ConfigFileContent
  rendered: RenderedMarkdown | null
  /** Set for anything shown as source: data, text, and an agent's own scripts. */
  source: ContentSource | null
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
  /**
   * The kinds whose bytes were read, so the status row can say what was
   * searched rather than leaving the reader to infer it. Every file is matched
   * on its *name* whatever its kind, which is why this is about bodies only.
   */
  bodyKinds: ContentFileKind[]
  /** How many of `filesSearched` had their text read. The rest matched by name. */
  filesWithText: number
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
