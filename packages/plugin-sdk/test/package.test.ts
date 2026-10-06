import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SDK_DIR } from './fixtures'

/**
 * The SDK as npm publishes it, used the way an author meets it: packed, run
 * through `npm exec` from npm's cache (what `npx` does), then installed into
 * the plugin it made. A file left out of `files`, a path that only resolves
 * inside this repository, or an export that points nowhere passes every other
 * test here and fails only like this.
 *
 * npm gets a cache of its own under the temp folder and works offline, so the
 * test reads nothing from the registry and leaves nothing in the user's cache.
 */

const NAME = '@coledtaylor/helm-plugin-sdk'

/** npm's own script, beside the node running this. Spawning `npm.cmd` would need a shell. */
const NPM_CLI = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

let root: string
let tarball: string
let packed: string[]

function npm(args: string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [NPM_CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_config_cache: join(root, 'npm cache'),
      npm_config_offline: 'true',
      npm_config_update_notifier: 'false',
      npm_config_audit: 'false',
      npm_config_fund: 'false'
    }
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

beforeAll(() => {
  if (!existsSync(NPM_CLI)) throw new Error(`these tests run npm, and it is not beside node at ${NPM_CLI}`)
  root = mkdtempSync(join(tmpdir(), 'helm sdk package-'))
  const pack = npm(['pack', '--json', '--pack-destination', root], SDK_DIR)
  expect(pack.status, pack.stderr).toBe(0)
  const [report] = JSON.parse(pack.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>
  if (report === undefined) throw new Error('npm pack reported nothing')
  tarball = join(root, report.filename)
  packed = report.files.map((file) => file.path).sort()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe(`${NAME} as published`, () => {
  it('ships the runtime files, the template and the licence, and none of its own tests', () => {
    const sdk = JSON.parse(readFileSync(join(SDK_DIR, 'package.json'), 'utf8')) as { name: string; private?: boolean }
    expect(sdk.name).toBe(NAME)
    expect(sdk.private).toBeUndefined()

    expect(packed).toContain('LICENSE')
    expect(packed).toContain('README.md')
    expect(packed).toContain('bin/helm-plugin.mjs')
    expect(packed).toContain('helm-plugin.schema.json')
    expect(packed).toContain('template/helm-plugin.json')
    expect(packed).toContain('template/pages/panel.js')
    for (const file of ['folder', 'manifest', 'react', 'stores', 'vue']) {
      expect(packed).toContain(`src/${file}.js`)
      expect(packed).toContain(`src/${file}.d.ts`)
    }
    // Imported by the framework helpers, and no export of its own.
    expect(packed).toContain('src/bridge.js')
    expect(packed.filter((file) => file.startsWith('test/') || file === 'tsconfig.json')).toEqual([])
    // The repository's licence, not a copy that has drifted from it.
    expect(readFileSync(join(SDK_DIR, 'LICENSE'), 'utf8')).toBe(readFileSync(join(SDK_DIR, '..', '..', 'LICENSE'), 'utf8'))
  })

  it('creates a plugin through npm exec, which installs the SDK, then checks it with its own copy', () => {
    const created = npm(['exec', '--yes', `--package=${tarball}`, '--', 'helm-plugin', 'create', 'Issue Tracker'], root)
    expect(created.status, created.stderr).toBe(0)
    expect(created.stdout).toContain('Created "Issue tracker" (issue-tracker)')
    const folder = join(root, 'Issue Tracker')

    const manifest = JSON.parse(readFileSync(join(folder, 'helm-plugin.json'), 'utf8')) as { $schema: string }
    // Nothing yet: the schema is the plugin's own, from its node_modules.
    expect(existsSync(resolve(folder, manifest.$schema))).toBe(false)

    const installed = npm(['install', tarball], folder)
    expect(installed.status, installed.stderr).toBe(0)
    expect(existsSync(resolve(folder, manifest.$schema))).toBe(true)

    const validated = npm(['run', 'validate'], folder)
    expect(validated.status, validated.stderr).toBe(0)
    expect(validated.stdout).toContain('Issue tracker (issue-tracker): Helm would load it.')

    // Every export resolves from an installed copy, not just inside this repository.
    const exports = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        [
          `import { validateManifest } from '${NAME}/manifest'`,
          `import { checkPluginFolder } from '${NAME}/folder'`,
          `import schema from '${NAME}/helm-plugin.schema.json' with { type: 'json' }`,
          `import pkg from '${NAME}/package.json' with { type: 'json' }`,
          // No framework and no window.helm here: the stores import, and read nothing until subscribed.
          `import { secret, settings } from '${NAME}/stores'`,
          `console.log(typeof validateManifest, checkPluginFolder('.').ok, typeof schema.properties, pkg.name, typeof settings.subscribe, typeof secret)`
        ].join('\n')
      ],
      { cwd: folder, encoding: 'utf8' }
    )
    expect(exports.stderr).toBe('')
    expect(exports.stdout.trim()).toBe(`function true object ${NAME} function function`)
  })
})
