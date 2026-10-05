import { watch, type FSWatcher } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { app, type BrowserWindow, type WebContents } from 'electron'
import {
  addPluginFolder,
  deleteSecret,
  pluginParamsProblem,
  PLUGIN_TITLE_MAX,
  readPluginFolders,
  readPluginSettings,
  readSecrets,
  removePluginFolder,
  setPluginEnabled,
  writePluginSetting,
  type PluginFolder,
  type Store
} from '@helm/core'
import type { HelmTheme, SettingSpec, SettingValue, StatusItem, StatusTone, SurfaceKind } from '@helm/plugin-sdk'
import { NAME_PATTERN } from '@helm/plugin-sdk/manifest'
import {
  PLUGIN_SCHEME,
  type EventChannel,
  type EventPayload,
  type PluginAddResult,
  type PluginBackgroundState,
  type PluginCallOutcome,
  type PluginCallRequest,
  type PluginDelivery,
  type PluginInfo,
  type PluginLogLine,
  type PluginMetrics,
  type SecretInput,
  type SecretsState
} from '../../shared/ipc'
import { createBackgroundHost, type BackgroundHost } from './background'
import { failure, PluginCallError } from './errors'
import { readExecRequest, runProgram } from './exec'
import { loadPluginFolder, MANIFEST_FILE, type LoadedPlugin, type LoadResult } from './loader'
import { electronSender, pluginFetch, type SendHop } from './net'
import type { PluginRuntime, ServedPlugin } from './protocol'
import { createSecretStore, safeStorageCrypto, type SecretCrypto, type SecretStore } from './secrets'
import { createServiceSupervisor, electronServiceLauncher, type ServiceLauncher, type ServiceSupervisor } from './service'
import { substituteEnv } from './substitute'

/**
 * Plugins: the folders the user registered, what each one is, and everything
 * a plugin page can ask of Helm.
 *
 * A plugin is a folder with a `helm-plugin.json`, registered by path in
 * Settings. It is read at start and again whenever its built files change, so
 * one developed in place with `vite build --watch` is always the one on screen.
 * Everything it is allowed to do is in its manifest, and this is where the
 * manifest is held to: every bridge call arrives here with the plugin it came
 * from established by the frame's origin (`pluginFrames.ts`), and is answered
 * only within what that plugin declared.
 *
 * Owns the lifetimes the plugin system has: services, the background host
 * window, folder watches, calls in flight. `before-quit` ends all of them.
 */

export interface PluginHostOptions {
  store: Store
  /** The app's window: where tabs open and Helm's own dialogs are drawn. */
  window: () => BrowserWindow | null
  /** The theme a page paints first; it is kept current from the window after that. */
  theme: () => HelmTheme
  /** The bridge script and primitives stylesheet, as served under `/__helm/`. */
  bridge: string
  stylesheet: string
  crypto?: SecretCrypto | undefined
  send?: SendHop | undefined
  launcher?: ServiceLauncher | undefined
  background?: BackgroundHost | undefined
  /** Watch plugin folders and reload on change. On in the app; a test turns it off. */
  watch?: boolean | undefined
}

export interface PluginHost {
  /** Reads every registered folder. Once, before the window asks. */
  start(): void
  list(): PluginInfo[]
  add(path: string): PluginAddResult
  remove(path: string, deleteSecrets: readonly string[]): PluginInfo[]
  setEnabled(path: string, enabled: boolean): PluginInfo[]
  reload(path: string): PluginInfo[]
  setSetting(plugin: string, key: string, value: SettingValue): PluginInfo[]
  call(request: PluginCallRequest, sender: number): Promise<PluginCallOutcome>
  cancel(callId: string, sender: number): void
  command(plugin: string, id: string): void
  answer(requestId: string): void
  backgroundState(plugin: string, revision: number, state: 'running' | 'crashed', error: string | null): void
  metrics(): PluginMetrics[]
  log(path: string): PluginLogLine[]
  ownSecrets(path: string): string[]
  secrets: {
    list(): SecretsState
    save(input: SecretInput): SecretsState
    remove(key: string): SecretsState
  }
  /** A theme or shape change, for every Helm page that frames plugins. */
  pushTheme(theme: HelmTheme): void
  served(id: string): ServedPlugin | null
  runtime: PluginRuntime
  shutdown(): void
}

/** How much of a plugin's log is kept: enough to read a crash, not a history. */
const LOG_LINES = 500
/** A burst of writes from a build is one reload. */
const WATCH_DEBOUNCE_MS = 400
/** Programs one plugin may have running at once. */
const EXEC_CONCURRENCY = 8
const STATUS_TEXT_MAX = 80
const STATUS_TOOLTIP_MAX = 300
const BADGE_MAX = 99_999
const TONES: readonly StatusTone[] = ['neutral', 'accent', 'success', 'warn', 'danger']
const SURFACES: readonly SurfaceKind[] = ['panel', 'tab', 'background']

interface Entry {
  folder: PluginFolder
  load: LoadResult
  /** Set at every read of the folder; a page from an older read reloads. */
  revision: number
  status: StatusItem | null
  badge: number | null
  service: ServiceSupervisor | null
  background: { state: PluginBackgroundState; error: string | null }
  watcher: FSWatcher | null
  reloadTimer: NodeJS.Timeout | null
  log: PluginLogLine[]
  running: number
}

export function createPluginHost(options: PluginHostOptions): PluginHost {
  const { store } = options
  const send = options.send ?? electronSender
  const launcher = options.launcher ?? electronServiceLauncher
  const watching = options.watch ?? true
  const entries: Entry[] = []
  const calls = new Map<string, AbortController>()
  const secretRequests = new Map<string, { plugin: string; key: string; resolve: (state: 'ready' | 'missing') => void }>()
  let revisions = 0
  let stopped = false

  const secrets: SecretStore = createSecretStore({
    store,
    crypto: options.crypto ?? safeStorageCrypto,
    onChange: () => {
      emitWindow('secrets:changed', secretsState())
      for (const entry of entries) {
        const plugin = live(entry)
        if (plugin !== null && plugin.manifest.secrets.length > 0) {
          deliver({ plugin: plugin.manifest.id, event: 'secrets', data: secretStates(plugin), to: 'all' })
        }
      }
      changed()
    }
  })

  const background =
    options.background ??
    createBackgroundHost({
      onGone: (reason) => {
        for (const entry of entries) {
          if (entry.background.state === 'starting' || entry.background.state === 'running') {
            entry.background = { state: 'crashed', error: `the background host stopped (${reason})` }
            note(entry, `background page stopped: the host process ended (${reason})`)
          }
        }
        changed()
      }
    })

  // ---------------------------------------------------------------------------
  // Pushing to the windows
  // ---------------------------------------------------------------------------

  const emitTo = <K extends EventChannel>(contents: WebContents | null | undefined, channel: K, payload: EventPayload<K>): void => {
    if (contents === null || contents === undefined || contents.isDestroyed()) return
    contents.send(channel, payload)
  }
  const emitWindow = <K extends EventChannel>(channel: K, payload: EventPayload<K>): void => {
    const win = options.window()
    if (win !== null && !win.isDestroyed()) emitTo(win.webContents, channel, payload)
  }
  /** Both Helm pages that frame plugins: the window, and the background host. */
  const emitAll = <K extends EventChannel>(channel: K, payload: EventPayload<K>): void => {
    emitWindow(channel, payload)
    emitTo(background.contents(), channel, payload)
  }
  const deliver = (delivery: PluginDelivery): void => {
    if (delivery.to === 'background') emitTo(background.contents(), 'plugins:deliver', delivery)
    else emitAll('plugins:deliver', delivery)
  }

  let pending = false
  /** Coalesced to one push per turn: a page setting its status and badge together is one repaint. */
  const changed = (): void => {
    if (pending || stopped) return
    pending = true
    setImmediate(() => {
      pending = false
      if (stopped) return
      syncBackground()
      emitAll('plugins:changed', list())
    })
  }

  // ---------------------------------------------------------------------------
  // Reading folders
  // ---------------------------------------------------------------------------

  /** The plugin an entry is, when it is enabled and loaded - the only state in which it does anything. */
  function live(entry: Entry): LoadedPlugin | null {
    return entry.folder.enabled && entry.load.ok ? entry.load.plugin : null
  }

  function byId(id: string): Entry | null {
    return entries.find((entry) => live(entry)?.manifest.id === id) ?? null
  }

  function note(entry: Entry, text: string): void {
    append(entry, { at: new Date().toISOString(), stream: 'helm', text })
  }

  function append(entry: Entry, line: PluginLogLine): void {
    entry.log.push(line)
    if (entry.log.length > LOG_LINES) entry.log.splice(0, entry.log.length - LOG_LINES)
  }

  /** Reads (or re-reads) one folder and brings everything that hangs off it in line. */
  function read(entry: Entry): void {
    stopRuntime(entry)
    entry.revision = ++revisions
    let result = loadPluginFolder(entry.folder.path)
    if (result.ok) {
      const id = result.plugin.manifest.id
      const taken = entries.find((other) => other !== entry && other.folder.enabled && live(other)?.manifest.id === id)
      if (taken !== undefined) {
        result = {
          ok: false,
          error: `a plugin with the id "${id}" is already loaded from ${taken.folder.path}`,
          warnings: result.plugin.warnings,
          id,
          name: result.plugin.manifest.name
        }
      }
    }
    entry.load = result
    if (!result.ok) note(entry, `not loaded: ${result.error}`)
    const plugin = live(entry)
    entry.background = {
      state: plugin?.manifest.background != null ? 'starting' : 'stopped',
      error: null
    }
    if (plugin !== null && plugin.manifest.service !== null) {
      const declared = plugin.manifest.service
      entry.service = createServiceSupervisor({
        plugin: plugin.manifest.id,
        dir: plugin.dir,
        spec: declared,
        env: () =>
          substituteEnv(declared.env, secrets.revealer(plugin.manifest.id, plugin.manifest.secrets, { kind: 'program' })),
        launcher,
        onChange: changed,
        log: (line) => append(entry, { at: new Date().toISOString(), ...line })
      })
      if (declared.start === 'enable') entry.service.start()
    }
    if (entry.folder.enabled) watchFolder(entry)
  }

  /** Everything an entry has running: its service, its watch, its pending reload, its status. */
  function stopRuntime(entry: Entry, sync = false): void {
    entry.service?.stop(sync)
    entry.service = null
    entry.watcher?.close()
    entry.watcher = null
    if (entry.reloadTimer !== null) clearTimeout(entry.reloadTimer)
    entry.reloadTimer = null
    entry.status = null
    entry.badge = null
  }

  /**
   * Reload on change: the manifest, and the files it names, written by a build.
   *
   * Only those paths count - a plugin is usually a repository, and a watch that
   * reloaded on every `node_modules` write or editor save in `src/` would
   * reload the plugin under the user while they typed. A folder whose manifest
   * could not be read counts any change outside `node_modules` and `.git`, so
   * the first build is noticed.
   */
  function watchFolder(entry: Entry): void {
    if (!watching) return
    const dir = entry.load.ok ? entry.load.plugin.dir : entry.folder.path
    if (!existsSync(dir)) return
    const relevant = relevantPaths(entry.load)
    try {
      entry.watcher = watch(dir, { recursive: true }, (_event, name) => {
        if (name === null) return
        const rel = String(name).split(/[\\/]/)
        if (!relevant(rel)) return
        if (entry.reloadTimer !== null) clearTimeout(entry.reloadTimer)
        entry.reloadTimer = setTimeout(() => {
          entry.reloadTimer = null
          if (!entries.includes(entry) || !entry.folder.enabled) return
          note(entry, `reloaded: ${rel.join('/')} changed`)
          read(entry)
          changed()
        }, WATCH_DEBOUNCE_MS)
      })
      entry.watcher.on('error', () => {
        entry.watcher?.close()
        entry.watcher = null
      })
    } catch {
      entry.watcher = null
    }
  }

  function syncBackground(): void {
    background.sync(
      entries.some(
        (entry) =>
          live(entry)?.manifest.background != null &&
          (entry.background.state === 'starting' || entry.background.state === 'running')
      )
    )
  }

  // ---------------------------------------------------------------------------
  // What the window sees
  // ---------------------------------------------------------------------------

  function secretStates(plugin: LoadedPlugin): Record<string, 'ready' | 'missing'> {
    const out: Record<string, 'ready' | 'missing'> = {}
    for (const key of plugin.manifest.secrets) {
      out[key] = secrets.status(plugin.manifest.id, key) === 'ready' ? 'ready' : 'missing'
    }
    return out
  }

  function settingValues(id: string, specs: readonly SettingSpec[]): Record<string, SettingValue> {
    const stored = readPluginSettings(store, id)
    const out: Record<string, SettingValue> = {}
    for (const spec of specs) {
      if (spec.type === 'secret') continue
      const value = stored[spec.key]
      out[spec.key] = value !== undefined && settingProblem(spec, value) === null ? value : (spec.default ?? null)
    }
    return out
  }

  function info(entry: Entry): PluginInfo {
    const base = {
      path: entry.folder.path,
      enabled: entry.folder.enabled,
      revision: entry.revision,
      status: entry.folder.enabled ? entry.status : null,
      badge: entry.folder.enabled ? entry.badge : null
    }
    if (!entry.load.ok) {
      return {
        ...base,
        id: entry.load.id,
        name: entry.load.name ?? entry.folder.path,
        version: null,
        description: null,
        error: entry.load.error,
        warnings: entry.load.warnings,
        icon: null,
        rail: null,
        panels: {},
        tabs: {},
        background: null,
        commands: [],
        settings: [],
        settingValues: {},
        network: [],
        secrets: [],
        exec: [],
        service: null,
        runsPrograms: false
      }
    }
    const { manifest, icon, warnings } = entry.load.plugin
    const page = (path: string): string => `${PLUGIN_SCHEME}://${manifest.id}/${path.split('/').map(encodeURIComponent).join('/')}`
    const service = manifest.service
    return {
      ...base,
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      error: null,
      warnings,
      icon,
      rail: manifest.rail,
      panels: Object.fromEntries(
        Object.entries(manifest.panels).map(([key, panel]) => [key, { title: panel.title, url: page(panel.entry), actions: panel.actions }])
      ),
      tabs: Object.fromEntries(Object.entries(manifest.tabs).map(([key, tab]) => [key, { title: tab.title, url: page(tab.entry) }])),
      background:
        manifest.background === null
          ? null
          : { url: page(manifest.background), state: entry.background.state, error: entry.background.error },
      commands: manifest.commands,
      settings: manifest.settings,
      settingValues: settingValues(manifest.id, manifest.settings),
      network: manifest.network.map((pattern) => pattern.origin),
      secrets: manifest.secrets.map((key) => ({ key, state: secrets.status(manifest.id, key) })),
      exec: Object.entries(manifest.exec).map(([name, spec]) => ({ name, command: spec.command, args: spec.args })),
      service:
        service === null
          ? null
          : {
              kind: service.kind,
              command: service.command,
              start: service.start,
              ...(entry.service?.info() ?? { state: 'stopped', pid: null, port: null, restarts: 0, error: null })
            },
      runsPrograms: Object.keys(manifest.exec).length > 0 || service !== null
    }
  }

  function list(): PluginInfo[] {
    return entries.map(info)
  }

  function entryAt(path: string): Entry {
    const entry = entries.find((candidate) => candidate.folder.path.toLowerCase() === path.toLowerCase())
    if (entry === undefined) throw new Error(`${path} is not a registered plugin folder`)
    return entry
  }

  const secretsState = (): SecretsState => ({ available: secrets.available(), secrets: secrets.list() })

  // ---------------------------------------------------------------------------
  // Bridge calls
  // ---------------------------------------------------------------------------

  interface CallContext {
    entry: Entry
    plugin: LoadedPlugin
    surface: SurfaceKind
    signal: AbortSignal
  }

  const methods: Record<string, (ctx: CallContext, args: unknown[]) => unknown> = {
    fetch: (ctx, [request]) => {
      const service = ctx.entry.service
      return pluginFetch(request, {
        plugin: ctx.plugin.manifest.id,
        manifest: ctx.plugin.manifest,
        secrets,
        service: service === null ? null : () => service.ensure(),
        send,
        signal: ctx.signal
      })
    },

    exec: async (ctx, [name, args, execOptions]) => {
      if (typeof name !== 'string' || !NAME_PATTERN.test(name)) throw new PluginCallError('invalid', 'exec needs a program name')
      const spec = ctx.plugin.manifest.exec[name]
      if (spec === undefined) throw new PluginCallError('not-declared', `"${name}" is not one of the programs the manifest's exec lists`)
      const request = readExecRequest(args, execOptions)
      if (ctx.entry.running >= EXEC_CONCURRENCY) {
        throw new PluginCallError('unavailable', `this plugin already has ${String(EXEC_CONCURRENCY)} programs running`)
      }
      const env = substituteEnv(
        spec.env,
        secrets.revealer(ctx.plugin.manifest.id, ctx.plugin.manifest.secrets, { kind: 'program' })
      )
      ctx.entry.running += 1
      try {
        return await runProgram({ dir: ctx.plugin.dir, spec, env, request, signal: ctx.signal })
      } finally {
        ctx.entry.running -= 1
      }
    },

    'tabs.open': (ctx, [tab, params, openOptions]) => {
      if (typeof tab !== 'string' || ctx.plugin.manifest.tabs[tab] === undefined) {
        throw new PluginCallError('not-declared', `"${String(tab)}" is not one of the tabs the manifest declares`)
      }
      const given = params ?? {}
      const problem = pluginParamsProblem(given)
      if (problem !== null) throw new PluginCallError('invalid', problem)
      const title = readTitle(openOptions)
      const win = options.window()
      if (win === null || win.isDestroyed()) throw new PluginCallError('unavailable', 'there is no window to open a tab in')
      emitTo(win.webContents, 'plugins:ui', {
        kind: 'openTab',
        plugin: ctx.plugin.manifest.id,
        tab,
        params: given as Record<string, string | number | boolean>,
        title
      })
      return undefined
    },

    'status.set': (ctx, [item]) => {
      ctx.entry.status = readStatus(item)
      changed()
      return undefined
    },

    'badge.set': (ctx, [count]) => {
      if (count !== null && (typeof count !== 'number' || !Number.isInteger(count) || count < 0)) {
        throw new PluginCallError('invalid', 'a badge is a whole number of zero or more, or null')
      }
      ctx.entry.badge = count === null || count === 0 ? null : Math.min(count, BADGE_MAX)
      changed()
      return undefined
    },

    'settings.get': (ctx) => settingValues(ctx.plugin.manifest.id, ctx.plugin.manifest.settings),

    'secrets.state': (ctx, [key]) => {
      declaredSecret(ctx.plugin, key)
      return secretStates(ctx.plugin)[key as string]
    },

    'secrets.request': (ctx, [key]) => {
      declaredSecret(ctx.plugin, key)
      const id = ctx.plugin.manifest.id
      if (secrets.status(id, key as string) === 'ready') return 'ready'
      const win = options.window()
      if (win === null || win.isDestroyed()) return 'missing'
      return new Promise<'ready' | 'missing'>((resolve) => {
        const requestId = randomUUID()
        secretRequests.set(requestId, { plugin: id, key: key as string, resolve })
        emitTo(win.webContents, 'plugins:ui', {
          kind: 'secret',
          requestId,
          plugin: id,
          key: key as string,
          hosts: ctx.plugin.manifest.network.map((pattern) => pattern.origin)
        })
      })
    }
  }

  function declaredSecret(plugin: LoadedPlugin, key: unknown): void {
    if (typeof key !== 'string' || !plugin.manifest.secrets.includes(key)) {
      throw new PluginCallError('not-declared', `"${String(key)}" is not one of the secrets the manifest declares`)
    }
  }

  // ---------------------------------------------------------------------------

  return {
    start() {
      for (const folder of readPluginFolders(store)) {
        const entry = blankEntry(folder)
        entries.push(entry)
        read(entry)
      }
      syncBackground()
    },

    list,

    add(path) {
      if (!isAbsolute(path)) return { path, error: 'Choose a folder.', plugins: list() }
      let isFolder = false
      try {
        isFolder = statSync(path).isDirectory()
      } catch {
        isFolder = false
      }
      if (!isFolder) return { path, error: `${path} is not a folder.`, plugins: list() }
      if (!existsSync(join(path, MANIFEST_FILE))) {
        return {
          path,
          error: `There is no ${MANIFEST_FILE} in ${path}. Choose the folder that holds the plugin's manifest.`,
          plugins: list()
        }
      }
      const known = entries.find((entry) => entry.folder.path.toLowerCase() === path.toLowerCase())
      if (known !== undefined) return { path, error: null, plugins: list() }
      const entry = blankEntry(addPluginFolder(store, path))
      entries.push(entry)
      read(entry)
      changed()
      return { path, error: null, plugins: list() }
    },

    remove(path, deleteSecrets) {
      const entry = entryAt(path)
      const id = entry.load.ok ? entry.load.plugin.manifest.id : null
      stopRuntime(entry)
      entries.splice(entries.indexOf(entry), 1)
      removePluginFolder(store, entry.folder.path)
      if (id !== null) {
        // Only what this plugin alone could use: a key another plugin is allowed
        // is that plugin's too, whatever the form sent.
        const own = new Set(ownSecretsOf(id))
        let removed = false
        for (const key of deleteSecrets) {
          if (own.has(key) && deleteSecret(store, key)) removed = true
        }
        if (removed) emitWindow('secrets:changed', secretsState())
      }
      changed()
      return list()
    },

    setEnabled(path, enabled) {
      const entry = entryAt(path)
      if (entry.folder.enabled === enabled) return list()
      setPluginEnabled(store, entry.folder.path, enabled)
      entry.folder = { ...entry.folder, enabled }
      if (enabled) read(entry)
      else {
        stopRuntime(entry)
        entry.background = { state: 'stopped', error: null }
        entry.revision = ++revisions
      }
      changed()
      return list()
    },

    reload(path) {
      const entry = entryAt(path)
      note(entry, 'reloaded from Settings')
      read(entry)
      changed()
      return list()
    },

    setSetting(plugin, key, value) {
      const entry = entries.find((candidate) => candidate.load.ok && candidate.load.plugin.manifest.id === plugin)
      if (entry === undefined || !entry.load.ok) throw new Error(`${plugin} is not a loaded plugin`)
      const { manifest } = entry.load.plugin
      const spec = manifest.settings.find((candidate) => candidate.key === key)
      if (spec === undefined || spec.type === 'secret') throw new Error(`${key} is not one of ${manifest.name}'s settings`)
      if (value !== null) {
        const problem = settingProblem(spec, value)
        if (problem !== null) throw new Error(problem)
      }
      writePluginSetting(store, plugin, key, value)
      if (live(entry) !== null) {
        deliver({ plugin, event: 'settings', data: settingValues(plugin, manifest.settings), to: 'all' })
      }
      changed()
      return list()
    },

    async call(request, sender) {
      const callKey = `${String(sender)}:${request.callId}`
      const controller = new AbortController()
      calls.set(callKey, controller)
      try {
        if (stopped) throw new PluginCallError('unavailable', 'Helm is shutting down')
        if (!SURFACES.includes(request.surface)) throw new PluginCallError('invalid', 'unknown surface')
        const entry = byId(request.plugin)
        const plugin = entry === null ? null : live(entry)
        if (entry === null || plugin === null) throw new PluginCallError('unavailable', 'the plugin is not enabled')
        const method = Object.hasOwn(methods, request.method) ? methods[request.method] : undefined
        if (method === undefined) throw new PluginCallError('invalid', `helm.${request.method} is not part of the bridge`)
        const args = Array.isArray(request.args) ? request.args : []
        const value = await method({ entry, plugin, surface: request.surface, signal: controller.signal }, args)
        return { ok: true, value }
      } catch (error) {
        return failure(error)
      } finally {
        calls.delete(callKey)
      }
    },

    cancel(callId, sender) {
      calls.get(`${String(sender)}:${callId}`)?.abort()
    },

    command(plugin, id) {
      const entry = byId(plugin)
      const loaded = entry === null ? null : live(entry)
      if (loaded === null || loaded.manifest.background === null) return
      if (!loaded.manifest.commands.some((command) => command.id === id)) return
      deliver({ plugin, event: 'command', data: { id }, to: 'background' })
    },

    answer(requestId) {
      const request = secretRequests.get(requestId)
      if (request === undefined) return
      secretRequests.delete(requestId)
      request.resolve(secrets.status(request.plugin, request.key) === 'ready' ? 'ready' : 'missing')
    },

    backgroundState(plugin, revision, state, error) {
      const entry = byId(plugin)
      if (entry === null || entry.revision !== revision) return
      if (entry.background.state === 'stopped') return
      if (state === 'crashed' && entry.background.state !== 'crashed') {
        note(entry, `background page stopped${error === null ? '' : `: ${error}`}`)
      }
      entry.background = { state, error: state === 'crashed' ? (error ?? 'it stopped responding') : null }
      changed()
    },

    metrics() {
      const usage = new Map(
        app.getAppMetrics().map((metric) => [metric.pid, { memoryKb: metric.memory.workingSetSize, cpu: metric.cpu.percentCPUUsage }])
      )
      const pids = new Map<string, Set<number>>()
      const frames = [options.window()?.webContents, background.contents()]
      for (const contents of frames) {
        if (contents === null || contents === undefined || contents.isDestroyed()) continue
        for (const frame of contents.mainFrame.framesInSubtree) {
          const prefix = `${PLUGIN_SCHEME}://`
          if (!frame.origin.startsWith(prefix)) continue
          const id = frame.origin.slice(prefix.length)
          const set = pids.get(id) ?? new Set<number>()
          set.add(frame.osProcessId)
          pids.set(id, set)
        }
      }
      return entries.flatMap((entry) => {
        const plugin = live(entry)
        if (plugin === null) return []
        const id = plugin.manifest.id
        const own = new Set(pids.get(id) ?? [])
        const servicePid = entry.service?.info().pid ?? null
        if (servicePid !== null) own.add(servicePid)
        let memoryKb = 0
        let cpuPercent = 0
        let found = 0
        for (const pid of own) {
          const metric = usage.get(pid)
          if (metric === undefined) continue
          found += 1
          memoryKb += metric.memoryKb
          cpuPercent += metric.cpu
        }
        return [
          {
            path: entry.folder.path,
            plugin: id,
            memoryKb: found === 0 && own.size > 0 ? null : memoryKb,
            cpuPercent: found === 0 && own.size > 0 ? null : cpuPercent,
            processes: found
          }
        ]
      })
    },

    log(path) {
      return [...entryAt(path).log]
    },

    ownSecrets(path) {
      const entry = entryAt(path)
      return entry.load.ok ? ownSecretsOf(entry.load.plugin.manifest.id) : []
    },

    secrets: {
      list: secretsState,
      save: (input) => {
        secrets.save(input)
        return secretsState()
      },
      remove: (key) => {
        secrets.remove(key)
        return secretsState()
      }
    },

    pushTheme(theme) {
      emitAll('plugins:theme', theme)
    },

    served(id) {
      const entry = byId(id)
      const plugin = entry === null ? null : live(entry)
      return plugin === null ? null : { dir: plugin.dir }
    },

    runtime: {
      bridge: () => options.bridge,
      css: () => options.stylesheet,
      boot: () => JSON.stringify({ theme: options.theme() })
    },

    shutdown() {
      stopped = true
      for (const controller of calls.values()) controller.abort()
      calls.clear()
      for (const request of secretRequests.values()) request.resolve('missing')
      secretRequests.clear()
      for (const entry of entries) stopRuntime(entry, true)
      background.shutdown()
    }
  }

  function ownSecretsOf(id: string): string[] {
    return readSecrets(store)
      .filter((row) => row.plugins.length === 1 && row.plugins[0] === id)
      .map((row) => row.key)
  }
}

function blankEntry(folder: PluginFolder): Entry {
  return {
    folder,
    load: { ok: false, error: 'not read yet', warnings: [], id: null, name: null },
    revision: 0,
    status: null,
    badge: null,
    service: null,
    background: { state: 'stopped', error: null },
    watcher: null,
    reloadTimer: null,
    log: [],
    running: 0
  }
}

/** Which changed paths in a plugin's folder are worth a reload. See `watchFolder`. */
function relevantPaths(load: LoadResult): (rel: readonly string[]) => boolean {
  if (!load.ok) {
    return (rel) => rel[0] !== 'node_modules' && rel[0] !== '.git'
  }
  const { manifest, dir } = load.plugin
  const roots = new Set<string>([MANIFEST_FILE])
  const files = [
    manifest.icon,
    manifest.background,
    ...Object.values(manifest.panels).map((panel) => panel.entry),
    ...Object.values(manifest.tabs).map((tab) => tab.entry),
    manifest.service?.kind === 'node' ? manifest.service.command : null
  ]
  for (const file of files) {
    if (file === null) continue
    // A page's folder, whole: its scripts and styles are beside it.
    const top = relative(dir, join(dir, file)).split(sep)[0]
    if (top !== undefined && top !== '' && top !== 'node_modules') roots.add(top)
  }
  return (rel) => rel[0] !== undefined && roots.has(rel[0])
}

function readTitle(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') throw new PluginCallError('invalid', 'tab options must be an object')
  const title = (value as Record<string, unknown>)['title']
  if (title === undefined || title === null) return null
  if (typeof title !== 'string' || title.trim() === '' || title.length > PLUGIN_TITLE_MAX) {
    throw new PluginCallError('invalid', `a tab title is 1-${String(PLUGIN_TITLE_MAX)} characters`)
  }
  return title.trim()
}

function readStatus(value: unknown): StatusItem | null {
  if (value === null) return null
  if (typeof value !== 'object' || value === undefined) throw new PluginCallError('invalid', 'a status item is an object, or null')
  const { text, tone, tooltip } = value as Record<string, unknown>
  if (typeof text !== 'string' || text.trim() === '' || text.length > STATUS_TEXT_MAX) {
    throw new PluginCallError('invalid', `a status item's text is 1-${String(STATUS_TEXT_MAX)} characters`)
  }
  if (tone !== undefined && !TONES.includes(tone as StatusTone)) {
    throw new PluginCallError('invalid', `tone is one of ${TONES.join(', ')}`)
  }
  if (tooltip !== undefined && (typeof tooltip !== 'string' || tooltip.length > STATUS_TOOLTIP_MAX)) {
    throw new PluginCallError('invalid', `a tooltip is at most ${String(STATUS_TOOLTIP_MAX)} characters`)
  }
  return {
    text: text.trim(),
    ...(tone === undefined ? {} : { tone: tone as StatusTone }),
    ...(tooltip === undefined ? {} : { tooltip: tooltip as string })
  }
}

/** Why a value does not fit a setting, or null when it does. */
export function settingProblem(spec: SettingSpec, value: unknown): string | null {
  switch (spec.type) {
    case 'text':
      return typeof value === 'string' && value.length <= 2000 ? null : `${spec.label} is text`
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${spec.label} is a number`
      if (spec.min !== undefined && value < spec.min) return `${spec.label} is at least ${String(spec.min)}`
      if (spec.max !== undefined && value > spec.max) return `${spec.label} is at most ${String(spec.max)}`
      return null
    case 'toggle':
      return typeof value === 'boolean' ? null : `${spec.label} is on or off`
    case 'select':
      return typeof value === 'string' && spec.options.some((option) => option.value === value)
        ? null
        : `${spec.label} is one of its options`
    case 'secret':
      return `${spec.label} is a secret, stored in Settings > Secrets`
  }
}
