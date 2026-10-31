import type { HostConnection, HostSubscription } from '../../../../shared/host/client'
import { filesStatusFromHost, writeConfigResultFromHost } from '../../../../shared/host/records'
import { windowArtifactUrl } from '../../../../shared/host/records/content'
import type { EventPayload } from '../../../../shared/ipc'
import type { HostReach } from './history'
import type { HostAdapter } from './router'

/**
 * The Files view and the note viewer while sessions run in the local host:
 * the host lists, reads, searches, renders and watches its own machine's
 * folders, and writes the one thing the view writes, a note, through the
 * config console's writer, which snapshots the bytes it replaces first, aborts
 * with a sentence when it cannot, and refuses a note changed since it was
 * read. Every request names a root, and the host refuses one it does not know
 * with a sentence naming it. The window asks it over its own connection, in
 * ipc.ts's shapes.
 *
 * `files:watch` replaces the window's whole set of watched roots each time,
 * and a watch belongs to a connection, so the last set the window said is told
 * to every new connection; `files:changed` is subscribed on every connect.
 * A folder the host could not look at stays `null`, never `[]`.
 *
 * An HTML artifact keeps the window's `helm-content:` scheme: the host's
 * address is handed to the window as `helm-content://artifact/...`, and main
 * answers a frame's request for one from the host's bytes on its own
 * connection. Opening a file in the editor and revealing it stay the window's
 * own (`files:editor`, `files:openInEditor`, `shell:showItem`).
 */

export function createFilesAdapter(link: HostReach, log: (line: string) => void = () => undefined): HostAdapter {
  const listeners = new Set<(change: EventPayload<'files:changed'>) => void>()
  let subscription: HostSubscription | null = null
  /** The roots the window has on screen, as it last said; told to every connection. */
  let watched: readonly string[] | null = null

  const host = (): Promise<HostConnection> => link.connection()

  link.onConnected((connection) => {
    subscription?.unsubscribe()
    subscription = connection.subscribe('files:changed', {
      event: (change) => {
        for (const listener of listeners) listener({ root: change.root, paths: change.paths })
      },
      error: (error) => log(`host: files:changed ended (${error.message})`)
    })
    if (watched === null || watched.length === 0) return
    connection.request('files:watch', { roots: [...watched] }).catch((error: Error) => {
      log(`host: could not watch the Files view's folders again (${error.message})`)
    })
  })

  return {
    requests: {
      'content:scopes': async () => (await host()).request('content:scopes', null),
      'content:document': async ({ scopePath, path }) => (await host()).request('content:document', { scopePath, path }),
      'content:render': async ({ scopePath, path, source }) =>
        (await host()).request('content:render', { scopePath, path, source }),
      'content:search': async ({ scopePath, query }) => (await host()).request('content:search', { scopePath, query }),
      'content:write': async (request) => writeConfigResultFromHost(await (await host()).request('content:write', request)),
      'content:snapshots': async ({ scopePath, path }) =>
        (await host()).request('content:snapshots', { scopePath, path }),
      'content:restore': async ({ id, path }) =>
        writeConfigResultFromHost(await (await host()).request('content:restore', { id, path })),
      'content:artifact': async ({ scopePath, path }) => {
        const artifact = await (await host()).request('content:artifact', { scopePath, path })
        return { url: windowArtifactUrl(artifact.url), token: artifact.token }
      },
      'content:wikilink': async ({ scopePath, target, from }) => ({
        path: (await (await host()).request('content:wikilink', { scopePath, target, from })).path
      }),
      'editor:highlight': async ({ path, source }) => (await host()).request('editor:highlight', { path, source }),
      'files:dir': async ({ root, relPath }) => (await host()).request('files:dir', { root, relPath }),
      'files:status': async ({ root }) => filesStatusFromHost(await (await host()).request('files:status', { root })),
      'files:read': async ({ root, path }) => (await host()).request('files:read', { root, path }),
      'files:list': async ({ root }) => (await host()).request('files:list', { root }),
      'files:watch': async ({ roots }) => {
        // Recorded once there is a connection, which the first connect's own
        // re-send would otherwise tell twice.
        const connection = await host()
        watched = [...roots]
        await connection.request('files:watch', { roots: [...roots] })
      }
    },
    events: {
      'files:changed': (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    }
  }
}
