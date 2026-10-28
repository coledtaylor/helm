import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestProject } from 'vitest/node'

/** The key `electronFake` reads its app folder from, through `inject`. */
export const ELECTRON_FAKE_ROOT = 'electronFakeRoot'

declare module 'vitest' {
  export interface ProvidedContext {
    [ELECTRON_FAKE_ROOT]: string
  }
}

/**
 * The `desktop` project's global setup: the folder the faked Electron app's
 * paths (`app.getPath`) live in, made once per run and removed when the run
 * ends, whether its tests passed or failed. One folder per run, so a run
 * finishing never removes it from under another run going at the same time.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const root = await mkdtemp(join(tmpdir(), 'helm-electron-fake-'))
  project.provide(ELECTRON_FAKE_ROOT, root)
  return async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
