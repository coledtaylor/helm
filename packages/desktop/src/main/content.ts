import { protocol, type BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import {
  buildCorpus,
  buildWikiIndex,
  contentExtension,
  contentFileKind,
  contentScope,
  corpusIsCurrent,
  editorExtension,
  highlightCode,
  highlightLines,
  parseWikilink,
  readConfigFileContent,
  readConfigSnapshots,
  readContentDir,
  readContentTree,
  renderMarkdown,
  resolveWikilink,
  restoreContentSnapshot,
  searchCorpus,
  snapshotKey,
  writeContentFile,
  WIKILINK_RE,
  type ConfigFileContent,
  type ConfigSnapshotMeta,
  type ContentCorpus,
  type ContentDirListing,
  type ContentDocument,
  type ContentFile,
  type ContentScope,
  type ContentSource,
  type ContentSearchResult,
  type EditorHighlight,
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
  /** One directory of the tree view, read on demand. */
  dir: (scopePath: string, relPath: string) => Promise<ContentDirListing>
  document: (scopePath: string, path: string) => Promise<ContentDocument>
  /** Renders a draft that is not on disk - the split preview while typing. */
  render: (scopePath: string, path: string, source: string) => Promise<RenderedMarkdown>
  search: (scopePath: string, query: string) => ContentSearchResult
  write: (req: WriteConfigRequest) => WriteConfigResult
  snapshots: (scopePath: string, path: string) => ConfigSnapshotMeta[]
  restore: (id: number, path: string) => WriteConfigResult
  /** Mints a URL a sandboxed frame may load, pinned to the file's directory. */
  artifact: (scopePath: string, path: string) => { url: string; token: string }
  /** Resolves a `[[wikilink]]` for the one caller that cannot: the artifact frame. */
  wikilink: (scopePath: string, target: string, from: string) => string | null
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

/**
 * Directories artifacts may be served from, keyed by an unguessable token.
 *
 * `links` is the wikilink table for the entry document, resolved when the token
 * was minted. It carries no paths - only which targets the vault can answer -
 * because the frame is untrusted code and a path in it is a path it can read.
 */
const artifacts = new Map<
  string,
  { dir: string; file: string; links: Array<{ target: string; heading: string | null; resolved: boolean }> }
>()

function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel))
}

/**
 * The `[[wikilink]]` bootstrap injected into an artifact's entry document.
 *
 * Wikilinks are a vault convention, not a markdown one. A lesson Claude wrote
 * as HTML links to the note beside it exactly the way a note does, and a viewer
 * that resolved the brackets in one file format and printed them literally in
 * the other would be splitting the vault down a line the author never drew.
 *
 * The frame is untrusted code, so this is written for a hostile document:
 *
 *   - **No paths cross into the frame.** It is told which targets resolve, not
 *     what they resolve to. A click posts the *target string* back and the host
 *     resolves it through its own index.
 *   - **The host trusts nothing it receives.** An artifact can call
 *     `parent.postMessage` whether or not this script is there, so the message
 *     is a request, not an instruction: the worst a forged one achieves is
 *     opening a note the user could have clicked in the list anyway.
 *   - **Text nodes only, and never inside a link, a script or an editable.**
 *     Rewriting markup would match inside attributes; rewriting a link's text
 *     would nest an anchor inside an anchor.
 *
 * `document.currentScript.previousElementSibling` carries the table rather than
 * a global, so a document that has already defined `window.__helm` cannot
 * change what this reads.
 */
function withWikilinks(
  html: string,
  links: ReadonlyArray<{ target: string; heading: string | null; resolved: boolean }>
): string {
  if (links.length === 0) return html

  const table = JSON.stringify(
    Object.fromEntries(links.map((link) => [link.target.toLowerCase(), link.resolved]))
  )
    // `</script>` inside a JSON island ends the island. `<!--` opens an HTML
    // comment inside one. Both are escaped rather than hoped about.
    .replace(/</g, '\\u003c')

  const bootstrap = `
<script type="application/json" data-helm-wikilinks>${table}</script>
<script>
(function () {
  var node = document.currentScript && document.currentScript.previousElementSibling
  if (!node) return
  var known = {}
  try { known = JSON.parse(node.textContent || '{}') } catch (e) { return }
  var RE = /\\[\\[([^\\]\\[\\n|#][^\\]\\[\\n]*?)((?:#[^\\]\\[\\n|]*)?)((?:\\|[^\\]\\[\\n]*)?)\\]\\]/g
  var SKIP = { A: 1, SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1 }
  // Raw hex, deliberately, and the one place in Helm where that is right: this
  // stylesheet is injected into a *foreign* document with an opaque origin, so
  // none of the app's tokens are reachable from it. The values are the light
  // theme's accent-text and warn, because the frame paints on white.
  var style = document.createElement('style')
  style.textContent = '.helm-wikilink{color:#5A4DA8;text-decoration:underline;text-underline-offset:2px;cursor:pointer}'
    + '.helm-wikilink-broken{color:#9A6B12;text-decoration:underline dotted;cursor:default}'
  document.head && document.head.appendChild(style)

  function walk(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement
        while (p) {
          if (SKIP[p.tagName] || p.isContentEditable) return NodeFilter.FILTER_REJECT
          p = p.parentElement
        }
        return (n.nodeValue || '').indexOf('[[') < 0
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT
      }
    })
    var targets = []
    for (var n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n)
    for (var i = 0; i < targets.length; i++) replace(targets[i])
  }

  function replace(node) {
    var text = node.nodeValue || ''
    var frag = document.createDocumentFragment()
    var at = 0
    RE.lastIndex = 0
    for (var m = RE.exec(text); m; m = RE.exec(text)) {
      if (m.index > at) frag.appendChild(document.createTextNode(text.slice(at, m.index)))
      var target = (m[1] || '').trim()
      var heading = (m[2] || '').replace('#', '').trim()
      var alias = (m[3] || '').replace('|', '').trim()
      var ok = known[target.toLowerCase()] === true
      var a = document.createElement('a')
      a.className = ok ? 'helm-wikilink' : 'helm-wikilink helm-wikilink-broken'
      a.textContent = alias || (heading ? target + ' \\u00a7 ' + heading : target)
      a.setAttribute('data-helm-wikilink', target)
      if (heading) a.setAttribute('data-helm-heading', heading)
      if (!ok) a.title = 'No note in this scope answers to that name yet'
      frag.appendChild(a)
      at = m.index + m[0].length
    }
    if (at === 0) return
    if (at < text.length) frag.appendChild(document.createTextNode(text.slice(at)))
    node.parentNode && node.parentNode.replaceChild(frag, node)
  }

  document.addEventListener('click', function (event) {
    var el = event.target
    while (el && el !== document.body && !(el.getAttribute && el.getAttribute('data-helm-wikilink'))) {
      el = el.parentElement
    }
    if (!el || !el.getAttribute) return
    var target = el.getAttribute('data-helm-wikilink')
    if (!target) return
    event.preventDefault()
    if (el.className.indexOf('helm-wikilink-broken') >= 0) return
    try {
      parent.postMessage(
        { helm: 'wikilink', target: target, heading: el.getAttribute('data-helm-heading') || null },
        '*'
      )
    } catch (e) { /* No parent to tell. Nothing else to do. */ }
  })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { walk(document.body) })
  } else {
    walk(document.body)
  }
})()
</script>
`
  const close = html.lastIndexOf('</body>')
  return close < 0 ? html + bootstrap : html.slice(0, close) + bootstrap + html.slice(close)
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

    // The entry document, and only that one, gets the wikilink bootstrap. A
    // stylesheet or a chart script beside it is served verbatim.
    //
    // Compared by *path*, not by the request being for the bare directory. The
    // URL a frame is handed carries the file's own name as its last segment -
    // `helm-content://artifact/<token>/lesson.html` - so `rel` is that name and
    // is never empty for the document itself. Written the other way round this
    // injected into nothing at all, which is a bootstrap that silently does not
    // run: CONT-15 read `[[beta]]` still sitting there as literal text.
    if (target.toLowerCase() === entry.file.toLowerCase() && /\.html?$/i.test(target)) {
      bytes = Buffer.from(withWikilinks(bytes.toString('utf8'), entry.links), 'utf8')
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

/**
 * The `[[wikilinks]]` an HTML artifact contains, and whether the vault answers
 * to them.
 *
 * Scanned from the file's own bytes rather than from an index of the vault, so
 * the frame learns nothing except the resolution of the names it already
 * carries. The same regular expression the markdown pipeline uses, so a link
 * that resolves in a note resolves in a lesson.
 */
function artifactWikilinks(
  index: WikiIndex,
  path: string
): Array<{ target: string; heading: string | null; resolved: boolean }> {
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out = new Map<string, { target: string; heading: string | null; resolved: boolean }>()
  WIKILINK_RE.lastIndex = 0
  for (let match = WIKILINK_RE.exec(source); match; match = WIKILINK_RE.exec(source)) {
    const link = parseWikilink(`${match[2] ?? ''}${match[3] ?? ''}${match[4] ?? ''}`)
    if (link.target === '' || out.has(link.target.toLowerCase())) continue
    out.set(link.target.toLowerCase(), {
      target: link.target,
      heading: link.heading,
      resolved: resolveWikilink(index, link, path) !== null
    })
  }
  return [...out.values()]
}

export interface ContentServiceDeps {
  services: Services
}

/** How long a tree is trusted before a fresh open re-walks it. */
const TREE_TTL_MS = 30_000

/**
 * The ceiling on highlighting a whole file.
 *
 * A fence in a note is a few dozen lines; a source file can be a generated
 * 3 MB bundle, and TextMate grammars are backtracking regular expressions. Past
 * this the file still opens - as plain text, saying so - because a source view
 * that hung on one file would be worse than one that is occasionally grey.
 */
const HIGHLIGHT_MAX_BYTES = 512 * 1024

/**
 * A draft being typed, tokenised for the editor's underlay.
 *
 * The one highlighter, reached from both editors - the config console's and the
 * content viewer's - which is why this is a free function rather than a method
 * on either service. It reads nothing: the bytes come in on the channel,
 * because the point of the editor is that what it colours is not on disk yet.
 *
 * **Main, over IPC, rather than a second shiki in the window**, and that is the
 * decision SPEC records. Main is externalised, so `import('@shikijs/langs/x')`
 * resolves through Node and every grammar shiki ships is reachable with no list
 * to maintain; a renderer-side highlighter needs a hand-written map, which caps
 * the languages at whatever somebody remembered and grows the bundle per
 * grammar. Where the tokeniser runs was never the latency question - the DOM
 * build is, and it happens in the window either way. What keeps typing fast is
 * that the underlay never waits for this: see `CodeEditor`.
 */
export async function highlightForEditor(
  path: string,
  source: string
): Promise<EditorHighlight> {
  const started = Date.now()
  // The same ceiling the read views use, measured the same way, so a file that
  // reads as plain text does not suddenly colour when you press Edit.
  if (Buffer.byteLength(source, 'utf8') > HIGHLIGHT_MAX_BYTES) {
    return { lines: [], language: 'plaintext', highlighted: false, tooLarge: true, tookMs: 0 }
  }
  const out = await highlightLines(source, editorExtension(path))
  return {
    lines: out.lines,
    language: out.language,
    highlighted: out.highlighted,
    tooLarge: false,
    tookMs: Date.now() - started
  }
}

/**
 * The source view's half of a document.
 *
 * Built in the main process for the same reasons the markdown render is: the
 * grammars are megabytes the browser bundle should never carry, and the
 * renderer should inject a finished string rather than run a tokeniser on the
 * thread that has to keep scrolling.
 */
async function sourceOf(
  file: ContentFile,
  content: ConfigFileContent
): Promise<ContentSource | null> {
  if (file.kind === 'markdown' || file.kind === 'html') return null
  if (file.kind === 'binary' || content.binary || !content.exists) return null
  if (content.size > HIGHLIGHT_MAX_BYTES) {
    return { html: '', language: 'plaintext', highlighted: false, tooLarge: true }
  }
  // The extension is the language. `normaliseLanguage` already knows `py` is
  // python and `yml` is yaml, because a fence's info string uses the same
  // spellings a filename does.
  const out = await highlightCode(content.content, file.ext)
  return { html: out.html, language: out.language, highlighted: out.highlighted, tooLarge: false }
}

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

  /**
   * A row for a file the curated tree does not list.
   *
   * Two callers, and the second is now the common one. A wikilink can point
   * into a directory the curated walk bounded out; and **the tree view opens
   * files the curated view never offered at all** - which is the point of it -
   * so most of a project's files arrive here. Everything below this treats the
   * result exactly like a listed file: the same kinds, the same renderers. The
   * only thing missing is the frontmatter the walk reads, and the markdown
   * render produces that itself.
   */
  function describeUnlisted(scopePath: string, absolute: string, content: ConfigFileContent): ContentFile {
    const name = absolute.split(sep).at(-1) ?? absolute
    return {
      path: absolute,
      relPath: relative(resolve(scopePath), absolute).split(sep).join('/'),
      root: '',
      rootKind: 'found',
      // The real kind, not a flat `text`: this decides which surface opens, and
      // calling a `.py` text here would have put a script in the plain pane
      // next to a highlighted one for no reason a reader could see.
      kind: contentFileKind(name),
      slug: name.replace(/\.[^.]+$/, ''),
      ext: contentExtension(name).replace(/^\./, ''),
      title: name,
      size: content.size,
      mtimeMs: content.mtimeMs,
      noteType: null,
      date: null,
      tags: []
    }
  }

  async function document(scopePath: string, path: string): Promise<ContentDocument> {
    const entry = cached(scopePath)
    const absolute = resolve(path)
    const content = readConfigFileContent(absolute)

    // Looked up once, and not re-walked when it misses. It used to force a
    // fresh walk of the whole scope on a miss, which was affordable while a
    // miss meant "a wikilink into a bounded-out directory" - a few times a
    // session. In the tree view a miss is the *normal* case, so that would be a
    // full curated walk per file opened. What the re-walk bought was a nicer
    // title; `describeUnlisted` gives a usable row and, for markdown, the
    // render reads the frontmatter itself.
    const listed = entry.tree.files.find(
      (candidate) => candidate.path.toLowerCase() === absolute.toLowerCase()
    )
    const file = listed ?? describeUnlisted(scopePath, absolute, content)
    const missing = content.exists ? null : 'That file is not there any more.'

    if (file.kind !== 'markdown' || content.binary || !content.exists) {
      return { file, content, rendered: null, source: await sourceOf(file, content), error: missing }
    }

    try {
      const rendered = await renderMarkdown(content.content, {
        index: entry.index,
        path: file.path
      })
      return { file, content, rendered, source: null, error: null }
    } catch (err) {
      // The source still shows. A document that will not render is a bug worth
      // seeing, not a reason to show nothing.
      return {
        file,
        content,
        rendered: null,
        source: await sourceOf(file, content),
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
    // Not cached. A directory listing is one `readdir` and one `check-ignore`
    // against a directory somebody just clicked open, and a cache here would be
    // a tree that goes on showing a file after it has been deleted - which is
    // the failure the curated view's 30-second TTL is already the compromise
    // for, and the tree has no reason to make it.
    dir: (scopePath, relPath) => readContentDir(scopeFor(scopePath), relPath),
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

    wikilink: (scopePath, target, from) => {
      const entry = cached(scopePath)
      return resolveWikilink(entry.index, parseWikilink(target), resolve(from))
    },

    artifact: (scopePath, path) => {
      const absolute = resolve(path)
      // Re-minted per open rather than remembered, so a token cannot outlive
      // the document it was issued for and a stale window cannot re-fetch.
      const token = randomUUID()
      artifacts.set(token, {
        dir: dirname(absolute),
        file: absolute,
        links: artifactWikilinks(cached(scopePath).index, absolute)
      })
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
