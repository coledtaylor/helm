import { resolve } from 'node:path'
import { projectConfigScope, type ConfigScope, type Project } from '@helm/core'
import type { ConfigConsoleService } from '../config-console'
import type { HostConnection, HostSubscription } from './client'
import type { HostLink } from './link'
import type * as P from './protocol'
import { effectiveRequestForHost, writeConfigResultFromHost } from './records'
import type { Emit } from './sessions'

/**
 * The config console when sessions run in the local host: the host reads the
 * agent's configuration, renders it, runs the agent's own CLI for MCP and the
 * doctor, and writes through its one writer, which snapshots the bytes it
 * replaces into `floti.db` first, aborts with a sentence when it cannot, and
 * refuses a write whose file changed since the editor read it. Helm's main
 * process reads and writes none of it.
 *
 * On every connect it subscribes to the host's `config:externalChange` and
 * hands each change to the window, and tells the host again which file the
 * editor has open: a watch belongs to a connection, so one made before a
 * reconnect is gone with it. The host sends a change only to the client
 * watching that file, and never for a change made through the host, so the
 * window's own save raises no warning.
 *
 * Every request goes through `link.connection()`, which joins the first
 * connect while it is in flight, so a window that asks before Helm has reached
 * the host gets the host's answer, never an empty one first. When the host
 * cannot be reached, each rejects with the link's sentence; none answers an
 * empty scope list, tree or version list in its place.
 */

/** What the sidebar shows of a scanned folder, which is what the switcher lists of it. */
export type ScannedFolder = Pick<Project, 'path' | 'kind' | 'name'>

export interface HostConfigDeps {
  link: HostLink
  /** Sends an event to the window. */
  emit: Emit
  /**
   * The harnesses and projects on Helm's sidebar, as last scanned, from
   * wherever discovery runs this run. The host's own scope list is the user's
   * and the saved profiles' folders; these are what it does not know.
   */
  scanned: () => readonly ScannedFolder[]
  log: (line: string) => void
}

export interface HostConfig extends ConfigConsoleService {
  shutdown(): void
}

const scopeKey = (path: string): string => resolve(path).toLowerCase()

/**
 * The switcher's list, in the order Helm has always given it: the user scope,
 * then the scanned harnesses, then the scanned projects, then every other
 * folder the host lists (a saved profile's root and overlays), each once by
 * its resolved path, ignoring case.
 */
export function mergeConfigScopes(host: readonly ConfigScope[], scanned: readonly ScannedFolder[]): ConfigScope[] {
  const out: ConfigScope[] = []
  const seen = new Set<string>()
  const add = (scope: ConfigScope): void => {
    const key = scopeKey(scope.path)
    if (seen.has(key)) return
    seen.add(key)
    out.push(scope)
  }
  for (const scope of host) if (scope.kind === 'user') add(scope)
  for (const folder of scanned) if (folder.kind === 'harness') add(projectConfigScope(folder.path, 'harness', folder.name))
  for (const folder of scanned) if (folder.kind !== 'harness') add(projectConfigScope(folder.path, 'project', folder.name))
  for (const scope of host) if (scope.kind !== 'user') add(scope)
  return out
}

export function createHostConfig({ link, emit, scanned, log }: HostConfigDeps): HostConfig {
  let subscription: HostSubscription | null = null
  /** The file the editor has open, as the window last said; told to every connection. */
  let watched: string | null = null

  const host = (): Promise<HostConnection> => link.connection()

  link.onConnected(async (connection) => {
    subscription?.unsubscribe()
    subscription = connection.subscribe('config:externalChange', {
      snapshot: () => undefined,
      event: (change: P.ConfigExternalChange) => emit('config:externalChange', change),
      error: (error) => log(`host: config:externalChange ended (${error.message})`)
    })
    if (watched === null) return
    try {
      await connection.request('config:watch', { path: watched })
    } catch (error) {
      log(`host: could not watch ${watched} again (${(error as Error).message})`)
    }
  })

  return {
    async scopes() {
      const listed = await (await host()).request('config:scopes', null)
      return mergeConfigScopes(listed, scanned())
    },

    async tree(scopePath) {
      return (await host()).request('config:tree', { scopePath })
    },

    async read(path) {
      return (await host()).request('config:read', { path })
    },

    async render(path, source) {
      return (await host()).request('config:render', { path, source })
    },

    async write(request) {
      return writeConfigResultFromHost(await (await host()).request('config:write', request))
    },

    async snapshots(scopePath, path) {
      return (await host()).request('config:snapshots', { scopePath, path })
    },

    async snapshot(id) {
      return (await host()).request('config:snapshot', { id })
    },

    async restore(id, path) {
      return writeConfigResultFromHost(await (await host()).request('config:restore', { id, path }))
    },

    async watch(path) {
      // Recorded once there is a connection, which the first connect's own
      // re-send would otherwise tell twice.
      const connection = await host()
      watched = path
      await connection.request('config:watch', { path })
    },

    async create(request) {
      return (await host()).request('config:create', request)
    },

    async rename(request) {
      return (await host()).request('config:rename', request)
    },

    async remove(request) {
      return (await host()).request('config:delete', request)
    },

    async effective(request) {
      return (await host()).request('config:effective', effectiveRequestForHost(request))
    },

    async mcpPreview(request) {
      return (await host()).request('config:mcpPreview', request)
    },

    async mcpAdd(request) {
      return (await host()).request('config:mcpAdd', request)
    },

    async mcpRemove(request) {
      return (await host()).request('config:mcpRemove', request)
    },

    async mcpApprove(request) {
      return writeConfigResultFromHost(await (await host()).request('config:mcpApprove', request))
    },

    async mcpList(cwd) {
      return (await host()).request('config:mcpList', { cwd })
    },

    async doctor() {
      return (await host()).request('config:doctor', null)
    },

    shutdown() {
      subscription?.unsubscribe()
      subscription = null
    }
  }
}
