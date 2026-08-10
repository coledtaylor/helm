import { openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import type {
  ConfigScopeKind,
  ContentFile,
  ContentFileKind,
  ContentRoot,
  ContentRootKind,
  ContentScope,
  ContentTree
} from '../types'
import { frontmatterString, frontmatterTags, parseNoteFrontmatter } from './frontmatter'

/**
 * The readable content of a scope, found rather than configured.
 *
 * The spec names four directories - `notes/`, `context/`, `.claude/skills/`,
 * `docs/` - and those are always offered first when they exist, because they
 * are the ones somebody goes looking for by name. But "any file Claude
 * produced" is the actual brief, and on this machine that means
 * `lessons/0001-...html` and `reference/glossary.html` at the harness root:
 * artifacts, in directories no specification could have listed. So every other
 * top-level directory is checked for markdown or HTML and included if it has
 * any.
 *
 * `repos/` is the one deliberate exclusion. Each repo underneath it is a scope
 * in its own right, and folding their notes into the harness's would make the
 * scope switcher meaningless.
 */

/** Deep enough for `docs/adr/2026/thing.md`, shallow enough to end. */
const MAX_DEPTH = 6

/** A ceiling so a scope pointed at something enormous still paints. */
const MAX_FILES = 5000

/** Read far enough into a file to have passed the frontmatter and the first heading. */
const HEAD_BYTES = 8192

const SKIPPED_DIRS = new Set([
  'repos',
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'out',
  'dist',
  'build',
  'coverage',
  'target',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
  '.vite',
  'bin',
  'obj',
  'vendor',
  'site-packages',
  '.pytest_cache',
  '.mypy_cache',
  '.idea',
  '.vs',
  '.vscode'
])

const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdx'])
const HTML_EXT = new Set(['.html', '.htm'])
const DATA_EXT = new Set(['.yaml', '.yml', '.json', '.jsonc', '.toml'])
const TEXT_EXT = new Set(['.txt', '.csv', '.log'])

/** The four the spec names, in the order it names them. */
const NAMED_ROOTS: Array<{ rel: string; kind: ContentRootKind; label: string }> = [
  { rel: 'notes', kind: 'notes', label: 'Notes' },
  { rel: 'context', kind: 'context', label: 'Context' },
  { rel: '.claude/skills', kind: 'skills', label: 'Skills' },
  { rel: 'docs', kind: 'docs', label: 'Docs' }
]

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

export function contentFileKind(name: string): ContentFileKind | null {
  const ext = extensionOf(name)
  if (MARKDOWN_EXT.has(ext)) return 'markdown'
  if (HTML_EXT.has(ext)) return 'html'
  if (DATA_EXT.has(ext)) return 'data'
  if (TEXT_EXT.has(ext)) return 'text'
  return null
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function contentScope(
  path: string,
  kind: ConfigScopeKind = 'project',
  label?: string
): ContentScope {
  const base = resolve(path)
  return { kind, path: base, label: label ?? (basename(base) || base) }
}

/**
 * The first `HEAD_BYTES` of a file.
 *
 * A partial read rather than `readFileSync`, because this runs over every file
 * in a scope on every scan and the answer it is after - frontmatter, then the
 * first heading - is in the first few hundred bytes of all of them. The 21 KB
 * note in this vault is not read to learn that its title is "Report Center".
 */
function readHead(path: string): string {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(HEAD_BYTES)
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // Already gone; nothing to release.
      }
    }
  }
}

/** The first ATX heading, which is a note's title when the frontmatter has none. */
function firstHeading(body: string): string | null {
  for (const line of body.split('\n', 400)) {
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line.replace(/\r$/, ''))
    if (match && (match[1] ?? '').trim() !== '') return (match[1] ?? '').trim()
  }
  return null
}

function describeFile(path: string, relPath: string, root: ContentRoot, stat: { size: number; mtimeMs: number }): ContentFile {
  const name = basename(path)
  const kind = contentFileKind(name) ?? 'text'
  const slug = name.replace(/\.[^.]+$/, '')

  let title = slug
  let noteType: string | null = null
  let date: string | null = null
  let tags: string[] = []

  if (kind === 'markdown') {
    const head = readHead(path)
    const front = parseNoteFrontmatter(head)
    noteType = frontmatterString(front.data, 'type')
    date = frontmatterString(front.data, 'date')
    tags = frontmatterTags(front.data)
    title = frontmatterString(front.data, 'title') ?? firstHeading(front.body) ?? slug
    // A skill is addressed by its directory, not by `SKILL.md` - the same
    // distinction the config console makes, and for the same reason.
    if (name.toLowerCase() === 'skill.md') {
      const parent = basename(join(path, '..'))
      title = frontmatterString(front.data, 'name') ?? parent
    }
  } else if (kind === 'html') {
    const head = readHead(path)
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)
    const captured = (match?.[1] ?? '').replace(/\s+/g, ' ').trim()
    if (captured !== '') title = captured
  }

  return {
    path,
    relPath,
    root: root.relPath,
    rootKind: root.kind,
    kind,
    slug,
    title,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    noteType,
    date,
    tags
  }
}

function relativeSlashed(from: string, path: string): string {
  return relative(from, path).split(sep).join('/')
}

/**
 * Everything readable in a scope, grouped by the directory it came from.
 *
 * Symlinked directories are not followed, for the reason the config tree does
 * not follow them either: an overlay shim's junction points back into a real
 * repository, and walking one would list another project's notes as this
 * scope's - and a link that points at an ancestor would not finish.
 */
export function readContentTree(scope: ContentScope): ContentTree {
  const started = Date.now()
  const roots: ContentRoot[] = []
  const files: ContentFile[] = []
  const errors: string[] = []

  const walk = (dir: string, root: ContentRoot, depth: number): void => {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      errors.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.isSymbolicLink()) continue
        if (SKIPPED_DIRS.has(entry.name.toLowerCase())) continue
        walk(path, root, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (contentFileKind(entry.name) === null) continue

      let stat
      try {
        stat = statSync(path)
      } catch {
        // Deleted between the readdir and the stat. Not there, so not listed.
        continue
      }
      files.push(describeFile(path, relativeSlashed(scope.path, path), root, stat))
      root.files++
    }
  }

  /** The scope's own top-level files: CLAUDE.md, README.md, a loose spec. */
  const rootLevel: ContentRoot = {
    kind: 'root',
    relPath: '',
    path: scope.path,
    label: scope.label,
    files: 0
  }
  try {
    for (const entry of readdirSync(scope.path, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (contentFileKind(entry.name) === null) continue
      const path = join(scope.path, entry.name)
      try {
        const stat = statSync(path)
        files.push(describeFile(path, entry.name, rootLevel, stat))
        rootLevel.files++
      } catch {
        continue
      }
    }
  } catch (err) {
    errors.push(`${scope.path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (rootLevel.files > 0) roots.push(rootLevel)

  const claimed = new Set<string>()
  for (const named of NAMED_ROOTS) {
    const path = join(scope.path, ...named.rel.split('/'))
    if (!isDir(path)) continue
    claimed.add(named.rel.split('/')[0]?.toLowerCase() ?? '')
    const root: ContentRoot = {
      kind: named.kind,
      relPath: named.rel,
      path,
      label: named.label,
      files: 0
    }
    walk(path, root, 1)
    if (root.files > 0) roots.push(root)
  }

  // Everything else at the top level that turns out to hold something readable.
  // Checked by walking it, which is the only honest test - a directory of PNGs
  // named `docs-images` is not content and no name-based rule would know.
  let discovered: ContentRoot[] = []
  try {
    for (const entry of readdirSync(scope.path, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const lower = entry.name.toLowerCase()
      if (SKIPPED_DIRS.has(lower) || claimed.has(lower)) continue
      // Dot directories are tooling, not content. `.claude/skills` is the one
      // exception and it is already a named root above.
      if (entry.name.startsWith('.')) continue
      const root: ContentRoot = {
        kind: 'found',
        relPath: entry.name,
        path: join(scope.path, entry.name),
        label: entry.name,
        files: 0
      }
      const before = files.length
      walk(root.path, root, 1)
      if (files.length > before) discovered.push(root)
    }
  } catch {
    // Already reported by the top-level file read above.
  }
  discovered = discovered.sort((a, b) => a.label.localeCompare(b.label))
  roots.push(...discovered)

  // Newest first inside a root: a notes directory is a journal, and the thing
  // most worth opening is nearly always the thing most recently written.
  const rootOrder = new Map(roots.map((root, index) => [root.relPath, index]))
  files.sort((a, b) => {
    const byRoot = (rootOrder.get(a.root) ?? 99) - (rootOrder.get(b.root) ?? 99)
    if (byRoot !== 0) return byRoot
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs
    return a.relPath.localeCompare(b.relPath)
  })

  return {
    scope,
    roots,
    files,
    errors,
    scannedAt: new Date().toISOString(),
    tookMs: Date.now() - started
  }
}
