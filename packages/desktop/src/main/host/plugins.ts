import type { PluginFolder } from '@helm/core'
import type { SettingValue } from '@coledtaylor/helm-plugin-sdk'
import type { PluginBackgroundReport, PluginInfo } from '../../shared/ipc'
import type { ToolAnswer, ToolCallRequest, ToolServer } from '../plugins/tools'
import { HostRequestError, type HostConnection, type HostSubscription } from './client'
import type { HostLink } from './link'
import type * as P from './protocol'
import { isBackgroundPage, pluginFromHost, withBackgroundReports } from './records'

/**
 * What Helm's main process keeps of the host's plugins when sessions run in
 * the local host. The host registers the folders, reads them, keeps their
 * switches, setting values and secrets, runs their services and answers their
 * pages' calls; each Helm page that frames plugins asks it over its own
 * connection (`renderer/src/app/host/plugins.ts`, `renderer/src/pluginHost`).
 *
 * Main keeps only what only it can do, on its own subscription to the host's
 * `plugins:changed`:
 *
 * - The `helm-plugin://<id>/` scheme: a plugin's page files from the host
 *   (`file`), cached here per plugin version and the host's revision of its
 *   read, and served only for a plugin the host has on (`serves`).
 * - The hidden plugin host window background pages run in under API v1,
 *   opened while a background page needs it. That window reports whether each
 *   page runs (`backgroundState`), which main alone hears; it tells the
 *   window (`reportsChanged`), which lays the reports over the host's list.
 * - A plugin's tools: the host's list says which plugins offer them, and the
 *   relay offers the host those (`toolServers`, `plugin-tools.ts`). A call is
 *   answered by the plugin's background page in the hidden window, once that
 *   page is running, and ends when the plugin stops offering the tool.
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
  /** What the hidden window has reported of its background pages moved: the window is told. */
  reportsChanged: (reports: PluginBackgroundReport[]) => void
  /** Hands a tool call to the plugin's background page in the hidden window. */
  runTool: (request: ToolCallRequest, signal: AbortSignal) => Promise<ToolAnswer>
  /** The plugins offering tools changed: the relay offers the host them again. */
  onToolsChanged: () => void
  /** Opens the hidden window while a background page needs it, and closes it when none does. */
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
  /** What the hidden window saw of a plugin's background page. */
  backgroundState(plugin: string, revision: number, state: 'running' | 'crashed', error: string | null): void
  /** The hidden window's renderer died, and every background page with it. */
  backgroundGone(reason: string): void
  /** What the hidden window has reported, for the plugins the host has on now. */
  reports(): PluginBackgroundReport[]
  /** Every plugin the host lists as offering tools now: on, read, with an agent section and its tools on. */
  toolServers(): ToolServer[]
  /** A session's call to a plugin's tool, answered by its background page. Never throws. */
  callTool(request: ToolCallRequest, signal: AbortSignal): Promise<ToolAnswer>
  /** Whether a plugin is on in the host, so its pages are served. Rejects when the host cannot be reached. */
  serves(plugin: string): Promise<boolean>
  /** One of a plugin's page files, from this run's cache when the host's read of the plugin has not moved. */
  file(plugin: string, path: string): Promise<PluginPageFile>
  shutdown(): void
}


/** One plugin's cached page files, for the version and revision they were read at. */
interface Cached {
  version: string | null
  revision: number
  files: Map<string, PluginPageFile>
}

/** How long a tool call waits for a background page that is still starting: a plugin just turned on, or reloaded. */
export const BACKGROUND_START_WAIT_MS = 15_000
/** What a session reads when a plugin stops offering the tool it called. */
export const NOT_OFFERING =
  'The plugin is not offering tools any more: it was turned off, removed, or had its tools turned off in Helm.'

export function createHostPlugins(deps: HostPluginsDeps): HostPlugins {
  const { link } = deps
  /** The host's last list, as it sent it; null until the first one. */
  let hosted: PluginInfo[] | null = null
  /** The reports as the window was last told them, to tell whether one moved them. */
  let said = '[]'
  const reports = new Map<string, PluginBackgroundReport>()
  const cache = new Map<string, Cached>()
  let subscriptions: HostSubscription[] = []
  /** Tool calls in flight, by plugin, so a plugin that stops offering its tools ends them. */
  const toolCalls = new Map<string, Set<AbortController>>()
  /** Tool calls waiting for a background page to finish starting; woken at every list. */
  const backgroundWaiters = new Set<() => void>()
  /** The tool servers as the relay last offered them, so it hears only when they move. */
  let offering = '[]'
  let stopped = false

  const host = (): Promise<HostConnection> => link.connection()

  /** The host's list, with what the hidden window saw of each background page. */
  const merged = (list: readonly PluginInfo[]): PluginInfo[] => withBackgroundReports(list, (plugin) => reports.get(plugin))

  const live = (plugin: string): PluginInfo | null =>
    hosted?.find((info) => info.id === plugin && info.enabled && info.error === null) ?? null

  /** The host's plugins offering tools, as the relay offers them: kept as the host sent them, schemas included. */
  let offered: P.PluginInfo[] = []

  const toolServers = (): ToolServer[] =>
    offered.flatMap((plugin) => {
      const { agent, id } = plugin
      if (id === null || !plugin.enabled || plugin.error !== null || agent === null || !agent.enabled) return []
      return [
        {
          plugin: id,
          name: plugin.name ?? id,
          server: agent.server,
          instructions: agent.instructions,
          tools: agent.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: schemaOf(tool.inputSchema),
            readOnly: tool.readOnly
          }))
        }
      ]
    })

  /** Tells the relay when the plugins offering tools moved, and ends the calls of a plugin that stopped. */
  const toolsMoved = (): void => {
    const servers = toolServers()
    const now = JSON.stringify(servers)
    if (now === offering) return
    offering = now
    const still = new Set(servers.map((server) => server.plugin))
    for (const [plugin, calls] of toolCalls) {
      if (still.has(plugin)) continue
      for (const controller of calls) controller.abort()
    }
    deps.onToolsChanged()
  }

  /** What the hidden window reported, for the plugins the host has on now. */
  const currentReports = (): PluginBackgroundReport[] => [...reports.values()]

  /** Tells the window what moved, wakes the tool calls waiting on a page, and opens or closes the hidden window. */
  const publish = (): void => {
    const now = currentReports()
    const text = JSON.stringify(now)
    if (text !== said) {
      said = text
      deps.reportsChanged(now)
    }
    for (const wake of [...backgroundWaiters]) wake()
    deps.background.sync(
      merged(hosted ?? []).some(
        (plugin) =>
          plugin.background !== null &&
          isBackgroundPage(plugin.background.url) &&
          (plugin.background.state === 'starting' || plugin.background.state === 'running')
      )
    )
  }

  /** The host's list, now the one Helm has: a plugin's cached files go once the host has read it again. */
  const take = (listed: readonly P.PluginInfo[]): void => {
    hosted = listed.map(pluginFromHost)
    offered = [...listed]
    for (const [id, cached] of cache) {
      const now = live(id)
      if (now === null || now.revision !== cached.revision || now.version !== cached.version) cache.delete(id)
    }
    // A report the hidden window made for a read the host has moved past is
    // about a page that is gone; one for a newer read than this list is kept.
    for (const [id, report] of reports) {
      const now = live(id)
      if (now === null || report.revision < now.revision) reports.delete(id)
    }
    publish()
    toolsMoved()
  }

  /** Null when the host's list says the plugin offers the tool now; the sentence a session reads otherwise. */
  const offeredTool = (request: ToolCallRequest): string | null => {
    const server = toolServers().find((candidate) => candidate.plugin === request.plugin)
    if (server === undefined) return NOT_OFFERING
    if (server.tools.some((tool) => tool.name === request.tool)) return null
    return `${server.name} has no tool called "${request.tool}". It has: ${server.tools.map((tool) => tool.name).join(', ')}.`
  }

  /** The plugin's background page as the window is told it: starting, running, crashed or stopped. */
  const backgroundOf = (plugin: string): PluginInfo['background'] =>
    merged(hosted ?? []).find((info) => info.id === plugin)?.background ?? null

  /**
   * Null once the plugin's background page is running, and why a call cannot
   * be answered otherwise. A page still starting - the plugin was just turned
   * on or reloaded - is waited for, briefly.
   */
  const backgroundReady = async (plugin: string, signal: AbortSignal): Promise<string | null> => {
    const deadline = Date.now() + BACKGROUND_START_WAIT_MS
    while (backgroundOf(plugin)?.state === 'starting' && !signal.aborted && !stopped && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer)
          backgroundWaiters.delete(wake)
          signal.removeEventListener('abort', wake)
          resolve()
        }
        const timer = setTimeout(wake, Math.max(0, deadline - Date.now()))
        backgroundWaiters.add(wake)
        signal.addEventListener('abort', wake, { once: true })
      })
    }
    if (signal.aborted) return 'The call was cancelled.'
    if (stopped) return 'Helm is shutting down.'
    const background = backgroundOf(plugin)
    switch (background?.state) {
      case 'running':
        return null
      case 'starting':
        return `The plugin's background page did not start within ${String(BACKGROUND_START_WAIT_MS / 1000)} seconds.`
      case 'crashed':
        return `The plugin's background page stopped${background.error === null ? '' : ` (${background.error})`}. Reloading the plugin in Helm's Settings > Plugins starts it again.`
      default:
        return "The plugin's background page is not running."
    }
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
    toolServers,

    async callTool(request, signal) {
      if (stopped) return { ok: false, message: 'Helm is shutting down.' }
      const first = offeredTool(request)
      if (first !== null) return { ok: false, message: first }
      const problem = await backgroundReady(request.plugin, signal)
      if (problem !== null) return { ok: false, message: problem }
      // Asked again: the plugin may have been turned off or reloaded while its page started.
      const now = offeredTool(request)
      if (now !== null) return { ok: false, message: now }
      const controller = new AbortController()
      const withdraw = (): void => controller.abort()
      signal.addEventListener('abort', withdraw, { once: true })
      const calls = toolCalls.get(request.plugin) ?? new Set<AbortController>()
      calls.add(controller)
      toolCalls.set(request.plugin, calls)
      try {
        const answer = await deps.runTool(request, controller.signal)
        // Ended here rather than by the session: the plugin stopped offering it.
        if (controller.signal.aborted && !signal.aborted) return { ok: false, message: NOT_OFFERING }
        return answer
      } finally {
        signal.removeEventListener('abort', withdraw)
        calls.delete(controller)
        if (calls.size === 0) toolCalls.delete(request.plugin)
      }
    },

    backgroundState(plugin, revision, state, error) {
      if (stopped) return
      const current = live(plugin)
      // A report about a read the host has moved on from is about a page that is gone.
      if (current !== null && revision < current.revision) return
      reports.set(plugin, { plugin, revision, state, error })
      publish()
    },

    backgroundGone(reason) {
      for (const plugin of merged(hosted ?? [])) {
        const { background } = plugin
        if (plugin.id === null || background === null || !isBackgroundPage(background.url)) continue
        if (background.state !== 'starting' && background.state !== 'running') continue
        reports.set(plugin.id, {
          plugin: plugin.id,
          revision: plugin.revision,
          state: 'crashed',
          error: `the background host stopped (${reason})`
        })
      }
      publish()
    },

    reports: currentReports,

    async serves(plugin) {
      if (hosted === null) take(await (await host()).request('plugins:list', null))
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
      stopped = true
      for (const subscription of subscriptions) subscription.unsubscribe()
      subscriptions = []
      cache.clear()
      for (const calls of toolCalls.values()) for (const controller of calls) controller.abort()
      toolCalls.clear()
      for (const wake of [...backgroundWaiters]) wake()
    }
  }
}

/** A tool's arguments' schema as the manifest wrote it: an object, or none when the host sent something else. */
function schemaOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { type: 'object', properties: {} }
}
