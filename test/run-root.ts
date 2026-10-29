import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'

/** The key a test reads its run's root from, through `inject`. */
export const RUN_ROOT = 'testRunRoot'

/**
 * What a run's root is named: the leftover check (`scripts/test-leftovers.mjs`)
 * lists a folder with this prefix that a run left behind.
 */
export const RUN_ROOT_PREFIX = 'helm-test-run-'

/** The variables `os.tmpdir()` reads: `TMPDIR` on macOS and Linux, `TEMP` and `TMP` on Windows. */
const TEMP_VARS = ['TMPDIR', 'TEMP', 'TMP'] as const

declare module 'vitest' {
  export interface ProvidedContext {
    [RUN_ROOT]: string
  }
}

interface RunRoot {
  root: string
  /** The holds on it not yet released: one per vitest project. */
  users: number
  /** What each temp variable held before the run, restored when it ends. */
  before: Record<(typeof TEMP_VARS)[number], string | undefined>
}

/**
 * Every vitest project runs the setup (the root config's, which each project
 * extends), and Vitest loads it once per project, so the run's one root is
 * kept on the process rather than in this module.
 */
const SHARED = Symbol.for('helm.testRunRoot')
type WithRunRoot = typeof globalThis & { [SHARED]?: RunRoot }

/** A hold on the run's root: `release` it once, when the run ends. */
export interface RunRootHold {
  root: string
  release: () => Promise<void>
}

/**
 * The run's root: one folder per run in the OS temp folder, which every temp
 * folder the run's tests make lands in, removed once the last hold on it is
 * released, when the run ends.
 *
 * The first hold points `TMPDIR`, `TEMP` and `TMP` at the root. It is taken in
 * the test runner's main process before any worker starts, and the workers
 * are started with that process's environment, so every `tmpdir()` in a test,
 * in the code under test and in any process either starts is under the root
 * by construction. The release runs in that main process too, which outlives
 * its workers: a worker that crashes or is killed skips its own `afterEach`
 * and `afterAll`, and the root still goes when the run ends.
 *
 * The root keeps the path the OS temp folder gives, not its real path: on
 * macOS that is under `/var`, a link to `/private/var`, and on a GitHub
 * Windows runner an 8.3 alias, as a user's own temp folder is. Tests that
 * need a real path resolve it themselves, as `createWorld` does.
 *
 * One root per run, so a run that finishes never removes a folder from under
 * another running at the same time.
 */
export async function holdRunRoot(): Promise<RunRootHold> {
  const shared = globalThis as WithRunRoot
  let run = shared[SHARED]
  if (run === undefined) {
    const root = await mkdtemp(join(tmpdir(), RUN_ROOT_PREFIX))
    run = { root, users: 0, before: { TMPDIR: undefined, TEMP: undefined, TMP: undefined } }
    for (const name of TEMP_VARS) {
      run.before[name] = process.env[name]
      process.env[name] = root
    }
    shared[SHARED] = run
  }
  run.users += 1
  const held = run
  let released = false
  return {
    root: held.root,
    release: async () => {
      if (released) return
      released = true
      held.users -= 1
      if (held.users > 0) return
      delete shared[SHARED]
      for (const name of TEMP_VARS) {
        const value = held.before[name]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      // A process a crashed worker left can hold a file in the root open for
      // the moment it takes to notice its owner is gone (a fake agent polls
      // for that), and Windows refuses to remove an open file, so the removal
      // is tried again for longer than that.
      await rm(held.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  }
}

/**
 * The global setup of every vitest project: a hold on the run's root, handed
 * to the project's tests as `inject(RUN_ROOT)` and released by its teardown.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const { root, release } = await holdRunRoot()
  project.provide(RUN_ROOT, root)
  return release
}
