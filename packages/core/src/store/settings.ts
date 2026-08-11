import { isAbsolute } from 'node:path'
import { sql } from 'drizzle-orm'
import {
  DEFAULT_SETTINGS,
  PR_POLL_MINUTES,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_FONT_SIZE,
  TERMINAL_SCROLLBACK,
  THEME_PREFERENCES,
  USAGE_DISPLAY_MODES,
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

export const SETTING_VALIDATORS: SettingValidators = {
  theme: oneOf(THEME_PREFERENCES),

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

  /** Null means "find it"; anything else is absolute, exactly as `claudePath`. */
  ghPath: (value) => {
    if (value === null) return null
    if (typeof value !== 'string' || value.trim() === '') {
      return `expected an absolute path or null, got ${describe(value)}`
    }
    if (!isAbsolute(value)) return `expected an absolute path, got ${JSON.stringify(value)}`
    return null
  },

  /**
   * Minutes, or zero for off.
   *
   * Zero is deliberately outside the range rather than the bottom of it: the
   * interval and "no interval at all" are different states, and a validator
   * that accepted 1 through 1440 plus 0 as a special case would let a
   * one-minute sweep over a dozen repositories through as well. Off is off, and
   * anything on is at least `PR_POLL_MINUTES.min` apart.
   */
  prPollMinutes: (value) => {
    if (value === PR_POLL_MINUTES.off) return null
    const problem = boundedInteger(PR_POLL_MINUTES)(value)
    return problem === null
      ? null
      : `${problem} (or ${String(PR_POLL_MINUTES.off)} to poll not at all)`
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
  return result
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
