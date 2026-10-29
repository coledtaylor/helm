import { writeFileSync } from 'node:fs'
import { spawn } from 'node-pty'
import { inject, it, vi } from 'vitest'
import { PATIENCE } from '../../../../test/patience'
import { RUN_ROOT } from '../../../../test/run-root'
import { createWorld, fakeClaudeLogs } from '../world'

/** What the crashed run reports, for `run-root.test.ts` to check afterwards. */
export interface CrashReport {
  /** The run's root. */
  root: string
  /** The world the test made in it. */
  world: string
  /** The fake claude's pid. */
  fake: number
}

/**
 * Not a test of the suite: `run-root.test.ts` runs it in a vitest run of its
 * own (`vitest.config.ts` beside it). It makes a world, starts the fake
 * `claude` in a pty as a session does, writes what it made to the file
 * `HELM_CRASH_REPORT` names, and then kills its own worker, which skips every
 * teardown a test has.
 */
it('crashes its worker with a world and a fake agent running', async () => {
  const report = process.env['HELM_CRASH_REPORT']
  if (report === undefined) throw new Error('HELM_CRASH_REPORT names no file')
  const world = createWorld()
  spawn(world.claude, [], { cwd: world.projects.alpha, env: world.env, cols: 80, rows: 24 })
  let fake = 0
  await vi.waitFor(
    () => {
      const [log] = fakeClaudeLogs(world)
      if (log === undefined) throw new Error('the fake claude has written no run log yet')
      fake = log.pid
    },
    { timeout: PATIENCE }
  )
  const crash: CrashReport = { root: inject(RUN_ROOT), world: world.root, fake }
  writeFileSync(report, JSON.stringify(crash))
  process.kill(process.pid, 'SIGKILL')
})
