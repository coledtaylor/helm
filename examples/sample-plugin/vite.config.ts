import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const src = fileURLToPath(new URL('./src', import.meta.url))

/**
 * One HTML page per surface the manifest names, built into `dist/` with the
 * same folders: `src/panels/main.html` becomes `dist/panels/main.html`. The
 * background is not a page: it is the ES module `dist/background/main.js`,
 * which the host runs in an isolate of its own.
 *
 * `base: './'` keeps every asset URL relative, because Helm serves the folder
 * at `floti-plugin://<id>/` and a root-relative `/assets/...` would resolve
 * against nothing the plugin owns. The same holds for the background module's
 * imports: the host lets a background import only its plugin's own files, by
 * a relative path, and the chunks it shares with the pages are imported as
 * `../assets/...`.
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
        item: `${src}/tabs/item.html`,
        background: `${src}/background/main.ts`
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background/main.js' : 'assets/[name]-[hash].js')
      }
    }
  }
})
