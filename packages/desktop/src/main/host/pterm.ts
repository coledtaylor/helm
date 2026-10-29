import type { PtermHost } from '../pterm'
import type { HostSubscription } from './client'
import type { HostLink } from './link'
import type { Emit } from './sessions'
import type { TerminalStreams } from './streams'

/**
 * Plain terminals when sessions run in the local host: each shell runs on the
 * host, and its terminal is carried on a stream like a session's, so a window
 * that reloads draws the shell's current screen and then streams.
 *
 * One shell per project path, as Helm's own: reopening a project's terminal
 * is the shell it already had. A terminal tab asks for one of its own.
 */

export interface HostPtermDeps {
  link: HostLink
  streams: TerminalStreams
  emit: Emit
  log: (line: string) => void
}

interface ShellRecord {
  id: number
  path: string
  shell: string
  grid: { cols: number; rows: number }
  opened: { cols: number; rows: number }
  separate: boolean
}

export function createHostPtermHost(deps: HostPtermDeps): PtermHost & { shutdown: () => void } {
  const { link, streams } = deps
  const byId = new Map<number, ShellRecord>()
  let subscription: HostSubscription | null = null

  const byPath = (path: string): ShellRecord | undefined =>
    [...byId.values()].find((record) => !record.separate && record.path.toLowerCase() === path.toLowerCase())

  const drop = (id: number): void => {
    byId.delete(id)
    streams.close('pterm:data', id)
  }

  link.onConnected((connection) => {
    subscription?.unsubscribe()
    subscription = connection.subscribe('pterm:exit', {
      event: ({ id, exitCode }) => {
        if (!byId.has(id)) return
        drop(id)
        deps.emit('pterm:exit', { id, exitCode })
      },
      error: (error) => deps.log(`host: pterm:exit ended (${error.message})`)
    })
  })

  const failed = (channel: string) => (error: unknown) =>
    deps.log(`host: ${channel} was not taken (${(error as Error).message})`)

  return {
    async open(request) {
      const separate = request.separate === true
      const existing = separate ? undefined : byPath(request.path)
      if (existing !== undefined) return { id: existing.id, shell: existing.shell, requested: null, problem: null }

      const connection = await link.connection()
      const opened = await connection.request('pterm:open', {
        path: request.path,
        cols: request.cols,
        rows: request.rows,
        shell: request.shell ?? null,
        separate
      })
      const grid = { cols: request.cols, rows: request.rows }
      byId.set(opened.id, { id: opened.id, path: request.path, shell: opened.shell, grid, opened: grid, separate })
      streams.open('pterm:data', opened.id)
      return opened
    },

    input(id, data) {
      streams.write('pterm:data', id, data)
    },

    resize(id, cols, rows) {
      const record = byId.get(id)
      if (record === undefined) return
      record.grid = { cols, rows }
      link.current()?.request('pterm:resize', { id, cols, rows }).catch(failed('pterm:resize'))
    },

    close(id) {
      if (!byId.has(id)) return
      drop(id)
      link.current()?.request('pterm:close', { id }).catch(failed('pterm:close'))
    },

    grid: (id) => {
      const record = byId.get(id)
      return record === undefined ? null : { ...record.grid }
    },

    list: () =>
      [...byId.values()].map((record) => ({
        id: record.id,
        path: record.path,
        shell: record.shell,
        grid: { ...record.grid },
        opened: { ...record.opened }
      })),

    async detected() {
      const connection = await link.connection()
      return connection.request('pterm:shells', null)
    },

    shutdown() {
      subscription?.unsubscribe()
      subscription = null
      for (const id of [...byId.keys()]) drop(id)
    }
  }
}
