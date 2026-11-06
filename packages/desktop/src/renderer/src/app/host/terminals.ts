import { HostRefusedError, type HostConnection, type HostSubscription } from '../../../../shared/host/client'
import type { TerminalStreams } from '../../../../shared/host/streams'
import type { LocalEvents } from './events'
import type { HostReach } from './history'
import type { HostAdapter } from './router'

/**
 * Plain terminals: each shell runs on the
 * host and its terminal is carried on a stream over the window's own
 * connection, so a page that has just loaded draws the shell's screen as it is
 * and then streams.
 *
 * A folder's own shell is the host's to find again: it reattaches every open
 * of that folder to the one shell. A terminal tab has a shell of its own, which
 * outlives a reload of the page; the shells this window's tabs had are kept in
 * its session storage, which a reload keeps, and given back to the first asks
 * for their folder, one each, before any new shell is opened.
 */

/** Where the window keeps its terminal tabs' shells across a reload: its session storage. */
export interface ShellShelf {
  read(): string | null
  write(text: string): void
}

export interface TerminalsAdapterDeps {
  link: HostReach
  /** The connection now, or null between connections. */
  current: () => HostConnection | null
  streams: TerminalStreams
  events: LocalEvents
  shelf: ShellShelf | null
  log: (line: string) => void
}

interface Shell {
  id: number
  path: string
  shell: string
}

const SHELF_KEY_VERSION = 1

function readShelf(shelf: ShellShelf | null): Shell[] {
  const text = shelf?.read() ?? null
  if (text === null) return []
  try {
    const parsed = JSON.parse(text) as { version?: unknown; shells?: unknown }
    if (parsed.version !== SHELF_KEY_VERSION || !Array.isArray(parsed.shells)) return []
    return parsed.shells.filter(
      (shell): shell is Shell =>
        typeof shell === 'object' &&
        shell !== null &&
        typeof (shell as Shell).id === 'number' &&
        typeof (shell as Shell).path === 'string' &&
        typeof (shell as Shell).shell === 'string'
    )
  } catch {
    return []
  }
}

const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** The terminals adapter, and the word on a shell's stream the host closed. */
export type TerminalsAdapter = HostAdapter & {
  streamClosed(id: number, reason: string | null, connectionEnded: boolean): void
}

export function createTerminalsAdapter(deps: TerminalsAdapterDeps): TerminalsAdapter {
  const { link, streams } = deps
  /** The shells this page shows, by id; `separate` ones are terminal tabs'. */
  const open = new Map<number, Shell & { separate: boolean }>()
  /** Terminal tabs' shells the last page had and this one has not asked for yet. */
  let waiting = readShelf(deps.shelf)
  let subscription: HostSubscription | null = null
  /** Shells asked for while the host refused the window, each waiting for the next connection. */
  let refusedWaiters: Array<(connection: HostConnection) => void> = []

  /**
   * The connection to open a shell on. While the host refuses this window's
   * protocol (a protocol-1.x host before Restart host to update replaces it),
   * a tab's shell waits for the host that connects next rather than failing:
   * the tab mounted once, and its shell is opened, or the folder's shell the
   * keeper kept running is reattached, when the carried host connects.
   */
  const reached = (): Promise<HostConnection> =>
    link.connection().catch((error: unknown) => {
      if (!(error instanceof HostRefusedError)) throw error
      return new Promise<HostConnection>((resolve) => {
        refusedWaiters.push(resolve)
      })
    })

  const keep = (): void => {
    if (deps.shelf === null) return
    const separate = [...open.values()].filter((shell) => shell.separate)
    const shells = [...separate, ...waiting].map(({ id, path, shell }) => ({ id, path, shell }))
    deps.shelf.write(JSON.stringify({ version: SHELF_KEY_VERSION, shells }))
  }

  const drop = (id: number): void => {
    open.delete(id)
    streams.close('pterm:data', id)
  }

  link.onConnected((connection) => {
    subscription?.unsubscribe()
    // Each shell is carried afresh on this connection, drawn from the host's redraw.
    for (const id of open.keys()) {
      streams.close('pterm:data', id)
      streams.open('pterm:data', id)
    }
    subscription = connection.subscribe('pterm:exit', {
      event: ({ id, exitCode }) => {
        if (waiting.some((shell) => shell.id === id)) {
          waiting = waiting.filter((shell) => shell.id !== id)
          keep()
        }
        if (!open.has(id)) return
        const separate = open.get(id)?.separate === true
        drop(id)
        if (separate) keep()
        deps.events.tell('pterm:exit', { id, exitCode })
      },
      error: (error) => deps.log(`host: pterm:exit ended (${error.message})`)
    })
    const waiters = refusedWaiters
    refusedWaiters = []
    for (const resolve of waiters) resolve(connection)
  })

  // A host that went without a stop or a quit leaves its shells running in its
  // session keeper: each keeps its screen, takes no input while there is no
  // stream, and is carried again from the next host's redraw once the window
  // reconnects (above). One the next host does not have is lost (`streamClosed`).

  /**
   * The host closed a shell's stream. With a reason, it would not carry it: the
   * shell is not there (it went with its keeper), so the window is told it is
   * lost. An ordinary end is `pterm:exit`'s, and a close with the connection
   * waits for the next one.
   */
  const streamClosed = (id: number, reason: string | null, connectionEnded: boolean): void => {
    if (connectionEnded || reason === null || !open.has(id)) return
    const separate = open.get(id)?.separate === true
    drop(id)
    if (separate) keep()
    deps.events.tell('pterm:exit', { id, exitCode: null, lost: true })
  }

  const failed = (channel: string) => (error: unknown) =>
    deps.log(`host: ${channel} was not taken (${(error as Error).message})`)

  return {
    streamClosed,
    requests: {
      'pterm:open': async (request) => {
        const separate = request.separate === true
        // Every shell's stream is opened on the window's connection, so that is
        // reached before a kept shell is taken: two asks then take two shells.
        const connection = await reached()
        const kept = separate ? waiting.find((shell) => samePath(shell.path, request.path)) : undefined
        if (kept !== undefined) {
          waiting = waiting.filter((shell) => shell !== kept)
          open.set(kept.id, { ...kept, separate })
          keep()
          streams.open('pterm:data', kept.id)
          return { id: kept.id, shell: kept.shell, requested: null, problem: null }
        }
        const opened = await connection.request('pterm:open', {
          path: request.path,
          cols: request.cols,
          rows: request.rows,
          shell: request.shell ?? null,
          separate
        })
        open.set(opened.id, { id: opened.id, path: request.path, shell: opened.shell, separate })
        if (separate) keep()
        streams.open('pterm:data', opened.id)
        return opened
      },
      'pterm:close': async ({ id }) => {
        const shell = open.get(id)
        if (shell === undefined) return
        drop(id)
        if (shell.separate) keep()
        await deps
          .current()
          ?.request('pterm:close', { id })
          .catch(failed('pterm:close'))
      },
      'pterm:shells': async () => (await link.connection()).request('pterm:shells', null),
      'pterm:checkShell': async ({ path }) => (await link.connection()).request('pterm:checkShell', { path })
    },
    sends: {
      'pterm:input': ({ id, data }) => streams.write('pterm:data', id, data),
      'pterm:resize': ({ id, cols, rows }) => {
        if (!open.has(id)) return
        deps
          .current()
          ?.request('pterm:resize', { id, cols, rows })
          .catch(failed('pterm:resize'))
      }
    },
    events: {
      'pterm:data': deps.events.listen('pterm:data'),
      'pterm:exit': deps.events.listen('pterm:exit')
    }
  }
}
