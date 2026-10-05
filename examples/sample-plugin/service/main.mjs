// @ts-check
import { createServer } from 'node:http'

/**
 * The sample's service: a long-running program Helm starts and stops for the
 * plugin, reached from its pages as `helm.fetch('service:/hello')`.
 *
 * Helm hands it a port and a token in its environment and sends the token on
 * every request, so nothing else on this machine that finds the port can use
 * it. It listens on loopback only.
 */

const port = Number(process.env['HELM_SERVICE_PORT'])
const token = process.env['HELM_SERVICE_TOKEN']
const started = Date.now()

const server = createServer((req, res) => {
  if (req.headers['helm-service-token'] !== token) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not Helm' }))
    return
  }
  if (req.url === '/hello') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ message: 'Hello from the service', pid: process.pid, upMs: Date.now() - started }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(port, '127.0.0.1', () => {
  console.log(`sample service listening on ${String(port)}`)
})
