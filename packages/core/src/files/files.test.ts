import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseZeroContextDiff, readFileChanges } from './changes'
import { listProjectFiles } from './listing'
import { parseStatusZ, readFilesStatus } from './status'
import { FILE_VIEW_MAX_BYTES, isInsideRoot, readFileView } from './view'

/**
 * The Files view against real repositories: `git init`, a commit, and edits on
 * top - because every claim here is "git says", and a fixture that imitated
 * git's output would be testing the imitation.
 */

/** git with no help from the machine's config: no autocrlf, an identity for commits. */
function git(cwd: string, ...args: string[]): string {
  const run = spawnSync(
    'git',
    ['-c', 'core.autocrlf=false', '-c', 'user.name=Helm', '-c', 'user.email=helm@example.invalid', ...args],
    { cwd, windowsHide: true, encoding: 'utf8' }
  )
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`)
  return run.stdout
}

const lines = (count: number, label = 'line'): string =>
  Array.from({ length: count }, (_, i) => `${label} ${String(i + 1)}`).join('\n') + '\n'

let root: string

beforeEach(() => {
  // A space in the path, as every Helm fixture has: quoting is where paths break.
  root = mkdtempSync(join(tmpdir(), 'helm files-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A repository with one commit holding `src/a.ts` (ten lines), `README.md` and a `.gitignore`. */
function committedRepo(): void {
  git(root, 'init', '-q')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), lines(10))
  writeFileSync(join(root, 'README.md'), '# Readme\n')
  writeFileSync(join(root, '.gitignore'), 'build/\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'first')
}

describe('parseZeroContextDiff', () => {
  it('marks added, changed and removed lines from the hunk headers alone', () => {
    const diff = [
      'diff --git a/x b/x',
      '@@ -2,0 +3,2 @@',
      '+new one',
      '+new two',
      '@@ -5 +7 @@',
      '-old',
      '+changed',
      '@@ -9,3 +10,0 @@',
      '-gone',
      '-gone',
      '-gone',
      '@@ -20,4 +18,2 @@'
    ].join('\n')
    expect(parseZeroContextDiff(diff)).toEqual({
      changed: [
        [3, 4],
        [7, 7],
        [18, 19]
      ],
      removedAfter: [10, 19],
      changedCount: 5,
      removedCount: 5
    })
  })

  it('reads a diff with no hunks - a binary file, or none at all - as nothing changed', () => {
    expect(parseZeroContextDiff('Binary files a/x and b/x differ\n')).toEqual({
      changed: [],
      removedAfter: [],
      changedCount: 0,
      removedCount: 0
    })
  })
})

describe('parseStatusZ', () => {
  const record = (...parts: string[]): string => parts.join('\0') + '\0'

  it('keys every kind of entry by its path inside the project, a rename consuming its source', () => {
    const out = record(
      '# branch.oid abc',
      '1 .M N... 100644 100644 100644 aaa bbb app/src/a b.ts',
      '1 A. N... 000000 100644 100644 000 ccc app/new.ts',
      '1 D. N... 100644 000000 000000 ddd 000 app/gone.ts',
      '2 R. N... 100644 100644 100644 eee eee R100 app/moved.ts',
      'app/was.ts',
      'u UU N... 100644 100644 100644 100644 f1 f2 f3 app/conflict.ts',
      '? app/scratch/notes.md',
      '? app/nested-repo/',
      '1 .M N... 100644 100644 100644 aaa bbb other/outside.ts'
    )
    expect(parseStatusZ(out, 'App')).toEqual({
      'src/a b.ts': 'modified',
      'new.ts': 'added',
      'gone.ts': 'deleted',
      'moved.ts': 'renamed',
      'conflict.ts': 'conflicted',
      'scratch/notes.md': 'untracked',
      'nested-repo': 'untracked'
    })
  })
})

describe('readFilesStatus', () => {
  it('reports each changed file under the project, and an empty map for a clean one', async () => {
    committedRepo()
    expect((await readFilesStatus(root)).files).toEqual({})

    writeFileSync(join(root, 'src', 'a.ts'), lines(11))
    writeFileSync(join(root, 'src', 'b.ts'), 'new\n')
    unlinkSync(join(root, 'README.md'))
    mkdirSync(join(root, 'build'))
    writeFileSync(join(root, 'build', 'out.js'), 'ignored\n')

    const status = await readFilesStatus(root)
    expect(status.error).toBeNull()
    expect(status.files).toEqual({
      'src/a.ts': 'modified',
      'src/b.ts': 'untracked',
      'README.md': 'deleted'
    })
  })

  it('answers for a folder inside a repository with paths relative to that folder', async () => {
    committedRepo()
    writeFileSync(join(root, 'src', 'a.ts'), lines(12))
    writeFileSync(join(root, 'README.md'), '# Changed\n')
    const status = await readFilesStatus(join(root, 'src'))
    expect(status.files).toEqual({ 'a.ts': 'modified' })
  })

  it('says a folder outside any repository has nothing for git to say', async () => {
    writeFileSync(join(root, 'plain.txt'), 'x')
    expect(await readFilesStatus(root)).toMatchObject({ repo: null, files: {}, error: null })
  })
})

describe('readFileChanges', () => {
  it('marks the lines that differ from the last commit', async () => {
    committedRepo()
    const text = lines(10).split('\n')
    text[2] = 'changed 3'
    text.splice(6, 0, 'inserted')
    text.splice(9, 1)
    writeFileSync(join(root, 'src', 'a.ts'), text.join('\n'))

    const state = await readFileChanges(join(root, 'src', 'a.ts'))
    expect(state).toEqual({
      kind: 'tracked',
      lines: { changed: [[3, 3], [7, 7]], removedAfter: [9], changedCount: 2, removedCount: 1 }
    })
  })

  it('tells unchanged, new, ignored and outside apart', async () => {
    committedRepo()
    writeFileSync(join(root, 'src', 'fresh.ts'), 'x\n')
    mkdirSync(join(root, 'build'))
    writeFileSync(join(root, 'build', 'out.js'), 'x\n')
    writeFileSync(join(root, 'src', 'staged.ts'), 'x\n')
    git(root, 'add', 'src/staged.ts')

    expect(await readFileChanges(join(root, 'README.md'))).toEqual({
      kind: 'tracked',
      lines: { changed: [], removedAfter: [], changedCount: 0, removedCount: 0 }
    })
    expect(await readFileChanges(join(root, 'src', 'fresh.ts'))).toEqual({ kind: 'new' })
    expect(await readFileChanges(join(root, 'src', 'staged.ts'))).toEqual({ kind: 'new' })
    expect(await readFileChanges(join(root, 'build', 'out.js'))).toEqual({ kind: 'ignored' })

    const elsewhere = mkdtempSync(join(tmpdir(), 'helm no-repo-'))
    try {
      writeFileSync(join(elsewhere, 'x.txt'), 'x\n')
      expect(await readFileChanges(join(elsewhere, 'x.txt'))).toEqual({ kind: 'outside' })
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('reads a file whose name git would otherwise take as a pattern', async () => {
    committedRepo()
    writeFileSync(join(root, 'src', '[id].tsx'), 'one\n')
    writeFileSync(join(root, 'src', 'i.tsx'), 'decoy\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'route')
    writeFileSync(join(root, 'src', 'i.tsx'), 'decoy changed\n')

    // `[id]` as a glob matches `i.tsx`, which did change; the literal file did not.
    expect(await readFileChanges(join(root, 'src', '[id].tsx'))).toMatchObject({
      kind: 'tracked',
      lines: { changedCount: 0 }
    })
  })
})

describe('readFileView', () => {
  it('reads a file with line feeds only, says how it ended its lines, and carries its changes', async () => {
    committedRepo()
    writeFileSync(join(root, 'src', 'a.ts'), 'one\r\ntwo\r\n')
    const view = await readFileView(root, join(root, 'src', 'a.ts'))
    expect(view).toMatchObject({
      relPath: 'src/a.ts',
      exists: true,
      binary: false,
      tooLarge: false,
      content: 'one\ntwo\n',
      eol: 'CRLF',
      error: null
    })
    expect(view.changes.kind).toBe('tracked')
  })

  it('refuses a path outside the project before reading it', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'helm outside-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'nope')
      const view = await readFileView(root, join(outside, 'secret.txt'))
      expect(view.content).toBe('')
      expect(view.error).toMatch(/not inside/)
      expect(isInsideRoot(root, join(root, '..', 'x'))).toBe(false)
      expect(isInsideRoot(root, join(root, 'a', 'b.txt'))).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('says a file is gone, binary, or too large rather than showing nothing', async () => {
    const gone = await readFileView(root, join(root, 'missing.txt'))
    expect(gone).toMatchObject({ exists: false, error: null })

    writeFileSync(join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
    expect(await readFileView(root, join(root, 'blob.bin'))).toMatchObject({
      exists: true,
      binary: true,
      content: ''
    })

    writeFileSync(join(root, 'huge.log'), Buffer.alloc(FILE_VIEW_MAX_BYTES + 1, 'a'))
    expect(await readFileView(root, join(root, 'huge.log'))).toMatchObject({
      exists: true,
      tooLarge: true,
      content: ''
    })
  })
})

describe('listProjectFiles', () => {
  it('lists what git tracks and what it does not ignore, relative to the project', async () => {
    committedRepo()
    writeFileSync(join(root, 'src', 'b.ts'), 'new\n')
    mkdirSync(join(root, 'build'))
    writeFileSync(join(root, 'build', 'out.js'), 'ignored\n')

    const listing = await listProjectFiles(root)
    expect(listing.source).toBe('git')
    expect([...listing.files].sort()).toEqual(['.gitignore', 'README.md', 'src/a.ts', 'src/b.ts'])
  })

  it('walks a folder with no repository, skipping what the tree skips', async () => {
    mkdirSync(join(root, 'docs'))
    mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(root, 'docs', 'a.md'), 'x')
    writeFileSync(join(root, 'top.txt'), 'x')
    writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'x')

    const listing = await listProjectFiles(root)
    expect(listing).toMatchObject({ source: 'walk', truncated: false, error: null })
    expect([...listing.files].sort()).toEqual(['docs/a.md', 'top.txt'])
  })
})
