import { hostArtifactUrl, windowArtifactUrl } from '../../shared/host/records/content'
import type { FilesReads } from '../files-reads'
import type { HostConnection, HostSubscription } from './client'
import type { HostLink } from './link'
import { filesStatusFromHost, writeConfigResultFromHost } from './records'
import type { Emit } from './sessions'

/**
 * The Files view and the note viewer when sessions run in the local host: the
 * host lists, reads, searches, renders and watches its own machine's folders,
 * and writes the one thing the view writes, a note, through the config
 * console's writer, which snapshots the bytes it replaces first, aborts with
 * a sentence when it cannot, and refuses a note changed since it was read.
 * Every request names a root, and the host refuses one it does not know with
 * a sentence naming it; it also scopes a note to the deepest folder it knows
 * that holds it. Helm checks neither again: both are the host's.
 *
 * `files:watch` replaces this client's whole set of watched roots each time,
 * and a watch belongs to a connection, so the last set the window said is told
 * to every new connection; `files:changed` is subscribed on every connect and
 * handed to the window.
 *
 * An HTML artifact keeps the window's `helm-content:` scheme: the host's
 * `floti-artifact://<token>/<name>` is handed to the window as
 * `helm-content://artifact/<token>/<name>`, and a frame's request for one is
 * answered from `content:artifactBytes`, a piece at a time until the body is
 * whole (`artifactBytes`).
 *
 * Every request goes through `link.connection()`, which joins the first
 * connect while it is in flight, so a window that asks before Helm has reached
 * the host gets the host's answer, never an empty one first. When the host
 * cannot be reached, each rejects with the link's sentence; none answers an
 * empty folder, file list or version list in its place.
 */

export { hostArtifactUrl, windowArtifactUrl }

/** What a frame's request for an artifact address is answered with. */
export interface ArtifactAnswer {
  status: number
  headers: Array<[string, string]>
  body: Uint8Array
}

export interface HostFilesDeps {
  link: HostLink
  emit: Emit
  log: (line: string) => void
}

export interface HostFiles extends FilesReads {
  /** A frame's request for `helm-content://artifact/...`, answered from the host's bytes. */
  artifactBytes(url: string): Promise<ArtifactAnswer>
  shutdown(): void
}

export function createHostFiles({ link, emit, log }: HostFilesDeps): HostFiles {
  let subscription: HostSubscription | null = null
  /** The roots the window has on screen, as it last said; told to every connection. */
  let watched: readonly string[] | null = null

  const host = (): Promise<HostConnection> => link.connection()

  link.onConnected(async (connection) => {
    subscription?.unsubscribe()
    subscription = connection.subscribe('files:changed', {
      event: (change) => emit('files:changed', { root: change.root, paths: change.paths }),
      error: (error) => log(`host: files:changed ended (${error.message})`)
    })
    if (watched === null || watched.length === 0) return
    try {
      await connection.request('files:watch', { roots: [...watched] })
    } catch (error) {
      log(`host: could not watch the Files view's folders again (${(error as Error).message})`)
    }
  })

  return {
    async scopes() {
      return (await host()).request('content:scopes', null)
    },

    async document(scopePath, path) {
      return (await host()).request('content:document', { scopePath, path })
    },

    async render(scopePath, path, source) {
      return (await host()).request('content:render', { scopePath, path, source })
    },

    async search(scopePath, query) {
      return (await host()).request('content:search', { scopePath, query })
    },

    async write(request) {
      return writeConfigResultFromHost(await (await host()).request('content:write', request))
    },

    async snapshots(scopePath, path) {
      return (await host()).request('content:snapshots', { scopePath, path })
    },

    async restore(id, path) {
      return writeConfigResultFromHost(await (await host()).request('content:restore', { id, path }))
    },

    async artifact(scopePath, path) {
      const link = await (await host()).request('content:artifact', { scopePath, path })
      return { url: windowArtifactUrl(link.url), token: link.token }
    },

    async wikilink(scopePath, target, from) {
      return (await (await host()).request('content:wikilink', { scopePath, target, from })).path
    },

    async highlight(path, source) {
      return (await host()).request('editor:highlight', { path, source })
    },

    async dir(root, relPath) {
      return (await host()).request('files:dir', { root, relPath })
    },

    async status(root) {
      return filesStatusFromHost(await (await host()).request('files:status', { root }))
    },

    async read(root, path) {
      return (await host()).request('files:read', { root, path })
    },

    async list(root) {
      return (await host()).request('files:list', { root })
    },

    async watch(roots) {
      // Recorded once there is a connection, which the first connect's own
      // re-send would otherwise tell twice.
      const connection = await host()
      watched = [...roots]
      await connection.request('files:watch', { roots: [...roots] })
    },

    async artifactBytes(url) {
      const address = hostArtifactUrl(url)
      if (address === null) return { status: 400, headers: [], body: new TextEncoder().encode('Bad request') }
      const connection = await host()
      const first = await connection.request('content:artifactBytes', { url: address, offset: 0 })
      const headers = first.headers.map(({ name, value }): [string, string] => [name, value])
      // A refusal is its whole text whatever the offset; only a 200 comes in pieces.
      if (first.status !== 200) return { status: first.status, headers, body: first.body }
      const pieces: Uint8Array[] = [first.body]
      let received = first.body.length
      while (received < first.totalBytes) {
        const next = await connection.request('content:artifactBytes', { url: address, offset: received })
        if (next.status !== 200)
          return { status: next.status, headers: next.headers.map(({ name, value }) => [name, value]), body: next.body }
        // A file that shrank under the read ends the body where it ends.
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
      return { status: 200, headers, body }
    },

    shutdown() {
      subscription?.unsubscribe()
      subscription = null
    }
  }
}
