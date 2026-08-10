import { parse as parseYaml } from 'yaml'
import type { ContentChip } from '../types'

/**
 * The YAML block at the top of a note, parsed for display rather than for edit.
 *
 * There are now two frontmatter parsers in this repo and that is deliberate.
 * `config/validate.ts` has a hand-rolled one because it runs in the renderer on
 * a file somebody is *typing into*, where a real parser throwing on a
 * half-finished document would blank the header on every other keystroke. This
 * one runs in the main process on a file that is already on disk, and it has to
 * understand the shapes the vault actually uses - `tags: [a, b]`, block
 * sequences, quoted dates - which the flat scalar reader cannot see.
 *
 * The failure mode that matters is the one the criterion names: frontmatter
 * shown as raw text. So a block that will not parse still reports `present`,
 * still gets stripped from the body, and shows its error - it never falls
 * through to the renderer as three dashes and a heading.
 */

export interface ParsedFrontmatter {
  present: boolean
  /** The text between the fences, without them. */
  raw: string
  /** The document after the closing fence. */
  body: string
  /** 1-based line the closing fence sits on. 0 when there is no block. */
  endLine: number
  fields: ContentChip[]
  /** The parsed document, when it parsed. */
  data: Record<string, unknown> | null
  error: string | null
}

const EMPTY: ParsedFrontmatter = {
  present: false,
  raw: '',
  body: '',
  endLine: 0,
  fields: [],
  data: null,
  error: null
}

/**
 * Keys shown first, in this order, because they are the ones the vault's own
 * convention puts there (`type`, `date`, `tags`) and the order a person reads
 * them in. Anything else follows in file order rather than alphabetically -
 * a note that lists `status` before `owner` meant something by it.
 */
const LEADING_KEYS = ['title', 'type', 'date', 'tags']

/** One value, as a chip shows it. Objects are summarised rather than dumped. */
function scalar(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (Array.isArray(value)) return value.map(scalar).filter((v) => v !== '').join(', ')
  return JSON.stringify(value)
}

function chipsFor(data: Record<string, unknown>): ContentChip[] {
  const chips: ContentChip[] = []
  const keys = [
    ...LEADING_KEYS.filter((key) => key in data),
    ...Object.keys(data).filter((key) => !LEADING_KEYS.includes(key))
  ]
  for (const key of keys) {
    const value = data[key]
    if (value === null || value === undefined) continue
    const values = Array.isArray(value)
      ? value.map(scalar).filter((v) => v !== '')
      : [scalar(value)].filter((v) => v !== '')
    if (values.length === 0) continue
    chips.push({ key, value: values.join(', '), values })
  }
  return chips
}

/**
 * Splits the block off the document.
 *
 * Tolerates a BOM and CRLF: a note written by another editor has both, and
 * neither means the note has no frontmatter. The opening fence must be the very
 * first line - a `---` further down is a horizontal rule, and treating it as
 * frontmatter would eat the top of the document.
 */
export function parseNoteFrontmatter(source: string): ParsedFrontmatter {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source
  const lines = text.split('\n')
  if ((lines[0] ?? '').replace(/\r$/, '').trim() !== '---') {
    return { ...EMPTY, body: text }
  }

  let end = -1
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').replace(/\r$/, '').trim()
    if (line === '---' || line === '...') {
      end = i
      break
    }
  }
  // An opening fence with no closing one is not frontmatter, it is a document
  // that starts with a rule. Rendering it as a block would swallow everything.
  if (end < 0) return { ...EMPTY, body: text }

  const raw = lines
    .slice(1, end)
    .map((line) => line.replace(/\r$/, ''))
    .join('\n')
  const body = lines.slice(end + 1).join('\n')

  let data: Record<string, unknown> | null = null
  let error: string | null = null
  try {
    const parsed: unknown = parseYaml(raw === '' ? '{}' : raw)
    if (parsed === null || parsed === undefined) {
      data = {}
    } else if (typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>
    } else {
      error = 'The frontmatter is not a set of key/value pairs.'
    }
  } catch (err) {
    error = err instanceof Error ? err.message.split('\n')[0] ?? 'Unparseable' : String(err)
  }

  return {
    present: true,
    raw,
    body,
    endLine: end + 1,
    fields: data ? chipsFor(data) : [],
    data,
    error
  }
}

/** One frontmatter value as a string, for the list rows. */
export function frontmatterString(data: Record<string, unknown> | null, key: string): string | null {
  if (!data) return null
  const value = data[key]
  if (value === null || value === undefined) return null
  const text = scalar(value)
  return text === '' ? null : text
}

/** `tags: [a, b]`, `tags: a, b`, or a block sequence - all of them as a list. */
export function frontmatterTags(data: Record<string, unknown> | null): string[] {
  if (!data) return []
  const value = data['tags']
  if (value === null || value === undefined) return []
  const list = Array.isArray(value) ? value.map(scalar) : scalar(value).split(',')
  return list.map((tag) => tag.trim().replace(/^#/, '')).filter((tag) => tag !== '')
}
