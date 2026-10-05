import type {
  PanelActionIcon,
  PanelActionSpec,
  RailSpec,
  SettingSpec,
  TabSpec
} from './types'

/** The bridge versions this Helm speaks. */
export const SUPPORTED_API_VERSIONS: readonly number[]
/** Every top-level field a manifest may have. Anything else is a warning. */
export const MANIFEST_FIELDS: readonly string[]
/** How many of each list or map a manifest may hold. */
export const MANIFEST_LIMITS: Readonly<{
  panels: number
  tabs: number
  actions: number
  commands: number
  settings: number
  network: number
  secrets: number
  exec: number
  args: number
  env: number
  options: number
}>
export const SETTING_TYPES: readonly SettingSpec['type'][]
export const SERVICE_START_MODES: readonly ('enable' | 'demand')[]
/** A `network` entry's shape. No flags, so the schema carries the same source. */
export const ORIGIN_PATTERN: RegExp
export const ID_PATTERN: RegExp
export const NAME_PATTERN: RegExp
export const SECRET_KEY_PATTERN: RegExp
export const SETTING_KEY_PATTERN: RegExp
export const ENV_NAME_PATTERN: RegExp
/** Global: reset `lastIndex`, or use `placeholders()`. */
export const PLACEHOLDER_PATTERN: RegExp
export const ICON_MAX_BYTES: number
/** The path prefix Helm serves its own runtime under on every plugin's origin. */
export const RESERVED_PREFIX: string
export const PANEL_ACTION_ICONS: readonly PanelActionIcon[]

/** A `network` entry, read. `origin` is its canonical spelling. */
export interface OriginPattern {
  scheme: 'http' | 'https'
  host: string
  /** Every subdomain of `host`, and not `host` itself. */
  wildcard: boolean
  port: number
  origin: string
}

export interface NormalizedExec {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface NormalizedService {
  /** `node`: `command` is a script in the plugin folder, run by Helm's own Node. */
  kind: 'command' | 'node'
  command: string
  args: string[]
  env: Record<string, string>
  start: 'enable' | 'demand'
}

/** A manifest that passed, with every optional part filled in and every path in one spelling. */
export interface NormalizedManifest {
  apiVersion: 1
  id: string
  name: string
  version: string | null
  description: string | null
  icon: string | null
  rail: RailSpec | null
  panels: Record<string, { title: string; entry: string; actions: PanelActionSpec[] }>
  tabs: Record<string, TabSpec>
  background: string | null
  commands: Array<{ id: string; title: string; tab: string | null }>
  settings: SettingSpec[]
  network: OriginPattern[]
  secrets: string[]
  exec: Record<string, NormalizedExec>
  service: NormalizedService | null
}

export type ManifestResult =
  | { ok: true; manifest: NormalizedManifest; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] }

/** Reads a parsed `helm-plugin.json`. Pure: whether the files it names exist is the caller's question. */
export function validateManifest(value: unknown): ManifestResult

/** Every `{{key}}` in a string, in order. */
export function placeholders(text: string): string[]

/** One `network` entry, or null when it is not an origin Helm accepts. */
export function parseOrigin(entry: string): OriginPattern | null

/** Whether a URL is one a pattern allows. */
export function originMatches(pattern: OriginPattern, url: URL): boolean

/** A path inside the plugin folder in one spelling, or null when it is not one. */
export function normalizeEntry(path: string): string | null

/** Every file the manifest names, for the caller to check exists. */
export function manifestFiles(manifest: NormalizedManifest): Array<{ field: string; path: string }>
