import type { ThemePreference } from '../types'
import { contrastRatio, formatColor, mix, parseColor, withAlpha, type Rgba } from './color'

/**
 * Themes: what one is, the three Helm ships, and how a file becomes one.
 *
 * A theme is the nineteen colours the chrome is painted with and nothing else.
 * Two things are deliberately **not** in it:
 *
 * - **The terminal.** Its ground and its 24-bit palette are the configuration
 *   Spike C measured and `pnpm fidelity` pins (`renderer/terminal.ts`), so a
 *   session renders the same under every theme. A theme that could move them
 *   would be a theme that could break a TUI.
 * - **Shape.** Gaps, corners and density are settings of their own, so a
 *   person's choice of corner survives changing colours.
 *
 * Pure: no DOM, no Node. The renderer imports it through `@helm/core/types`;
 * reading theme files off disk is `theme/load.ts`, which is not reachable from
 * there.
 */

/**
 * Every colour a theme sets, by the name it has in a theme file and - with a
 * `--helm-` prefix - as a CSS custom property. Order is the order a duplicated
 * theme file lists them in: grounds, edges, text, accent, status.
 */
export const THEME_TOKENS = [
  'bg',
  'surface',
  'surface-raised',
  'surface-sunken',
  'hover',
  'active',
  'border',
  'border-strong',
  'fg',
  'fg-muted',
  'fg-subtle',
  'accent',
  'accent-fg',
  'accent-soft',
  'accent-soft-hover',
  'accent-text',
  'success',
  'warn',
  'danger'
] as const

export type ThemeToken = (typeof THEME_TOKENS)[number]
export type ThemeTokens = Record<ThemeToken, string>
export type ThemeKind = 'dark' | 'light'
export const THEME_KINDS: readonly ThemeKind[] = ['dark', 'light']

/**
 * The tokens that may be translucent. Everything else is a ground or a text
 * colour and must be opaque: `bg` and `fg-muted` become the colours Windows
 * paints the title-bar buttons with, which takes no alpha, and a translucent
 * ground composites over whatever happens to be behind it - which for an
 * island is the canvas, and for a popover is a session.
 */
export const TRANSLUCENT_TOKENS: ReadonlySet<ThemeToken> = new Set<ThemeToken>([
  'border',
  'border-strong',
  'accent-soft',
  'accent-soft-hover'
])

export interface ThemeDefinition {
  /** Lower-case, from the file name for a user theme. Unique across all themes. */
  id: string
  name: string
  kind: ThemeKind
  tokens: ThemeTokens
  builtin: boolean
  /** The file it was read from; null for a built-in. */
  file: string | null
  /** Things in the file that were ignored or fell back. Empty for a built-in. */
  problems: string[]
}

/** A theme file that could not be read as a theme at all. */
export interface ThemeProblem {
  file: string
  message: string
}

/** The Appearance pane's view of the themes there are. */
export interface ThemeListing {
  /** Where user themes live, for "Open folder" and for the sentence beside it. */
  dir: string
  themes: ThemeDefinition[]
  /** Files that were skipped, each with the sentence saying why. */
  errors: ThemeProblem[]
}

/** The theme on screen, every value in canonical spelling, accent override folded in. */
export interface AppliedTheme {
  id: string
  name: string
  kind: ThemeKind
  tokens: ThemeTokens
  /** Modals only (DESIGN.md "no stacked shadows"). Follows the kind, not the file. */
  shadow: string
  /**
   * True when the setting named a theme that is not there - a file deleted or
   * broken while it was chosen - and this is the built-in standing in for it.
   */
  fallback: boolean
}

/** What a theme preference resolves to, with the theme it resolved to. */
export interface ThemeState {
  preference: ThemePreference
  /** The kind of theme on screen. What `.dark` on `<html>` says. */
  resolved: ThemeKind
  applied: AppliedTheme
}

/** Lower-case letters, digits and single dashes; a file name made safe. */
export const THEME_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const THEME_ID_MAX_LENGTH = 48
export const THEME_NAME_MAX_LENGTH = 48

/** A theme file this large is not a palette. Refused before it is parsed. */
export const THEME_FILE_MAX_BYTES = 64 * 1024

const SHADOW: Record<ThemeKind, string> = {
  dark: '0 24px 64px rgb(0 0 0 / 0.5)',
  light: '0 24px 64px rgb(16 20 30 / 0.18)'
}

/**
 * The three Helm ships.
 *
 * **Nocturne** is v1's dark ramp exactly, values measured into DESIGN.md over
 * many rounds (the hover step, `accent-soft-hover`, the 4.5:1 floors), so the
 * default look of every existing install does not move.
 *
 * **Graphite** inverts the elevation: the canvas is lighter than the islands
 * on it, so a pane reads as a recess in a frame rather than a card on a table.
 *
 * **Daylight** is the light ramp, re-tuned for thin gutters: a lighter canvas
 * and a lighter well, since 6px of canvas between white islands reads as a
 * seam where 8px read as a gutter. `fg-subtle` holds 4.7:1 on white, where the
 * 11px chip text binds.
 */
export const BUILTIN_THEMES: readonly ThemeDefinition[] = [
  builtin('nocturne', 'Nocturne', 'dark', {
    bg: '#12131f',
    surface: '#1a1c2b',
    'surface-raised': '#202233',
    'surface-sunken': '#0d0e17',
    hover: '#242639',
    active: '#2b2d44',
    border: 'rgb(233 233 237 / 0.08)',
    'border-strong': 'rgb(233 233 237 / 0.16)',
    fg: '#e9e9ed',
    'fg-muted': '#9397ab',
    'fg-subtle': '#75798c',
    accent: '#9184d9',
    'accent-fg': '#12131f',
    'accent-soft': 'rgb(145 132 217 / 0.14)',
    'accent-soft-hover': 'rgb(145 132 217 / 0.26)',
    'accent-text': '#d2cefd',
    success: '#8fbf7f',
    warn: '#d9b36c',
    danger: '#d97c76'
  }),
  builtin('graphite', 'Graphite', 'dark', {
    bg: '#25282e',
    surface: '#1c1f24',
    'surface-raised': '#2a2e35',
    'surface-sunken': '#16181c',
    hover: '#272a30',
    active: '#30343c',
    border: 'rgb(255 255 255 / 0.08)',
    'border-strong': 'rgb(255 255 255 / 0.15)',
    fg: '#e3e5e9',
    'fg-muted': '#a0a6b0',
    'fg-subtle': '#767c87',
    accent: '#6ca6f5',
    'accent-fg': '#16181c',
    'accent-soft': 'rgb(108 166 245 / 0.15)',
    'accent-soft-hover': 'rgb(108 166 245 / 0.27)',
    'accent-text': '#bbd7ff',
    success: '#85c28b',
    warn: '#e3b262',
    danger: '#e57a7c'
  }),
  builtin('daylight', 'Daylight', 'light', {
    bg: '#e6e8ee',
    surface: '#ffffff',
    'surface-raised': '#f4f5f8',
    'surface-sunken': '#eef0f4',
    hover: '#eceef3',
    active: '#e3e5ee',
    border: 'rgb(22 24 38 / 0.1)',
    'border-strong': 'rgb(22 24 38 / 0.18)',
    fg: '#1d1f2e',
    'fg-muted': '#555a69',
    'fg-subtle': '#6f7383',
    accent: '#6f61c4',
    'accent-fg': '#ffffff',
    'accent-soft': 'rgb(111 97 196 / 0.1)',
    'accent-soft-hover': 'rgb(111 97 196 / 0.2)',
    'accent-text': '#5a4da8',
    success: '#2f7a43',
    warn: '#9a6b12',
    danger: '#c03b38'
  })
]

function builtin(id: string, name: string, kind: ThemeKind, tokens: ThemeTokens): ThemeDefinition {
  return { id, name, kind, tokens, builtin: true, file: null, problems: [] }
}

/** Which built-in stands in for each kind: the default, and the fallback. */
export const DEFAULT_THEME_ID: Record<ThemeKind, string> = {
  dark: 'nocturne',
  light: 'daylight'
}

/**
 * Accents offered as swatches. `null` - the theme's own - is the first choice
 * and is not in this list. Any `#rrggbb` is a valid setting; these are what the
 * pane offers, each one re-derived per theme by `deriveAccent`.
 */
export const ACCENT_SWATCHES: readonly { name: string; hex: string }[] = [
  { name: 'Blue', hex: '#6ca6f5' },
  { name: 'Teal', hex: '#4fc3b4' },
  { name: 'Green', hex: '#8fbf7f' },
  { name: 'Amber', hex: '#d9a066' },
  { name: 'Rose', hex: '#d9849a' }
]

function builtinById(id: string): ThemeDefinition | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id)
}

function defaultTheme(kind: ThemeKind): ThemeDefinition {
  // The table above has both ids, so this is total; the throw is for the day
  // somebody renames one and not the other.
  const found = builtinById(DEFAULT_THEME_ID[kind])
  if (!found) throw new Error(`no built-in theme for ${kind}`)
  return found
}

/**
 * A theme id from a file name: `My Theme.json` is `my-theme`. Null when nothing
 * usable is left.
 */
export function themeIdFromFileName(fileName: string): string | null {
  const stem = fileName.replace(/\.json$/i, '')
  const id = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, THEME_ID_MAX_LENGTH)
    .replace(/-+$/, '')
  return id === '' ? null : id
}

export type ParsedTheme =
  | { ok: true; theme: ThemeDefinition }
  | { ok: false; message: string }

const KNOWN_KEYS = new Set(['$schema', 'name', 'kind', 'extends', 'colors'])

/**
 * One theme file, read.
 *
 * The file needs only what makes it different: `kind` (or `extends`, which
 * implies one) and the colours it changes. Every token it leaves out comes
 * from the theme it extends, which is the built-in of its kind unless it says
 * otherwise. Only built-ins can be extended - a chain through other people's
 * files is a theme that changes when a file it never mentions does.
 *
 * Two grades of wrong, and the line between them is whether the file still
 * says what theme it is:
 *
 * - **Problems** - a colour that does not parse, a token name nobody knows, a
 *   translucent ground. That one value falls back and the theme still loads,
 *   because a person mid-edit with a live preview should not watch the whole
 *   window revert over one typo. The pane lists them under the theme.
 * - **Errors** - not JSON, no kind, an id that is a built-in's. The file is
 *   skipped and the pane says why.
 */
export function parseThemeFile(fileName: string, text: string): ParsedTheme {
  const id = themeIdFromFileName(fileName)
  if (id === null) return { ok: false, message: 'the file name has no letters or digits to make an id from' }
  if (builtinById(id)) {
    return { ok: false, message: `"${id}" is a built-in theme's name - rename the file` }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { ok: false, message: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'expected a JSON object with "kind" and "colors"' }
  }
  const doc = raw as Record<string, unknown>
  const problems: string[] = []

  for (const key of Object.keys(doc)) {
    if (!KNOWN_KEYS.has(key)) problems.push(`"${key}" is not a theme field and was ignored`)
  }

  let base: ThemeDefinition | undefined
  if (doc['extends'] !== undefined) {
    base = typeof doc['extends'] === 'string' ? builtinById(doc['extends']) : undefined
    if (!base) {
      return {
        ok: false,
        message: `"extends" must name a built-in theme: ${BUILTIN_THEMES.map((t) => t.id).join(', ')}`
      }
    }
  }

  const kindValue = doc['kind']
  let kind: ThemeKind
  if (kindValue === undefined) {
    if (!base) return { ok: false, message: 'say whether it is a dark or a light theme: "kind": "dark"' }
    kind = base.kind
  } else if (kindValue === 'dark' || kindValue === 'light') {
    kind = kindValue
  } else {
    return { ok: false, message: `"kind" must be "dark" or "light"` }
  }
  base ??= defaultTheme(kind)

  let name = id
  const nameValue = doc['name']
  if (nameValue !== undefined) {
    const cleaned = typeof nameValue === 'string' ? cleanName(nameValue) : null
    if (cleaned === null) {
      problems.push(`"name" must be text of 1 to ${String(THEME_NAME_MAX_LENGTH)} characters; the file name is used instead`)
    } else {
      name = cleaned
    }
  }

  const tokens: ThemeTokens = { ...base.tokens }
  const colors = doc['colors']
  if (colors !== undefined) {
    if (colors === null || typeof colors !== 'object' || Array.isArray(colors)) {
      problems.push('"colors" must be an object of token names to colours; every colour was inherited')
    } else {
      for (const [key, value] of Object.entries(colors as Record<string, unknown>)) {
        if (!(THEME_TOKENS as readonly string[]).includes(key)) {
          problems.push(`"${key}" is not a colour Helm uses and was ignored`)
          continue
        }
        const token = key as ThemeToken
        const parsed = typeof value === 'string' ? parseColor(value) : null
        if (parsed === null) {
          problems.push(`${token}: ${describeValue(value)} is not a colour; ${base.name}'s was used`)
          continue
        }
        if (parsed.a < 1 && !TRANSLUCENT_TOKENS.has(token)) {
          problems.push(`${token} must be opaque; ${base.name}'s was used`)
          continue
        }
        tokens[token] = formatColor(parsed)
      }
    }
  }

  return {
    ok: true,
    theme: { id, name, kind, tokens, builtin: false, file: fileName, problems }
  }
}

function cleanName(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > THEME_NAME_MAX_LENGTH) return null
  for (const ch of trimmed) if (ch.charCodeAt(0) < 0x20) return null
  return trimmed
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : typeof value
}

/**
 * A theme written out as a complete file, every token spelled, for "Duplicate".
 * Complete rather than a diff against its base, so the copy is a palette a
 * person can read top to bottom and change any line of.
 */
export function serializeTheme(theme: ThemeDefinition, name: string): string {
  const colors: Record<string, string> = {}
  for (const token of THEME_TOKENS) colors[token] = theme.tokens[token]
  return `${JSON.stringify({ name, kind: theme.kind, colors }, null, 2)}\n`
}

const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 }
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 }

/**
 * A chosen accent, fitted to a theme.
 *
 * One swatch cannot be one value on every theme: `#d9a066` is a fine mark on
 * Nocturne's islands and 2.1:1 on Daylight's white. So the swatch is a hue
 * and this finds the value of it that holds the same two floors the built-in
 * accents were tuned to - **3:1** against the island for `accent`, which is
 * marks and outlines (WCAG non-text), and **4.5:1** for `accent-text` - by
 * moving toward white on a dark theme and toward black on a light one. The two
 * tints keep the alphas the theme gave its own accent, so a chosen accent sits
 * at the same weight the theme was designed around.
 *
 * `accent-text` starts part of the way there even when the floor is already
 * met, because on a dark theme it is the *readable tint*, and an accent used
 * as-is for 12px text reads as a link rather than a label.
 */
export function deriveAccent(
  tokens: ThemeTokens,
  kind: ThemeKind,
  hex: string
): Pick<ThemeTokens, 'accent' | 'accent-soft' | 'accent-soft-hover' | 'accent-text'> {
  const chosen = parseColor(hex)
  const surface = parseColor(tokens.surface)
  if (chosen === null || surface === null) {
    return {
      accent: tokens.accent,
      'accent-soft': tokens['accent-soft'],
      'accent-soft-hover': tokens['accent-soft-hover'],
      'accent-text': tokens['accent-text']
    }
  }
  const toward = kind === 'dark' ? WHITE : BLACK
  const opaque = { ...chosen, a: 1 }
  const accent = reach(opaque, toward, surface, 3, 0)
  const text = reach(accent, toward, surface, 4.5, kind === 'dark' ? 0.6 : 0.15)
  const softAlpha = parseColor(tokens['accent-soft'])?.a ?? (kind === 'dark' ? 0.14 : 0.1)
  const hoverAlpha = parseColor(tokens['accent-soft-hover'])?.a ?? (kind === 'dark' ? 0.26 : 0.2)
  return {
    accent: formatColor(accent),
    'accent-soft': formatColor(withAlpha(accent, softAlpha)),
    'accent-soft-hover': formatColor(withAlpha(accent, hoverAlpha)),
    'accent-text': formatColor(text)
  }
}

/** The first step from `start`, in 5% steps toward `toward`, that clears `ratio` on `ground`. */
function reach(color: Rgba, toward: Rgba, ground: Rgba, ratio: number, start: number): Rgba {
  for (let step = Math.round(start * 20); step <= 20; step += 1) {
    const candidate = mix(color, toward, step / 20)
    if (contrastRatio(candidate, ground) >= ratio) return candidate
  }
  return toward
}

export interface ThemeChoice {
  preference: ThemePreference
  /** What Windows says, consulted only when the preference is `system`. */
  systemDark: boolean
  themeDark: string
  themeLight: string
  accentColor: string | null
}

/**
 * Which theme is on screen.
 *
 * The preference picks a **slot** - `dark` and `light` always, `system` by
 * asking Windows - and the slot names a theme. A slot naming a theme that is
 * not there falls back to the built-in of that kind and says so, rather than
 * to the other slot: a deleted dark theme should leave the window dark.
 */
export function resolveTheme(
  choice: ThemeChoice,
  themes: readonly ThemeDefinition[]
): AppliedTheme {
  const slot: ThemeKind =
    choice.preference === 'system' ? (choice.systemDark ? 'dark' : 'light') : choice.preference
  const wanted = slot === 'dark' ? choice.themeDark : choice.themeLight
  const found = themes.find((t) => t.id === wanted) ?? builtinById(wanted)
  const theme = found ?? defaultTheme(slot)
  const tokens: ThemeTokens = { ...theme.tokens }
  if (choice.accentColor !== null) {
    Object.assign(tokens, deriveAccent(tokens, theme.kind, choice.accentColor))
  }
  return {
    id: theme.id,
    name: theme.name,
    kind: theme.kind,
    tokens,
    shadow: SHADOW[theme.kind],
    fallback: found === undefined
  }
}
