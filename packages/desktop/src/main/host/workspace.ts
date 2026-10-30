import type { AppSettings, CachedProject, DiscoveryResult } from '@helm/core'
import type { ClaudeStatus } from '../../shared/ipc'
import type { WorkspaceService } from '../workspace'
import type { HostConnection, HostSubscription } from './client'
import type { HostLink } from './link'
import type * as P from './protocol'
import {
  cachedProjectsFromHost,
  claudeStatusFromHost,
  discoveryFromHost,
  gitStatesFromHost,
  scanStatusFromHost,
  settingsWithHost,
  splitSettingsPatch
} from './records'
import { CLAUDE_CODE_BACKEND, type Emit } from './sessions'

/**
 * Discovery, scan roots, harnesses, setup, templates and the host's half of
 * the settings, when sessions run in the local host. The host scans its own
 * machine's folders, keeps the scan roots, the pinned projects and whether
 * setup was finished, checks Claude Code for setup, makes harnesses and keeps
 * the templates; Helm's main process does none of it.
 *
 * The settings are split by who owns them. The workspace keys
 * (`HOST_WORKSPACE_KEYS`) are the host's and are held here in memory, never
 * written to `helm.db`. Everything else is Helm's: the window's own keys, and
 * the ones Helm tells the host on every connect (`hostSettingsFor`). What the
 * window reads is Helm's settings with the host's keys laid over; while the
 * host cannot be reached it is Helm's own, so the window still paints, and the
 * sidebar says why from its own refused read.
 *
 * On the first connect to a host that has never been set up - no scan roots
 * and no finished setup - Helm's own scan roots, pins and setup stamp are
 * written to it once, before `connection()` resolves, so a user who turns the
 * setting on keeps the sidebar and the finished setup they had.
 *
 * On every connect it subscribes to `settings:changed`, `discovery:updated`,
 * `scan:status` and `git:updated` and hands each to the window, and it keeps
 * the host's last scan for what main asks of it (`knownProject`, the config
 * console's scope list).
 *
 * Every request goes through `link.connection()`, which joins the first
 * connect while it is in flight, so a window that asks before Helm has reached
 * the host gets the host's answer, never an empty one first. When the host
 * cannot be reached, each rejects with the link's sentence; none answers an
 * empty list in its place.
 */

export interface HostWorkspaceDeps {
  link: HostLink
  emit: Emit
  /** Helm's own settings, as they are now. */
  own: () => AppSettings
  /** Writes Helm's own settings, and answers them after. */
  writeOwn: (patch: Partial<AppSettings>) => AppSettings
  /** An executable the host checked and kept for Claude Code, which Helm's Settings then show. */
  claudePicked: (path: string) => void
  log: (line: string) => void
}

export interface HostWorkspace extends WorkspaceService {
  /** Helm's settings as they are now, with the host's keys laid over once it has said them. */
  overlay(own: AppSettings): AppSettings
  /** The host's last scan, or null before it has said one. */
  lastScan(): DiscoveryResult | null
  /** The discovered project at `cwd`, by the path the host's discovery spells it, or null. */
  knownProject(cwd: string): string | null
  /** Asks the host to read git again; the window hears the answer on `git:updated`. */
  refreshGit(): Promise<void>
  shutdown(): void
}

export function createHostWorkspace({
  link,
  emit,
  own,
  writeOwn,
  claudePicked,
  log
}: HostWorkspaceDeps): HostWorkspace {
  let hostSettings: P.HostSettings | null = null
  let scanned: DiscoveryResult | null = null
  let cached: CachedProject[] = []
  let subscriptions: HostSubscription[] = []

  const host = (): Promise<HostConnection> => link.connection()
  const overlay = (settings: AppSettings): AppSettings => settingsWithHost(settings, hostSettings)

  const adoptSettings = (next: P.HostSettings): AppSettings => {
    hostSettings = next
    return overlay(own())
  }

  const adoptScan = (result: P.DiscoveryResult): DiscoveryResult => {
    scanned = discoveryFromHost(result)
    return scanned
  }

  /** Helm's scan roots, pins and setup stamp, written once to a host that has never been set up. */
  const copyOnFirstConnect = async (connection: HostConnection, current: P.HostSettings): Promise<P.HostSettings> => {
    const fresh = current.scanRoots.length === 0 && current.firstRunCompletedAt === null
    const mine = own()
    if (!fresh || (mine.scanRoots.length === 0 && mine.firstRunCompletedAt === null)) return current
    return connection.request('settings:write', {
      scanRoots: mine.scanRoots,
      pinnedProjects: mine.pinnedProjects,
      firstRunCompletedAt: mine.firstRunCompletedAt
    })
  }

  link.onConnected(async (connection) => {
    for (const subscription of subscriptions) subscription.unsubscribe()
    const ended = (channel: string) => (error: Error) => log(`host: ${channel} ended (${error.message})`)
    try {
      adoptSettings(await copyOnFirstConnect(connection, await connection.request('settings:read', null)))
    } catch (error) {
      log(`host: could not read the local host's settings (${(error as Error).message})`)
    }
    subscriptions = [
      connection.subscribe('settings:changed', {
        snapshot: (state) => {
          hostSettings = state
        },
        event: (next) => emit('settings:changed', adoptSettings(next)),
        error: ended('settings:changed')
      }),
      connection.subscribe('discovery:updated', {
        snapshot: (state) => {
          if (state !== null) adoptScan(state)
        },
        event: (result) => emit('discovery:updated', adoptScan(result)),
        error: ended('discovery:updated')
      }),
      connection.subscribe('scan:status', {
        event: (status) => emit('scan:status', scanStatusFromHost(status)),
        error: ended('scan:status')
      }),
      connection.subscribe('git:updated', {
        event: (read) => {
          const states = gitStatesFromHost(read)
          if (scanned !== null) {
            for (const project of scanned.projects) {
              if (project.path in states) project.git = states[project.path] ?? null
            }
          }
          emit('git:updated', states)
        },
        error: ended('git:updated')
      })
    ]
  })

  /** Setup's reading of Claude Code, out of the host's one per backend. */
  const claude = (status: P.SetupStatus): ClaudeStatus => claudeStatusFromHost(status.backends[CLAUDE_CODE_BACKEND])

  const workspace: HostWorkspace = {
    overlay,

    lastScan: () => scanned,

    knownProject(cwd) {
      const wanted = cwd.toLowerCase()
      const projects: ReadonlyArray<{ path: string }> = scanned?.projects ?? cached
      return projects.find((project) => project.path.toLowerCase() === wanted)?.path ?? null
    },

    async refreshGit() {
      // The host pushes what it read on `git:updated`, which is relayed above.
      await (await host()).request('git:refresh', null)
    },

    async settings() {
      try {
        await host()
      } catch {
        return own()
      }
      return overlay(own())
    },

    async writeSettings(patch) {
      const split = splitSettingsPatch(patch)
      const mine = Object.keys(split.own).length > 0 ? writeOwn(split.own) : own()
      if (Object.keys(split.host).length === 0) return overlay(mine)
      return adoptSettings(await (await host()).request('settings:write', split.host))
    },

    async cached() {
      cached = cachedProjectsFromHost(await (await host()).request('discovery:cached', null))
      return cached
    },

    async scan(includeGit) {
      return adoptScan(await (await host()).request('discovery:scan', { includeGit }))
    },

    async suggestRoots() {
      return (await host()).request('roots:suggest', null)
    },

    async acceptRoots(paths) {
      const connection = await host()
      let roots = hostSettings?.scanRoots ?? []
      for (const path of paths) roots = await connection.request('roots:accept', { path })
      return roots
    },

    async removeRoot(path) {
      return (await host()).request('roots:remove', { path })
    },

    async setupStatus() {
      return claude(await (await host()).request('setup:status', null))
    },

    async locateClaude(path) {
      const status = await (await host()).request('setup:locateBackend', { backend: CLAUDE_CODE_BACKEND, path })
      // Kept by the host only once it ran; Helm's Settings show the same one,
      // and tell it to the host on every connect from then on.
      if (status.error === null && status.installed) {
        claudePicked(path)
        emit('settings:changed', overlay(own()))
      }
      return claudeStatusFromHost(status)
    },

    async completeSetup() {
      return adoptSettings(await (await host()).request('setup:complete', null))
    },

    async createHarness(request) {
      return (await host()).request('harness:create', {
        mode: request.mode,
        dir: request.dir,
        name: request.name ?? null,
        template: request.mode === 'new' ? (request.template ?? null) : null
      })
    },

    templates: {
      list: async () => (await host()).request('template:list', null),
      preview: async ({ template, mode }) =>
        (await host()).request('template:preview', {
          template,
          mode: mode ?? null
        }),
      detail: async (template) => (await host()).request('template:detail', { template }),
      create: async ({ name, label, description }) =>
        (await host()).request('template:create', {
          name,
          label: label ?? null,
          description: description ?? null
        }),
      rename: async (request) => (await host()).request('template:rename', request),
      remove: async (template) => (await host()).request('template:delete', { template }),
      metadata: async (request) => (await host()).request('template:metadata', request),
      substitute: async (request) => (await host()).request('template:substitute', request),
      importFiles: async (request) => (await host()).request('template:import', request),
      folderPreview: async (request) => (await host()).request('template:folderPreview', request),
      fromFolder: async (request) => (await host()).request('template:fromFolder', request)
    },

    shutdown() {
      for (const subscription of subscriptions) subscription.unsubscribe()
      subscriptions = []
    }
  }
  return workspace
}
