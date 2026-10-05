import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const src = fileURLToPath(new URL('./src', import.meta.url))

/**
 * One HTML page per surface the manifest names, built into `dist/` with the
 * same folders: `src/panels/main.html` becomes `dist/panels/main.html`.
 *
 * `base: './'` keeps every asset URL relative, because Helm serves the folder
 * at `helm-plugin://<id>/` and a root-relative `/assets/...` would resolve
 * against nothing the plugin owns.
 */
export default defineConfig({
  root: src,
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        panel: `${src}/panels/main.html`,
        detail: `${src}/tabs/detail.html`
      }
    }
  }
})
