import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DiscoveryResult, Profile, Project } from '@helm/core'
import { createFilesService, filesRoots, vscodeUrl, type FilesService, type KnownFolders } from './files'

/**
 * The Files view's hand-off to VS Code: only a file in a folder Helm knows,
 * reached through VS Code's own URL handler and nothing else.
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
let opened: string[]
let handler: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm files-ipc-'))
  git(root, 'init', '-q')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.ts'), 'one\ntwo\nthree\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'first')

  opened = []
  handler = 'Visual Studio Code'
  known = [root]
  service = createFilesService({
    roots: () => known,
    protocolHandler: () => handler,
    openExternal: async (url) => {
      opened.push(url)
    }
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('the editor hand-off', () => {
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

describe('filesRoots', () => {
  const scanOf = (...paths: string[]): DiscoveryResult => ({
    roots: [],
    harnesses: [],
    projects: paths.map((path) => ({ path }) as Project),
    errors: [],
    scannedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 0
  })
  const profileAt = (root: string, overlays: string[] = []): Profile => ({ root, overlays }) as Profile

  it('hands on a file from a folder the host knows and nothing else', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'helm files-elsewhere-'))
    try {
      const profileRoot = join(elsewhere, 'profile root')
      const overlay = join(elsewhere, 'overlay')
      const sessionCwd = join(elsewhere, 'session cwd')
      const stranger = join(elsewhere, 'stranger')
      for (const folder of [profileRoot, overlay, sessionCwd, stranger]) mkdirSync(folder)

      // What the host answers: its scan, its profiles and its sessions.
      const host: KnownFolders = {
        scan: scanOf(root),
        profiles: [profileAt(profileRoot, [overlay])],
        sessions: [{ cwd: sessionCwd }]
      }
      expect(filesRoots(host)).toEqual([root, profileRoot, overlay, sessionCwd])

      known = filesRoots(host)
      for (const folder of [root, profileRoot, overlay, sessionCwd]) {
        expect(await service.openInEditor(join(folder, 'a.ts'), 1)).toEqual({ opened: true })
      }
      expect(await service.openInEditor(join(stranger, 'a.ts'), 1)).toEqual({ opened: false })
      expect(opened).toHaveLength(4)

      // Before the host has answered, nothing is a folder Helm knows.
      known = filesRoots({ scan: null, profiles: [], sessions: [] })
      expect(await service.openInEditor(join(root, 'src', 'a.ts'), 1)).toEqual({ opened: false })
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('names each folder once, however many of the three name it', () => {
    const spelledAgain = join(root, 'src', '..')
    expect(
      filesRoots({ scan: scanOf(root, root), profiles: [profileAt(spelledAgain, [root])], sessions: [{ cwd: root }] })
    ).toEqual([root])
  })
})

describe('vscodeUrl', () => {
  it('encodes each folder on its own and leaves the drive alone', () => {
    if (process.platform !== 'win32') return
    expect(vscodeUrl('C:\\work\\my repo\\#1\\a.ts', 12)).toBe('vscode://file/C:/work/my%20repo/%231/a.ts:12:1')
    expect(vscodeUrl('C:\\work', null)).toBe('vscode://file/C:/work')
  })
})
