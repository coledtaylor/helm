import type { Project } from '@helm/core/types'
import type { HostConnection, HostSubscription } from '../../../../shared/host/client'
import { effectiveRequestForHost, writeConfigResultFromHost } from '../../../../shared/host/records'
import { configScopesWithScan } from '../../../../shared/host/records/content'
import type { EventPayload } from '../../../../shared/ipc'
import type { HostReach } from './history'
import type { HostAdapter } from './router'

/**
 * The config console while sessions run in the local host: the host reads the
 * agent's configuration, renders it, runs the agent's own CLI for MCP and the
 * doctor, and writes through its one writer, which snapshots the bytes it
 * replaces first, aborts with a sentence when it cannot, and refuses a write
 * whose file changed since the editor read it. The window asks it over its own
 * connection, in ipc.ts's shapes.
 *
 * On every connect it subscribes to the host's `config:externalChange` and
 * tells the host again which file the editor has open: a watch belongs to a
 * connection, so one made before a reconnect is gone with it. The host sends a
 * change only to the client watching that file, and never for a change made
 * through the host, so the window's own save raises no warning.
 *
 * Every request goes through `link.connection()`, which joins the first
 * connect while it is in flight; with no host each rejects with the link's
 * sentence, never an empty scope list, tree or version list in its place.
 */

export interface ConfigAdapterDeps {
  link: HostReach
  /** The harnesses and projects on the sidebar, which the switcher lists beside the host's scopes. */
  scanned: () => Promise<readonly Project[]>
  log?: (line: string) => void
}

export function createConfigAdapter({ link, scanned, log = () => undefined }: ConfigAdapterDeps): HostAdapter {
  const listeners = new Set<(change: EventPayload<'config:externalChange'>) => void>()
  let subscription: HostSubscription | null = null
  /** The file the editor has open, as the window last said; told to every connection. */
  let watched: string | null = null

  const host = (): Promise<HostConnection> => link.connection()

  link.onConnected((connection) => {
    subscription?.unsubscribe()
    subscription = connection.subscribe('config:externalChange', {
      event: (change) => {
        for (const listener of listeners) listener(change)
      },
      error: (error) => log(`host: config:externalChange ended (${error.message})`)
    })
    if (watched === null) return
    const path = watched
    connection.request('config:watch', { path }).catch((error: Error) => {
      log(`host: could not watch ${path} again (${error.message})`)
    })
  })

  return {
    requests: {
      'config:scopes': async () => {
        const connection = await host()
        const [listed, folders] = await Promise.all([connection.request('config:scopes', null), scanned()])
        return configScopesWithScan(listed, folders)
      },
      'config:tree': async ({ scopePath }) => (await host()).request('config:tree', { scopePath }),
      'config:read': async ({ path }) => (await host()).request('config:read', { path }),
      'config:render': async ({ path, source }) => (await host()).request('config:render', { path, source }),
      'config:write': async (request) => writeConfigResultFromHost(await (await host()).request('config:write', request)),
      'config:snapshots': async ({ scopePath, path }) => (await host()).request('config:snapshots', { scopePath, path }),
      'config:snapshot': async ({ id }) => (await host()).request('config:snapshot', { id }),
      'config:restore': async ({ id, path }) =>
        writeConfigResultFromHost(await (await host()).request('config:restore', { id, path })),
      'config:watch': async ({ path }) => {
        // Recorded once there is a connection, which the first connect's own
        // re-send would otherwise tell twice.
        const connection = await host()
        watched = path
        await connection.request('config:watch', { path })
      },
      'config:create': async (request) => (await host()).request('config:create', request),
      'config:rename': async (request) => (await host()).request('config:rename', request),
      'config:delete': async (request) => (await host()).request('config:delete', request),
      'config:effective': async (request) => (await host()).request('config:effective', effectiveRequestForHost(request)),
      'config:mcpPreview': async (request) => (await host()).request('config:mcpPreview', request),
      'config:mcpAdd': async (request) => (await host()).request('config:mcpAdd', request),
      'config:mcpRemove': async (request) => (await host()).request('config:mcpRemove', request),
      'config:mcpApprove': async (request) =>
        writeConfigResultFromHost(await (await host()).request('config:mcpApprove', request)),
      'config:mcpList': async ({ cwd }) => (await host()).request('config:mcpList', { cwd }),
      'config:doctor': async () => (await host()).request('config:doctor', null)
    },
    events: {
      'config:externalChange': (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    }
  }
}
