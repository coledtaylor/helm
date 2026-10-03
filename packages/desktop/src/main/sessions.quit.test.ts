import { describe, expect, it, vi } from 'vitest'
import { readSessions } from '@helm/core'
import { hostInWorld } from '../../test/hosted'
import type * as Pty from './pty'
import type { SessionSpawnOptions } from './pty'

vi.mock('electron', async () => (await import('../../test/electron')).electronFake())

/**
 * Every exit the ptys report, and what the host's exit handler did with it.
 *
 * A pty reports its exit on a later turn of the event loop than the kill that
 * caused it, so at quit the report can arrive after `will-quit` has closed the
 * database. Wrapping the handler is the only way to see it run: a throw there
 * is otherwise an uncaught main-process exception, which in the app is
 * Electron's error dialog and a Helm that never exits.
 */
const exits = vi.hoisted(() => ({ handled: [] as string[], threw: [] as unknown[] }))

vi.mock('./pty', async (importOriginal) => {
  const real = await importOriginal<typeof Pty>()
  return {
    ...real,
    spawnSession: (opts: SessionSpawnOptions) =>
      real.spawnSession({
        ...opts,
        onExit: (exitCode, signal) => {
          try {
            opts.onExit(exitCode, signal)
          } catch (err) {
            exits.threw.push(err)
          } finally {
            exits.handled.push(opts.id)
          }
        }
      })
  }
})

describe('quitting right after a tab was closed', () => {
  it('lets the closed session’s exit arrive after the store has closed without touching it', async () => {
    const h = await hostInWorld()
    try {
      const { alpha } = h.world.projects
      const record = await h.host.start({ cwd: alpha, projectPath: alpha, name: 'alpha', cols: 80, rows: 24 })
      await h.ready(record.id)

      // The tab is closed, and before its pty has reported the exit, the app
      // quits: `before-quit` shuts the host down and `will-quit` lets go of
      // the database - all on this turn of the event loop.
      await expect(h.host.close({ id: record.id, force: true })).resolves.toEqual({ closed: true })
      h.host.shutdown()
      expect(readSessions(h.services.store).find((row) => row.id === record.id)?.status).toBe('exited')
      h.services.store.close()

      await vi.waitFor(() => expect(exits.handled).toContain(String(record.id)), { timeout: 10_000 })
      expect(exits.threw).toEqual([])
    } finally {
      await h.dispose()
    }
  })
})
