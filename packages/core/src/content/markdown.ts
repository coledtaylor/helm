import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import type {
  ContentCounts,
  ContentHeading,
  ContentWikilink,
  RenderedMarkdown
} from '../types'
import { parseNoteFrontmatter } from './frontmatter'
import { highlightCode } from './highlight'
import {
  headingSlug,
  parseWikilink,
  resolveWikilink,
  WIKILINK_RE,
  type WikiIndex
} from './wikilinks'

/**
 * Markdown, as this vault actually writes it.
 *
 * The pipeline is remark -> rehype, and the order of the last four steps is the
 * whole design:
 *
 *   1. `remark-rehype` with `allowDangerousHtml`, then `rehype-raw`, so the raw
 *      HTML a note contains is *parsed* rather than passed through as a string.
 *   2. `rehype-sanitize`, which is therefore the only thing that ever sees user
 *      content, and sees all of it.
 *   3. Helm's own transforms - wikilinks, callouts, tags, heading anchors -
 *      applied to the sanitised tree.
 *   4. Shiki, applied last, replacing whole `<pre>` blocks.
 *
 * Steps 3 and 4 come *after* the sanitiser on purpose. The obvious arrangement
 * puts them before it, and then every attribute they generate has to be added
 * to the schema - which means widening the sanitiser to let Helm's markup
 * through, and a widened sanitiser lets a note's markup through too. Running
 * afterwards means the schema stays exactly GitHub's, unmodified but for one
 * attribute, and nothing Helm generates depends on the sanitiser agreeing with
 * it.
 *
 * Frontmatter is removed before parsing rather than handled by a plugin. The
 * criterion is that frontmatter is a header chip row and never raw text, and a
 * document whose `---` block is not in the source cannot render it by accident.
 */

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

export interface RenderMarkdownOptions {
  /** For `[[wikilink]]` resolution. Omit to render every wikilink as broken. */
  index?: WikiIndex | undefined
  /** The file being rendered, so `[[#heading]]` and same-folder ties resolve. */
  path?: string | undefined
  /**
   * Whether a leading `---` block is metadata. True for a note; **false** for
   * markdown that is not a file in a vault.
   *
   * It has to be an option rather than a rule, because the same three
   * characters mean two different things depending on where the text came
   * from. In a note, `---` on the first line opens frontmatter and belongs in
   * the header chips rather than in the prose. In a pull request description it
   * is a horizontal rule and nothing else, and treating it as frontmatter eats
   * everything down to the next `---` - a whole section of somebody's
   * description, silently.
   */
  frontmatter?: boolean | undefined
}

/**
 * GitHub's schema, plus `checked` on an input.
 *
 * The default omits it, which is defensible for a comment box and wrong here:
 * GFM renders a task list as a disabled checkbox, and without `checked` every
 * completed item in every note reads as outstanding. The attribute cannot carry
 * a value that does anything - the input is already restricted to
 * `type="checkbox"` and `disabled` - so this is the narrowest possible widening.
 */
const SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    input: [...(defaultSchema.attributes?.['input'] ?? []), 'checked']
  }
}

/** Subtrees whose text is not prose and must not be rewritten. */
const OPAQUE = new Set(['code', 'pre', 'a', 'script', 'style', 'kbd', 'samp'])

const CALLOUT_RE = /^\[!([A-Za-z][\w-]*)\]([+-]?)\s*(.*)$/s

/**
 * A `#tag`, as Obsidian counts one.
 *
 * Anchored to a boundary so `https://example.com/#frag` and `C#` are not tags,
 * and required to start with a letter so `#1` in "issue #1" is not one either.
 * These two exclusions are the difference between a tag row and a document
 * sprinkled with false positives.
 */
const TAG_RE = /(^|[\s(])#([\p{L}][\p{L}\p{N}_/-]*)/gu

const text = (value: string): HastNode => ({ type: 'text', value })

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? ''
  if (!node.children) return ''
  return node.children.map(textOf).join('')
}

/**
 * Walks a tree, replacing text nodes, without descending into code.
 *
 * Written as an explicit recursion rather than with `visit` because a replaced
 * text node becomes several nodes, and mutating a parent's children while a
 * visitor is walking it is how you get half a document transformed.
 */
function rewriteText(
  node: HastNode,
  rewrite: (value: string) => HastNode[] | null
): void {
  if (!node.children) return
  if (node.tagName !== undefined && OPAQUE.has(node.tagName)) return

  const out: HastNode[] = []
  let changed = false
  for (const child of node.children) {
    if (child.type === 'text') {
      const replacement = rewrite(child.value ?? '')
      if (replacement) {
        out.push(...replacement)
        changed = true
        continue
      }
      out.push(child)
      continue
    }
    rewriteText(child, rewrite)
    out.push(child)
  }
  if (changed) node.children = out
}

// ---------------------------------------------------------------------------
// The transforms
// ---------------------------------------------------------------------------

/**
 * `[[wikilink]]`, `[[note|alias]]`, `[[note#heading]]`, `![[embed]]`.
 *
 * A link that resolves gets the absolute path it resolved to; one that does not
 * gets `data-broken` and is styled as a note worth writing. Nothing is dropped
 * and nothing throws - a vault whose links are half-written is the normal case,
 * not the error case.
 */
function applyWikilinks(
  tree: HastNode,
  options: RenderMarkdownOptions,
  links: ContentWikilink[]
): void {
  rewriteText(tree, (value) => {
    if (!value.includes('[[')) return null
    WIKILINK_RE.lastIndex = 0
    const out: HastNode[] = []
    let at = 0
    let matched = false

    for (let match = WIKILINK_RE.exec(value); match; match = WIKILINK_RE.exec(value)) {
      matched = true
      const [whole, bang, name = '', hash = '', alias = ''] = match
      if (match.index > at) out.push(text(value.slice(at, match.index)))
      at = match.index + whole.length

      const link = parseWikilink(`${name}${hash}${alias}`, bang === '!')
      const resolved = options.index
        ? resolveWikilink(options.index, link, options.path ?? null)
        : null
      links.push({
        target: link.target,
        label: link.label,
        heading: link.heading,
        resolved
      })

      out.push({
        type: 'element',
        tagName: 'a',
        properties: {
          className: resolved === null ? ['wikilink', 'wikilink-broken'] : ['wikilink'],
          href: '#',
          'data-wikilink': link.target,
          ...(resolved === null ? { 'data-wikilink-broken': 'true' } : { 'data-wikilink-path': resolved }),
          ...(link.heading ? { 'data-wikilink-heading': headingSlug(link.heading) } : {}),
          title:
            resolved === null
              ? `No note called “${link.target}” in this scope yet`
              : resolved
        },
        children: [text(link.label)]
      })
    }

    if (!matched) return null
    if (at < value.length) out.push(text(value.slice(at)))
    return out
  })
}

/** `#tag`, shown as a chip inline the way the vault writes them. */
function applyTags(tree: HastNode, tags: Set<string>): void {
  rewriteText(tree, (value) => {
    if (!value.includes('#')) return null
    TAG_RE.lastIndex = 0
    const out: HastNode[] = []
    let at = 0
    let matched = false

    for (let match = TAG_RE.exec(value); match; match = TAG_RE.exec(value)) {
      const [whole, lead = '', name = ''] = match
      matched = true
      const start = match.index + lead.length
      if (start > at) out.push(text(value.slice(at, start)))
      at = match.index + whole.length
      tags.add(name)
      out.push({
        type: 'element',
        tagName: 'span',
        properties: { className: ['md-tag'], 'data-tag': name },
        children: [text(`#${name}`)]
      })
    }

    if (!matched) return null
    if (at < value.length) out.push(text(value.slice(at)))
    return out
  })
}

/**
 * Obsidian callouts: a blockquote whose first line is `> [!note] Title`.
 *
 * Turned into a `div` rather than left as a styled blockquote because a
 * callout is not a quotation - it is an admonition, and a reader who has seen
 * one in Obsidian is looking for the coloured box, not an indented rule.
 */
function applyCallouts(tree: HastNode, counts: ContentCounts): void {
  visit(tree as never, 'element', (node: HastNode) => {
    if (node.tagName !== 'blockquote' || !node.children) return
    const first = node.children.find((child) => child.type === 'element' && child.tagName === 'p')
    if (!first?.children) return
    const lead = first.children[0]
    if (!lead || lead.type !== 'text') return

    const match = CALLOUT_RE.exec(lead.value ?? '')
    if (!match) return

    const kind = (match[1] ?? 'note').toLowerCase()
    const fold = match[2] ?? ''
    const rest = match[3] ?? ''

    // The marker is consumed and whatever followed it on the same line becomes
    // the title. What follows on *later* lines is the body, so the paragraph is
    // split rather than replaced.
    const [titleText, ...bodyLines] = rest.split('\n')
    lead.value = bodyLines.join('\n').replace(/^\n+/, '')
    if ((lead.value ?? '') === '') first.children.shift()
    if (first.children.length === 0) {
      node.children = node.children.filter((child) => child !== first)
    }

    const title = (titleText ?? '').trim()
    node.tagName = 'div'
    node.properties = {
      className: ['callout', `callout-${kind}`],
      'data-callout': kind,
      ...(fold !== '' ? { 'data-callout-fold': fold } : {})
    }
    node.children = [
      {
        type: 'element',
        tagName: 'p',
        properties: { className: ['callout-title'], 'data-callout-title': kind },
        children: [
          {
            type: 'element',
            tagName: 'span',
            properties: { className: ['callout-kind'] },
            children: [text(title === '' ? kind : title)]
          }
        ]
      },
      ...(node.children ?? [])
    ]
    counts.callouts++
  })
}

/** Anchors, so `[[note#heading]]` and `[text](#heading)` have somewhere to land. */
function applyHeadings(tree: HastNode, headings: ContentHeading[]): void {
  const used = new Map<string, number>()
  visit(tree as never, 'element', (node: HastNode) => {
    const tag = node.tagName ?? ''
    if (!/^h[1-6]$/.test(tag)) return
    const label = textOf(node).trim()
    const base = headingSlug(label) || 'section'
    const seen = used.get(base) ?? 0
    used.set(base, seen + 1)
    const slug = seen === 0 ? base : `${base}-${String(seen)}`
    node.properties = { ...(node.properties ?? {}), 'data-heading': slug }
    headings.push({ depth: Number(tag.slice(1)), text: label, slug })
  })
}

/**
 * Puts every table in its own horizontal scroller.
 *
 * A seven-column measurement table in a 74ch column has to go somewhere, and
 * the two alternatives are both worse: wrapping the cells turns a table of
 * numbers into a wall, and letting it overflow makes the *document* scroll
 * sideways, which moves the prose out from under the reader.
 */
function wrapTables(tree: HastNode): void {
  visit(tree as never, 'element', (node: HastNode, index: number | undefined, parent: HastNode | undefined) => {
    if (node.tagName !== 'table' || !parent?.children || index === undefined) return
    if (parent.tagName === 'div' && (parent.properties?.['className'] as string[] | undefined)?.includes('md-table-scroll')) {
      return
    }
    parent.children[index] = {
      type: 'element',
      tagName: 'div',
      properties: { className: ['md-table-scroll'] },
      children: [node]
    }
  })
}

function countStructures(tree: HastNode, counts: ContentCounts): void {
  visit(tree as never, 'element', (node: HastNode) => {
    const tag = node.tagName ?? ''
    if (tag === 'table') counts.tables++
    if (tag === 'input' && (node.properties?.['type'] ?? '') === 'checkbox') {
      counts.taskItems++
      if (node.properties?.['checked'] === true || node.properties?.['checked'] === 'checked') {
        counts.taskItemsChecked++
      }
    }
  })
}

/**
 * Replaces every `<pre><code>` with shiki's markup.
 *
 * The replacement is a raw node - the highlighter returns a string of HTML and
 * re-parsing it into hast only to serialise it again would be work for nothing.
 * That is safe here and nowhere else in this file: this string is generated by
 * shiki from the block's *text content*, after the sanitiser has already run
 * over the document.
 */
async function applyHighlighting(
  tree: HastNode,
  counts: ContentCounts,
  unknown: Set<string>
): Promise<void> {
  const blocks: Array<{ node: HastNode; code: string; language: string }> = []

  visit(tree as never, 'element', (node: HastNode) => {
    if (node.tagName !== 'pre' || !node.children) return
    const child = node.children.find((c) => c.type === 'element' && c.tagName === 'code')
    if (!child) return
    const className = child.properties?.['className']
    const classes = Array.isArray(className) ? className.map(String) : []
    const declared = classes.find((name) => name.startsWith('language-'))?.slice('language-'.length)
    blocks.push({ node, code: textOf(child).replace(/\n$/, ''), language: declared ?? '' })
  })

  counts.codeBlocks = blocks.length

  for (const block of blocks) {
    const result = await highlightCode(block.code, block.language)
    if (block.language !== '' && !result.highlighted) unknown.add(block.language)
    if (result.html === '') continue
    if (result.highlighted) counts.highlightedBlocks++
    // Kept on the wrapper so the stylesheet can label the block with its
    // language and a copy button has something to read.
    const labelled = result.html.replace(
      /^<pre /,
      `<pre data-language="${result.highlighted ? result.language : 'text'}" `
    )
    block.node.type = 'raw'
    block.node.value = labelled
    delete block.node.tagName
    delete block.node.properties
    delete block.node.children
  }
}

// ---------------------------------------------------------------------------

const PROCESSOR = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, SCHEMA)

const STRINGIFY = unified().use(rehypeStringify, { allowDangerousHtml: true })

function emptyCounts(): ContentCounts {
  return {
    tables: 0,
    taskItems: 0,
    taskItemsChecked: 0,
    codeBlocks: 0,
    highlightedBlocks: 0,
    callouts: 0,
    wikilinks: 0,
    brokenWikilinks: 0,
    tags: 0,
    headings: 0
  }
}

/** Words, counted over the body rather than the whole file - the frontmatter is
 * metadata and counting it would inflate every short note by a dozen. */
function countWords(body: string): number {
  const matches = body.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu)
  return matches ? matches.length : 0
}

export async function renderMarkdown(
  source: string,
  options: RenderMarkdownOptions = {}
): Promise<RenderedMarkdown> {
  const started = Date.now()
  const front =
    options.frontmatter === false
      ? { present: false, raw: '', body: source, endLine: 0, fields: [], data: null, error: null }
      : parseNoteFrontmatter(source)
  const counts = emptyCounts()
  const links: ContentWikilink[] = []
  const headings: ContentHeading[] = []
  const tags = new Set<string>()
  const unknown = new Set<string>()

  const mdast = PROCESSOR.parse(front.body)
  const tree = (await PROCESSOR.run(mdast)) as unknown as HastNode

  applyCallouts(tree, counts)
  applyHeadings(tree, headings)
  applyWikilinks(tree, options, links)
  applyTags(tree, tags)
  countStructures(tree, counts)
  wrapTables(tree)
  await applyHighlighting(tree, counts, unknown)

  counts.wikilinks = links.length
  counts.brokenWikilinks = links.filter((link) => link.resolved === null).length
  counts.headings = headings.length
  counts.tags = tags.size

  const html = STRINGIFY.stringify(tree as never)

  return {
    html,
    frontmatter: {
      present: front.present,
      fields: front.fields,
      raw: front.raw,
      error: front.error,
      endLine: front.endLine
    },
    headings,
    links,
    tags: [...tags].sort(),
    words: countWords(front.body),
    counts,
    unknownLanguages: [...unknown].sort(),
    tookMs: Date.now() - started
  }
}
