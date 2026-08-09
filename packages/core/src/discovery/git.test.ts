import { describe, expect, it } from 'vitest'
import { parseGitStatus } from './git'

/**
 * The spawn is not the interesting part; the parse is. These are real
 * `git status --porcelain=v2 --branch` outputs.
 */
describe('parseGitStatus', () => {
  it('reads a clean branch with an upstream', () => {
    const out = [
      '# branch.oid 38a0c50f0e9a4f1b0b2f3d4c5e6a7b8c9d0e1f22',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
      ''
    ].join('\n')

    expect(parseGitStatus(out)).toEqual({
      branch: 'main',
      detached: false,
      dirty: 0,
      ahead: 0,
      behind: 0
    })
  })

  it('counts changed, renamed, unmerged and untracked paths as dirty', () => {
    const out = [
      '# branch.head feature/discovery',
      '# branch.upstream origin/feature/discovery',
      '# branch.ab +2 -3',
      '1 .M N... 100644 100644 100644 aaa bbb packages/core/src/index.ts',
      '1 M. N... 100644 100644 100644 ccc ddd packages/core/src/types.ts',
      '2 R. N... 100644 100644 100644 eee fff R100 new/path.ts\told/path.ts',
      'u UU N... 100644 100644 100644 100644 111 222 333 conflicted.ts',
      '? untracked.ts',
      ''
    ].join('\n')

    expect(parseGitStatus(out)).toEqual({
      branch: 'feature/discovery',
      detached: false,
      dirty: 5,
      ahead: 2,
      behind: 3
    })
  })

  it('recognises a detached HEAD', () => {
    const out = ['# branch.oid 38a0c50', '# branch.head (detached)', ''].join('\n')

    const state = parseGitStatus(out)
    expect(state.detached).toBe(true)
    expect(state.branch).toBeNull()
  })

  it('leaves ahead/behind at zero when there is no upstream', () => {
    // git omits `# branch.ab` entirely rather than printing +0 -0.
    const out = ['# branch.oid 38a0c50', '# branch.head local-only', '? notes.md', ''].join('\n')

    expect(parseGitStatus(out)).toEqual({
      branch: 'local-only',
      detached: false,
      dirty: 1,
      ahead: 0,
      behind: 0
    })
  })

  it('handles branch names containing spaces in the path column', () => {
    const out = [
      '# branch.head main',
      '# branch.ab +0 -0',
      '1 .M N... 100644 100644 100644 aaa bbb atlas Project/README.md',
      ''
    ].join('\n')

    expect(parseGitStatus(out).dirty).toBe(1)
  })
})
