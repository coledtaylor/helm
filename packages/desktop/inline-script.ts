import { resolve } from 'node:path'
import { build } from 'esbuild'
import type { Plugin } from 'vite'

/**
 * `import source from './file.ts?script'`: the file bundled into one classic
 * script, as a string.
 *
 * For code Helm serves to a page rather than runs itself - the plugin bridge,
 * which every plugin page loads from Helm under `/__helm/bridge.js`. It is
 * TypeScript checked against the SDK's types like the rest of the app, and it
 * has to arrive as one self-contained IIFE: a classic script in the page's
 * `<head>`, so `window.helm` is there before the plugin's own modules run.
 * Building it here, inside the main bundle, keeps that to one build step.
 */
export function inlineScript(): Plugin {
  const SUFFIX = '?script'
  return {
    name: 'helm-inline-script',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.endsWith(SUFFIX)) return null
      const resolved = await this.resolve(source.slice(0, -SUFFIX.length), importer, { skipSelf: true })
      return resolved === null ? null : `${resolved.id}${SUFFIX}`
    },
    async load(id) {
      if (!id.endsWith(SUFFIX)) return null
      const result = await build({
        entryPoints: [id.slice(0, -SUFFIX.length)],
        bundle: true,
        format: 'iife',
        platform: 'browser',
        target: 'chrome130',
        write: false,
        metafile: true,
        legalComments: 'none',
        charset: 'utf8'
      })
      for (const input of Object.keys(result.metafile.inputs)) this.addWatchFile(resolve(input))
      const [output] = result.outputFiles
      if (output === undefined) throw new Error(`${id}: esbuild produced nothing`)
      return `export default ${JSON.stringify(output.text)}`
    }
  }
}
