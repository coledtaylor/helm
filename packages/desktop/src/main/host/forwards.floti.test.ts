import { request } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, inject, it } from 'vitest'
import { PATIENCE } from '../../../../../test/patience'
import { RUN_ROOT } from '../../../../../test/run-root'
import {
  connectThroughCarry,
  endStartedProcesses,
  flotiAvailable,
  flotiEnv,
  startFlotiHost,
  stopFlotiHost
} from '../../../test/floti-host'
import { createWorld } from '../../../test/world'
import type { HostConnection } from './client'
import { createPortForwards } from './forwards'
import type * as P from './protocol'

/**
 * Main's forwards against the real thing: the `floti` this checkout built, a
 * `floti host` in this test's own folders standing for a host on another
 * computer, reached through test/fake-ssh's `carry.mjs`, and a session there
 * running the fake `claude`, whose `/serve` starts a dev server on that
 * host's loopback. Runs where `floti` has been built.
 */

afterEach(endStartedProcesses)

/** What a request to `port` on this PC's loopback got back: status and body. */
function fetchAt(port: number, method: 'GET' | 'POST', path: string, body?: Buffer): Promise<{ status: number; body: Buffer }> {
  return new Promise((done, fail) => {
    const asked = request({ host: '127.0.0.1', port, method, path, agent: false }, (answer) => {
      const parts: Buffer[] = []
      answer.on('data', (chunk: Buffer) => parts.push(chunk))
      answer.once('end', () => done({ status: answer.statusCode ?? 0, body: Buffer.concat(parts) }))
      answer.once('error', fail)
    })
    asked.once('error', fail)
    asked.end(body)
  })
}

/** Resolves once `check` holds, polled, failing past the shared patience. */
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + PATIENCE
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((done) => setTimeout(done, 20))
  }
}

/** Starts the fake `claude` in `cwd` there and has it serve HTTP; its session id and port. */
async function serveInSession(connection: HostConnection, cwd: string): Promise<{ id: number; port: number }> {
  const session = await connection.request('session:start', {
    cwd,
    projectPath: null,
    name: 'dev server',
    backend: 'claude-code' as P.BackendId,
    profileId: null,
    overlays: null,
    extraFolders: null,
    model: null,
    effort: null,
    agent: null,
    permissionMode: null,
    openingPrompt: null,
    cols: 100,
    rows: 30
  })
  let screen = ''
  const decoder = new TextDecoder()
  const terminal = connection.openStream('session:data', { id: session.id }, {
    data: (bytes) => (screen += decoder.decode(bytes, { stream: true }))
  })
  // Typed once its prompt is up, as a person would.
  await until(() => screen.includes('>'), 'the fake claude to start')
  terminal.write(new TextEncoder().encode('/serve 0\r'))
  await until(() => /serving \d+/.test(screen), 'the dev server to listen')
  terminal.close()
  return { id: session.id, port: Number(/serving (\d+)/.exec(screen)![1]) }
}

describe.runIf(flotiAvailable)('a remote session\'s port forwarded through a real floti host', () => {
  it(
    'S1, S3, S4: the dev server answers on this PC\'s loopback, both ways and unchanged, on another port when its own is taken here, again on reload, and not once the session ends',
    { timeout: PATIENCE * 4 },
    async () => {
      const world = createWorld()
      const root = await mkdtemp(join(inject(RUN_ROOT), 'forwarded port '))
      const env = flotiEnv(root, { ...world.env, HOME: world.home, USERPROFILE: world.home }, join(world.root, 'bin'))
      const host = await startFlotiHost(env)
      const reached = await connectThroughCarry(env, join(root, 'this pc'))
      const { connection } = reached

      const listeners: Array<(connection: HostConnection) => void | Promise<void>> = []
      const forwards = createPortForwards({ changed: () => undefined, log: () => undefined })
      forwards.attach('build-box', {
        current: () => connection,
        onConnected: (listener) => void listeners.push(listener)
      })
      for (const listener of listeners) await listener(connection)

      const { id, port } = await serveInSession(connection, world.projects.alpha)
      const forward = await forwards.open('build-box', id, port)
      // The dev server holds that port on this computer too, which stands
      // for the other one: this PC listens on another free one.
      expect(forward.port).toBe(port)
      expect(forward.local).not.toBe(port)

      // S4: the page as the host serves it, and again on reload.
      const page = await fetchAt(forward.local, 'GET', '/index.html')
      expect(page.status).toBe(200)
      expect(page.body.toString()).toContain('fake dev server: GET /index.html')
      const reload = await fetchAt(forward.local, 'GET', '/app.js')
      expect(reload.body.toString()).toContain('fake dev server: GET /app.js')

      // S1: every byte there and back unchanged, more than one credit's worth.
      const bytes = Buffer.alloc(300 * 1024)
      for (let at = 0; at < bytes.length; at++) bytes[at] = at % 256
      const echoed = await fetchAt(forward.local, 'POST', '/echo', bytes)
      expect(echoed.body.equals(bytes)).toBe(true)

      // S3: the session ends, and so does the forward.
      await connection.request('session:close', { id, force: true })
      await until(() => forwards.list().length === 0, 'the forward to close with its session')
      await expect(fetchAt(forward.local, 'GET', '/')).rejects.toMatchObject({ code: 'ECONNREFUSED' })

      forwards.stop()
      await reached.close()
      await stopFlotiHost(host, env)
    }
  )
})
