import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
 */
const BUNDLED_WORKSPACE_PACKAGES = ['@helm/core', '@helm/ui']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: BUNDLED_WORKSPACE_PACKAGES })],
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
          spike: resolve(__dirname, 'src/renderer/spike.html')
        }
      }
    }
  }
})
