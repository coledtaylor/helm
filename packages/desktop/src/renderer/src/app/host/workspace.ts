import type { AppSettings, Project } from '@helm/core/types'
import { CLAUDE_CODE_BACKEND } from '../../../../shared/host/backend'
import type { HostConnection, HostSubscription } from '../../../../shared/host/client'
import type * as P from '../../../../shared/host/protocol'
import {
  cachedProjectsFromHost,
  claudeStatusFromHost,
  discoveryFromHost,
  gitStatesFromHost,
  scanStatusFromHost,
  settingsWithHost,
  splitSettingsPatch
} from '../../../../shared/host/records'
import type { ClaudeStatus, EventPayload, HelmBridge } from '../../../../shared/ipc'
import type { HostReach } from './history'
import type { HostAdapter } from './router'

/**
 * Discovery, scan roots, harnesses, setup, templates and the settings while
 * sessions run in the local host. The host scans its own machine's folders,
 * keeps the scan roots, the pinned projects and whether setup was finished,
 * checks Claude Code, makes harnesses and keeps the templates, and the window
 * asks it over its own connection, in ipc.ts's shapes.
 *
 * The settings are split by who keeps them. The host's half (`HostSettings`'s
 * scan roots, pins and setup stamp) is read and written over the protocol.
 * Helm's own half - the window, theme, terminal and browser preferences, and
 * the `claude` Helm picked, which main tells the host - stays with Helm's main
 * process on the client-only `ownSettings:*`, whose write does what main does
 * with it. The window is answered Helm's half with the host's laid over; while
 * the host cannot be reached it is Helm's own, so the window still paints and
 * the sidebar says why from its own refused read.
 *
 * The pickers are the window's own: `path:chooseFile` for the `claude`
 * program, whose choice the host checks before Helm keeps it.
 *
 * The first listener starts the window's first scan, as main did when the
 * window said it had painted; a host that cannot be reached says why on
 * `scan:status`. While the window has a scan from the host, its coming to the
 * front reads git again, which the host pushes on `git:updated`.
 *
 * Every request goes through `link.connection()`, which joins the first
 * connect while it is in flight, so a read asked before the window has reached
 * the host gets the host's answer, never an empty one first; with no host each
 * rejects with the link's sentence, never an empty list in its place.
 */

type Pushed = 'settings:changed' | 'discovery:updated' | 'scan:status' | 'git:updated'

export interface WorkspaceAdapterDeps {
  link: HostReach
  /** The preload's bridge, for Helm's own settings, build and pickers. */
  own: Pick<HelmBridge, 'invoke' | 'on'>
  /** Calls `listener` whenever the window comes to the front. */
  onFocus?: (listener: () => void) => void
  log?: (line: string) => void
}

export interface WorkspaceAdapter extends HostAdapter {
  /** The harnesses and projects on the sidebar: the host's last scan, or its cached one before any. */
  scannedProjects(): Promise<readonly Project[]>
}

export function createWorkspaceAdapter({
  link,
  own,
  onFocus,
  log = () => undefined
}: WorkspaceAdapterDeps): WorkspaceAdapter {
  const listeners: { [K in Pushed]: Set<(payload: EventPayload<K>) => void> } = {
    'settings:changed': new Set(),
    'discovery:updated': new Set(),
    'scan:status': new Set(),
    'git:updated': new Set()
  }
  let hostSettings: P.HostSettings | null = null
  let mine: AppSettings | null = null
  let scanned: readonly Project[] | null = null
  let started = false
  let subscriptions: HostSubscription[] = []

  const host = (): Promise<HostConnection> => link.connection()
  /** The settings last told, which a listener that comes later hears at once. */
  let toldSettings: AppSettings | null = null
  const tell = <K extends Pushed>(channel: K, payload: EventPayload<K>): void => {
    if (channel === 'settings:changed') toldSettings = payload as AppSettings
    for (const listener of listeners[channel]) listener(payload)
  }

  const ownSettings = async (): Promise<AppSettings> => (mine ??= await own.invoke('ownSettings:read'))
  /**
   * Tells every listener Helm's settings with the host's laid over once the
   * host's are known: read first when they are not yet, and Helm's alone only
   * when the host cannot be reached. Told before then, the window would take
   * the host's half (its scan roots among them) for empty.
   */
  let hostAsked: Promise<void> | null = null
  /** Resolves once the host's settings are known, or the host could not be reached for them. */
  const hostKnown = (): Promise<void> => {
    if (hostSettings !== null) return Promise.resolve()
    hostAsked ??= host()
      .then((connection) => connection.request('settings:read', null))
      .then(
        (read) => {
          hostSettings ??= read
        },
        () => undefined
      )
      .finally(() => {
        hostAsked = null
      })
    return hostAsked
  }
  const tellSettled = (): void => {
    // Told at once when the host's are known: a scan waits on this telling.
    if (hostSettings !== null && mine !== null) {
      tell('settings:changed', settingsWithHost(mine, hostSettings))
      return
    }
    void hostKnown().then(() => {
      if (mine !== null) tell('settings:changed', settingsWithHost(mine, hostSettings))
    })
  }
  /** Helm's settings with the host's laid over, told to every listener. */
  const settled = (settings: AppSettings): AppSettings => {
    mine = settings
    tellSettled()
    return settingsWithHost(settings, hostSettings)
  }
  const adoptHost = async (next: P.HostSettings): Promise<AppSettings> => {
    hostSettings = next
    // Helm's half as it is when the answer lands, not when it was asked for.
    await ownSettings()
    return settled(mine ?? (await ownSettings()))
  }

  link.onConnected((connection) => {
    for (const subscription of subscriptions) subscription.unsubscribe()
    const ended = (channel: string) => (error: Error) => log(`host: ${channel} ended (${error.message})`)
    // The window is told this connection's settings before its first scan,
    // so nothing that offers a scan root shows the projects without them.
    let settingsTold: Promise<unknown> = Promise.resolve()
    const discovered = (result: P.DiscoveryResult): void => {
      const discovery = discoveryFromHost(result)
      void settingsTold.then(() => {
        scanned = discovery.projects
        tell('discovery:updated', discovery)
      })
    }
    subscriptions = [
      connection.subscribe('settings:changed', {
        snapshot: (state) => {
          settingsTold = adoptHost(state).catch(ended('settings:changed'))
        },
        event: (next) => void adoptHost(next).catch(ended('settings:changed')),
        error: ended('settings:changed')
      }),
      connection.subscribe('discovery:updated', {
        snapshot: (state) => {
          if (state !== null) discovered(state)
        },
        event: discovered,
        error: ended('discovery:updated')
      }),
      connection.subscribe('scan:status', {
        event: (status) => tell('scan:status', scanStatusFromHost(status)),
        error: ended('scan:status')
      }),
      connection.subscribe('git:updated', {
        event: (read) => tell('git:updated', gitStatesFromHost(read)),
        error: ended('git:updated')
      })
    ]
  })

  /** The window's first scan; a host that cannot be reached says why where the scan shows. */
  const start = (): void => {
    if (started) return
    started = true
    own.on('ownSettings:changed', (settings) => void settled(settings))
    void host()
      .then((connection) => connection.request('discovery:scan', { includeGit: true }))
      .catch((error: unknown) => {
        tell('scan:status', { running: false, error: error instanceof Error ? error.message : String(error) })
      })
  }

  let gitInFlight = false
  onFocus?.(() => {
    // Only a window that has the host's scan has projects whose git to read.
    if (gitInFlight || scanned === null) return
    gitInFlight = true
    void host()
      .then((connection) => connection.request('git:refresh', null))
      .catch(() => undefined)
      .finally(() => {
        gitInFlight = false
      })
  })

  const listen =
    <K extends Pushed>(channel: K) =>
    (listener: (payload: EventPayload<K>) => void): (() => void) => {
      listeners[channel].add(listener)
      // The connection may have told its settings before the window listened,
      // and a scan told after them must not land on a window without them.
      if (channel === 'settings:changed' && toldSettings !== null) listener(toldSettings as EventPayload<K>)
      start()
      return () => {
        listeners[channel].delete(listener)
      }
    }

  /** Setup's reading of Claude Code, out of the host's one per backend. */
  const claude = (status: P.SetupStatus): ClaudeStatus => claudeStatusFromHost(status.backends[CLAUDE_CODE_BACKEND])

  return {
    async scannedProjects() {
      return scanned ?? cachedProjectsFromHost(await (await host()).request('discovery:cached', null))
    },

    requests: {
      'app:info': async () => {
        const build = await own.invoke('ownApp:info')
        let claudeVersion: string | null = null
        try {
          claudeVersion = claude(await (await host()).request('setup:status', null)).version
        } catch (error) {
          log(`host: the claude version could not be read (${(error as Error).message})`)
        }
        return { ...build, claudeVersion }
      },

      'settings:read': async () => {
        const settings = await ownSettings()
        let connection: HostConnection
        try {
          connection = await host()
        } catch {
          return settings
        }
        hostSettings = await connection.request('settings:read', null)
        return settingsWithHost(settings, hostSettings)
      },

      'settings:write': async (patch) => {
        const split = splitSettingsPatch(patch)
        // A write of Helm's half alone answers with the host's laid over, so
        // the host's are read first when they are not known yet.
        if (Object.keys(split.host).length === 0) await hostKnown()
        const settings =
          Object.keys(split.own).length > 0 ? await own.invoke('ownSettings:write', split.own) : await ownSettings()
        if (Object.keys(split.host).length === 0) return settled(settings)
        hostSettings = await (await host()).request('settings:write', split.host)
        return settled(settings)
      },

      'discovery:cached': async () => cachedProjectsFromHost(await (await host()).request('discovery:cached', null)),
      'discovery:scan': async (request) =>
        discoveryFromHost(await (await host()).request('discovery:scan', { includeGit: request?.includeGit ?? true })),

      'roots:suggest': async () => (await host()).request('roots:suggest', null),
      'roots:accept': async ({ path }) => (await host()).request('roots:accept', { path }),
      'roots:remove': async ({ path }) => (await host()).request('roots:remove', { path }),

      'setup:status': async () => claude(await (await host()).request('setup:status', null)),
      // The picker is the window's own; the host checks what it chose, and
      // only a program it kept becomes Helm's, which main tells the host on
      // every connect from then on.
      'setup:locateClaude': async () => {
        const { path } = await own.invoke('path:chooseFile', { title: 'Locate the claude executable' })
        const connection = await host()
        if (path === null) return claude(await connection.request('setup:status', null))
        const status = await connection.request('setup:locateBackend', { backend: CLAUDE_CODE_BACKEND, path })
        if (status.error === null && status.installed) settled(await own.invoke('ownSettings:write', { claudePath: path }))
        return claudeStatusFromHost(status)
      },
      'setup:complete': async () => adoptHost(await (await host()).request('setup:complete', null)),

      'harness:create': async (request) =>
        (await host()).request('harness:create', {
          mode: request.mode,
          dir: request.dir,
          name: request.name ?? null,
          template: request.mode === 'new' ? (request.template ?? null) : null
        }),

      'template:list': async () => (await host()).request('template:list', null),
      'template:preview': async ({ template, mode }) =>
        (await host()).request('template:preview', { template, mode: mode ?? null }),
      'template:detail': async ({ template }) => (await host()).request('template:detail', { template }),
      'template:create': async ({ name, label, description }) =>
        (await host()).request('template:create', { name, label: label ?? null, description: description ?? null }),
      'template:rename': async (request) => (await host()).request('template:rename', request),
      'template:delete': async ({ template }) => (await host()).request('template:delete', { template }),
      'template:metadata': async (request) => (await host()).request('template:metadata', request),
      'template:substitute': async (request) => (await host()).request('template:substitute', request),
      'template:import': async (request) => (await host()).request('template:import', request),
      'template:folderPreview': async (request) => (await host()).request('template:folderPreview', request),
      'template:fromFolder': async (request) => (await host()).request('template:fromFolder', request)
    },
    events: {
      'settings:changed': listen('settings:changed'),
      'discovery:updated': listen('discovery:updated'),
      'scan:status': listen('scan:status'),
      'git:updated': listen('git:updated')
    }
  }
}
