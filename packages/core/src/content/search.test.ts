import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contentScope, readContentTree } from './roots'
import { buildCorpus, searchCorpus } from './search'

/**
 * What a search reads and what it counts, against a scope whose every byte the
 * test wrote - so each expected count below is read off the fixture, not off
 * the search.
 */
describe('searchCorpus', () => {
  let root: string

  // One file per kind, every one of them saying "quokka" in its body, so a
  // kind whose body is skipped is visible as a count that comes up short.
  const BODIES = {
    'notes/zebra.md': '# Zebra\n\nQuokka quokka.\nA QUOKKA again.\n', // 3
    'notes/data.json': '{ "animal": "quokka" }\n', // 1
    'notes/plain.txt': 'quokka, then quokka\n', // 2
    'notes/tool.py': 'print("quokka")\n', // 1
    'notes/page.html': '<p>quokka quokka quokka</p>\n', // html: name only
    'notes/blob.png': 'quokka in bytes' // binary: name only
  }
  const READ = ['notes/zebra.md', 'notes/data.json', 'notes/plain.txt', 'notes/tool.py']
  /** Past the 4 MB ceiling, and full of the word, so reading it would be obvious. */
  const HUGE = 'quokka filler line\n'.repeat(Math.ceil((4 * 1024 * 1024 + 4096) / 19))

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'helm-search-'))
    mkdirSync(join(root, 'notes'), { recursive: true })
    for (const [rel, body] of Object.entries(BODIES)) writeFileSync(join(root, rel), body)
    writeFileSync(join(root, 'notes', 'huge.md'), HUGE)
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const corpus = (): ReturnType<typeof buildCorpus> => {
    const tree = readContentTree(contentScope(root))
    // The fixture is what every expectation below is read from, so it has to
    // be the thing that was listed.
    expect(tree.files.map((file) => file.relPath).sort()).toEqual(
      [...Object.keys(BODIES), 'notes/huge.md'].sort()
    )
    return buildCorpus(root, tree.files)
  }

  /** An occurrence count of the fixture's own, non-overlapping, case-folded. */
  const occurrences = (term: string): number =>
    READ.map((rel) => BODIES[rel as keyof typeof BODIES].toLowerCase().split(term.toLowerCase()).length - 1).reduce(
      (sum, n) => sum + n,
      0
    )

  it('reads bodies for markdown, data, text and source only, and says so', () => {
    const result = searchCorpus(corpus(), 'quokka', true)

    expect([...result.bodyKinds].sort()).toEqual(['data', 'markdown', 'source', 'text'])
    expect(result.filesSearched).toBe(7)
    expect(result.filesWithText).toBe(READ.length)

    const matched = Object.fromEntries(result.hits.map((hit) => [hit.relPath, hit.matches]))
    expect(matched).toEqual({
      'notes/zebra.md': 3,
      'notes/data.json': 1,
      'notes/plain.txt': 2,
      'notes/tool.py': 1
    })
  })

  it('matches a file over 4 MB by its name only', () => {
    const result = searchCorpus(corpus(), 'huge', true)
    expect(result.hits.map((hit) => [hit.relPath, hit.nameMatch, hit.matches])).toEqual([
      ['notes/huge.md', true, 0]
    ])
    // Its body is full of the word and none of it is counted.
    expect(searchCorpus(corpus(), 'filler', true).totalMatches).toBe(0)
  })

  it('totals every occurrence, for terms that match many, part of a word, or nothing', () => {
    const built = corpus()
    for (const term of ['quokka', 'QUOKKA', 'okk', 'quokka.', 'wombat']) {
      const result = searchCorpus(built, term, false)
      expect(result.totalMatches, term).toBe(occurrences(term))
    }
    expect(occurrences('wombat')).toBe(0)
    expect(searchCorpus(built, 'wombat', false).hits).toEqual([])
  })
})

describe('searchCorpus over more files than it lists', () => {
  it('caps the hit list at 200 files and keeps counting past it', () => {
    const root = mkdtempSync(join(tmpdir(), 'helm-search-cap-'))
    try {
      mkdirSync(join(root, 'notes'))
      for (let i = 0; i < 205; i++) {
        writeFileSync(join(root, 'notes', `n${String(i).padStart(3, '0')}.md`), 'needle and needle\n')
      }
      const tree = readContentTree(contentScope(root))
      expect(tree.files).toHaveLength(205)

      const result = searchCorpus(buildCorpus(root, tree.files), 'needle', true)
      expect(result.hits).toHaveLength(200)
      expect(result.truncated).toBe(true)
      expect(result.totalMatches).toBe(205 * 2)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
