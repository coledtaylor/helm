import type { ContentFile } from '../types'

/**
 * `[[wikilink]]` resolution, the way Obsidian resolves it.
 *
 * The rule that matters is that a link is written by *name*, not by path:
 * `[[reference-session-history]]` finds
 * `notes/reference-session-history.md` from anywhere in the vault. So
 * the index is keyed three ways - bare name, path without extension, and full
 * path - and a link is looked up in that order, because a note called `index`
 * in two directories is a real thing and the more specific spelling has to win.
 *
 * A link that resolves to nothing is *not* an error. The vault's convention is
 * that an unresolved link marks a note worth writing, so the resolver reports
 * the miss and the renderer styles it; nothing is dropped and nothing throws.
 */

export interface ParsedWikilink {
  /** Everything between the brackets, verbatim. */
  target: string
  /** What to show: the alias after `|`, else the target. */
  label: string
  /** The `#heading` part, without the hash. */
  heading: string | null
  /** True for `![[embed]]`, which Helm links rather than inlines. */
  embed: boolean
}

export interface WikiIndex {
  /** Lower-cased name (no extension) to every file that answers to it. */
  byName: Map<string, string[]>
  /** Lower-cased scope-relative path, with and without its extension. */
  byPath: Map<string, string>
  size: number
}

/** The bracket pair, with the leading `!` of an embed. Non-greedy, no nesting. */
export const WIKILINK_RE = /(!?)\[\[([^\][\n|#][^\][\n]*?)?((?:#[^\][\n|]*)?)((?:\|[^\][\n]*)?)\]\]/g

export function buildWikiIndex(files: readonly ContentFile[]): WikiIndex {
  const byName = new Map<string, string[]>()
  const byPath = new Map<string, string>()

  for (const file of files) {
    const name = file.slug.toLowerCase()
    const existing = byName.get(name)
    if (existing) existing.push(file.path)
    else byName.set(name, [file.path])

    const rel = file.relPath.toLowerCase()
    if (!byPath.has(rel)) byPath.set(rel, file.path)
    const withoutExt = rel.replace(/\.[^./]+$/, '')
    if (!byPath.has(withoutExt)) byPath.set(withoutExt, file.path)
  }

  return { byName, byPath, size: files.length }
}

/**
 * Splits `name#heading|alias` into its parts.
 *
 * Order is fixed by Obsidian's own syntax: the heading comes before the alias,
 * so `[[note#Section|Read this]]` is a link to `note`, scrolled to `Section`,
 * displayed as `Read this`. Parsing them the other way round produces a target
 * called `note` and a heading called `Section|Read this`, which resolves and
 * then silently scrolls nowhere.
 */
export function parseWikilink(raw: string, embed = false): ParsedWikilink {
  const text = raw.trim()
  const pipe = text.indexOf('|')
  const beforeAlias = pipe < 0 ? text : text.slice(0, pipe)
  const alias = pipe < 0 ? null : text.slice(pipe + 1).trim()

  const hash = beforeAlias.indexOf('#')
  const target = (hash < 0 ? beforeAlias : beforeAlias.slice(0, hash)).trim()
  const heading = hash < 0 ? null : beforeAlias.slice(hash + 1).trim() || null

  const label =
    alias && alias !== ''
      ? alias
      : target === ''
        ? (heading ?? text)
        : heading
          ? `${target} § ${heading}`
          : target

  return { target, label, heading, embed }
}

/**
 * The file a link names, or null.
 *
 * `selfPath` is what makes `[[#Heading]]` - a link inside the current note -
 * resolve to the note it is written in rather than to nothing, and it is also
 * the tie-break: two notes called `index` in different directories are both
 * valid answers to `[[index]]`, and the one in the same directory is the one
 * the author meant.
 */
export function resolveWikilink(
  index: WikiIndex,
  link: ParsedWikilink,
  selfPath: string | null = null
): string | null {
  if (link.target === '') return selfPath

  const needle = link.target.toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '')

  const byPath = index.byPath.get(needle) ?? index.byPath.get(needle.replace(/\.[^./]+$/, ''))
  if (byPath) return byPath

  const candidates = index.byName.get(needle.split('/').at(-1) ?? needle)
  if (!candidates || candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0] ?? null

  if (selfPath !== null) {
    const dir = selfPath.slice(0, Math.max(selfPath.lastIndexOf('/'), selfPath.lastIndexOf('\\')))
    const sibling = candidates.find((path) => path.startsWith(dir))
    if (sibling) return sibling
  }
  return candidates[0] ?? null
}

/**
 * A heading's anchor: lower-cased, punctuation dropped, spaces hyphenated.
 *
 * Written here rather than pulled from a slugger package because both ends have
 * to agree - the heading rendered into the document and the `#heading` half of
 * a wikilink pointing at it - and two implementations of "roughly GitHub's
 * rules" agree right up until the first heading with a colon in it.
 */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}
