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
 * top-level directory is checked for readable content and included if it has
 * any.
 *
 * **This is a curation model, and curation is only correct for a harness.** In
 * a project the same rule produces neither a curated set nor a complete one -
 * `packages/` appears because one package has a README while `src/` does not
 * appear at all - so a project scope opens on `filetree.ts` instead. See
 * SPEC 4.3. Curation decides which *directories* are offered; it does not get
 * to decide which files inside one are shown.
 *
 * `repos/` is the one deliberate exclusion **here**, in the curated view. Each
 * repo underneath it is a scope in its own right, and folding their notes into
 * the harness's would make the scope switcher meaningless - a curated list is a
 * short list, and one that quietly contained six other projects' notes would
 * not be. The tree view descends into it: `FALLBACK_SKIPPED_DIRS` in
 * `filetree.ts` is the other half of that answer.
 */

/** Deep enough for `docs/adr/2026/thing.md`, shallow enough to end. */
const MAX_DEPTH = 6

/** A ceiling so a scope pointed at something enormous still paints. */
const MAX_FILES = 5000

/** Read far enough into a file to have passed the frontmatter and the first heading. */
const HEAD_BYTES = 8192

/**
 * Directories the curated walk does not enter.
 *
 * Exported because the tree view's fallback - what it hides when there is no
 * repository to ask about `.gitignore` - is this list minus one entry, and two
 * copies of it would drift. `filetree.ts` says which entry and why.
 */
export const CURATED_SKIPPED_DIRS = new Set([
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
const TEXT_EXT = new Set(['.txt', '.csv', '.log', '.text', '.rst', '.adoc'])

/**
 * Extensions that open in the source view, mirroring the config tree's
 * `TEXT_EXT` and extended for what an agent actually writes into a harness.
 *
 * The list is generous on purpose. Getting it wrong in this direction costs a
 * syntax-highlighted pane for a file that would have read fine as plain text;
 * getting it wrong in the other direction is the bug this task is named for -
 * a file that exists, that the agent wrote, and that the pane does not admit
 * to. Anything not listed anywhere is `binary`, which is still **shown**.
 */
const SOURCE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.mts', '.cts', '.tsx',
  '.py', '.pyi', '.rb', '.pl', '.php', '.lua', '.r',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.psd1', '.bat', '.cmd',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.java', '.kt', '.kts', '.swift',
  '.go', '.rs', '.scala', '.clj', '.ex', '.exs', '.erl', '.hs', '.ml', '.vb',
  '.sql', '.graphql', '.gql', '.proto',
  '.css', '.scss', '.sass', '.less',
  '.vue', '.svelte', '.astro',
  '.ini', '.cfg', '.conf', '.properties', '.env', '.editorconfig',
  '.gitignore', '.gitattributes', '.dockerignore', '.npmrc', '.nvmrc',
  '.xml', '.svg', '.patch', '.diff', '.make', '.mk', '.cmake', '.gradle',
  '.tf', '.tfvars', '.nix', '.vim', '.el', '.applescript'
])

/** The four the spec names, in the order it names them. */
const NAMED_ROOTS: Array<{ rel: string; kind: ContentRootKind; label: string }> = [
  { rel: 'notes', kind: 'notes', label: 'Notes' },
  { rel: 'context', kind: 'context', label: 'Context' },
  { rel: '.claude/skills', kind: 'skills', label: 'Skills' },
  { rel: 'docs', kind: 'docs', label: 'Docs' }
]

/**
 * The part of a name that decides its kind.
 *
 * A leading dot is the whole name, not an empty extension: `.gitignore` and
 * `.npmrc` are files somebody edits, and reading them as "no extension" put
 * them in the same bucket as a `.dll`.
 */
export function contentExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return ''
  if (dot === 0) return name.toLowerCase()
  return name.slice(dot).toLowerCase()
}

/**
 * How a file opens - never whether it is listed.
 *
 * This used to return `null` for anything it did not recognise and the walk
 * used that as a filter, which is how `tools/rep-payload.py` came to be absent
 * from a pane whose whole job is showing what the agent wrote. Now every file
 * has a kind: unrecognised is `binary`, which is listed, greyed, and opened in
 * Explorer rather than in Helm.
 */
export function contentFileKind(name: string): ContentFileKind {
  const ext = contentExtension(name)
  if (MARKDOWN_EXT.has(ext)) return 'markdown'
  if (HTML_EXT.has(ext)) return 'html'
  if (DATA_EXT.has(ext)) return 'data'
  if (TEXT_EXT.has(ext)) return 'text'
  if (SOURCE_EXT.has(ext)) return 'source'
  // A file with no extension at all is text until proved otherwise. `LICENSE`,
  // `Makefile`, `Dockerfile`, `CODEOWNERS`, `Procfile` - every extensionless
  // file a repository normally holds is one somebody reads, and greying them
  // was this rule making the omission it was written to end, in the one place
  // no extension list can reach. A name-by-name table would always be one
  // convention behind; the byte check inside `readConfigFileContent` is the
  // backstop, and it says "could not read this as text" for the rare case that
  // really is a blob.
  if (ext === '') return 'text'
  // And the same argument for a dotfile whose whole name is its "extension":
  // `.gitkeep`, `.prettierrc`, `.babelrc`, `.editorconfig`. These are tooling
  // configuration, which is to say text, and the named ones above are only the
  // ones that happened to get written down.
  if (ext === name.toLowerCase()) return 'source'
  return 'binary'
}

/**
 * Whether a file is evidence that the directory holding it is content.
 *
 * Source counts, which is the change: a directory of nothing but scripts is a
 * directory of things the agent wrote, and `tools/` is a directory the harness
 * layout names for exactly that. Binary does not count, and that is the same
 * judgement as before wearing a different name - a directory of PNGs called
 * `docs-images` is not a place to go reading, and offering it as a root would
 * put a list of unopenable rows on screen for nothing.
 */
export function countsAsContent(kind: ContentFileKind): boolean {
  return kind !== 'binary'
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
  const kind = contentFileKind(name)
  const rawExt = contentExtension(name)
  // The name without its extension - and the whole name when the "extension" is
  // the whole name. `.gitignore` used to slug to the empty string, which put a
  // row on screen with a size, a date and no name at all: the failure this
  // surface is about, arriving through the fix for it.
  const slug = rawExt === '' || rawExt === name.toLowerCase() ? name : name.slice(0, -rawExt.length)
  const ext = rawExt.replace(/^\./, '')

  /**
   * The name, unless the file carries a better one inside it.
   *
   * Prose has a title - frontmatter, or the first heading - and stripping `.md`
   * off the fallback reads better than keeping it. A `package.json` has no
   * title, and calling it "package" is a viewer editing the name of a file
   * somebody is looking for by its full name. So the default is the filename,
   * and only the two rendered kinds go looking for something better.
   */
  let title = kind === 'markdown' || kind === 'html' ? slug : name
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
    ext,
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
        if (CURATED_SKIPPED_DIRS.has(entry.name.toLowerCase())) continue
        walk(path, root, depth + 1)
        continue
      }
      if (!entry.isFile()) continue

      // No kind filter. A root that is offered lists **everything** inside it;
      // the kind decides which surface opens, not whether the row exists.

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

  /**
   * The scope's own top-level files: CLAUDE.md, README.md, a loose spec.
   *
   * `named`, because it is offered by rule rather than because a walk found
   * something. That is what the badge means - *why* this directory is on the
   * list - and it is the one question the old heuristic left the reader to
   * infer.
   */
  const rootLevel: ContentRoot = {
    kind: 'root',
    offer: 'named',
    relPath: '',
    path: scope.path,
    label: scope.label,
    files: 0
  }
  try {
    for (const entry of readdirSync(scope.path, { withFileTypes: true })) {
      if (!entry.isFile()) continue
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
  // Unlike the four the spec names, this one is listed only when it holds
  // something. "`docs/` is empty" is a fact about a directory somebody went
  // looking for by name; "the scope directory has no loose files" is the tidy
  // case rather than a finding, and a row saying it would be on screen in every
  // scope that keeps its files in subdirectories.
  if (rootLevel.files > 0) roots.push(rootLevel)

  const claimed = new Set<string>()
  for (const named of NAMED_ROOTS) {
    const path = join(scope.path, ...named.rel.split('/'))
    if (!isDir(path)) continue
    claimed.add(named.rel.split('/')[0]?.toLowerCase() ?? '')
    const root: ContentRoot = {
      kind: named.kind,
      offer: 'named',
      relPath: named.rel,
      path,
      label: named.label,
      files: 0
    }
    walk(path, root, 1)
    // Listed whether or not it holds anything. An empty `docs/` is
    // present-and-empty, and dropping it would be the same silent omission this
    // whole surface exists to stop - one level down, where it is harder to see.
    roots.push(root)
  }

  // Everything else at the top level that turns out to hold something readable.
  // Checked by walking it, which is the only honest test - a directory of PNGs
  // named `docs-images` is not content and no name-based rule would know. What
  // *counts* as readable now includes source, which is what makes a `tools/`
  // holding nothing but scripts a root rather than a directory that vanishes.
  let discovered: ContentRoot[] = []
  try {
    for (const entry of readdirSync(scope.path, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const lower = entry.name.toLowerCase()
      if (CURATED_SKIPPED_DIRS.has(lower) || claimed.has(lower)) continue
      // Dot directories are tooling, not content. `.claude/skills` is the one
      // exception and it is already a named root above.
      if (entry.name.startsWith('.')) continue
      const root: ContentRoot = {
        kind: 'found',
        offer: 'discovered',
        relPath: entry.name,
        path: join(scope.path, entry.name),
        label: entry.name,
        files: 0
      }
      const before = files.length
      walk(root.path, root, 1)
      // Offered only if the walk found something worth *reading*. A directory
      // that produced nothing but binaries is dropped, and dropping it is a
      // judgement about the directory rather than about its files - the files
      // inside a root that is offered are all listed, binaries included.
      if (files.slice(before).some((file) => countsAsContent(file.kind))) {
        discovered.push(root)
      } else {
        files.length = before
        root.files = 0
      }
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
