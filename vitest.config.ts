import { defineConfig } from 'vitest/config'

/**
 * The unit and integration tier (docs/TESTING.md), one project per runtime:
 *
 * - `core`: pure logic in Node.
 * - `ui`: React components and renderer modules in jsdom, through Testing
 *   Library.
 * - `desktop`: main-process services in Node, with Electron faked and real
 *   ptys running the fake `claude` (`packages/desktop/test`).
 */
export default defineConfig({
  test: {
    // Native modules and temp directories: a worker per file keeps a failing
    // test from leaving an open SQLite handle in a process another test reuses.
    pool: 'forks',
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: { name: 'core', include: ['packages/core/src/**/*.test.ts'], environment: 'node' }
      },
      {
        extends: true,
        test: {
          name: 'ui',
          include: ['packages/ui/src/**/*.test.{ts,tsx}', 'packages/desktop/src/renderer/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['packages/ui/src/test-setup.ts']
        }
      },
      {
        extends: true,
        test: { name: 'desktop', include: ['packages/desktop/src/main/**/*.test.ts'], environment: 'node' }
      }
    ]
  }
})
