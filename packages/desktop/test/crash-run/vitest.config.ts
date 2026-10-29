import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * The vitest run `run-root.test.ts` starts to crash a worker in: the one
 * fixture beside it, with the run root every project of the suite has.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    include: ['crash.fixture.ts'],
    environment: 'node',
    pool: 'forks',
    globalSetup: [fileURLToPath(new URL('../../../../test/run-root.ts', import.meta.url))]
  }
})
