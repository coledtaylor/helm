import { isAbsolute } from 'node:path'
import { sql } from 'drizzle-orm'
import { RETIRED_TAB_KINDS, upgradeSavedLayout } from '../layout/panes'
import {
  isPluginRailId,
  PLUGIN_PAGES_MAX,
  PLUGIN_TITLE_MAX,
  pluginParamsProblem,
  pluginTabNameProblem
} from '../plugins/tabs'
import {
  BROWSER_PROJECT_URLS_MAX,
  BROWSER_REACH_MODES,
  BROWSER_SEARCH_ENGINES,
  BROWSER_RECENT_URLS_MAX,
  browserReachAllows,
  CORNER_RADIUS,
  DEFAULT_SETTINGS,
  DENSITY_MODES,
  PANE_GAP,
  PINNED_PROJECTS_MAX,
  PROJECT_SHELL_HEIGHT_PCT,
  RAIL_DESTINATIONS,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_FONT_SIZE,
  TERMINAL_SCROLLBACK,
  THEME_ID_MAX_LENGTH,
  THEME_ID_PATTERN,
  THEME_PREFERENCES,
  TRANSCRIPT_ARCHIVE_BYTES,
  USAGE_DISPLAY_MODES,
  WORKSPACE_TABS_MAX,
  type AppSettings
} from '../types'
import type { Store } from './db'
import { appSettings } from './schema'

/**
 * `app_settings` as a typed object rather than a key-value bag at the call
 * site. Unknown keys in the table are ignored and missing keys fall back to
 * `DEFAULT_SETTINGS`, so a database written by an older or newer build still
 * loads.
 *
 * Reads are tolerant and writes are strict, and the asymmetry is deliberate.
 * A row this build does not understand is a fact about the past - another
 * version wrote it - and refusing to start over one would make every settings
 * change a migration. A *write* that does not match a key's shape is a bug
 * happening now: `{ theme: 'purple' }` reaches `nativeTheme.themeSource`, and
 * a value that only fails at the surface it drives fails a long way from
 * whatever sent it. So `writeSetting` and `writeSettings` validate first and
 * write nothing at all when a value does not fit.
 */

/**
 * The shape of every key, restated as a predicate.
 *
 * One entry per key of `AppSettings`, enforced by the compiler: adding a key to
 * the interface without a validator here does not compile. Each returns a
 * sentence naming what was wrong, or null when the value is fine.
 */
type SettingValidators = { [K in keyof AppSettings]: (value: unknown) => string | null }

const oneOf = (allowed: readonly string[]) => {
  return (value: unknown): string | null =>
    typeof value === 'string' && allowed.includes(value)
      ? null
      : `expected one of ${allowed.join(', ')}, got ${describe(value)}`
}

/** What a rejected value was, for the message. Short - this goes in an Error. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `an array of ${String(value.length)}`
  if (typeof value === 'object') return 'an object'
  return `${typeof value} ${String(value)}`
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** A whole number inside `[min, max]`, named for the message. */
const boundedInteger = (bounds: { min: number; max: number }) => {
  return (value: unknown): string | null => {
    if (!isFiniteNumber(value) || !Number.isInteger(value)) {
      return `expected a whole number, got ${describe(value)}`
    }
    if (value < bounds.min || value > bounds.max) {
      return `expected ${String(bounds.min)} to ${String(bounds.max)}, got ${String(value)}`
    }
    return null
  }
}

/**
 * Characters that must not reach a `font-family` declaration.
 *
 * The value is assigned to `Terminal.options.fontFamily`, which xterm puts
 * straight into an element's inline style. A semicolon or a brace there is not
 * a font name, it is the end of the declaration - so the shape of the value is
 * checked at the point it is saved rather than at the point it is painted.
 *
 * A comma is refused too, and that one is about meaning rather than safety:
 * this setting names *one* family, which Helm puts in front of the default
 * stack. A stack typed in here would look like it replaced the default and
 * would not.
 */
const FONT_FAMILY_PUNCTUATION = ";{}<>,\\/*\"'`"

function unsafeFontFamily(value: string): boolean {
  for (const ch of value) {
    // Written as a scan rather than a regular expression so the control-character
    // half of the rule is legible: an escape sequence in a character class is
    // exactly the kind of thing that gets "tidied" into a range that means
    // something else.
    if (ch.charCodeAt(0) < 0x20) return true
    if (FONT_FAMILY_PUNCTUATION.includes(ch)) return true
  }
  return false
}

/**
 * A theme's id, not its existence. The settings layer cannot know which files
 * are in the themes directory, and should not: a slot naming a theme whose file
 * has gone is resolved to the built-in of its kind at paint time, and the row
 * keeps the name so the theme comes back when the file does.
 */
const themeId = (value: unknown): string | null =>
  typeof value === 'string' && value.length <= THEME_ID_MAX_LENGTH && THEME_ID_PATTERN.test(value)
    ? null
    : `expected a theme id (lower-case letters, digits and dashes), got ${describe(value)}`

/**
 * `#rrggbb` and nothing else. This one reaches CSS through `deriveAccent`, which
 * would also take `rgb()` - but the pane only ever writes hex, and one spelling
 * in the row is one spelling to compare.
 */
const ACCENT_HEX = /^#[0-9a-f]{6}$/

/**
 * Why one persisted tab is not a tab, or null when it is.
 *
 * Every `kind` is checked against the union and every kind's own fields with
 * it, because this is read back and rendered as panes - a `project` with no
 * path is a tab pointing nowhere, and it would fail at the pane rather than at
 * the write.
 */
function paneProblem(pane: unknown): string | null {
  if (typeof pane !== 'object' || pane === null || Array.isArray(pane)) {
    return `expected a pane, got ${describe(pane)}`
  }
  const { kind, path, id } = pane as Record<string, unknown>
  if (kind === 'history' || kind === 'config') return null
  if (kind === 'session') {
    // A row id. Never reopened from here - only read after a crash, to find
    // where the session that is being reopened was.
    if (!isFiniteNumber(id) || !Number.isInteger(id) || id <= 0) {
      return `expected a session id, got ${describe(id)}`
    }
    return null
  }
  if (kind === 'settings' || kind === 'sessions') return null
  // A kind an older build wrote and this one opens nothing for. Accepted so the
  // rest of the layout it sits in still loads; `fromSaved` drops the tab.
  if (typeof kind === 'string' && RETIRED_TAB_KINDS.has(kind)) return null
  if (kind === 'project') {
    if (typeof path !== 'string' || path.trim() === '') {
      return `expected a project path, got ${describe(path)}`
    }
    return null
  }
  if (kind === 'file') {
    const { root } = pane as Record<string, unknown>
    if (typeof root !== 'string' || root.trim() === '') {
      return `expected the file's project, got ${describe(root)}`
    }
    if (typeof path !== 'string' || path.trim() === '') {
      return `expected a file path, got ${describe(path)}`
    }
    return null
  }
  if (kind === 'plugin') {
    const { plugin, tab, params, title } = pane as Record<string, unknown>
    return pluginSurfaceProblem(plugin, tab, params, title)
  }
  if (kind === 'plugin-pages') {
    const { plugin, pages, active } = pane as Record<string, unknown>
    if (!Array.isArray(pages) || pages.length === 0 || pages.length > PLUGIN_PAGES_MAX) {
      return `expected 1 to ${String(PLUGIN_PAGES_MAX)} plugin pages, got ${describe(pages)}`
    }
    for (const page of pages as unknown[]) {
      if (typeof page !== 'object' || page === null || Array.isArray(page)) {
        return `expected a plugin page, got ${describe(page)}`
      }
      const { tab, params, title } = page as Record<string, unknown>
      const problem = pluginSurfaceProblem(plugin, tab, params, title)
      if (problem !== null) return problem
    }
    if (active !== null && typeof active !== 'string') return `expected the page in front or null, got ${describe(active)}`
    return null
  }
  return `expected a pane kind, got ${describe(kind)}`
}

/** Why a plugin tab, or a page in a plugin's strip, is not one a manifest could have opened. */
function pluginSurfaceProblem(plugin: unknown, tab: unknown, params: unknown, title: unknown): string | null {
  const named = pluginTabNameProblem(plugin, tab)
  if (named !== null) return named
  const problem = pluginParamsProblem(params)
  if (problem !== null) return problem
  if (title !== null && (typeof title !== 'string' || title.trim() === '' || title.length > PLUGIN_TITLE_MAX)) {
    return `expected a tab title or null, got ${describe(title)}`
  }
  return null
}

/** Deeper than this is not a tree a person arranged; see `paneTreeProblem`. */
const PANE_TREE_DEPTH_MAX = 32

/**
 * Why a saved pane tree is not one, or null when it is, counting its groups
 * and tabs into `count` as it goes.
 *
 * A node is a group - `panes` and `activeId` - or a split: an axis, two or more
 * children and a positive share for each. The depth is bounded before the walk
 * goes deeper, so a hand-edited value nested a thousand levels is refused
 * rather than walked.
 */
function paneTreeProblem(node: unknown, depth: number, count: { groups: number; panes: number }): string | null {
  if (depth > PANE_TREE_DEPTH_MAX) return `expected panes nested at most ${String(PANE_TREE_DEPTH_MAX)} deep`
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    return `expected a group or a split, got ${describe(node)}`
  }
  const record = node as Record<string, unknown>
  if ('axis' in record) {
    const { axis, children, sizes } = record
    if (axis !== 'row' && axis !== 'column') return `expected a split axis, got ${describe(axis)}`
    if (!Array.isArray(children) || children.length < 2) {
      return `expected a split of two or more, got ${describe(children)}`
    }
    if (
      !Array.isArray(sizes) ||
      sizes.length !== children.length ||
      !sizes.every((size) => isFiniteNumber(size) && size > 0)
    ) {
      return `expected a positive share for each of ${String(children.length)} children, got ${describe(sizes)}`
    }
    for (const child of children) {
      const problem = paneTreeProblem(child, depth + 1, count)
      if (problem !== null) return problem
    }
    return null
  }
  const { panes, activeId } = record
  if (!Array.isArray(panes)) return `expected an array of panes, got ${describe(panes)}`
  if (activeId !== null && typeof activeId !== 'string') {
    return `expected a tab id or null, got ${describe(activeId)}`
  }
  count.groups += 1
  count.panes += panes.length
  if (count.panes > WORKSPACE_TABS_MAX) {
    return `expected at most ${String(WORKSPACE_TABS_MAX)} panes in all, got more`
  }
  for (const pane of panes) {
    const problem = paneProblem(pane)
    if (problem !== null) return problem
  }
  return null
}

export const SETTING_VALIDATORS: SettingValidators = {
  theme: oneOf(THEME_PREFERENCES),

  themeDark: themeId,
  themeLight: themeId,
  paneGap: boundedInteger(PANE_GAP),
  cornerRadius: boundedInteger(CORNER_RADIUS),
  density: oneOf(DENSITY_MODES),
  accentColor: (value) =>
    value === null || (typeof value === 'string' && ACCENT_HEX.test(value))
      ? null
      : `expected null or a lower-case #rrggbb, got ${describe(value)}`,

  usageDisplay: oneOf(USAGE_DISPLAY_MODES),

  /**
   * Absolute paths only. A relative root would be resolved against whatever
   * the process's working directory happened to be - which for a packaged app
   * is wherever the shortcut pointed - so the same setting would scan two
   * different directories on two different launches.
   */
  scanRoots: (value) => {
    if (!Array.isArray(value)) return `expected an array of paths, got ${describe(value)}`
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        return `expected every root to be a path, got ${describe(entry)}`
      }
      if (!isAbsolute(entry)) return `expected an absolute path, got ${JSON.stringify(entry)}`
    }
    return null
  },

  /**
   * Projects in the sidebar's Pinned section, as a *set* of absolute paths.
   *
   * **Keyed by path, and a moved or re-cloned checkout therefore loses its
   * pin.** That is the decision, not an oversight found later: a project has
   * nothing steadier than its path to key by.
   * It is not a repository - a plain folder and a harness root are both
   * pinnable and neither has a remote - and it is not a database row, because
   * this list has to be readable and writable before the first scan finishes.
   * Its path is the only identity it has; `Project.path` says so, and the
   * `projects` table uses it as the primary key for the same reason.
   *
   * What that costs is one re-pin after a move, in the surface the pin was made
   * in. What keying by anything else would cost is an identity that has to be
   * resolved before the tree can paint. The trade is worth it in that
   * direction, and it is written here so the next person to meet a pin that
   * disappeared after a re-clone knows it was chosen rather than broken.
   *
   * Absolute, for the reason `scanRoots` is: a relative entry would name a
   * different directory depending on what the shortcut's working directory was.
   * The duplicate check is case-insensitive and matches `isProjectPinned`, so
   * two spellings of one path cannot become two rows in a section where only
   * one of them could ever be un-pinned.
   */
  pinnedProjects: (value) => {
    if (!Array.isArray(value)) return `expected an array of paths, got ${describe(value)}`
    if (value.length > PINNED_PROJECTS_MAX) {
      return `expected at most ${String(PINNED_PROJECTS_MAX)} projects, got ${String(value.length)}`
    }
    const seen = new Set<string>()
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        return `expected every pin to be a path, got ${describe(entry)}`
      }
      if (!isAbsolute(entry)) return `expected an absolute path, got ${JSON.stringify(entry)}`
      const key = entry.toLowerCase()
      if (seen.has(key)) return `expected each project once, got ${JSON.stringify(entry)} twice`
      seen.add(key)
    }
    return null
  },

  /** Null means "find it"; anything else has to be an absolute path. */
  claudePath: (value) => {
    if (value === null) return null
    if (typeof value !== 'string' || value.trim() === '') {
      return `expected an absolute path or null, got ${describe(value)}`
    }
    if (!isAbsolute(value)) return `expected an absolute path, got ${JSON.stringify(value)}`
    return null
  },

  /**
   * Geometry, not a preference - but it is written on every resize, so a
   * nonsense value here is a window that opens off screen or 0px wide.
   * Position is optional and only meaningful as a pair.
   */
  windowBounds: (value) => {
    if (value === null) return null
    if (typeof value !== 'object' || Array.isArray(value)) {
      return `expected window bounds or null, got ${describe(value)}`
    }
    const bounds = value as Record<string, unknown>
    if (!isFiniteNumber(bounds['width']) || bounds['width'] <= 0) {
      return `expected a positive width, got ${describe(bounds['width'])}`
    }
    if (!isFiniteNumber(bounds['height']) || bounds['height'] <= 0) {
      return `expected a positive height, got ${describe(bounds['height'])}`
    }
    for (const axis of ['x', 'y'] as const) {
      const at = bounds[axis]
      if (at !== undefined && !isFiniteNumber(at)) {
        return `expected a number for ${axis}, got ${describe(at)}`
      }
    }
    return null
  },

  /**
   * The panes. State like `windowBounds`, and validated like it: written by
   * the window on every tab change, so a malformed value here is a layout that
   * cannot be restored on the next launch.
   *
   * A tree of splits and groups (`paneTreeProblem`), and a focus that is the
   * place of one of its groups in reading order. The whole value is rejected
   * rather than the offending entry filtered out: a partly-written layout
   * restored as if it were whole is a worse answer than the previous one.
   */
  paneLayout: (value) => {
    if (value === null) return null
    if (typeof value !== 'object' || Array.isArray(value)) {
      return `expected a pane layout or null, got ${describe(value)}`
    }
    const { root, focused } = value as Record<string, unknown>
    const count = { groups: 0, panes: 0 }
    const problem = paneTreeProblem(root, 0, count)
    if (problem !== null) return problem
    if (!Number.isInteger(focused) || (focused as number) < 0 || (focused as number) >= count.groups) {
      return `expected the place of a group, got ${describe(focused)}`
    }
    // Every group holds a tab except the window's one empty group: `toSaved`
    // writes no other. So the tab bound is also the bound on the tree's size.
    if (count.groups > Math.max(1, count.panes)) {
      return `expected every group to hold a tab, got ${String(count.groups)} groups for ${String(count.panes)} tabs`
    }
    return null
  },

  /** A timestamp, or null for "has not happened". Parsed, not pattern-matched. */
  firstRunCompletedAt: (value) => {
    if (value === null) return null
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      return `expected an ISO timestamp or null, got ${describe(value)}`
    }
    return null
  },

  /**
   * One family name, or null for the built-in stack.
   *
   * Length-capped as well as character-checked: this ends up in an inline style
   * on every terminal, and there is no font name that needs a hundred
   * characters.
   */
  terminalFontFamily: (value) => {
    if (value === null) return null
    if (typeof value !== 'string' || value.trim() === '') {
      return `expected a font family or null, got ${describe(value)}`
    }
    if (value.length > 100) return `expected a font family, got ${String(value.length)} characters`
    if (unsafeFontFamily(value)) {
      return `expected one plain family name, got ${JSON.stringify(value)}`
    }
    return null
  },

  terminalFontSize: boundedInteger(TERMINAL_FONT_SIZE),

  terminalCursorStyle: oneOf(TERMINAL_CURSOR_STYLES),

  terminalCursorBlink: (value) =>
    typeof value === 'boolean' ? null : `expected true or false, got ${describe(value)}`,

  terminalScrollback: boundedInteger(TERMINAL_SCROLLBACK),

  /**
   * Null means "find one"; anything else is an absolute path, for the same
   * reason `claudePath` is. A bare `pwsh.exe` would be resolved against the
   * PATH of whatever launched Helm, so the setting would name different
   * programs on different launches.
   */
  terminalShell: (value) => {
    if (value === null) return null
    if (typeof value !== 'string' || value.trim() === '') {
      return `expected an absolute path or null, got ${describe(value)}`
    }
    if (!isAbsolute(value)) return `expected an absolute path, got ${JSON.stringify(value)}`
    return null
  },

  /**
   * A percentage of the project page's column, bounded at both ends.
   *
   * The non-finite case is the one worth naming. This number is divided into a
   * layout - it becomes a `height` - and `NaN%` is a declaration the style
   * parser drops silently, so the pane would keep whatever height it happened
   * to have and nothing on screen would say the setting was broken. The bound
   * that refuses it is the same one that refuses 900.
   *
   * Whole numbers only, because that is what the drag writes: a percentage is
   * rounded before it is stored, so the settings row shows the number a person
   * can retype rather than 31.4159.
   */
  projectShellHeightPct: boundedInteger(PROJECT_SHELL_HEIGHT_PCT),

  /** Whether a file in the Files view wraps. A boolean and nothing truthy. */
  filesWrap: (value) =>
    typeof value === 'boolean' ? null : `expected true or false, got ${describe(value)}`,

  /**
   * Known destinations and plugins' rail ids (`plugin:<id>`), each once.
   * `settings` is refused because it is not in `RAIL_DESTINATIONS` - the rail
   * always keeps a way back to this setting.
   */
  railHidden: (value) => {
    if (!Array.isArray(value)) return `expected an array of rail destinations, got ${describe(value)}`
    const seen = new Set<string>()
    for (const entry of value) {
      if (
        typeof entry !== 'string' ||
        !((RAIL_DESTINATIONS as readonly string[]).includes(entry) || isPluginRailId(entry))
      ) {
        return `expected one of ${RAIL_DESTINATIONS.join(', ')} or a plugin's rail id, got ${describe(entry)}`
      }
      if (seen.has(entry)) return `${entry} is listed twice`
      seen.add(entry)
    }
    return null
  },

  /**
   * The transcript archive's ceiling, in bytes.
   *
   * A plain bounded integer, with no "off" value beside it. Turning the archive off is not
   * something this key expresses, because the archive is not optional: see the
   * field's comment in `types.ts`. The floor is low enough for a check to drive
   * eviction, which is the whole reason it is not something respectable.
   */
  transcriptArchiveMaxBytes: boundedInteger(TRANSCRIPT_ARCHIVE_BYTES),

  updateCheck: (value) => (typeof value === 'boolean' ? null : 'must be a boolean'),

  /**
   * An instant Helm wrote, checked anyway. This is the only defence against a
   * throttle that never opens: a value `Date.parse` cannot read would make
   * every comparison against it NaN, and NaN fails every `>` - so a single bad
   * row would silently mean "never check again" rather than "check now".
   */
  lastUpdateCheckAt: (value) => {
    if (value === null) return null
    if (typeof value !== 'string') return 'must be an ISO 8601 string or null'
    return Number.isFinite(Date.parse(value)) ? null : 'must be an ISO 8601 instant'
  },

  browserReach: oneOf(BROWSER_REACH_MODES),
  browserSearch: oneOf(BROWSER_SEARCH_ENGINES),

  /**
   * The two agent controls, and a boolean is checked as a boolean for the
   * reason `updateCheck` is: `'false'` is truthy, and a row hand-edited into a
   * string would switch the endpoint **on** while reading as off in the pane.
   */
  browserMcp: (value) => (typeof value === 'boolean' ? null : 'must be a boolean'),
  browserMcpLocalOnly: (value) => (typeof value === 'boolean' ? null : 'must be a boolean'),
  restoreWithoutAsking: (value) => (typeof value === 'boolean' ? null : 'must be a boolean'),

  /**
   * The session-awareness tools, checked exactly as strictly for exactly the
   * same reason: this one also decides whether a port is bound.
   */
  sessionMcp: (value) => (typeof value === 'boolean' ? null : 'must be a boolean'),

  /**
   * Addresses the browser pane has been to, newest first.
   *
   * Every entry has to be something `browserReachAllows` would allow with the
   * widest posture - which is to say an absolute http or https URL. A dropdown
   * whose rows are not addresses is a dropdown whose rows do nothing when
   * clicked, and the value is written by Helm rather than typed, so a row that
   * is not one is a bug in this build and not a fact about the past.
   */
  browserRecentUrls: (value) => {
    if (!Array.isArray(value)) return `expected an array of URLs, got ${describe(value)}`
    if (value.length > BROWSER_RECENT_URLS_MAX) {
      return `expected at most ${String(BROWSER_RECENT_URLS_MAX)}, got ${String(value.length)}`
    }
    for (const entry of value) {
      if (typeof entry !== 'string') return `expected URLs, got ${describe(entry)}`
      if (!browserReachAllows(entry, 'web').allowed) {
        return `expected an http or https URL, got ${JSON.stringify(entry)}`
      }
    }
    return null
  },

  /** The same, keyed by the project directory the browser was opened beside. */
  browserProjectUrls: (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return `expected an object of path to URL, got ${describe(value)}`
    }
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length > BROWSER_PROJECT_URLS_MAX) {
      return `expected at most ${String(BROWSER_PROJECT_URLS_MAX)}, got ${String(entries.length)}`
    }
    for (const [path, url] of entries) {
      // Absolute for the reason `scanRoots` is: a relative key resolves against
      // whatever the working directory happened to be when it was written.
      if (!isAbsolute(path)) return `expected absolute project paths, got ${JSON.stringify(path)}`
      if (path !== path.toLowerCase()) {
        return `expected lower-cased project paths, got ${JSON.stringify(path)}`
      }
      if (typeof url !== 'string' || !browserReachAllows(url, 'web').allowed) {
        return `expected an http or https URL for ${JSON.stringify(path)}, got ${describe(url)}`
      }
    }
    return null
  }
}

/** A write that was refused, with the key and the reason in the message. */
export class SettingsValidationError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`settings rejected: ${problems.join('; ')}`)
    this.name = 'SettingsValidationError'
    this.problems = problems
  }
}

/** The problem with this value for this key, or null when there is none. */
export function validateSetting(key: keyof AppSettings, value: unknown): string | null {
  const problem = SETTING_VALIDATORS[key](value)
  return problem === null ? null : `${key}: ${problem}`
}

/** Rail ids an older build could hide that name nothing now. See `readSettings`. */
const RETIRED_RAIL_DESTINATIONS: ReadonlySet<string> = new Set(['pulls'])

export function readSettings(store: Store): AppSettings {
  const rows = store.db.select().from(appSettings).all()
  const result: AppSettings = { ...DEFAULT_SETTINGS }

  for (const row of rows) {
    if (!(row.key in DEFAULT_SETTINGS)) continue
    try {
      // A hand-edited or truncated value must not take the whole app down with
      // it; one unreadable key falls back to its default.
      Object.assign(result, { [row.key]: JSON.parse(row.value) as unknown })
    } catch {
      continue
    }
  }

  // A rail destination an older build drew and this one does not, dropped
  // rather than kept: the list is validated against `RAIL_DESTINATIONS` on
  // the way back in, so one stale id would refuse every later change to it.
  if (Array.isArray(result.railHidden)) {
    result.railHidden = result.railHidden.filter((entry) => !RETIRED_RAIL_DESTINATIONS.has(entry))
  }

  // A layout written before panes were a tree, read as the row it was with the
  // divider where its own setting left it. That setting is no key of this
  // build's, so it is read here and nowhere else.
  const split = rows.find((row) => row.key === 'paneSplitPct')
  result.paneLayout = upgradeSavedLayout(result.paneLayout as unknown, parsedOrNull(split?.value))
  return result
}

/** A stored value read back, or null when there is none or it is not JSON. */
function parsedOrNull(value: string | undefined): unknown {
  if (value === undefined) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

export function writeSetting<K extends keyof AppSettings>(
  store: Store,
  key: K,
  value: AppSettings[K]
): void {
  const problem = validateSetting(key, value)
  if (problem !== null) throw new SettingsValidationError([problem])

  store.db
    .insert(appSettings)
    .values({ key, value: JSON.stringify(value) })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: {
        value: JSON.stringify(value),
        updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
      }
    })
    .run()
}

/**
 * A patch, applied as one edit.
 *
 * Every key is validated *before* anything is written, so a patch carrying one
 * bad value leaves the table exactly as it was rather than half applied - the
 * caller's next read then still describes a state the app was ever actually in.
 * Keys this build does not know are skipped rather than rejected: that is the
 * read side's tolerance, kept on the write side for the same reason.
 */
export function writeSettings(store: Store, patch: Partial<AppSettings>): AppSettings {
  const entries = Object.entries(patch).filter(([key]) => key in DEFAULT_SETTINGS) as Array<
    [keyof AppSettings, AppSettings[keyof AppSettings]]
  >

  const problems = entries
    .map(([key, value]) => validateSetting(key, value))
    .filter((problem): problem is string => problem !== null)
  if (problems.length > 0) throw new SettingsValidationError(problems)

  const apply = store.raw.transaction(() => {
    for (const [key, value] of entries) writeSetting(store, key, value)
  })
  apply()
  return readSettings(store)
}
