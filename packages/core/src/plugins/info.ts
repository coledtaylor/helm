import type { PanelActionSpec, SettingSpec, SettingValue, StatusItem } from '@helm/plugin-sdk'

/**
 * A plugin, as the window draws it: what main read from its folder and what
 * it is doing now. Sent over `plugins:list` and `plugins:changed`.
 *
 * Here rather than in the desktop's IPC contract so the ui package's Settings
 * pages can take it as it is. Types only.
 */

/** A sidebar panel: Helm's header, the plugin's page. */
export interface PluginPanelInfo {
  title: string
  /** `helm-plugin://<id>/<path>`: the plugin's own origin. */
  url: string
  actions: PanelActionSpec[]
}

export interface PluginTabInfo {
  title: string
  url: string
}

export type PluginServiceState = 'stopped' | 'starting' | 'running' | 'crashed' | 'failed'

export interface PluginServiceInfo {
  /** `node`: run by Helm's own Node. `command`: any program. */
  kind: 'command' | 'node'
  command: string
  start: 'enable' | 'demand'
  state: PluginServiceState
  pid: number | null
  port: number | null
  /** Restarts after a crash, this run. */
  restarts: number
  error: string | null
}

export type PluginBackgroundState = 'stopped' | 'starting' | 'running' | 'crashed'

export interface PluginBackgroundInfo {
  url: string
  state: PluginBackgroundState
  error: string | null
}

/** Whether a secret the manifest declares can be used: see `SecretStatus` in `main/plugins/secrets.ts`. */
export type PluginSecretState = 'ready' | 'missing' | 'not-allowed'

/**
 * One registered plugin folder, as the window draws it.
 *
 * A folder whose manifest could not be read is still here, with `error` saying
 * why and every surface empty, so Settings can show it and offer Reload. Only
 * a plugin that is `enabled` with no `error` has surfaces on screen.
 */
export interface PluginInfo {
  /** The folder, as registered. The key Settings acts on. */
  path: string
  /** Null when the manifest did not say one Helm could read. */
  id: string | null
  name: string
  version: string | null
  description: string | null
  enabled: boolean
  /** Why it is not loaded: no manifest, an unsupported `apiVersion`, a file that is not built. */
  error: string | null
  warnings: string[]
  /** Bumped at every read of the folder. A page whose plugin moved on reloads. */
  revision: number
  /** The rail icon as a `data:` URL, drawn as a mask so it takes the rail's own colour. */
  icon: string | null
  rail: { title: string; panel: string } | null
  panels: Record<string, PluginPanelInfo>
  tabs: Record<string, PluginTabInfo>
  background: PluginBackgroundInfo | null
  commands: Array<{ id: string; title: string; tab: string | null }>
  settings: SettingSpec[]
  /** The values the page shows: what the user set, else the manifest's default, else null. */
  settingValues: Record<string, SettingValue>
  /** The origins `helm.fetch` may reach, canonical. */
  network: string[]
  secrets: Array<{ key: string; state: PluginSecretState }>
  exec: Array<{ name: string; command: string; args: string[] }>
  service: PluginServiceInfo | null
  /** It declares a program or a service: what it runs, runs with the user's rights. */
  runsPrograms: boolean
  status: StatusItem | null
  badge: number | null
}

export interface PluginMetrics {
  path: string
  plugin: string
  /** Working set across the plugin's page processes and its service. Null: could not look. */
  memoryKb: number | null
  cpuPercent: number | null
  processes: number
}

export interface PluginLogLine {
  at: string
  stream: 'out' | 'err' | 'helm'
  text: string
}

export interface SecretInfo {
  key: string
  /** Canonical origins the value may be sent to. */
  hosts: string[]
  /** Plugin ids that may use it. */
  plugins: string[]
  updatedAt: string
}

export interface SecretInput {
  key: string
  /** Null keeps the stored value: changing who may use a secret is not typing it again. */
  value: string | null
  hosts: string[]
  plugins: string[]
}

export interface SecretsState {
  /** Whether this computer can encrypt. When it cannot, nothing can be stored. */
  available: boolean
  secrets: SecretInfo[]
}
