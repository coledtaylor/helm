import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { inlineScript } from './inline-script'

/**
 * `@helm/core` and `@helm/ui` are excluded from externalisation on purpose.
 *
 * Both export TypeScript source rather than a build output, so the bundler
 * compiles them in. That keeps one build step instead of three, gives the
 * renderer real HMR across package boundaries, and - the part that matters for
 * M7 - leaves `node_modules` in a packaged app holding only genuine third-party
 * dependencies, which is the shape Spike B verified. The native modules those
 * packages use (`better-sqlite3`) stay external and are listed in this
 * package's dependencies so electron-builder still sees them.
 *
 * `@coledtaylor/helm-plugin-sdk` is bundled for the same last reason: main validates
 * manifests with the SDK's own validator, so the two can never disagree, and
 * a workspace package is not something the packaged app should carry loose.
 */
const BUNDLED_WORKSPACE_PACKAGES = ['@helm/core', '@helm/ui', '@coledtaylor/helm-plugin-sdk']

export default defineConfig({
  main: {
    // `?script`: the plugin bridge, built into a string main serves to plugin pages.
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED_WORKSPACE_PACKAGES }), inlineScript()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED_WORKSPACE_PACKAGES })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: {
          // The app.
          index: resolve(__dirname, 'src/renderer/index.html'),
          // Spike B/C's harness page, kept as its own entry so the regression
          // checks drive a bare terminal with no app chrome around it.
          spike: resolve(__dirname, 'src/renderer/spike.html'),
          // The hidden page plugins' background pages run in (main/plugins/background.ts).
          'plugin-host': resolve(__dirname, 'src/renderer/plugin-host.html')
        }
      }
    }
  }
})
