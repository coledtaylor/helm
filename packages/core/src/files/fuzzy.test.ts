import { describe, expect, it } from 'vitest'
import { matchPath, normalizeQuery, rankPaths } from './fuzzy'
import { changedDirectories, changedLineSet, describeFileChanges } from './shape'

const PATHS = [
  'packages/ui/src/components/TabBar.tsx',
  'packages/ui/src/components/TabBar.test.tsx',
  'packages/ui/src/components/SessionTree.tsx',
  'packages/core/src/layout/panes.ts',
  'packages/core/src/layout/panes.test.ts',
  'docs/tabbar-notes.md',
  'README.md'
]

describe('rankPaths', () => {
  it('puts the file whose name is exactly what was typed first, however deep it sits', () => {
    const ranked = rankPaths('tabbar', PATHS).map((m) => m.path)
    expect(ranked[0]).toBe('packages/ui/src/components/TabBar.tsx')
    expect(ranked.slice(1).sort()).toEqual(['docs/tabbar-notes.md', 'packages/ui/src/components/TabBar.test.tsx'])
  })

  it('matches across folders when the query has a slash in it, either way round', () => {
    expect(rankPaths('core/panes', PATHS)[0]?.path).toBe('packages/core/src/layout/panes.ts')
    expect(rankPaths('core\\panes', PATHS)[0]?.path).toBe('packages/core/src/layout/panes.ts')
  })

  it('finds a file by the capitals of its name', () => {
    expect(rankPaths('stree', PATHS)[0]?.path).toBe('packages/ui/src/components/SessionTree.tsx')
  })

  it('lists nothing for a query that is not in any path, and nothing for no query', () => {
    expect(rankPaths('zzz', PATHS)).toEqual([])
    expect(rankPaths('   ', PATHS)).toEqual([])
  })

  it('stops at the limit', () => {
    expect(rankPaths('s', PATHS, 2)).toHaveLength(2)
  })
})

describe('matchPath', () => {
  it('returns the indices it matched, in order, for the list to underline', () => {
    const match = matchPath(normalizeQuery('rme'), 'README.md')
    // `m` then `e` run on from each other in "ME", which beats the later `m`.
    expect(match?.hits).toEqual([0, 4, 5])
    expect(
      match?.hits
        .map((i) => 'README.md'[i])
        .join('')
        .toLowerCase()
    ).toBe('rme')
  })

  it('needs every character, in order', () => {
    expect(matchPath('dmr', 'README.md')).toBeNull()
  })
})

describe('the sentences and sets about git', () => {
  it('marks every folder above a changed path and nothing else', () => {
    expect([...changedDirectories({ 'a/b/c.ts': 'modified', 'a/d.ts': 'added', 'top.ts': 'modified' })].sort()).toEqual([
      'a',
      'a/b'
    ])
  })

  it('counts lines in a sentence that names the comparison, and never calls "unknown" clean', () => {
    const lines = { changed: [[3, 5]] as Array<[number, number]>, removedAfter: [9], changedCount: 3, removedCount: 1 }
    expect(describeFileChanges({ kind: 'tracked', lines })).toEqual({
      text: '3 lines changed, 1 line removed since the last commit',
      short: '3 changed, 1 removed',
      marked: true
    })
    expect(
      describeFileChanges({
        kind: 'tracked',
        lines: { changed: [], removedAfter: [], changedCount: 0, removedCount: 0 }
      }).text
    ).toBe('No changes since the last commit')
    expect(describeFileChanges({ kind: 'unknown', reason: 'no git' }).text).toBe('Could not read what changed')
    expect([...changedLineSet(lines)]).toEqual([3, 4, 5])
  })
})
