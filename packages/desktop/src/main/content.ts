import { protocol, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import {
  buildCorpus,
  buildWikiIndex,
  contentScope,
  corpusIsCurrent,
  readConfigFileContent,
  readConfigSnapshots,
  readContentTree,
  renderMarkdown,
  restoreContentSnapshot,
  searchCorpus,
  snapshotKey,
  writeContentFile,
  type ConfigSnapshotMeta,
  type ContentCorpus,
  type ContentDocument,
  type ContentScope,
  type ContentSearchResult,
  type ContentTree,
  type RenderedMarkdown,
  type WikiIndex,
  type WriteConfigRequest,
  type WriteConfigResult
} from '@helm/core'
import { listProfiles } from '@helm/core'
import type { Services } from './services'

/**
 * The content viewer's main-process half.
 *
 * Three things live here that cannot live anywhere else.
 *
 * **The cache.** A scope's tree, its wikilink index and its search corpus are
 * built together and held together, because all three answer questions about
 * the same set of files and rebuilding one without the others produces a viewer
 * that resolves a link to a note the list does not show. The harness scope
 * takes ~250 ms to walk; the search budget is 200 ms. A search that re-walked
 * would fail the criterion on the walk alone, so it does not - it reads the
 * cache and says whether it was warm.
 *
 * **The renderer.** Markdown is turned into HTML here rather than in the
 * window. Shiki's grammars are megabytes that the browser bundle should never
 * carry, the parse for a 21 KB note is milliseconds the UI thread should never
 * spend, and the renderer receiving finished HTML means it injects a string
 * instead of walking a syntax tree on every keystroke of a live preview.
 *
 * **The artifact protocol.** An HTML artifact is the one piece of content Helm
 * shows that it did not produce, so it is served to a sandboxed frame through a
 * scheme of its own, from a directory it is pinned to, under a Content Security
 * Policy that permits no network of any kind. See `registerContentProtocol`.
 */

export interface ContentService {
  scopes: () => ContentScope[]
  tree: (scopePath: string, refresh?: boolean) => ContentTree
  document: (scopePath: string, path: string) => Promise<ContentDocument>
  /** Renders a draft that is not on disk - the split preview while typing. */
  render: (scopePath: string, path: string, source: string) => Promise<RenderedMarkdown>
  search: (scopePath: string, query: string) => ContentSearchResult
  write: (req: WriteConfigRequest) => WriteConfigResult
  snapshots: (scopePath: string, path: string) => ConfigSnapshotMeta[]
  restore: (id: number, path: string) => WriteConfigResult
  /** Mints a URL a sandboxed frame may load, pinned to the file's directory. */
  artifact: (path: string) => { url: string; token: string }
}

export const CONTENT_SCHEME = 'helm-content'

/**
 * What an artifact frame is allowed to do.
 *
 * `default-src 'none'` and no `http:` or `https:` anywhere is the whole point:
 * an artifact renders from the disk it was found on or it does not render.
 * `connect-src 'none'` closes fetch, XHR, WebSocket and EventSource together,
 * which is the set a chart library reaches for when it wants to phone home.
 *
 * Inline script and style are allowed because a generated report is one file
 * with its CSS and its JS inside it - refusing them would mean refusing to
 * render the thing this criterion is about. They can do nothing outside the
 * frame: the frame has no node, no preload, no same-origin, and no network.
 */
const ARTIFACT_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${CONTENT_SCHEME}:`,
  `style-src 'unsafe-inline' ${CONTENT_SCHEME}:`,
  `img-src data: blob: ${CONTENT_SCHEME}:`,
  `font-src data: ${CONTENT_SCHEME}:`,
  `media-src data: blob: ${CONTENT_SCHEME}:`,
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join('; ')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
}

/** Directories artifacts may be served from, keyed by an unguessable token. */
const artifacts = new Map<string, { dir: string; file: string }>()

function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel))
}

/**
 * Serves an artifact and the files beside it, and nothing else on the disk.
 *
 * Two gates, both necessary. The **token** decides which directory is
 * addressable at all - a frame cannot name a path, only a token Helm minted for
 * a file the user opened. The **containment check** then decides which files
 * inside it are reachable, so `../../../.ssh/id_rsa` resolves, fails the
 * check, and returns 403 rather than a private key.
 *
 * Registered on the default session rather than a partition: the frame is a
 * sandboxed iframe of the app's own window, so there is no second session to
 * register on. Its isolation comes from the sandbox attribute and this policy,
 * not from a partition.
 */
export function registerContentProtocol(): void {
  protocol.handle(CONTENT_SCHEME, (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Bad request', { status: 400 })
    }

    const parts = url.pathname.split('/').filter((part) => part !== '')
    const token = parts[0] ?? ''
    const entry = artifacts.get(token)
    if (!entry) return new Response('Not found', { status: 404 })

    const rel = parts
      .slice(1)
      .map((part) => decodeURIComponent(part))
      .join(sep)
    const target = rel === '' ? entry.file : resolve(entry.dir, rel)
    if (!isInside(entry.dir, target)) {
      return new Response('Forbidden', { status: 403 })
    }

    let bytes: Buffer
    try {
      if (!statSync(target).isFile()) return new Response('Not found', { status: 404 })
      bytes = readFileSync(target)
    } catch {
      return new Response('Not found', { status: 404 })
    }

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'content-security-policy': ARTIFACT_CSP,
        'x-content-type-options': 'nosniff',
        // A generated report is read once and edited by hand afterwards; a
        // cached copy of the version before the edit is the wrong answer.
        'cache-control': 'no-store'
      }
    })
  })
}

interface ScopeCache {
  tree: ContentTree
  index: WikiIndex
  corpus: ContentCorpus | null
  builtAt: number
}

export interface ContentServiceDeps {
  services: Services
}

/** How long a tree is trusted before a fresh open re-walks it. */
const TREE_TTL_MS = 30_000

export function createContentService({ services }: ContentServiceDeps): ContentService {
  const cache = new Map<string, ScopeCache>()

  const key = (scopePath: string): string => resolve(scopePath).toLowerCase()

  /**
   * Every scope the viewer can be pointed at.
   *
   * Harnesses first, then projects, then any directory a saved profile names -
   * the same rule the config console uses, and for the same reason: a profile's
   * root decides what a session reads, and a profile built against a folder
   * outside every scanned root would otherwise be unreachable.
   *
   * The user scope is deliberately absent. `~/.claude` is Claude Code's working
   * directory, not a place anybody keeps notes, and walking it means walking
   * `projects/` - hundreds of megabytes of transcripts - to find nothing.
   */
  function scopes(): ContentScope[] {
    const out: ContentScope[] = []
    const seen = new Set<string>()
    const add = (path: string, kind: ContentScope['kind'], label?: string): void => {
      const id = key(path)
      if (seen.has(id)) return
      seen.add(id)
      out.push(contentScope(path, kind, label))
    }

    const projects = services.lastScan?.projects ?? []
    for (const project of projects) {
      if (project.kind === 'harness') add(project.path, 'harness', project.name)
    }
    for (const project of projects) {
      if (project.kind !== 'harness') add(project.path, 'project', project.name)
    }
    for (const profile of listProfiles(services.store)) {
      add(profile.root, 'project')
      for (const overlay of profile.overlays) add(overlay, 'project')
    }
    return out
  }

  function scopeFor(scopePath: string): ContentScope {
    const known = scopes().find((scope) => key(scope.path) === key(scopePath))
    return known ?? contentScope(scopePath)
  }

  function cached(scopePath: string, refresh = false): ScopeCache {
    const id = key(scopePath)
    const existing = cache.get(id)
    if (!refresh && existing && Date.now() - existing.builtAt < TREE_TTL_MS) return existing

    const tree = readContentTree(scopeFor(scopePath))
    const entry: ScopeCache = {
      tree,
      index: buildWikiIndex(tree.files),
      // The corpus is not built here. A scope is opened far more often than it
      // is searched, and reading 3 MB of notes to paint a file list is 3 MB
      // nobody asked for.
      corpus: existing && corpusIsCurrent(existing.corpus, id, tree.files) ? existing.corpus : null,
      builtAt: Date.now()
    }
    cache.set(id, entry)
    return entry
  }

  function invalidate(path: string): void {
    // A save changes one file, but it changes the tree's mtimes, the corpus and
    // - if the file is new - what a wikilink resolves to. Cheaper to drop the
    // scope than to reason about which of the three moved.
    const touched = resolve(path).toLowerCase()
    for (const id of [...cache.keys()]) {
      if (touched.startsWith(id)) cache.delete(id)
    }
  }

  async function document(scopePath: string, path: string): Promise<ContentDocument> {
    const entry = cached(scopePath)
    const absolute = resolve(path)
    const file =
      entry.tree.files.find((candidate) => candidate.path.toLowerCase() === absolute.toLowerCase()) ??
      // A file the tree does not list - opened through a wikilink into a
      // directory the walk bounded out, most plausibly. Still readable.
      cached(scopePath, true).tree.files.find(
        (candidate) => candidate.path.toLowerCase() === absolute.toLowerCase()
      )

    const content = readConfigFileContent(absolute)
    if (!file) {
      return {
        file: {
          path: absolute,
          relPath: relative(resolve(scopePath), absolute).split(sep).join('/'),
          root: '',
          rootKind: 'found',
          kind: 'text',
          slug: absolute.split(sep).at(-1) ?? absolute,
          title: absolute.split(sep).at(-1) ?? absolute,
          size: content.size,
          mtimeMs: content.mtimeMs,
          noteType: null,
          date: null,
          tags: []
        },
        content,
        rendered: null,
        error: content.exists ? null : 'That file is not there any more.'
      }
    }

    if (file.kind !== 'markdown' || content.binary || !content.exists) {
      return { file, content, rendered: null, error: null }
    }

    try {
      const rendered = await renderMarkdown(content.content, {
        index: entry.index,
        path: file.path
      })
      return { file, content, rendered, error: null }
    } catch (err) {
      // The source still shows. A document that will not render is a bug worth
      // seeing, not a reason to show nothing.
      return {
        file,
        content,
        rendered: null,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  }

  async function render(
    scopePath: string,
    path: string,
    source: string
  ): Promise<RenderedMarkdown> {
    const entry = cached(scopePath)
    return renderMarkdown(source, { index: entry.index, path: resolve(path) })
  }

  function search(scopePath: string, query: string): ContentSearchResult {
    const entry = cached(scopePath)
    const cold = entry.corpus === null
    if (entry.corpus === null) {
      entry.corpus = buildCorpus(key(scopePath), entry.tree.files)
    }
    return searchCorpus(entry.corpus, query, cold)
  }

  return {
    scopes,
    tree: (scopePath, refresh) => cached(scopePath, refresh ?? false).tree,
    document,
    render,
    search,

    write: (req) => {
      const result = writeContentFile(services.store, req)
      if (result.ok && !result.unchanged) invalidate(req.path)
      return result
    },

    snapshots: (scopePath, path) =>
      readConfigSnapshots(services.store, resolve(scopePath), snapshotKey(scopePath, path)),

    restore: (id, path) => {
      const result = restoreContentSnapshot(services.store, id, path)
      if (result.ok && !result.unchanged) invalidate(path)
      return result
    },

    artifact: (path) => {
      const absolute = resolve(path)
      // Re-minted per open rather than remembered, so a token cannot outlive
      // the document it was issued for and a stale window cannot re-fetch.
      const token = randomUUID()
      artifacts.set(token, { dir: dirname(absolute), file: absolute })
      // Bounded: a session that opens a hundred artifacts should not keep a
      // hundred directories addressable.
      if (artifacts.size > 32) {
        const oldest = artifacts.keys().next()
        if (!oldest.done) artifacts.delete(oldest.value)
      }
      const name = absolute.split(sep).at(-1) ?? 'index.html'
      return {
        token,
        url: `${CONTENT_SCHEME}://artifact/${token}/${encodeURIComponent(name)}`
      }
    }
  }
}

/** Used by the driver to prove the protocol refuses what it should. */
export function artifactRoots(): Array<{ token: string; dir: string; file: string }> {
  return [...artifacts.entries()].map(([token, entry]) => ({ token, ...entry }))
}

// ---------------------------------------------------------------------------
// What the artifact logged
// ---------------------------------------------------------------------------

export interface ArtifactConsoleEntry {
  level: string
  message: string
  source: string
  line: number
}

const artifactConsole: ArtifactConsoleEntry[] = []

export function artifactConsoleEntries(): ArtifactConsoleEntry[] {
  return [...artifactConsole]
}

export function clearArtifactConsole(): void {
  artifactConsole.length = 0
}

/**
 * Collects what an artifact frame writes to its console.
 *
 * It has to be done here. The frame's origin is opaque, so the window hosting
 * it cannot read its console at all - only the process that owns both of them
 * can, and `console-message` on the host `webContents` carries messages from
 * every frame under it with the source URL attached. Filtering on that URL is
 * what separates "the artifact logged an error" from "React logged a warning".
 *
 * `zero console errors` is an acceptance criterion, and a criterion that
 * nothing observes is a wish - so this exists whether or not the badge that
 * shows it is on screen.
 */
export function attachArtifactConsole(
  win: BrowserWindow,
  onEntry: (entry: ArtifactConsoleEntry) => void
): void {
  win.webContents.on('console-message', (event) => {
    // One parameter, deliberately: Electron decides which signature to call by
    // the listener's arity, and taking the deprecated positional arguments as
    // well earns a warning on every start.
    //
    // The shape is checked rather than assumed. If a future version stops
    // populating `sourceId`, this listener would silently stop recognising
    // artifact output and criterion 3 would pass because it saw nothing - the
    // exact failure PROF-4 taught. So an unrecognised event is *recorded*, not
    // dropped.
    if (typeof event.sourceId !== 'string' || typeof event.level !== 'string') {
      const broken: ArtifactConsoleEntry = {
        level: 'error',
        message: `console-message arrived in a shape Helm does not recognise: ${JSON.stringify(Object.keys(event))}`,
        source: `${CONTENT_SCHEME}://unknown`,
        line: 0
      }
      artifactConsole.push(broken)
      onEntry(broken)
      return
    }
    if (!event.sourceId.startsWith(`${CONTENT_SCHEME}:`)) return

    const entry: ArtifactConsoleEntry = {
      level: event.level,
      message: event.message,
      source: event.sourceId,
      line: event.lineNumber
    }
    artifactConsole.push(entry)
    if (artifactConsole.length > 200) artifactConsole.shift()
    onEntry(entry)
  })
}
