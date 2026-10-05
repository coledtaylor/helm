import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NormalizedService } from '@helm/plugin-sdk/manifest'
import type { PluginLogLine } from '../../shared/ipc'
import type { ServiceLauncher, ServiceSupervisor } from './service'

vi.mock('electron', async () => (await import('../../../test/electron')).electronFake())

const { childProcessLauncher, createServiceSupervisor, CRASH_LIMIT } = await import('./service')
const { PluginCallError } = await import('./errors')

/**
 * A plugin's service, run for real as a child process from a folder with
 * spaces in its path: started on demand and found listening, told its port,
 * token and plugin in its environment, restarted after it dies, given up on
 * after it keeps dying, and stopped with everything it started.
 */

let root: string
let dir: string

const SERVER = `import { createServer } from 'node:http'
const server = createServer((req, res) => {
  if (req.headers['helm-service-token'] !== process.env.HELM_SERVICE_TOKEN) { res.writeHead(401); res.end(); return }
  if (req.url === '/die') { res.end('bye'); setTimeout(() => process.exit(5), 20); return }
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({
    port: process.env.HELM_SERVICE_PORT,
    token: process.env.HELM_SERVICE_TOKEN,
    plugin: process.env.HELM_PLUGIN_ID,
    mine: process.env.MINE ?? null,
    claude: process.env.CLAUDECODE ?? null,
    pid: process.pid
  }))
})
server.listen(Number(process.env.HELM_SERVICE_PORT), '127.0.0.1', () => console.log('listening\\npartial'))
`

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'helm plugin service-'))
  dir = join(root, 'my plugin')
  mkdirSync(join(dir, 'service'), { recursive: true })
  writeFileSync(join(dir, 'service', 'main.mjs'), SERVER)
  writeFileSync(join(dir, 'service', 'exits.mjs'), 'process.exit(2)')
  writeFileSync(join(dir, 'service', 'silent.mjs'), 'console.log(process.pid); setInterval(() => {}, 1000)')
  writeFileSync(join(root, 'outside.mjs'), 'process.exit(0)')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const running: ServiceSupervisor[] = []

afterEach(() => {
  for (const service of running.splice(0)) service.stop(true)
  vi.unstubAllEnvs()
})

interface Made {
  service: ServiceSupervisor
  log: Array<Omit<PluginLogLine, 'at'>>
  launches: () => number
}

function make(
  command: string,
  patch: { env?: () => Record<string, string>; timing?: { readyMs?: number; backoffMinMs?: number; backoffMaxMs?: number } } = {}
): Made {
  const log: Array<Omit<PluginLogLine, 'at'>> = []
  let launches = 0
  const launcher: ServiceLauncher = (launch) => {
    launches += 1
    return childProcessLauncher(launch)
  }
  const spec: NormalizedService = { kind: 'node', command, args: [], env: {}, start: 'demand' }
  const service = createServiceSupervisor({
    plugin: 'sample',
    dir,
    spec,
    env: patch.env ?? (() => ({ MINE: 'declared' })),
    launcher,
    onChange: () => undefined,
    log: (line) => log.push(line),
    timing: patch.timing
  })
  running.push(service)
  return { service, log, launches: () => launches }
}

async function ask(endpoint: { origin: string; token: string }, path = '/'): Promise<Record<string, unknown>> {
  const response = await fetch(`${endpoint.origin}${path}`, { headers: { 'helm-service-token': endpoint.token } })
  return (await response.json()) as Record<string, unknown>
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

describe('a service', () => {
  it('starts on first need, once, and is found listening with its port, token and plugin in its environment', async () => {
    vi.stubEnv('CLAUDECODE', '1')
    const { service, log, launches } = make('service/main.mjs')
    expect(service.info().state).toBe('stopped')
    const [endpoint, again] = await Promise.all([service.ensure(), service.ensure()])
    expect(again).toEqual(endpoint)
    expect(launches()).toBe(1)
    expect(endpoint.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(endpoint.token).toMatch(/^[0-9a-f]{64}$/)
    const env = await ask(endpoint)
    expect(env).toMatchObject({
      port: endpoint.origin.split(':').at(-1),
      token: endpoint.token,
      plugin: 'sample',
      mine: 'declared',
      claude: null
    })
    expect(service.info()).toMatchObject({ state: 'running', pid: env['pid'], port: Number(env['port']), restarts: 0, error: null })
    await vi.waitFor(() => expect(log).toContainEqual({ stream: 'out', text: 'listening' }))
    expect(await service.ensure()).toEqual(endpoint)
  })

  it('refuses a request without its token: the port alone is not enough', async () => {
    const { service } = make('service/main.mjs')
    const endpoint = await service.ensure()
    expect((await fetch(`${endpoint.origin}/`)).status).toBe(401)
  })

  it('is stopped with its process, and says the last of what it printed', async () => {
    const { service, log } = make('service/main.mjs')
    const endpoint = await service.ensure()
    const pid = Number((await ask(endpoint))['pid'])
    service.stop(false)
    expect(service.info()).toMatchObject({ state: 'stopped', pid: null, port: null })
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 })
    await vi.waitFor(() => expect(log).toContainEqual({ stream: 'out', text: 'partial' }))
    expect(log).toContainEqual({ stream: 'helm', text: 'stopped' })
  })

  it('is started again after it dies, as another process', async () => {
    const { service, launches } = make('service/main.mjs', { timing: { backoffMinMs: 50 } })
    const first = await service.ensure()
    const firstPid = (await ask(first))['pid']
    await fetch(`${first.origin}/die`, { headers: { 'helm-service-token': first.token } })
    await vi.waitFor(() => expect(service.info().restarts).toBe(1), { timeout: 5000 })
    const second = await service.ensure()
    expect((await ask(second))['pid']).not.toBe(firstPid)
    expect(second.token).not.toBe(first.token)
    expect(launches()).toBe(2)
    expect(service.info()).toMatchObject({ state: 'running', restarts: 1, error: null })
  })

  it(`is given up on after ${String(CRASH_LIMIT)} deaths in a minute, and a request for it is refused`, async () => {
    const { service, log, launches } = make('service/exits.mjs', { timing: { backoffMinMs: 10, backoffMaxMs: 20 } })
    const result = await service.ensure().then(
      () => null,
      (error: unknown) => error
    )
    expect(result).toBeInstanceOf(PluginCallError)
    expect(result).toMatchObject({ code: 'service' })
    expect(launches()).toBe(CRASH_LIMIT)
    expect(service.info()).toMatchObject({ state: 'failed', restarts: CRASH_LIMIT - 1 })
    expect(service.info().error).toMatch(/exited with code 2, and has stopped 5 times in a minute/)
    expect(log.filter((line) => line.stream === 'helm' && /starting it again/.test(line.text))).toHaveLength(CRASH_LIMIT - 1)
    await expect(service.ensure()).rejects.toMatchObject({ code: 'service' })
  })

  it('is stopped when it does not listen in time', async () => {
    const { service, log } = make('service/silent.mjs', { timing: { readyMs: 400, backoffMinMs: 60_000 } })
    const pending = service.ensure()
    await vi.waitFor(() => expect(log.some((line) => line.stream === 'helm' && /did not listen/.test(line.text))).toBe(true), {
      timeout: 5000
    })
    expect(service.info().state).toBe('crashed')
    const pid = Number(log.find((line) => line.stream === 'out')?.text)
    expect(pid).toBeGreaterThan(0)
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 5000 })
    service.stop(false)
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('fails without starting when its secrets cannot be filled', async () => {
    const { service, launches } = make('service/main.mjs', {
      env: () => {
        throw new PluginCallError('secret', 'the secret "token" is not stored')
      }
    })
    await expect(service.ensure()).rejects.toMatchObject({ code: 'service' })
    expect(launches()).toBe(0)
    expect(service.info()).toMatchObject({ state: 'failed', error: 'the service was not started: the secret "token" is not stored' })
  })

  it('fails for a script that is not in the plugin folder', async () => {
    const { service } = make('../outside.mjs')
    await expect(service.ensure()).rejects.toMatchObject({ code: 'service' })
    expect(service.info().error).toBe('../outside.mjs is not a file in the plugin folder')
  })

  it('refuses whoever was waiting when it is stopped', async () => {
    const { service } = make('service/main.mjs')
    const pending = service.ensure()
    service.stop(false)
    await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('starts without anyone waiting, for a plugin that asks for it on enable', async () => {
    const { service } = make('service/main.mjs')
    service.start()
    await vi.waitFor(() => expect(service.info().state).toBe('running'), { timeout: 10_000 })
  })
})
