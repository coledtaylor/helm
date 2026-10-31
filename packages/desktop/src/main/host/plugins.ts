import type { SettingSpec, SettingValue } from '@coledtaylor/helm-plugin-sdk'
import type { PluginFolder } from '@helm/core'
import type {
  PluginAddResult,
  PluginInfo,
  PluginLogLine,
  PluginMetrics,
  SecretInput,
  SecretsState
} from '../../shared/ipc'
import { HostRequestError, type HostConnection, type HostSubscription } from './client'
import type { HostLink } from './link'
import type * as P from './protocol'
import type { Emit } from './sessions'

/**
 * Helm's plugins when sessions run in the local host: the host registers the
 * folders, reads them, keeps their switches and setting values and runs their
 * services, and this is what Settings and the window ask instead of
 * `main/plugins`' registry.
 *
 * What stays Helm's is what concerns the pages on screen: the window draws
 * every plugin page on its own `helm-plugin://<id>/` origin, from files the
 * host serves (`file`, cached here per plugin version and the host's revision
 * of its read), and a plugin's background page still runs in Helm's hidden
 * plugin host window. That window reports whether each page is running, and
 * the list handed to the window and to that page says so: the host lists a
 * background page without running it.
 *
 * On every connect it subscribes to the host's `plugins:changed` and
 * `secrets:changed`, and hands each to every Helm page that frames plugins.
 * Every read goes through `link.connection()`, which joins the first connect
 * while it is in flight, so a window that asks before Helm has reached the
 * host gets the host's plugins, and one that asks when the host cannot be
 * reached gets the sentence saying why, never an empty list in its place.
 *
 * The first time Helm ever connects to a host, it copies its own plugin
 * folders into it, with each one's on/off and tools switches and its setting
 * values, skipping a folder the host has. Secrets are not copied: the user
 * types them again in Settings. That it ran is recorded, so a plugin removed
 * in the host later is not copied back, and Helm's own plugin records are
 * never written by it: with the setting off again, they are as they were.
 */

/** One of a plugin's page files, as the scheme answers it. */
export interface PluginPageFile {
  status: number
  contentType: string
  body: Uint8Array
}

export interface HostPluginsDeps {
  link: HostLink
  /** To every Helm page that frames plugins: the window, and the background host. */
  emit: Emit
  /** Opens the background host window while a background page needs it, and closes it when none does. */
  background: { sync(needed: boolean): void }
  /** Helm's own plugin folders, in the order they were added: what the first connect copies. */
  ownFolders: () => PluginFolder[]
  /** Helm's own setting values for a plugin, by its id. */
  ownSettings: (plugin: string) => Record<string, SettingValue>
  /** Whether Helm's plugins have been copied into a host before. */
  copied: () => boolean
  /** Records that they have, so no later start copies them again. */
  markCopied: () => void
  log: (line: string) => void
}

export interface HostPlugins {
  list(): Promise<PluginInfo[]>
  add(path: string): Promise<PluginAddResult>
  remove(path: string, deleteSecrets: readonly string[]): Promise<PluginInfo[]>
  setEnabled(path: string, enabled: boolean): Promise<PluginInfo[]>
  setTools(path: string, enabled: boolean): Promise<PluginInfo[]>
  reload(path: string): Promise<PluginInfo[]>
  setSetting(plugin: string, key: string, value: SettingValue): Promise<PluginInfo[]>
  log(path: string): Promise<PluginLogLine[]>
  metrics(): Promise<PluginMetrics[]>
  ownSecrets(path: string): Promise<string[]>
  secrets: {
    list(): Promise<SecretsState>
    save(input: SecretInput): Promise<SecretsState>
    remove(key: string): Promise<SecretsState>
  }
  /** What the background host window saw of a plugin's background page. */
  backgroundState(plugin: string, revision: number, state: 'running' | 'crashed', error: string | null): void
  /** The background host window's renderer died, and every background page with it. */
  backgroundGone(reason: string): void
  /** Whether a plugin is on in the host, so its pages are served. Rejects when the host cannot be reached. */
  serves(plugin: string): Promise<boolean>
  /** One of a plugin's page files, from this run's cache when the host's read of the plugin has not moved. */
  file(plugin: string, path: string): Promise<PluginPageFile>
  shutdown(): void
}

/** What the background host said of a page, for the read of the plugin it was. */
interface Report {
  revision: number
  state: 'running' | 'crashed'
  error: string | null
}

/** One plugin's cached page files, for the version and revision they were read at. */
interface Cached {
  version: string | null
  revision: number
  files: Map<string, PluginPageFile>
}

/** A background a page runs, as opposed to a script the host's engine runs. */
const isPage = (url: string): boolean => /\.html?$/i.test(new URL(url).pathname)

export function createHostPlugins(deps: HostPluginsDeps): HostPlugins {
  const { link } = deps
  /** The host's last list, as it sent it; null until the first one. */
  let hosted: PluginInfo[] | null = null
  /** The list as last handed to Helm's pages, to tell whether a report moved it. */
  let said = ''
  const reports = new Map<string, Report>()
  const cache = new Map<string, Cached>()
  let subscriptions: HostSubscription[] = []

  const host = (): Promise<HostConnection> => link.connection()

  /** The host's list, with what Helm's background host saw of each background page. */
  const merged = (list: readonly PluginInfo[]): PluginInfo[] =>
    list.map((plugin) => {
      const { background } = plugin
      if (background === null || plugin.id === null || !plugin.enabled || plugin.error !== null || !isPage(background.url)) {
        return plugin
      }
      const report = reports.get(plugin.id)
      const seen = report !== undefined && report.revision === plugin.revision ? report : null
      return {
        ...plugin,
        background: { ...background, state: seen?.state ?? 'starting', error: seen?.error ?? null }
      }
    })

  const live = (plugin: string): PluginInfo | null =>
    hosted?.find((info) => info.id === plugin && info.enabled && info.error === null) ?? null

  /** Hands the list to every Helm page that frames plugins, when it is not what they have. */
  const publish = (): PluginInfo[] => {
    const list = merged(hosted ?? [])
    const text = JSON.stringify(list)
    if (text !== said) {
      said = text
      deps.emit('plugins:changed', list)
    }
    deps.background.sync(
      list.some(
        (plugin) =>
          plugin.background !== null &&
          isPage(plugin.background.url) &&
          (plugin.background.state === 'starting' || plugin.background.state === 'running')
      )
    )
    return list
  }

  /** The host's list, now the one Helm has: a plugin's cached files go once the host has read it again. */
  const take = (listed: readonly P.PluginInfo[]): PluginInfo[] => {
    hosted = listed.map(pluginFromHost)
    for (const [id, cached] of cache) {
      const now = live(id)
      if (now === null || now.revision !== cached.revision || now.version !== cached.version) cache.delete(id)
    }
    for (const id of reports.keys()) if (live(id) === null) reports.delete(id)
    return publish()
  }

  /** Helm's own plugins into a host that has never been given them. */
  const copyOwnPlugins = async (connection: HostConnection): Promise<void> => {
    if (deps.copied()) return
    const registered = new Set((await connection.request('plugins:list', null)).map((plugin) => plugin.path))
    for (const folder of deps.ownFolders()) {
      if (registered.has(folder.path)) continue
      const added = await connection.request('plugins:add', { path: folder.path })
      if (added.error !== null) {
        deps.log(`host: the plugin folder ${folder.path} was not copied into the local host (${added.error})`)
        continue
      }
      registered.add(folder.path)
      const id = added.plugins.find((plugin) => plugin.path === folder.path)?.id ?? null
      // Values first, while it is on: they are the host's to check against
      // the manifest, and one it refuses is said and left out.
      if (id !== null) {
        for (const [key, value] of Object.entries(deps.ownSettings(id))) {
          await refusedIsLogged(
            () => connection.request('plugins:setSetting', { plugin: id, key, value }),
            `host: the setting “${key}” of ${folder.path} was not copied into the local host`
          )
        }
      }
      if (!folder.toolsEnabled) await connection.request('plugins:setTools', { path: folder.path, enabled: false })
      if (!folder.enabled) await connection.request('plugins:setEnabled', { path: folder.path, enabled: false })
    }
    deps.markCopied()
  }

  /** A request the host refused is logged and the copy goes on; one that never reached it ends the copy. */
  const refusedIsLogged = async (request: () => Promise<unknown>, what: string): Promise<void> => {
    try {
      await request()
    } catch (error) {
      if (error instanceof HostRequestError && error.code !== 'unavailable') {
        deps.log(`${what} (${error.message})`)
        return
      }
      throw error
    }
  }

  link.onConnected(async (connection) => {
    for (const subscription of subscriptions) subscription.unsubscribe()
    subscriptions = [
      connection.subscribe('plugins:changed', {
        snapshot: (listed) => take(listed),
        event: (listed) => take(listed),
        error: (error) => deps.log(`host: plugins:changed ended (${error.message})`)
      }),
      connection.subscribe('secrets:changed', {
        snapshot: (state) => deps.emit('secrets:changed', state),
        event: (state) => deps.emit('secrets:changed', state),
        error: (error) => deps.log(`host: secrets:changed ended (${error.message})`)
      })
    ]
    try {
      await copyOwnPlugins(connection)
    } catch (error) {
      // Not recorded as done, so the next start tries again; a folder copied
      // this time is skipped then.
      deps.log(`host: Helm's plugins were not copied into the local host (${(error as Error).message})`)
    }
  })

  /** Reads one file a piece at a time until it is whole. */
  const read = async (connection: HostConnection, plugin: string, path: string): Promise<{ file: PluginPageFile; answer: P.PluginFile }> => {
    const first = await connection.request('plugins:file', { plugin, path, offset: 0 })
    // A refusal is its whole text whatever the offset; only a 200 comes in pieces.
    if (first.status !== 200) return { file: { status: first.status, contentType: first.contentType, body: first.body }, answer: first }
    const pieces: Uint8Array[] = [first.body]
    let received = first.body.length
    while (received < first.totalBytes) {
      const next = await connection.request('plugins:file', { plugin, path, offset: received })
      if (next.status !== 200) return { file: { status: next.status, contentType: next.contentType, body: next.body }, answer: next }
      // A file that shrank under the read ends where it ends.
      if (next.body.length === 0) break
      pieces.push(next.body)
      received += next.body.length
    }
    const body = new Uint8Array(received)
    let at = 0
    for (const piece of pieces) {
      body.set(piece, at)
      at += piece.length
    }
    return { file: { status: 200, contentType: first.contentType, body }, answer: first }
  }

  return {
    async list() {
      take(await (await host()).request('plugins:list', null))
      return merged(hosted ?? [])
    },

    async add(path) {
      const added = await (await host()).request('plugins:add', { path })
      return { path: added.path, error: added.error, plugins: take(added.plugins) }
    },

    async remove(path, deleteSecrets) {
      return take(await (await host()).request('plugins:remove', { path, deleteSecrets: [...deleteSecrets] }))
    },

    async setEnabled(path, enabled) {
      return take(await (await host()).request('plugins:setEnabled', { path, enabled }))
    },

    async setTools(path, enabled) {
      return take(await (await host()).request('plugins:setTools', { path, enabled }))
    },

    async reload(path) {
      return take(await (await host()).request('plugins:reload', { path }))
    },

    async setSetting(plugin, key, value) {
      return take(await (await host()).request('plugins:setSetting', { plugin, key, value }))
    },

    async log(path) {
      return (await (await host()).request('plugins:log', { path })).map((line) => ({
        at: line.at,
        // The host's own lines are what Helm's log calls its own.
        stream: line.stream === 'host' ? 'helm' : line.stream,
        text: line.text
      }))
    },

    async metrics() {
      return (await host()).request('plugins:metrics', null)
    },

    async ownSecrets(path) {
      return (await host()).request('plugins:ownSecrets', { path })
    },

    secrets: {
      list: async () => (await host()).request('secrets:list', null),
      save: async (input) => (await host()).request('secrets:save', input),
      remove: async (key) => (await host()).request('secrets:remove', { key })
    },

    backgroundState(plugin, revision, state, error) {
      const current = live(plugin)
      // A report about a read the host has moved on from is about a page that is gone.
      if (current === null || current.revision !== revision) return
      reports.set(plugin, { revision, state, error })
      publish()
    },

    backgroundGone(reason) {
      for (const plugin of merged(hosted ?? [])) {
        const { background } = plugin
        if (plugin.id === null || background === null || !isPage(background.url)) continue
        if (background.state !== 'starting' && background.state !== 'running') continue
        reports.set(plugin.id, {
          revision: plugin.revision,
          state: 'crashed',
          error: `the background host stopped (${reason})`
        })
      }
      publish()
    },

    async serves(plugin) {
      if (hosted === null) await this.list()
      return live(plugin) !== null
    },

    async file(plugin, path) {
      const connection = await host()
      const known = live(plugin)
      const cached = cache.get(plugin)
      const hit =
        known !== null && cached !== undefined && cached.revision === known.revision && cached.version === known.version
          ? cached.files.get(path)
          : undefined
      if (hit !== undefined) return hit
      const { file, answer } = await read(connection, plugin, path)
      // Kept only for the read the window's list has: a file from a read the
      // list has not caught up with is served, and asked for again next time.
      if (file.status === 200 && known !== null && answer.revision === known.revision && answer.version === known.version) {
        let entry = cache.get(plugin)
        if (entry === undefined || entry.revision !== answer.revision || entry.version !== answer.version) {
          entry = { version: answer.version, revision: answer.revision, files: new Map() }
          cache.set(plugin, entry)
        }
        entry.files.set(path, file)
      }
      return file
    },

    shutdown() {
      for (const subscription of subscriptions) subscription.unsubscribe()
      subscriptions = []
      cache.clear()
    }
  }
}

/** A plugin as the host lists it, in the shape Helm's window draws. */
export function pluginFromHost(plugin: P.PluginInfo): PluginInfo {
  return {
    path: plugin.path,
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    enabled: plugin.enabled,
    error: plugin.error,
    warnings: plugin.warnings,
    revision: plugin.revision,
    icon: plugin.icon,
    rail: plugin.rail,
    panels: defined(plugin.panels),
    tabs: defined(plugin.tabs),
    pageStrip: plugin.pageStrip,
    background: plugin.background,
    commands: plugin.commands,
    settings: plugin.settings as SettingSpec[],
    settingValues: defined(plugin.settingValues),
    network: plugin.network,
    secrets: plugin.secrets,
    exec: plugin.exec,
    service: plugin.service,
    runsPrograms: plugin.runsPrograms,
    agent:
      plugin.agent === null
        ? null
        : {
            enabled: plugin.agent.enabled,
            server: plugin.agent.server,
            instructions: plugin.agent.instructions,
            tools: plugin.agent.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              readOnly: 'readOnly' in tool && tool.readOnly === true
            }))
          },
    startsSessions: plugin.startsSessions,
    seesSessions: plugin.seesSessions,
    status: plugin.status,
    badge: plugin.badge
  }
}

/** A record whose values the protocol marks optional, with only the ones that are there. */
function defined<T>(record: { [key in string]?: T }): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [key, value] of Object.entries(record)) if (value !== undefined) out[key] = value
  return out
}
