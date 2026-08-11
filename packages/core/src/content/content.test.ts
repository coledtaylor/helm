import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseNoteFrontmatter } from './frontmatter'
import { renderMarkdown } from './markdown'
import { contentScope, readContentTree } from './roots'
import { buildCorpus, searchCorpus } from './search'
import { assertContentWritable } from './write'
import { buildWikiIndex, headingSlug, parseWikilink, resolveWikilink } from './wikilinks'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'helm-content-'))
  mkdirSync(join(root, 'notes'), { recursive: true })
  mkdirSync(join(root, '.claude', 'skills', 'think'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'repos', 'other', 'notes'), { recursive: true })

  writeFileSync(
    join(root, 'notes', 'alpha.md'),
    ['---', 'type: journal', 'date: 2026-08-10', 'tags: [helm, m6]', '---', '', '# Alpha', '', 'Links to [[beta]] and [[nowhere]].', ''].join('\n')
  )
  writeFileSync(join(root, 'notes', 'beta.md'), '# Beta\n\nAlpha mentions geofencing here.\n')
  writeFileSync(join(root, '.claude', 'skills', 'think', 'SKILL.md'), '---\nname: think\n---\n\n# think\n')
  writeFileSync(join(root, 'docs', 'SPEC.md'), '# Spec\n')
  writeFileSync(join(root, 'README.md'), '# Readme\n')
  writeFileSync(join(root, 'repos', 'other', 'notes', 'hidden.md'), '# Hidden\n')
  return root
}

describe('frontmatter', () => {
  it('parses lists and leaves the body behind', () => {
    const parsed = parseNoteFrontmatter('---\ntype: journal\ntags: [a, b]\n---\n\n# Title\n')
    expect(parsed.present).toBe(true)
    expect(parsed.body.trim()).toBe('# Title')
    expect(parsed.fields.find((f) => f.key === 'tags')?.values).toEqual(['a', 'b'])
  })

  it('treats an unclosed fence as a document, not as frontmatter', () => {
    const parsed = parseNoteFrontmatter('---\nnot closed\n\n# Title\n')
    expect(parsed.present).toBe(false)
    expect(parsed.body).toContain('# Title')
  })

  it('reports a broken block rather than letting it render as text', () => {
    const parsed = parseNoteFrontmatter('---\n: : :\n\ta\n---\nbody\n')
    expect(parsed.present).toBe(true)
    expect(parsed.error).not.toBeNull()
    expect(parsed.body.trim()).toBe('body')
  })
})

describe('wikilinks', () => {
  const files = [
    { path: 'C:/v/notes/beta.md', relPath: 'notes/beta.md', slug: 'beta' },
    { path: 'C:/v/docs/beta.md', relPath: 'docs/beta.md', slug: 'beta' },
    { path: 'C:/v/notes/gamma.md', relPath: 'notes/gamma.md', slug: 'gamma' }
  ] as never
  const index = buildWikiIndex(files)

  it('splits heading before alias', () => {
    const link = parseWikilink('note#Section|Read this')
    expect(link.target).toBe('note')
    expect(link.heading).toBe('Section')
    expect(link.label).toBe('Read this')
  })

  it('resolves by bare name', () => {
    expect(resolveWikilink(index, parseWikilink('gamma'))).toBe('C:/v/notes/gamma.md')
  })

  it('prefers a path spelling over a name collision', () => {
    expect(resolveWikilink(index, parseWikilink('docs/beta'))).toBe('C:/v/docs/beta.md')
  })

  it('breaks a link with no note behind it', () => {
    expect(resolveWikilink(index, parseWikilink('nothing-here'))).toBeNull()
  })

  it('slugs headings the same way on both ends', () => {
    expect(headingSlug('The Mechanism: what it does')).toBe('the-mechanism-what-it-does')
  })
})

describe('renderMarkdown', () => {
  it('never emits the frontmatter as text', async () => {
    const out = await renderMarkdown('---\ntype: journal\n---\n\n# Hello\n')
    expect(out.html).not.toContain('type: journal')
    expect(out.html).toContain('<h1')
    expect(out.frontmatter.present).toBe(true)
    expect(out.frontmatter.fields[0]).toEqual({ key: 'type', value: 'journal', values: ['journal'] })
  })

  it('reads a leading --- as a rule, not as metadata, when it is not a note', async () => {
    // A pull request description is not a file in a vault: three dashes at the
    // top of one are a horizontal rule, and reading them as frontmatter eats
    // everything down to the next set.
    const source = '---\nA section somebody wrote.\n---\n\nAnd the rest.\n'

    const asNote = await renderMarkdown(source)
    const asProse = await renderMarkdown(source, { frontmatter: false })

    expect(asNote.frontmatter.present).toBe(true)
    expect(asNote.html).not.toContain('A section somebody wrote.')

    expect(asProse.frontmatter.present).toBe(false)
    expect(asProse.html).toContain('A section somebody wrote.')
    expect(asProse.html).toContain('And the rest.')
    expect(asProse.html).toContain('<hr>')
  })

  it('renders GFM tables and keeps task list state', async () => {
    const out = await renderMarkdown(
      ['| a | b |', '| --- | --- |', '| 1 | 2 |', '', '- [x] done', '- [ ] not done', ''].join('\n')
    )
    expect(out.counts.tables).toBe(1)
    expect(out.counts.taskItems).toBe(2)
    expect(out.counts.taskItemsChecked).toBe(1)
    expect(out.html).toContain('checked')
  })

  it('highlights a fenced block and labels its language', async () => {
    const out = await renderMarkdown('```ts\nconst a: number = 1\n```\n')
    expect(out.counts.codeBlocks).toBe(1)
    expect(out.counts.highlightedBlocks).toBe(1)
    expect(out.html).toContain('data-language="typescript"')
    expect(out.html).toContain('--shiki-dark')
  })

  it('leaves an unknown language as plain text without failing', async () => {
    const out = await renderMarkdown('```notalanguage\nhello\n```\n')
    expect(out.counts.codeBlocks).toBe(1)
    expect(out.counts.highlightedBlocks).toBe(0)
    expect(out.unknownLanguages).toEqual(['notalanguage'])
  })

  it('marks a broken wikilink and resolves a live one', async () => {
    const index = buildWikiIndex([
      { path: 'C:/v/notes/beta.md', relPath: 'notes/beta.md', slug: 'beta' }
    ] as never)
    const out = await renderMarkdown('See [[beta]] and [[missing]].\n', { index })
    expect(out.counts.wikilinks).toBe(2)
    expect(out.counts.brokenWikilinks).toBe(1)
    expect(out.html).toContain('data-wikilink-path="C:/v/notes/beta.md"')
    expect(out.html).toContain('wikilink-broken')
  })

  it('does not treat a bracket inside code as a wikilink', async () => {
    const out = await renderMarkdown('Inline `[[not a link]]` stays.\n')
    expect(out.counts.wikilinks).toBe(0)
    expect(out.html).toContain('[[not a link]]')
  })

  it('renders a callout as an admonition, not a quotation', async () => {
    const out = await renderMarkdown('> [!warning] Supersedes the SDK draft\n> The body.\n')
    expect(out.counts.callouts).toBe(1)
    expect(out.html).toContain('data-callout="warning"')
    expect(out.html).toContain('Supersedes the SDK draft')
    expect(out.html).not.toContain('[!warning]')
  })

  it('shows tags and ignores hashes that are not tags', async () => {
    const out = await renderMarkdown('A #helm tag, see https://x.test/#frag and issue #12.\n')
    expect(out.tags).toEqual(['helm'])
  })

  it('strips a script a note contains', async () => {
    const out = await renderMarkdown('Hello\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n')
    expect(out.html).not.toContain('<script')
    expect(out.html).not.toContain('onerror')
  })

  it('gives every heading an anchor a wikilink can aim at', async () => {
    const out = await renderMarkdown('# One\n\n## Two Words\n')
    expect(out.headings.map((h) => h.slug)).toEqual(['one', 'two-words'])
    expect(out.html).toContain('data-heading="two-words"')
  })
})

describe('readContentTree', () => {
  it('finds the named roots, the scope root, and nothing inside repos/', () => {
    const root = fixture()
    try {
      const tree = readContentTree(contentScope(root, 'harness', 'fixture'))
      const roots = tree.roots.map((r) => r.relPath).sort()
      expect(roots).toContain('notes')
      expect(roots).toContain('docs')
      expect(roots).toContain('.claude/skills')
      expect(roots).toContain('')
      expect(tree.files.some((f) => f.relPath.startsWith('repos/'))).toBe(false)
      const alpha = tree.files.find((f) => f.slug === 'alpha')
      expect(alpha?.noteType).toBe('journal')
      expect(alpha?.tags).toEqual(['helm', 'm6'])
      expect(alpha?.title).toBe('Alpha')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('search', () => {
  it('matches inside a word and reports the line', () => {
    const root = fixture()
    try {
      const tree = readContentTree(contentScope(root))
      const corpus = buildCorpus(root, tree.files)
      const result = searchCorpus(corpus, 'geofenc', true)
      expect(result.totalMatches).toBe(1)
      expect(result.hits[0]?.lines[0]?.text).toContain('geofencing')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('finds a non-markdown file by name without reading its contents', () => {
    const root = fixture()
    try {
      mkdirSync(join(root, 'notes'), { recursive: true })
      writeFileSync(join(root, 'notes', 'dashboard.html'), '<style>notes { color: red }</style>')

      const tree = readContentTree(contentScope(root))
      const corpus = buildCorpus(root, tree.files)

      // Found by what it is called...
      const byName = searchCorpus(corpus, 'dashboard', true)
      expect(byName.hits.map((hit) => hit.relPath)).toContain('notes/dashboard.html')
      expect(byName.hits.find((hit) => hit.relPath.endsWith('.html'))?.nameMatch).toBe(true)

      // ...and never by what is inside it. `notes` appears in that stylesheet
      // and must not put the file in the results on those grounds.
      const byBody = searchCorpus(corpus, 'color: red', true)
      expect(byBody.hits.map((hit) => hit.relPath)).not.toContain('notes/dashboard.html')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('assertContentWritable', () => {
  it('refuses a path outside the scope', () => {
    expect(() => assertContentWritable('C:/v', 'C:/other/notes/a.md')).toThrow(/not inside/)
  })

  it('refuses a nested repository', () => {
    expect(() => assertContentWritable('C:/v', 'C:/v/repos/x/notes/a.md')).toThrow(/not content/)
  })

  it('refuses a file it cannot read as content', () => {
    expect(() => assertContentWritable('C:/v', 'C:/v/notes/a.exe')).toThrow(/markdown/)
  })

  it('allows a note and a skill', () => {
    expect(() => assertContentWritable('C:/v', 'C:/v/notes/a.md')).not.toThrow()
    expect(() => assertContentWritable('C:/v', 'C:/v/.claude/skills/x/SKILL.md')).not.toThrow()
  })
})
