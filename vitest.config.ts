import { svelte } from '@sveltejs/vite-plugin-svelte'
import { configDefaults, defineConfig } from 'vitest/config'

const SDK_SVELTE = 'packages/plugin-sdk/test/svelte.test.ts'

/**
 * The unit and integration tier (docs/TESTING.md), one project per runtime:
 *
 * - `core`: pure logic in Node.
 * - `ui`: React components and renderer modules in jsdom, through Testing
 *   Library.
 * - `desktop`: main-process services in Node, with Electron faked and real
 *   ptys running the fake `claude` (`packages/desktop/test`).
 * - `sdk`: the plugin SDK - its manifest validator, its schema, its
 *   `helm-plugin` command and the package as npm publishes it - in Node, and
 *   its React and Vue helpers in jsdom, each test file naming that
 *   environment.
 * - `sdk-svelte`: a Svelte component the compiler built, mounted in jsdom to
 *   show the SDK's stores need no adapter there. Svelte's `mount` is in its
 *   browser build only, so this project resolves the `browser` condition and
 *   the Node tests above do not.
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
      // A fixed floor, and a run below it fails. It is not raised
      // automatically: a ratchet that rose with every run made each untested
      // line of wiring a failed gate, which is a cost the owner chose not to pay.
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 68,
        statements: 70
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
      },
      {
        extends: true,
        test: {
          name: 'sdk',
          include: ['packages/plugin-sdk/test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, SDK_SVELTE],
          environment: 'node'
        }
      },
      {
        extends: true,
        plugins: [svelte()],
        resolve: { conditions: ['browser'] },
        test: { name: 'sdk-svelte', include: [SDK_SVELTE], environment: 'jsdom' }
      }
    ]
  }
})
