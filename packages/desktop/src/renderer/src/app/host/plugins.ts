import type { SurfaceKind } from '@coledtaylor/helm-plugin-sdk'
import type { SessionRecord } from '@helm/core/types'
import type { HostConnection, HostSubscription } from '../../../../shared/host/client'
import type * as P from '../../../../shared/host/protocol'
import {
  deliveryFromHost,
  logFromHost,
  pluginFromHost,
  uiFromHost,
  withBackgroundReports
} from '../../../../shared/host/records'
import type {
  HelmBridge,
  PluginBackgroundReport,
  PluginCallOutcome,
  PluginCallRequest,
  PluginInfo,
  PluginUiRequest
} from '../../../../shared/ipc'
import { CLIENT_METHODS, createClientCalls } from '../../../../shared/plugins/client-calls'
import { failure, PluginCallError } from '../../../../shared/plugins/errors'
import { createLocalEvents, type LocalEvents } from './events'
import type { HostReach } from './history'
import type { HostAdapter } from './router'

/**
 * Plugins while sessions run in the local host, over a Helm page's own
 * connection. The host registers the folders, keeps their switches, setting
 * values and secrets, runs their services and answers their pages' calls:
 * `helm.fetch`, `exec`, settings, secrets, sessions, status and badge, and a
 * `BroadcastChannel` post, which the host hands every page of the plugin on
 * every client and its background page.
 *
 * Two pages frame plugins, each on its own connection:
 *
 * - The window (`createPluginsAdapter`): Settings and the rail, and the
 *   plugin's panels and tabs. It draws what the host asks of it on this
 *   connection (`plugins:ui`: the secret and session dialogs), answers on the
 *   same connection, which is the one the host checks, and takes every
 *   delivery but those for the background page.
 * - The hidden plugin host window (`createBackgroundAdapter`), where a plugin's
 *   background page runs under API v1. It takes every delivery, the
 *   background's included. What a background page asks that only the window
 *   can draw (one of the plugin's tabs, a secret dialog) goes to the window
 *   through main (`pluginWindow:*`), and the window's word that the dialog
 *   closed comes back the same way, to be answered on this connection.
 *
 * What concerns only the page on screen is answered in the page that draws
 * it, with the checks main makes with the setting off (`client-calls.ts`):
 * opening one of the plugin's tabs, and opening a link in the Browser tab,
 * which the window opens through `browser:open` and the reach rule. A call the
 * host cannot be reached for settles in the page as unavailable, with the
 * link's sentence, and nowhere in Helm's chrome.
 *
 * Every read goes through `link.connection()`, so one asked before the first
 * connect waits for it, and one asked when the host cannot be reached rejects
 * with the link's sentence, never an empty list.
 *
 * Whether each background page runs is what the hidden window sees: the window
 * hears it from main (`pluginBackground:*`), the hidden window from its own
 * frames, and each lays it over the host's list, which lists a background page
 * without running it.
 */

const SURFACES: readonly SurfaceKind[] = ['panel', 'tab', 'background']

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

type Own = Pick<HelmBridge, 'invoke' | 'send' | 'on'>

interface CoreDeps {
  link: HostReach
  /** Where the client calls hand what they open: false when there is nothing to hand it to. */
  ui: (request: PluginUiRequest) => boolean
  /** What the hidden window saw of a plugin's background page. */
  report: (plugin: string) => PluginBackgroundReport | undefined
  /** What the host asked of this page on its connection. */
  asked: (request: PluginUiRequest) => void
  /** Whether a delivery is for this page's frames. */
  delivers: (delivery: P.PluginDelivery) => boolean
  /** Subscribes to secrets as well: only Settings, in the window, shows them. */
  secrets: boolean
  log: (line: string) => void
}

/** What both pages share: the host's list, its subscriptions and a page's calls. */
interface PluginsCore {
  events: LocalEvents
  host(): Promise<HostConnection>
  current(): HostConnection | null
  /** The host's list as the page shows it, after waiting for the first read. */
  list(): Promise<PluginInfo[]>
  /** The host's list, now the one this page has; the list as the page shows it. */
  take(listed: readonly P.PluginInfo[]): PluginInfo[]
  /** Tells the page's listeners the list again when what it shows moved. */
  retell(): void
  call(request: PluginCallRequest): Promise<PluginCallOutcome>
  cancel(callId: string): void
}

function createPluginsCore(deps: CoreDeps): PluginsCore {
  const { link, log } = deps
  const host = (): Promise<HostConnection> => link.connection()
  const events = createLocalEvents(() => {
    void host().catch(() => undefined)
  })
  /** The host's last list, mapped; null until the first one. */
  let hosted: PluginInfo[] | null = null
  /** The list as last told, so a report that moves nothing tells nobody. */
  let said = ''
  let current: HostConnection | null = null
  let subscriptions: HostSubscription[] = []

  const shown = (): PluginInfo[] => withBackgroundReports(hosted ?? [], deps.report)

  const retell = (): void => {
    if (hosted === null) return
    const list = shown()
    const text = JSON.stringify(list)
    if (text === said) return
    said = text
    events.tell('plugins:changed', list)
  }

  const take = (listed: readonly P.PluginInfo[]): PluginInfo[] => {
    hosted = listed.map(pluginFromHost)
    retell()
    return shown()
  }

  const live = (plugin: string): PluginInfo | null =>
    hosted?.find((info) => info.id === plugin && info.enabled && info.error === null) ?? null

  const clientCalls = createClientCalls({ ui: deps.ui })

  /** A call answered here: one that concerns only the page on screen. */
  const answerOnClient = async (request: PluginCallRequest): Promise<PluginCallOutcome> => {
    if (hosted === null) take(await (await host()).request('plugins:list', null))
    const plugin = live(request.plugin)
    if (plugin === null) return { ok: false, code: 'unavailable', message: 'the plugin is not enabled' }
    clientCalls.run(
      request.method,
      { plugin: request.plugin, declaresTab: (tab) => Object.hasOwn(plugin.tabs, tab), surface: request.surface },
      Array.isArray(request.args) ? request.args : []
    )
    return { ok: true, value: undefined }
  }

  link.onConnected((connection) => {
    current = connection
    void connection.ended.then(() => {
      if (current === connection) current = null
    })
    for (const subscription of subscriptions) subscription.unsubscribe()
    const failed = (channel: string) => (error: Error) => log(`host: ${channel} ended (${error.message})`)
    subscriptions = [
      connection.subscribe('plugins:changed', {
        snapshot: (listed) => take(listed),
        event: (listed) => take(listed),
        error: failed('plugins:changed')
      }),
      connection.subscribe('plugins:ui', {
        event: (request) => deps.asked(uiFromHost(request)),
        error: failed('plugins:ui')
      }),
      connection.subscribe('plugins:deliver', {
        event: (delivery) => {
          if (deps.delivers(delivery)) events.tell('plugins:deliver', deliveryFromHost(delivery))
        },
        error: failed('plugins:deliver')
      }),
      ...(deps.secrets
        ? [
            connection.subscribe('secrets:changed', {
              snapshot: (state) => events.tell('secrets:changed', state),
              event: (state) => events.tell('secrets:changed', state),
              error: failed('secrets:changed')
            })
          ]
        : [])
    ]
  })

  return {
    events,
    host,
    current: () => current,
    async list() {
      take(await (await host()).request('plugins:list', null))
      return shown()
    },
    take,
    retell,
    async call(request) {
      try {
        if (!SURFACES.includes(request.surface)) return { ok: false, code: 'invalid', message: 'unknown surface' }
        if (CLIENT_METHODS.has(request.method)) return await answerOnClient(request)
        const connection = await host()
        return await connection.request('plugins:call', {
          plugin: request.plugin,
          surface: request.surface,
          method: request.method,
          args: Array.isArray(request.args) ? request.args : [],
          // The host keys a call by the connection it came on, so the relay's own id is enough.
          callId: request.callId
        })
      } catch (error) {
        // A check here refused it, or the host could not be reached or refused
        // the request itself: the page is told why, as a call that failed, and
        // Helm's chrome hears nothing.
        if (error instanceof PluginCallError) return failure(error)
        return { ok: false, code: 'unavailable', message: messageOf(error) }
      }
    },
    cancel(callId) {
      // A call in flight went out on the connection there is now; with none,
      // nothing is in flight to cancel.
      current?.request('plugins:cancel', { callId }).catch((error: unknown) => {
        log(`host: plugins:cancel was not taken (${messageOf(error)})`)
      })
    }
  }
}

export interface PluginsAdapterDeps {
  link: HostReach
  /** The preload's bridge: the folder picker, and what main hears from the hidden window. */
  own: Own
  /** A session the host started for a plugin, kept with the window's sessions so it opens as a tab. */
  adopt: (row: P.SessionRecord) => SessionRecord
  log?: (line: string) => void
}

/** The window's plugins: Settings and the rail, and the plugin pages it frames. */
export function createPluginsAdapter(deps: PluginsAdapterDeps): HostAdapter {
  const { own } = deps
  const log = deps.log ?? (() => undefined)
  const reports = new Map<string, PluginBackgroundReport>()
  /** Secret dialogs the hidden window handed over, whose close goes back to it. */
  const handedOver = new Set<string>()

  const setReports = (next: readonly PluginBackgroundReport[]): void => {
    reports.clear()
    for (const report of next) reports.set(report.plugin, report)
  }

  const core: PluginsCore = createPluginsCore({
    link: deps.link,
    ui: (request) => {
      if (core.events.count('plugins:ui') === 0) return false
      core.events.tell('plugins:ui', request)
      return true
    },
    report: (plugin) => reports.get(plugin),
    asked: (request) => core.events.tell('plugins:ui', request),
    delivers: (delivery) => delivery.to !== 'background',
    secrets: true,
    log
  })

  /** Main's word on the background pages, asked once and then heard as it moves. */
  let reportsRead: Promise<void> | null = null
  const readReports = (): Promise<void> => {
    reportsRead ??= (async () => {
      own.on('pluginBackground:changed', (next) => {
        setReports(next)
        core.retell()
      })
      try {
        setReports(await own.invoke('pluginBackground:states'))
      } catch (error) {
        log(`plugins: the background pages' states were not read (${messageOf(error)})`)
      }
    })()
    return reportsRead
  }
  deps.link.onConnected(() => {
    void readReports()
  })

  const host = (): Promise<HostConnection> => core.host()
  const listed = async (answer: Promise<readonly P.PluginInfo[]>): Promise<PluginInfo[]> => {
    const plugins = await answer
    await readReports()
    return core.take(plugins)
  }

  let handOverHeard = false
  const uiRoute = core.events.listen('plugins:ui')

  return {
    requests: {
      'plugins:list': async () => listed((await host()).request('plugins:list', null)),
      'plugins:add': async () => {
        const { path } = await own.invoke('path:chooseDirectory', { title: 'Add a plugin folder' })
        if (path === null) {
          return { path: null, error: null, plugins: await listed((await host()).request('plugins:list', null)) }
        }
        const added = await (await host()).request('plugins:add', { path })
        return { path: added.path, error: added.error, plugins: await listed(Promise.resolve(added.plugins)) }
      },
      'plugins:remove': async ({ path, deleteSecrets }) =>
        listed((await host()).request('plugins:remove', { path, deleteSecrets: [...deleteSecrets] })),
      'plugins:setEnabled': async ({ path, enabled }) =>
        listed((await host()).request('plugins:setEnabled', { path, enabled })),
      'plugins:setTools': async ({ path, enabled }) => listed((await host()).request('plugins:setTools', { path, enabled })),
      'plugins:reload': async ({ path }) => listed((await host()).request('plugins:reload', { path })),
      'plugins:setSetting': async ({ plugin, key, value }) =>
        listed((await host()).request('plugins:setSetting', { plugin, key, value })),
      'plugins:log': async ({ path }) => logFromHost(await (await host()).request('plugins:log', { path })),
      'plugins:metrics': async () => (await host()).request('plugins:metrics', null),
      'plugins:ownSecrets': async ({ path }) => (await host()).request('plugins:ownSecrets', { path }),
      'plugins:command': async ({ plugin, id }) => {
        await (await host()).request('plugins:command', { plugin, id })
      },
      'plugins:call': (request) => core.call(request),
      'plugins:session': async (answer) => {
        const row = await (await host()).request('plugins:session', answer)
        return row === null ? null : deps.adopt(row)
      },
      'secrets:list': async () => (await host()).request('secrets:list', null),
      'secrets:save': async (input) => (await host()).request('secrets:save', input),
      'secrets:remove': async ({ key }) => (await host()).request('secrets:remove', { key })
    },
    sends: {
      'plugins:cancel': ({ callId }) => core.cancel(callId),
      'plugins:answer': ({ requestId }) => {
        if (handedOver.delete(requestId)) {
          own.send('pluginWindow:answer', { requestId })
          return
        }
        host()
          .then((connection) => connection.request('plugins:answer', { requestId }))
          .catch((error: unknown) => log(`host: plugins:answer was not taken (${messageOf(error)})`))
      }
    },
    events: {
      'plugins:changed': core.events.listen('plugins:changed'),
      'secrets:changed': core.events.listen('secrets:changed'),
      'plugins:deliver': core.events.listen('plugins:deliver'),
      'plugins:ui': (listener) => {
        if (!handOverHeard) {
          handOverHeard = true
          own.on('pluginWindow:asked', (request) => {
            if (request.kind === 'secret') handedOver.add(request.requestId)
            core.events.tell('plugins:ui', request)
          })
        }
        return uiRoute(listener)
      }
    }
  }
}

export interface BackgroundAdapterDeps {
  link: HostReach
  /** The preload's bridge: Helm's own settings, and the hand-off to the window through main. */
  own: Own
  log?: (line: string) => void
}

export interface BackgroundAdapter extends HostAdapter {
  /** What this window's frames say of a background page: it connected, or it crashed. */
  reported(report: PluginBackgroundReport): void
}

/**
 * The hidden plugin host window's plugins: the background pages it runs.
 * Nothing else is asked here: no terminal, files or sessions.
 */
export function createBackgroundAdapter(deps: BackgroundAdapterDeps): BackgroundAdapter {
  const { own } = deps
  const log = deps.log ?? (() => undefined)
  const reports = new Map<string, PluginBackgroundReport>()

  const handOver = (request: PluginUiRequest): boolean => {
    own.send('pluginWindow:ask', request)
    return true
  }

  const core: PluginsCore = createPluginsCore({
    link: deps.link,
    ui: handOver,
    report: (plugin) => reports.get(plugin),
    asked: (request) => {
      // Only a secret dialog can be asked of a background page: starting a
      // session needs a click, which a page nobody sees never has.
      if (request.kind === 'secret') handOver(request)
      else log(`plugins: a background page cannot answer “${request.kind}”`)
    },
    delivers: () => true,
    secrets: false,
    log
  })

  // The window closed a secret dialog this window's page asked for: answered
  // on this connection, which is the one the host asked on.
  own.on('pluginWindow:answered', ({ requestId }) => {
    core
      .host()
      .then((connection) => connection.request('plugins:answer', { requestId }))
      .catch((error: unknown) => log(`host: plugins:answer was not taken (${messageOf(error)})`))
  })

  return {
    requests: {
      'plugins:list': () => core.list(),
      'plugins:call': (request) => core.call(request),
      // The first theme the relay hands its frames: Helm's own corner and density.
      'settings:read': () => own.invoke('ownSettings:read')
    },
    sends: {
      'plugins:cancel': ({ callId }) => core.cancel(callId)
    },
    events: {
      'plugins:changed': core.events.listen('plugins:changed'),
      'plugins:deliver': core.events.listen('plugins:deliver')
    },
    reported(report) {
      reports.set(report.plugin, report)
      core.retell()
    }
  }
}
