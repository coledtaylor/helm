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
  tools: number
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
/** A key of `agent.tools`. */
export const TOOL_NAME_PATTERN: RegExp
/** `helm-plugin-`: what a plugin's MCP server is called, before its id. */
export const AGENT_SERVER_PREFIX: string
/** The longest `mcp__<server>__<tool>` a session can be given. */
export const AGENT_TOOL_NAME_MAX: number
/** `agent.instructions` and a tool's description, in characters. */
export const AGENT_TEXT_MAX: number
/** A tool's `inputSchema`, as JSON, in characters. */
export const INPUT_SCHEMA_MAX_CHARS: number
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

export interface NormalizedAgentTool {
  name: string
  description: string
  /** As the manifest wrote it; `{ type: 'object', properties: {} }` when it wrote none. */
  inputSchema: Record<string, unknown>
}

export interface NormalizedAgent {
  instructions: string | null
  /** In the order the manifest lists them. Never empty. */
  tools: NormalizedAgentTool[]
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
  /** Its tabs open as pages in one tab of its own, with their own strip, rather than a tab each in the pane. */
  pageStrip: boolean
  background: string | null
  commands: Array<{ id: string; title: string; tab: string | null }>
  settings: SettingSpec[]
  network: OriginPattern[]
  secrets: string[]
  exec: Record<string, NormalizedExec>
  service: NormalizedService | null
  agent: NormalizedAgent | null
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

/** The MCP server name a plugin's tools appear under in a session: `helm-plugin-<id>`. */
export function agentServerName(id: string): string

/** What a session calls one of a plugin's tools: `mcp__helm-plugin-<id>__<tool>`. */
export function agentToolName(id: string, tool: string): string

/** Every file the manifest names, for the caller to check exists. */
export function manifestFiles(manifest: NormalizedManifest): Array<{ field: string; path: string }>
