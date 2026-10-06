import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { selfSignedCertificate } from '../test/self-signed'

/**
 * The pages the browser pane is tested against, served on this machine only.
 *
 * Four servers, so the address is the only thing two probes differ by:
 *
 *   - `http`, plain HTTP on 127.0.0.1 - the dev server the pane exists for;
 *   - `httpsLoopback`, HTTPS on 127.0.0.1 with a certificate minted at start,
 *     which the loopback exception must accept;
 *   - `httpsNamed`, the same certificate on 127.0.0.2, which is still this
 *     machine on Windows but is **not** loopback by Helm's rule, so the
 *     exception must not apply;
 *   - `httpNamed`, plain HTTP on 127.0.0.2: reachable, and refused by "This
 *     machine only". A test that proved the refusal by trying the internet
 *     would be a test that made a network request every time it ran.
 */
export interface BrowserFixture {
  http: string
  httpsLoopback: string
  httpsNamed: string
  httpNamed: string
  /** Every request any of the servers was asked, as `origin + path`, in order. */
  requests: string[]
  /** The `cookie` header of each request, in step with `requests`. */
  cookies: Array<string | null>
  close(): Promise<void>
}

/** What `/popup` hands back to its opener. */
export const POPUP_CODE = 'FIXTURE-CODE-5501'
/** What `/tools` puts on the clipboard. */
export const COPIED = 'copied by the fixture 7302'
export const COOKIE = { name: 'helmcookie', value: 'persisted-4711' }

/*
 * A Content-Security-Policy on every page. An unpackaged Electron writes a
 * security warning into the console of any http page with no CSP, which would
 * put a line in the pane's console that no page wrote.
 */
const HTML = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"
}

const page = (title: string, body = '', script = ''): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
  `<body>${body}<script>${script}</script></body></html>`

function respond(path: string, elsewhere: string): { headers: Record<string, string>; body: string } {
  switch (path) {
    case '/two':
      return { headers: HTML, body: page('Helm fixture two', '<p>Two</p>') }
    // Three of one word and none of another, for find in page.
    case '/find':
      return {
        headers: HTML,
        body: page('Helm fixture find', '<p>needle one</p><p>a haystack</p><p>needle two</p><p>needle three</p>')
      }
    /*
     * The two things a page may ask for - writing the clipboard and the whole
     * screen - and a record of every key that reached the page, so a test can
     * tell the browser's keys from the page's.
     */
    case '/tools':
      return {
        headers: HTML,
        body: page(
          'Helm fixture tools',
          '<button id="copy">Copy</button> <button id="fs">Go full screen</button><p role="status" id="status">idle</p>',
          `const status = document.getElementById('status')
           window.keys = []
           window.addEventListener('keydown', (event) => window.keys.push((event.ctrlKey ? 'Control+' : '') + event.key))
           document.getElementById('copy').addEventListener('click', () => {
             navigator.clipboard.writeText('${COPIED}').then(() => { status.textContent = 'copied' }, (error) => { status.textContent = 'copy refused: ' + error.name })
           })
           document.getElementById('fs').addEventListener('click', () => {
             document.documentElement.requestFullscreen().then(() => { status.textContent = 'fullscreen' }, (error) => { status.textContent = 'fullscreen refused: ' + error.name })
           })
           document.addEventListener('fullscreenchange', () => { if (document.fullscreenElement === null) status.textContent = 'left fullscreen' })`
        )
      }
    case '/cookie':
      return {
        // A year, so the second app start reads a cookie that was stored rather
        // than one that happens not to have expired yet.
        headers: { ...HTML, 'set-cookie': `${COOKIE.name}=${COOKIE.value}; Path=/; Max-Age=31536000; SameSite=Lax` },
        body: page('Helm fixture cookie')
      }
    /*
     * A sign-in in the shape every OAuth popup has: `window.open` must hand back
     * a live window, the popup must reach `window.opener` to hand back a code,
     * and then it closes itself. Both halves have to hold whether the page
     * opens as a window (`Sign in`) or as a tab (`Sign in in a tab`): a tab
     * Helm loaded fresh had neither, which is what left a sign-in opening tab
     * after tab.
     */
    case '/posture':
      return {
        headers: HTML,
        body: page(
          'Helm fixture posture',
          `<a href="/two" target="_blank">Open two in a new tab</a>
           <button id="signin" type="button">Sign in</button>
           <button id="tab" type="button">Sign in in a tab</button>
           <button id="elsewhere" type="button">Sign in elsewhere</button>
           <p id="status" role="status">signed out</p>`,
          `const status = document.getElementById('status')
           window.addEventListener('message', (event) => {
             if (event.data && event.data.code) {
               status.textContent = 'signed in with ' + event.data.code
               event.source.postMessage('done', '*')
             }
           })
           document.getElementById('signin').addEventListener('click', () => {
             window.__popup = window.open('/popup', 'signin', 'width=480,height=640')
             status.textContent = window.__popup ? 'popup open' : 'popup refused'
           })
           document.getElementById('tab').addEventListener('click', () => {
             window.__tab = window.open('/opened')
             status.textContent = window.__tab ? 'tab open' : 'tab refused'
           })
           document.getElementById('elsewhere').addEventListener('click', () => {
             const opened = window.open(${JSON.stringify(`${elsewhere}/popup`)}, 'elsewhere', 'width=480,height=640')
             status.textContent = opened ? 'popup open' : 'popup refused'
           })`
        )
      }
    // The same sign-in, opened with a plain `window.open`: a tab, not a window.
    case '/opened':
    case '/popup':
      return {
        headers: HTML,
        body: page(
          path === '/opened' ? 'Helm fixture opened' : 'Helm fixture popup',
          '<p>Signing in</p>',
          `if (window.opener) window.opener.postMessage({ code: ${JSON.stringify(POPUP_CODE)} }, '*')
           window.addEventListener('message', (event) => { if (event.data === 'done') window.close() })`
        )
      }
    default:
      return { headers: HTML, body: page('Helm fixture one', '<a href="/two">Two</a>') }
  }
}

export async function startBrowserFixture(): Promise<BrowserFixture> {
  const requests: string[] = []
  const cookies: Array<string | null> = []
  let httpNamedOrigin = ''

  const handler =
    (scheme: 'http' | 'https') =>
    (req: IncomingMessage, res: ServerResponse): void => {
      const path = (req.url ?? '/').split('?')[0] ?? '/'
      requests.push(`${scheme}://${req.headers.host ?? ''}${path}`)
      cookies.push(req.headers.cookie ?? null)
      const answer = respond(path, httpNamedOrigin)
      res.writeHead(200, answer.headers)
      res.end(answer.body)
    }

  const cert = selfSignedCertificate()
  const http = createHttpServer(handler('http'))
  const httpsLoopback = createHttpsServer(cert, handler('https'))
  const httpsNamed = createHttpsServer(cert, handler('https'))
  const httpNamed = createHttpServer(handler('http'))
  const servers = [http, httpsLoopback, httpsNamed, httpNamed]

  const httpPort = await listen(http, '127.0.0.1')
  const httpsLoopbackPort = await listen(httpsLoopback, '127.0.0.1')
  const httpsNamedPort = await listen(httpsNamed, '127.0.0.2')
  const httpNamedPort = await listen(httpNamed, '127.0.0.2')
  httpNamedOrigin = `http://127.0.0.2:${String(httpNamedPort)}`

  return {
    http: `http://127.0.0.1:${String(httpPort)}`,
    httpsLoopback: `https://127.0.0.1:${String(httpsLoopbackPort)}`,
    httpsNamed: `https://127.0.0.2:${String(httpsNamedPort)}`,
    httpNamed: httpNamedOrigin,
    requests,
    cookies,
    close: async () => {
      // Connections first: a browser holds its socket open on keep-alive, and
      // `close` waits for every connection to end.
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections()
              server.close(() => resolve())
            })
        )
      )
    }
  }
}

/** `listen` as a promise that rejects when the port cannot be had. */
function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.removeListener('error', reject)
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
}
