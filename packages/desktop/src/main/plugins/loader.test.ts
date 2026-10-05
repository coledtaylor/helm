import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../../../test/electron')).electronFake())

const { loadPluginFolder, resolveInside, MANIFEST_FILE } = await import('./loader')

/**
 * Reading a plugin folder: the manifest validated, every file it names found
 * inside the folder with links followed, the icon inlined. Each way a folder
 * can be wrong comes back as one sentence naming what is wrong.
 */

let root: string
let dir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm plugin loader-'))
  dir = join(root, 'my plugin')
  mkdirSync(join(dir, 'dist'), { recursive: true })
})

afterEach(() => {
  // Junctions first, unlinked rather than walked: `rmSync` with `recursive`
  // has been seen to leave one standing.
  for (const link of ['escape', 'inside']) {
    try {
      execFileSync('cmd', ['/c', 'rmdir', join(dir, link)], { stdio: 'ignore' })
    } catch {
      // Not made by this test.
    }
  }
  rmSync(root, { recursive: true, force: true })
})

function write(rel: string, content: string | Buffer): void {
  const path = join(dir, rel)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function manifest(patch: Record<string, unknown> = {}): void {
  write(
    MANIFEST_FILE,
    JSON.stringify({
      apiVersion: 1,
      id: 'sample',
      name: 'Sample',
      panels: { main: { title: 'Main', entry: 'dist/main.html' } },
      ...patch
    })
  )
}

function junction(link: string, target: string): void {
  execFileSync('cmd', ['/c', 'mklink', '/J', link, target], { stdio: 'ignore' })
}

describe('loadPluginFolder', () => {
  it('reads a built plugin: its manifest normalised, its folder resolved', () => {
    manifest({ icon: 'icon.svg' })
    write('dist/main.html', '<!doctype html><title>x</title>')
    write('icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')
    const result = loadPluginFolder(dir)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plugin.path).toBe(dir)
    expect(result.plugin.dir).toBe(realpathSync.native(dir))
    expect(result.plugin.manifest).toMatchObject({ id: 'sample', name: 'Sample', panels: { main: { entry: 'dist/main.html' } } })
    expect(result.plugin.icon).toBe(
      `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`
    )
  })

  it('inlines a PNG icon as one', () => {
    manifest({ icon: 'icon.png' })
    write('dist/main.html', '')
    write('icon.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const result = loadPluginFolder(dir)
    expect(result.ok && result.plugin.icon).toBe('data:image/png;base64,iVBORw==')
  })

  it('refuses an icon past the size a rail icon can be', () => {
    manifest({ icon: 'icon.svg' })
    write('dist/main.html', '')
    write('icon.svg', 'x'.repeat(64 * 1024 + 1))
    const result = loadPluginFolder(dir)
    expect(result).toMatchObject({ ok: false, id: 'sample', name: 'Sample' })
    expect(!result.ok && result.error).toMatch(/^icon: icon\.svg is over 64 KB$/)
  })

  it('says there is no manifest', () => {
    expect(loadPluginFolder(dir)).toMatchObject({ ok: false, error: `there is no ${MANIFEST_FILE} in this folder` })
  })

  it('says the folder does not exist', () => {
    expect(loadPluginFolder(join(root, 'gone'))).toMatchObject({ ok: false, error: 'the folder does not exist', name: 'gone' })
  })

  it('says the manifest is not JSON', () => {
    write(MANIFEST_FILE, '{ "apiVersion": 1, ')
    const result = loadPluginFolder(dir)
    expect(!result.ok && result.error).toMatch(/^helm-plugin\.json is not valid JSON: /)
  })

  it('says an apiVersion is unsupported, and nothing else, keeping the id and name it gave', () => {
    manifest({ apiVersion: 7, panels: 'not even an object' })
    const result = loadPluginFolder(dir)
    expect(result).toEqual({
      ok: false,
      error: 'apiVersion 7 is not supported by this Helm, which supports 1',
      warnings: [],
      id: 'sample',
      name: 'Sample'
    })
  })

  it('names a page that is missing and suggests the plugin is not built', () => {
    manifest()
    expect(loadPluginFolder(dir)).toMatchObject({
      ok: false,
      error: 'panels.main.entry: dist/main.html does not exist - has the plugin been built?'
    })
  })

  it('keeps the validator warnings', () => {
    manifest({ colour: 'blue' })
    write('dist/main.html', '')
    const result = loadPluginFolder(dir)
    expect(result.ok && result.plugin.warnings).toEqual(['"colour" is not a manifest field and is ignored'])
  })

  it('refuses a page reached through a junction out of the folder', () => {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'main.html'), '')
    junction(join(dir, 'escape'), elsewhere)
    manifest({ panels: { main: { title: 'Main', entry: 'escape/main.html' } } })
    expect(loadPluginFolder(dir)).toMatchObject({ ok: false, error: 'panels.main.entry: escape/main.html is outside the plugin folder' })
  })
})

describe('resolveInside', () => {
  it('is the real file for a path inside the folder', () => {
    write('dist/a b.html', '')
    expect(resolveInside(dir, 'dist/a b.html')).toBe(realpathSync.native(join(dir, 'dist', 'a b.html')))
  })

  it('is null for a file that is not there, or a folder', () => {
    expect(resolveInside(dir, 'dist/nope.html')).toBeNull()
    expect(resolveInside(dir, 'dist')).toBeNull()
  })

  it('is outside for a path that climbs out, an absolute one, or one on another drive', () => {
    writeFileSync(join(root, 'secret.txt'), '')
    expect(resolveInside(dir, '../secret.txt')).toBe('outside')
    expect(resolveInside(dir, join(root, 'secret.txt'))).toBe('outside')
    expect(resolveInside(dir, 'Z:\\elsewhere.txt')).toBe('outside')
  })

  it('is outside for a file reached through a junction that points out of the folder', () => {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'x.js'), '')
    junction(join(dir, 'escape'), elsewhere)
    expect(resolveInside(dir, 'escape/x.js')).toBe('outside')
  })

  it('follows a junction that stays inside the folder', () => {
    write('dist/x.js', '')
    junction(join(dir, 'inside'), join(dir, 'dist'))
    expect(resolveInside(realpathSync.native(dir), 'inside/x.js')).toBe(realpathSync.native(join(dir, 'dist', 'x.js')))
  })
})
