import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { readSessions } from '@helm/core'
import { hostInWorld, processAlive } from '../../test/hosted'

vi.mock('electron', async () => (await import('../../test/electron')).electronFake())

/**
 * The host's synchronous teardown, which `before-quit` runs: every process a
 * session started goes with it, every row is completed before the processes
 * go, and the next start finds the rows as this one left them.
 */
describe('session host shutdown', () => {
  it('ends every session’s whole process tree, completes every row, and a restart finds them as they were', async () => {
    const h = await hostInWorld()
    try {
      const { alpha: alphaDir, beta: betaDir } = h.world.projects
      const branchOf = (cwd: string): string =>
        execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
      const branches = { alpha: branchOf(alphaDir), beta: branchOf(betaDir) }
      expect(branches).toEqual({ alpha: 'main', beta: 'feature/beta' })

      const [alpha, beta] = await Promise.all([
        h.host.start({ cwd: alphaDir, projectPath: alphaDir, name: 'alpha', cols: 80, rows: 24 }),
        h.host.start({ cwd: betaDir, projectPath: betaDir, name: 'beta', cols: 80, rows: 24 })
      ])
      await Promise.all([h.ready(alpha.id), h.ready(beta.id)])
      h.host.rename({ id: beta.id, label: 'beta review' })

      // A process the session started, beneath the CLI beneath the pty.
      h.host.input(alpha.id, '/child\r')
      let child = 0
      await vi.waitFor(
        () => {
          child = Number(/child (\d+)/.exec(h.output.get(alpha.id) ?? '')?.[1] ?? 0)
          expect(child).toBeGreaterThan(0)
        },
        { timeout: 10_000 }
      )
      const runs = await Promise.all([h.run(alpha), h.run(beta)])
      const ptys = [h.host.pid(alpha.id), h.host.pid(beta.id)].filter((pid) => pid !== null)
      const tree = [...ptys, ...runs.map((run) => run.pid), child]
      expect(tree).toHaveLength(5)
      expect(new Set(tree).size).toBe(5)
      expect(tree.filter(processAlive)).toEqual(tree)

      h.host.shutdown()

      // The rows are completed by the time shutdown returns, before any exit
      // has had a turn on the event loop.
      for (const row of readSessions(h.services.store)) {
        expect(row.status).toBe('exited')
        expect(row.durationMs).not.toBeNull()
      }
      expect(h.host.list()).toEqual([])
      await vi.waitFor(() => expect(tree.filter(processAlive)).toEqual([]), { timeout: 10_000 })

      // The next start: nothing was left claiming to run, and each row is as it was.
      h.services.store.close()
      const { createServices } = await import('./services')
      const next = createServices()
      try {
        expect(next.lostSessions).toBe(0)
        const rows = readSessions(next.store)
        expect(rows).toHaveLength(2)
        expect(rows.find((row) => row.id === beta.id)).toMatchObject({
          name: 'beta',
          label: 'beta review',
          branch: branches.beta,
          status: 'exited'
        })
        expect(rows.find((row) => row.id === alpha.id)).toMatchObject({
          name: 'alpha',
          label: null,
          branch: branches.alpha,
          status: 'exited'
        })
      } finally {
        next.store.close()
      }
    } finally {
      await h.dispose()
    }
  })
})
