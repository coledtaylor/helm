import { protocol, type BrowserWindow } from 'electron'
import { relative } from 'node:path'

/**
 * The window's half of the content viewer's artifacts.
 *
 * An HTML artifact is content Helm did not produce, so it is served to a
 * sandboxed frame through a scheme of its own, under a Content Security Policy
 * that permits no network of any kind. The local host mints each artifact's
 * address and answers its bytes (`host/files.ts`); this scheme hands the frame
 * what the host said, under the window's own policy, and collects what the
 * frame logs.
 *
 * An artifact is a **file on disk**, rendered with the network taken away -
 * `ARTIFACT_CSP` names no `http:` anywhere, so remote content is not blocked by
 * policy, it has nowhere to be requested from. A browser view is the reverse:
 * it exists *to* fetch, and what makes it safe is a partition of its own, a
 * locked-down `webPreferences`, and every posture around it stated rather than
 * defaulted (`main/browser.ts`). Neither one's guarantees are the other's, and
 * the frame here must never acquire the browser's - `ContentDocumentPane`
 * passes the console panel no evaluator for exactly that reason.
 */

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

export const MIME: Record<string, string> = {
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

export function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !/^[A-Za-z]:/.test(rel))
}

/**
 * Serves an artifact and the files beside it, as the local host answers them.
 *
 * Registered on the default session rather than a partition: the frame is a
 * sandboxed iframe of the app's own window, so there is no second session to
 * register on. Its isolation comes from the sandbox attribute and this policy,
 * not from a partition.
 */
export function registerContentProtocol(): void {
  protocol.handle(CONTENT_SCHEME, (request) =>
    remoteArtifacts === null
      ? new Response('Not found', { status: 404 })
      : answerFromHost(remoteArtifacts, request.url)
  )
}

/** What a remote source answers for an artifact address: its status, headers and whole body. */
export interface RemoteArtifactAnswer {
  status: number
  headers: Array<[string, string]>
  body: Uint8Array
}

type RemoteArtifacts = (url: string) => Promise<RemoteArtifactAnswer>

/**
 * Where artifact addresses are answered from: the local host, which mints them
 * (`host/files.ts`). Null until the desktop host exists.
 */
let remoteArtifacts: RemoteArtifacts | null = null

export function serveArtifactsFrom(source: RemoteArtifacts | null): void {
  remoteArtifacts = source
}

/**
 * The host's answer, with its status (a 400, 403 or 404 kept as it said them)
 * and headers, under the window's own policy: the frame is the window's, on
 * the window's scheme, so the window's CSP is the one it is held to.
 */
export async function answerFromHost(source: RemoteArtifacts, url: string): Promise<Response> {
  let answer: RemoteArtifactAnswer
  try {
    answer = await source(url)
  } catch (err) {
    return new Response(err instanceof Error ? err.message : String(err), { status: 502 })
  }
  const headers = new Headers()
  for (const [name, value] of answer.headers) {
    if (name.toLowerCase() !== 'content-security-policy') headers.append(name, value)
  }
  headers.set('content-security-policy', ARTIFACT_CSP)
  headers.set('x-content-type-options', 'nosniff')
  // A view onto a decoded frame may sit on a shared buffer, which a body cannot be.
  return new Response(new Uint8Array(answer.body), { status: answer.status, headers })
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
    // artifact output and criterion 3 would pass because it saw nothing. So an
    // unrecognised event is *recorded*, not dropped.
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
