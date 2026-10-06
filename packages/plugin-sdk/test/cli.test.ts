import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkPluginFolder } from '../src/folder.js'
import { SDK_DIR } from './fixtures'

/**
 * `helm-plugin`, run as an author runs it: a separate Node process, in a
 * folder with a space in its path, reading and writing real files.
 */

const BIN = join(SDK_DIR, 'bin', 'helm-plugin.mjs')
const SDK = JSON.parse(readFileSync(join(SDK_DIR, 'package.json'), 'utf8')) as { name: string; version: string }

interface Run {
  status: number | null
  stdout: string
  stderr: string
}

function run(args: string[], cwd: string): Run {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm sdk-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('helm-plugin create', () => {
  it('writes a plugin Helm would load, named after its folder, and validate agrees', () => {
    const created = run(['create', 'Issue Tracker'], root)
    expect(created.stderr).toBe('')
    expect(created.status).toBe(0)
    const folder = join(root, 'Issue Tracker')
    expect(created.stdout).toContain(`Created "Issue tracker" (issue-tracker) in ${folder}`)
    expect(created.stdout).toContain('Settings > Plugins > Add folder')

    const manifest = JSON.parse(readFileSync(join(folder, 'helm-plugin.json'), 'utf8')) as Record<string, unknown>
    expect(manifest['id']).toBe('issue-tracker')
    expect(manifest['name']).toBe('Issue tracker')
    expect(manifest['rail']).toEqual({ title: 'Issue tracker', panel: 'main' })
    // The schema the plugin installs, never this copy's path: run through npx,
    // that is a cache folder.
    expect(manifest['$schema']).toBe(`./node_modules/${SDK.name}/helm-plugin.schema.json`)
    expect(Object.keys(manifest)[0]).toBe('$schema')

    // The SDK is a development dependency, at this version or later.
    expect(JSON.parse(readFileSync(join(folder, 'package.json'), 'utf8'))).toEqual({
      name: 'issue-tracker',
      private: true,
      scripts: { validate: 'helm-plugin validate' },
      devDependencies: { [SDK.name]: `^${SDK.version}` }
    })
    expect(readFileSync(join(folder, '.gitignore'), 'utf8')).toBe('node_modules/\n')

    for (const file of ['icon.svg', 'README.md', 'pages/panel.html', 'pages/panel.js', 'pages/tab.html', 'pages/tab.js', 'pages/style.css']) {
      expect(existsSync(join(folder, file)), file).toBe(true)
    }
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toMatch(/^# Issue tracker\n/)
    expect(created.stdout).toContain('npm run validate')

    const validated = run(['validate'], folder)
    expect(validated.status).toBe(0)
    expect(validated.stdout).toContain('Issue tracker (issue-tracker): Helm would load it.')
    expect(checkPluginFolder(folder)).toMatchObject({ ok: true, errors: [], warnings: [] })
  })

  it('takes an id and a name, and escapes the name where it lands in HTML', () => {
    const created = run(['create', 'p', '--id', 'board', '--name=Q&A <board> "two"'], root)
    expect(created.status).toBe(0)
    const folder = join(root, 'p')
    const manifest = JSON.parse(readFileSync(join(folder, 'helm-plugin.json'), 'utf8')) as Record<string, unknown>
    expect(manifest['id']).toBe('board')
    expect(manifest['name']).toBe('Q&A <board> "two"')
    expect(readFileSync(join(folder, 'pages', 'panel.html'), 'utf8')).toContain('Q&amp;A &lt;board&gt; &quot;two&quot;')
    expect(run(['validate', folder], root).status).toBe(0)
  })

  it('writes into an empty folder that already exists', () => {
    mkdirSync(join(root, 'empty'))
    expect(run(['create', 'empty'], root).status).toBe(0)
  })

  it('refuses a folder that is not empty, and leaves it alone', () => {
    const folder = join(root, 'busy')
    mkdirSync(folder)
    writeFileSync(join(folder, 'notes.txt'), 'mine')
    const refused = run(['create', 'busy'], root)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('is not empty')
    expect(existsSync(join(folder, 'helm-plugin.json'))).toBe(false)
  })

  it('refuses an id Helm would refuse, before writing anything', () => {
    const refused = run(['create', 'x', '--id', 'Not_An_Id'], root)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('"Not_An_Id" cannot be a plugin id')
    expect(existsSync(join(root, 'x'))).toBe(false)
    // A folder name with nothing usable in it needs --id too.
    expect(run(['create', '___'], root).stderr).toContain('cannot be a plugin id')
  })

  it('says what is wrong with the command line', () => {
    expect(run(['create'], root)).toMatchObject({ status: 1 })
    expect(run(['create', 'a', '--colour', 'red'], root).stderr).toContain('unknown option --colour')
    expect(run(['create', 'a', '--id'], root).stderr).toContain('--id needs a value')
  })
})

describe('helm-plugin validate', () => {
  const write = (folder: string, manifest: unknown, files: Record<string, string> = {}): void => {
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'helm-plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(join(folder, path, '..'), { recursive: true })
      writeFileSync(join(folder, path), body)
    }
  }

  it('refuses a manifest Helm would refuse, says why, and exits 1', () => {
    const folder = join(root, 'broken')
    write(folder, { apiVersion: 7, id: 'broken', name: 'Broken' })
    const result = run(['validate', folder], root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('error: apiVersion 7 is not supported by this Helm, which supports 1')
    expect(result.stderr).toContain('1 error: Helm would not load this plugin.')
  })

  it('refuses a page that is not there, the way Helm does', () => {
    const folder = join(root, 'unbuilt')
    write(folder, { apiVersion: 1, id: 'unbuilt', name: 'Unbuilt', tabs: { a: { title: 'A', entry: 'dist/a.html' } } })
    const result = run(['validate'], folder)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('error: tabs.a.entry: dist/a.html does not exist - has the plugin been built?')
  })

  it('refuses an icon too large to be one', () => {
    const folder = join(root, 'big icon')
    write(folder, { apiVersion: 1, id: 'big', name: 'Big', icon: 'icon.svg' }, { 'icon.svg': `<svg>${'x'.repeat(70_000)}</svg>` })
    const result = run(['validate', folder], root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('icon: icon.svg is over 64 KB')
  })

  it('says when there is no manifest, or it is not JSON', () => {
    mkdirSync(join(root, 'nothing'))
    expect(run(['validate', join(root, 'nothing')], root).stderr).toContain('there is no helm-plugin.json')
    write(join(root, 'garbled'), '{ "apiVersion": 1,')
    const garbled = run(['validate', join(root, 'garbled')], root)
    expect(garbled.status).toBe(1)
    expect(garbled.stderr).toContain('helm-plugin.json is not valid JSON')
    expect(run(['validate', join(root, 'missing')], root).stderr).toContain('does not exist')
  })

  it('passes a plugin with warnings, and prints them', () => {
    const folder = join(root, 'warned')
    write(folder, { apiVersion: 1, id: 'warned', name: 'Warned', colour: 'red' })
    const result = run(['validate', folder], root)
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('warning: "colour" is not a manifest field and is ignored')
    expect(result.stdout).toContain('Warned (warned): Helm would load it (1 warning).')
  })

  it('passes the template as it ships', () => {
    expect(checkPluginFolder(join(SDK_DIR, 'template'))).toMatchObject({ ok: true, errors: [], warnings: [] })
  })
})

describe('helm-plugin', () => {
  it('prints its usage for --help, and fails without a command or with an unknown one', () => {
    const help = run(['--help'], root)
    expect(help.status).toBe(0)
    expect(help.stdout).toContain('helm-plugin create <folder>')
    expect(run([], root).status).toBe(1)
    const unknown = run(['publish'], root)
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain('unknown command "publish"')
  })
})
