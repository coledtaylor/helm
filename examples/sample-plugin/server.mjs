// @ts-check
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

/**
 * The API the sample plugin reads: a list of items behind a bearer token.
 *
 * Helm's end-to-end tests start it on a free port and point a copy of the
 * plugin at it; `pnpm serve` starts it on 4790, the origin the manifest names,
 * for trying the plugin by hand. Every request is recorded, headers included,
 * so a test can see exactly what Helm sent - which is how it proves a secret
 * went where it was allowed and nowhere else.
 */

/**
 * @typedef {{ id: string, title: string, body: string, read: boolean, created: number }} Item
 * @typedef {{ method: string, path: string, authorization: string | null, cookie: string | null }} Seen
 */

/**
 * @param {{ port?: number, host?: string, token: string }} options
 * @returns {Promise<{ url: string, port: number, requests: Seen[], items: Item[], close: () => Promise<void> }>}
 */
export async function startSampleServer({ port = 0, host = '127.0.0.1', token }) {
  /** @type {Item[]} */
  const items = [
    { id: '1', title: 'Welcome', body: 'The first item, from the sample server.', read: false, created: 1 },
    { id: '2', title: 'Second item', body: 'Another one.', read: false, created: 2 },
    { id: '3', title: 'Already read', body: 'Read before you looked.', read: true, created: 3 }
  ]
  /** @type {Seen[]} */
  const requests = []
  let next = 4

  /** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    requests.push({
      method: req.method ?? 'GET',
      path: url.pathname + url.search,
      authorization: req.headers.authorization ?? null,
      cookie: req.headers.cookie ?? null
    })

    // Redirects, for the allowlist: one that stays on this origin and one
    // that leaves it for 127.0.0.2, which no manifest names.
    if (url.pathname === '/redirect/inside') {
      res.writeHead(302, { location: '/items' })
      res.end()
      return
    }
    if (url.pathname === '/redirect/outside') {
      res.writeHead(302, { location: `http://127.0.0.2:${String(actualPort())}/items` })
      res.end()
      return
    }
    // What a page sent, given back: for the tests of what Helm put in it.
    if (url.pathname === '/echo') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => json(res, 200, { method: req.method, headers: req.headers, body }))
      return
    }

    if (req.headers.authorization !== `Bearer ${token}`) {
      json(res, 401, { error: 'a bearer token is required' })
      return
    }

    const match = /^\/items(?:\/([^/]+))?(\/read)?$/.exec(url.pathname)
    if (match === null) {
      json(res, 404, { error: 'not found' })
      return
    }
    const [, id, read] = match
    if (id === undefined && req.method === 'GET') {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 20) || 20))
      let list = [...items]
      if (url.searchParams.get('unread') === 'true') list = list.filter((item) => !item.read)
      list.sort((a, b) => (url.searchParams.get('order') === 'old' ? a.created - b.created : b.created - a.created))
      json(res, 200, { items: list.slice(0, limit), unread: items.filter((item) => !item.read).length })
      return
    }
    if (id === undefined && req.method === 'POST') {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        /** @type {{ title?: unknown }} */
        let parsed = {}
        try {
          parsed = JSON.parse(body)
        } catch {
          // Answered below.
        }
        if (typeof parsed.title !== 'string' || parsed.title.trim() === '') {
          json(res, 400, { error: 'an item needs a title' })
          return
        }
        const item = { id: String(next++), title: parsed.title.trim(), body: '', read: false, created: Date.now() }
        items.push(item)
        json(res, 201, item)
      })
      return
    }
    const item = items.find((candidate) => candidate.id === id)
    if (item === undefined) {
      json(res, 404, { error: 'no such item' })
      return
    }
    if (read !== undefined && req.method === 'POST') item.read = true
    json(res, 200, item)
  })

  await new Promise((resolve) => server.listen(port, host, () => resolve(undefined)))
  const actualPort = () => {
    const address = server.address()
    return typeof address === 'object' && address !== null ? address.port : port
  }
  return {
    url: `http://${host}:${String(actualPort())}`,
    port: actualPort(),
    requests,
    items,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined)))
  }
}

// `node server.mjs [token]`: the server on the manifest's own port, for trying the plugin by hand.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const token = process.argv[2] ?? 'sample'
  const started = await startSampleServer({ port: 4790, token })
  console.log(`Sample server on ${started.url}. Store the token "${token}" as the plugin's secret.`)
}
