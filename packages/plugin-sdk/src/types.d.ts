/**
 * The contract between a Helm plugin and the Helm running it, at apiVersion 1.
 *
 * Types only. Everything here describes something the running Helm provides:
 * the `window.helm` bridge it injects into every page a plugin serves, and the
 * manifest it reads from `helm-plugin.json`. A plugin never carries a copy of
 * the runtime, so it cannot carry a stale one - `apiVersion` in the manifest is
 * what ties a plugin to the Helm it was built against.
 *
 * `import type { HelmBridge } from '@coledtaylor/helm-plugin-sdk'`, and add
 * `/// <reference types="@coledtaylor/helm-plugin-sdk/global" />` once to have `window.helm`
 * typed everywhere.
 */

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** The bridge versions this SDK describes. */
export type ApiVersion = 1

/**
 * `helm-plugin.json`, at the root of a plugin's folder. Every surface is
 * optional; a plugin with none of them loads and does nothing.
 *
 * Paths (`icon`, every `entry`, `background`) are relative to the folder and
 * may not leave it.
 */
export interface PluginManifest {
  /** For editors: `"./node_modules/@coledtaylor/helm-plugin-sdk/helm-plugin.schema.json"`. Ignored by Helm. */
  $schema?: string
  apiVersion: ApiVersion
  /** Lower-case letters, digits and dashes. The plugin's origin is `helm-plugin://<id>`. */
  id: string
  name: string
  version?: string
  description?: string
  /** An `.svg` or `.png`, drawn as a mask in the rail's own colours. 64 KB at most. */
  icon?: string
  /** A rail icon that opens one of the panels in the sidebar. */
  rail?: RailSpec
  panels?: Record<string, PanelSpec>
  tabs?: Record<string, TabSpec>
  /** A page that runs from the moment the plugin is enabled, with no surface open. */
  background?: string
  /** Entries in Quick Open (Ctrl+Shift+P). */
  commands?: CommandSpec[]
  /** A settings page Helm draws for the plugin. */
  settings?: SettingSpec[]
  /** The origins `helm.fetch` may reach: `https://api.example.com`, `https://*.example.com`, `http://127.0.0.1:8080`. */
  network?: string[]
  /** The secret keys the plugin uses as `{{key}}`. The user stores the values in Settings > Secrets. */
  secrets?: string[]
  /** Programs `helm.exec` may run, by the name the plugin calls them. */
  exec?: Record<string, ExecSpec>
  /** A long-running process Helm starts, supervises and stops. */
  service?: ServiceSpec | null
}

export interface RailSpec {
  /** The rail button's tooltip. */
  title: string
  /** A key of `panels`. */
  panel: string
}

export interface PanelSpec {
  /** The sidebar header. */
  title: string
  /** The page, e.g. `dist/panels/runs.html`. */
  entry: string
  /** Icon buttons in the sidebar header. A press arrives as the `action` event. */
  actions?: PanelActionSpec[]
}

/** The icons a panel action may use: Helm's own, so the header looks like every other header. */
export type PanelActionIcon =
  | 'refresh'
  | 'plus'
  | 'search'
  | 'list'
  | 'settings'
  | 'external'
  | 'pin'
  | 'edit'
  | 'trash'
  | 'link'
  | 'eye'

export interface PanelActionSpec {
  id: string
  /** Its tooltip and accessible name. */
  title: string
  icon: PanelActionIcon
}

export interface TabSpec {
  /** The tab's title until the page sets its own with `helm.surface.setTitle`. */
  title: string
  entry: string
}

export interface CommandSpec {
  id: string
  /** Shown in Quick Open after the plugin's name: "Factory: Open run". */
  title: string
  /** Opens this tab. Without it the command arrives as the `command` event. */
  tab?: string
}

export type SettingSpec = TextSetting | NumberSetting | ToggleSetting | SelectSetting | SecretSetting

interface SettingBase {
  /** How the plugin reads it: `(await helm.settings.get())[key]`. */
  key: string
  label: string
  description?: string
}

export interface TextSetting extends SettingBase {
  type: 'text'
  default?: string
  placeholder?: string
}

export interface NumberSetting extends SettingBase {
  type: 'number'
  default?: number
  min?: number
  max?: number
}

export interface ToggleSetting extends SettingBase {
  type: 'toggle'
  default?: boolean
}

export interface SelectSetting extends SettingBase {
  type: 'select'
  options: Array<{ value: string; label: string }>
  default?: string
}

/** Shown as the state of a secret the plugin needs, with a way to add it. Holds no value of its own. */
export interface SecretSetting extends SettingBase {
  type: 'secret'
  /** A key from `secrets`. */
  secret: string
}

/**
 * A program, by name: `"factory"` (found on PATH, or a path relative to the
 * plugin folder), or the object form with fixed leading arguments and an
 * environment. Environment values may use `{{secret}}`.
 */
export type ExecSpec = string | { command: string; args?: string[]; env?: Record<string, string> }

/**
 * One long-running process: exactly one of `command` (any program) or `node`
 * (a script in the plugin folder, run by Helm's own Node - no Node install
 * needed).
 *
 * It is given `HELM_SERVICE_PORT` to listen on, on 127.0.0.1, and
 * `HELM_SERVICE_TOKEN`, which every request from Helm carries as the
 * `Helm-Service-Token` header. The plugin reaches it as
 * `helm.fetch('service:/path')`.
 */
export interface ServiceSpec {
  command?: string
  node?: string
  args?: string[]
  env?: Record<string, string>
  /** `demand` (the default) starts it on the first `service:` fetch; `enable` starts it with the plugin. */
  start?: 'enable' | 'demand'
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

export type SurfaceKind = 'panel' | 'tab' | 'background'

/** A tab's parameters: part of its identity, so the same tab with other parameters is another tab. */
export type PluginParams = Record<string, string | number | boolean>

/** Where this page is running. Read synchronously; it never changes for the life of the page. */
export interface HelmContext {
  plugin: string
  surface: SurfaceKind
  /** The key in `panels` or `tabs`; `background` for the background page. */
  name: string
  params: PluginParams
}

export type ThemeTokenName =
  | 'bg'
  | 'surface'
  | 'surface-raised'
  | 'surface-sunken'
  | 'hover'
  | 'active'
  | 'border'
  | 'border-strong'
  | 'fg'
  | 'fg-muted'
  | 'fg-subtle'
  | 'accent'
  | 'accent-fg'
  | 'accent-soft'
  | 'accent-soft-hover'
  | 'accent-text'
  | 'success'
  | 'warn'
  | 'danger'

/**
 * Helm's theme, as the page sees it. The same values are on the page's
 * `<html>` as `--helm-<token>`, `--helm-radius` and `data-density`, kept
 * current without a reload.
 */
export interface HelmTheme {
  kind: 'dark' | 'light'
  tokens: Record<ThemeTokenName, string>
  /** The corner radius setting, in pixels. */
  radius: number
  density: 'comfortable' | 'compact'
}

export type StatusTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger'

/** The plugin's item on Helm's status bar. Clicking it opens the plugin's rail panel. */
export interface StatusItem {
  text: string
  tone?: StatusTone
  tooltip?: string
}

export interface ExecOptions {
  /** Written to the program's standard input, then closed. */
  stdin?: string
  /** Default 60 000, at most 600 000. */
  timeoutMs?: number
}

export interface ExecResult {
  /** Null when the program was stopped (`timedOut`) or never started. */
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export type SettingValue = string | number | boolean | null

/**
 * `ready`: stored, and this plugin may use it. `missing`: not stored, or
 * stored without permission for this plugin - which the plugin is not told
 * apart, since another plugin's secrets are not its business.
 */
export type SecretState = 'ready' | 'missing'

/** What Helm tells a page, by event name. */
export interface HelmEvents {
  /** The theme changed. Tokens are already applied to the page when this fires. */
  theme: HelmTheme
  /** The surface came on screen, or went off it. Always false for the background page. */
  visibility: boolean
  /** The user changed the plugin's settings. */
  settings: Record<string, SettingValue>
  /** A secret the manifest declares was stored, permitted, refused or removed. Every declared key's state. */
  secrets: Record<string, SecretState>
  /**
   * A command with no `tab` was chosen in Quick Open. Delivered to the
   * background page when there is one, and otherwise to the rail panel, which
   * Helm opens first.
   */
  command: { id: string }
  /** A panel's header action was pressed. Panels only. */
  action: { id: string }
}

/** Why a bridge call failed: `error.code` on the `Error` it rejects with. */
export type HelmErrorCode =
  /** The URL, command or tab is not declared in the manifest. */
  | 'not-declared'
  /** A `{{secret}}` is not stored, not permitted for this plugin, or not bound to the request's host. */
  | 'secret'
  /** The request could not be made or did not complete. */
  | 'network'
  | 'timeout'
  | 'aborted'
  /** The arguments were not what the method takes. */
  | 'invalid'
  /** The plugin is disabled, or Helm is shutting down. */
  | 'unavailable'
  /** The service is not running and could not be started. */
  | 'service'
  /** A program `exec` names was not found on this computer. */
  | 'not-found'

export interface HelmError extends Error {
  code: HelmErrorCode
}

/**
 * `window.helm`: everything a plugin page can ask of Helm.
 *
 * Present before any of the page's own scripts run. Calls made before the
 * connection to Helm is up are queued, not dropped.
 */
export interface HelmBridge {
  readonly apiVersion: ApiVersion
  readonly context: HelmContext
  /** The current theme. Also on the page as CSS variables. */
  readonly theme: HelmTheme
  /** Whether the surface is on screen. Always false for the background page. */
  readonly visible: boolean

  /**
   * `fetch`, sent by Helm. Only to the origins in `network`, and to the
   * plugin's own service as `service:/path`. Redirects are followed by Helm and
   * each hop is checked against the same list.
   *
   * `{{key}}` in the URL, a header or a text body is replaced with the stored
   * secret, provided the manifest declares the key and the user allowed this
   * plugin and this host to use it. The page never sees the value. No cookies
   * are sent or kept.
   */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>

  /** Runs a program from `exec`, with no shell. Arguments are passed as they are. */
  exec(command: string, args?: readonly string[], options?: ExecOptions): Promise<ExecResult>

  tabs: {
    /**
     * Opens one of the plugin's tabs, or brings it forward if it is open with
     * the same parameters. `title` names the tab until its page sets one.
     */
    open(tab: string, params?: PluginParams, options?: { title?: string }): Promise<void>
  }

  /** The page's own surface. */
  surface: {
    /** A tab's title in the strip. Null puts back the manifest's. No effect outside a tab. */
    setTitle(title: string | null): void
  }

  status: {
    /** The plugin's status bar item, or null to take it away. */
    set(item: StatusItem | null): Promise<void>
  }

  badge: {
    /** A count on the plugin's rail icon. Null or 0 takes it away. */
    set(count: number | null): Promise<void>
  }

  settings: {
    /** Every setting the manifest declares, with its default where the user has set nothing. */
    get(): Promise<Record<string, SettingValue>>
  }

  secrets: {
    state(key: string): Promise<SecretState>
    /** Opens Helm's dialog for adding the key, scoped to this plugin. Resolves with the state after it closes. */
    request(key: string): Promise<SecretState>
  }

  /** Subscribes to an event. Returns the function that unsubscribes. */
  on<K extends keyof HelmEvents>(event: K, listener: (data: HelmEvents[K]) => void): () => void
}
