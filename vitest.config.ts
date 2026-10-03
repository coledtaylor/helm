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
    // `pnpm test` runs with --coverage; a targeted `vitest run <file>` does
    // not, so a narrow run never trips the thresholds.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        // Test helpers that live beside the code they fake.
        '**/*.testkit.{ts,tsx}',
        'packages/ui/src/test-setup.ts',
        'packages/core/src/store/migrations.generated.ts',
        // The diagnostic drivers and the spike page they drive are tools, not
        // app code (docs/TESTING.md).
        'packages/desktop/src/main/{fidelity,claudecheck,packagingcheck,selftest,checkkit}.ts',
        'packages/desktop/src/renderer/src/{spike,probe,latency}.ts'
      ],
      reporter: ['text-summary', 'html'],
      reportsDirectory: 'reports/coverage',
      // The floor only goes up: a run that beats it raises it in this file,
      // rounded down to a whole percent, and a run below it fails.
      thresholds: {
        autoUpdate: (value: number) => Math.floor(value),
        lines: 78,
        functions: 70,
        branches: 67,
        statements: 75
      }
    },
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
