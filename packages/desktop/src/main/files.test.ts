import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFilesService, vscodeUrl, type FilesService } from './files'
import { PATIENCE } from '../../../../test/patience'

/**
 * The Files view's main half, over a real repository: every call is scoped to
 * a folder Helm knows, the watch reports what a session writes, and VS Code is
 * reached through its own URL handler and nothing else.
 */

function git(cwd: string, ...args: string[]): void {
  const run = spawnSync(
    'git',
    ['-c', 'core.autocrlf=false', '-c', 'user.name=Helm', '-c', 'user.email=helm@example.invalid', ...args],
    { cwd, windowsHide: true, encoding: 'utf8' }
  )
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`)
}

let root: string
let known: string[]
let service: FilesService
let changes: Array<{ root: string; paths: string[] | null }>
let opened: string[]
let handler: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm files-ipc-'))
  git(root, 'init', '-q')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.ts'), 'one\ntwo\nthree\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'first')

  changes = []
  opened = []
  handler = 'Visual Studio Code'
  known = [root]
  service = createFilesService({
    roots: () => known,
    onChanged: (changedRoot, paths) => changes.push({ root: changedRoot, paths }),
    protocolHandler: () => handler,
    openExternal: async (url) => {
      opened.push(url)
    }
  })
})

afterEach(() => {
  service.stop()
  rmSync(root, { recursive: true, force: true })
})

describe('the Files service', () => {
  it('lists, reads and reports status only under a folder it knows', async () => {
    writeFileSync(join(root, 'src', 'a.ts'), 'one\n2\nthree\n')

    const listing = await service.dir(root, 'src')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['a.ts'])
    expect((await service.status(root)).files).toEqual({ 'src/a.ts': 'modified' })
    const view = await service.read(root, join(root, 'src', 'a.ts'))
    expect(view.content).toBe('one\n2\nthree\n')
    expect(view.changes).toMatchObject({ kind: 'tracked', lines: { changed: [[2, 2]] } })
    expect((await service.list(root)).files).toEqual(['src/a.ts'])

    const stranger = mkdtempSync(join(tmpdir(), 'helm stranger-'))
    try {
      await expect(service.dir(stranger, '')).rejects.toThrow(/not a folder Helm knows/)
      await expect(service.read(stranger, join(stranger, 'x'))).rejects.toThrow(/not a folder Helm knows/)
      await expect(service.status(stranger)).rejects.toThrow(/not a folder Helm knows/)
    } finally {
      rmSync(stranger, { recursive: true, force: true })
    }
  })

  it('tells the window which files changed under a watched root, and stops when it is let go', async () => {
    service.watch([root])
    // Written again on every try: macOS's FSEvents can miss a write made in
    // the moment after a stream starts, and nothing says when it is live.
    let write = 0
    await vi.waitFor(
      () => {
        writeFileSync(join(root, 'src', 'a.ts'), `changed ${++write}\n`)
        expect(changes.flatMap((change) => change.paths ?? [])).toContain('src/a.ts')
      },
      { timeout: PATIENCE, interval: 250 }
    )
    expect(changes[0]?.root.toLowerCase()).toBe(root.toLowerCase())

    // Let go, the root is silent. A probe told from a root still watched is
    // the barrier: a watch that had outlived being let go would have told
    // b.ts before it.
    const other = mkdtempSync(join(tmpdir(), 'helm files-other-'))
    try {
      known = [root, other]
      service.watch([other])
      const before = changes.length
      writeFileSync(join(root, 'src', 'b.ts'), 'after\n')
      await vi.waitFor(
        () => {
          writeFileSync(join(other, 'probe.txt'), `probe ${++write}\n`)
          expect(changes.slice(before).flatMap((change) => change.paths ?? [])).toContain('probe.txt')
        },
        { timeout: PATIENCE, interval: 250 }
      )
      const sameRoot = (change: { root: string }) => change.root.toLowerCase() === root.toLowerCase()
      expect(changes.slice(before).filter(sameRoot)).toEqual([])

      // Watched again, its changes are told again. Whether b.ts is among
      // them is the OS's to say: FSEvents may report a write made just
      // before a stream starts, and the file did change.
      const again = changes.length
      service.watch([other, root])
      await vi.waitFor(
        () => {
          writeFileSync(join(root, 'src', 'c.ts'), `again ${++write}\n`)
          expect(changes.slice(again).filter(sameRoot).flatMap((change) => change.paths ?? [])).toContain('src/c.ts')
        },
        { timeout: PATIENCE, interval: 250 }
      )
    } finally {
      service.watch([])
      rmSync(other, { recursive: true, force: true })
    }
  })

  it('opens a file in VS Code at a line through its URL handler, and only a file Helm knows', async () => {
    expect(service.editor()).toBe('Visual Studio Code')
    expect(await service.openInEditor(join(root, 'src', 'a.ts'), 2)).toEqual({ opened: true })
    expect(opened).toEqual([vscodeUrl(join(root, 'src', 'a.ts'), 2)])

    expect(await service.openInEditor(join(tmpdir(), 'elsewhere.ts'), null)).toEqual({ opened: false })
    handler = ''
    expect(service.editor()).toBeNull()
    expect(await service.openInEditor(join(root, 'src', 'a.ts'), null)).toEqual({ opened: false })
    expect(opened).toHaveLength(1)
  })
})

describe('vscodeUrl', () => {
  it('encodes each folder on its own and leaves the drive alone', () => {
    if (process.platform !== 'win32') return
    expect(vscodeUrl('C:\\work\\my repo\\#1\\a.ts', 12)).toBe('vscode://file/C:/work/my%20repo/%231/a.ts:12:1')
    expect(vscodeUrl('C:\\work', null)).toBe('vscode://file/C:/work')
  })
})
