import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, writeSessionMcpConfig, type AppSettings } from '@helm/core'
import { callTool, rpc, rpcResult, send, toolNames } from '../../test/mcp-client'
import type { BrowserHost, BrowserOpener } from './browser'
import { createBrowserMcp, type BrowserMcpHost, type BrowserMcpRegistration } from './browser-mcp'
import type { BrowserConsoleEntry, BrowserState } from '../shared/ipc'

/**
 * Helm's one inbound listener, over real HTTP on 127.0.0.1: what it binds, who
 * it answers, which routes exist with which settings, how long a token lives,
 * and what the browser tools let a session do to tabs it does and does not own.
 *
 * The browser host is a fake that records every call: what is under test here
 * is the endpoint's gate in front of the host. The tools against a real page
 * are `e2e/agent-tools.spec.ts`.
 */

const BROWSER_TOOLS = [
  'browser_click',
  'browser_close',
  'browser_console',
  'browser_evaluate',
  'browser_hover',
  'browser_navigate',
  'browser_open',
  'browser_press',
  'browser_screenshot',
  'browser_scroll',
  'browser_select',
  'browser_snapshot',
  'browser_tabs',
  'browser_text',
  'browser_type',
  'browser_wait_for'
]

/** What the endpoint reaches into the host for, and nothing it does not. */
type AgentSurface = Pick<
  BrowserHost,
  | 'states'
  | 'entries'
  | 'evaluate'
  | 'openFor'
  | 'navigateFor'
  | 'closeFor'
  | 'openerOf'
  | 'sharedWith'
  | 'revoke'
  | 'back'
  | 'forward'
  | 'reload'
  | 'hover'
  | 'scroll'
  | 'viewport'
  | 'capturePng'
  | 'pointer'
  | 'typeInto'
  | 'press'
>

interface Call {
  method: string
  id: number
  detail?: unknown
}

type Evaluator = (id: number, source: string) => { ok: boolean; value: string; error: string | null }

/** A browser host holding tabs in a map, recording every call that reaches a page. */
function fakeBrowsers() {
  const tabs = new Map<
    number,
    { state: BrowserState; opener: BrowserOpener | null; shared: BrowserOpener | null; console: BrowserConsoleEntry[] }
  >()
  const calls: Call[] = []
  let next = 1
  let zoom = 1
  let evaluator: Evaluator = () => ({ ok: true, value: 'undefined', error: null })
  let shot = { width: 1280, height: 800, png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) }

  const add = (url: string, opener: BrowserOpener | null): number => {
    const id = next++
    const state: BrowserState = {
      id,
      url,
      title: `Page at ${new URL(url).host}`,
      host: new URL(url).host,
      canGoBack: false,
      canGoForward: false,
      loading: false,
      problem: null,
      retryingUntil: null,
      zoomLevel: 0,
      errors: 0,
      devtoolsOpen: false,
      find: null,
      project: null,
      openedBy: opener?.name ?? null,
      openerRunning: opener !== null,
      sharedWith: null
    }
    tabs.set(id, { state, opener, shared: null, console: [] })
    return id
  }

  /** The user sharing a tab with a session, or taking it back. */
  const share = (id: number, to: BrowserOpener | null): void => {
    const tab = tabs.get(id)!
    tab.shared = to
    tab.state = { ...tab.state, sharedWith: to === null ? null : { session: 1, name: to.name } }
  }

  /** Moves a tab through its history, as the host would. */
  const travel = (id: number, method: string): BrowserState | null => {
    calls.push({ method, id })
    return tabs.get(id)?.state ?? null
  }

  const host: AgentSurface = {
    states: (id) =>
      id === undefined ? [...tabs.values()].map((tab) => tab.state) : tabs.has(id) ? [tabs.get(id)!.state] : [],
    entries: (id) => {
      calls.push({ method: 'entries', id })
      return tabs.get(id)?.console ?? []
    },
    evaluate: (id, source) => {
      calls.push({ method: 'evaluate', id, detail: source })
      return Promise.resolve(evaluator(id, source))
    },
    openFor: (opener, url) => {
      const id = add(url, opener)
      calls.push({ method: 'openFor', id, detail: { opener, url } })
      return Promise.resolve({ state: tabs.get(id)!.state, problem: null })
    },
    navigateFor: (opener, id, url) => {
      calls.push({ method: 'navigateFor', id, detail: { opener, url } })
      const tab = tabs.get(id)!
      tab.state = { ...tab.state, url }
      return { state: tab.state, problem: null }
    },
    closeFor: (opener, id) => {
      calls.push({ method: 'closeFor', id })
      // The host's own rule, which a shared tab reaches: only the opener closes.
      if (tabs.get(id)?.opener?.key !== opener.key) return { closed: false, problem: "closing it is theirs" }
      tabs.delete(id)
      return { closed: true, problem: null }
    },
    openerOf: (id) => tabs.get(id)?.opener ?? null,
    sharedWith: (id) => tabs.get(id)?.shared ?? null,
    revoke: (key) => {
      calls.push({ method: 'revoke', id: 0, detail: key })
      for (const [id, tab] of tabs) if (tab.shared?.key === key) share(id, null)
    },
    back: (id) => travel(id, 'back'),
    forward: (id) => travel(id, 'forward'),
    reload: (id) => travel(id, 'reload'),
    hover: (id, x, y) => {
      calls.push({ method: 'hover', id, detail: { x, y } })
      return Promise.resolve()
    },
    scroll: (id, x, y, dx, dy) => {
      calls.push({ method: 'scroll', id, detail: { x, y, dx, dy } })
      return Promise.resolve()
    },
    viewport: () => ({ width: 1280, height: 800, zoom }),
    capturePng: (id) => {
      calls.push({ method: 'capturePng', id })
      return Promise.resolve(shot)
    },
    pointer: (id, x, y, options) => {
      calls.push({ method: 'pointer', id, detail: { x, y, options } })
      return Promise.resolve()
    },
    typeInto: (id, text) => {
      calls.push({ method: 'typeInto', id, detail: text })
      return Promise.resolve()
    },
    press: (id, key, modifiers) => {
      calls.push({ method: 'press', id, detail: { key, modifiers } })
      return Promise.resolve()
    }
  }

  return {
    // A downcast: the endpoint is typed against the whole host and touches only this part.
    host: host as BrowserHost,
    tabs,
    calls,
    add,
    share,
    evaluateWith: (next: Evaluator) => {
      evaluator = next
    },
    zoomTo: (level: number) => {
      zoom = level
    },
    captureAs: (next: typeof shot) => {
      shot = next
    }
  }
}

/** Whether anything accepts a TCP connection at that address. */
function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

describe('the tool endpoint', () => {
  let dir: string
  let settings: AppSettings
  let browsers: ReturnType<typeof fakeBrowsers>
  let endpoint: BrowserMcpHost
  const others: BrowserMcpHost[] = []

  const make = (): BrowserMcpHost =>
    createBrowserMcp({ browsers: browsers.host, settings: () => settings, dir, sessions: () => null })

  /** A registration and the two URLs it was handed. */
  const register = (name: string): BrowserMcpRegistration & { browser: string; sessions: string } => {
    const registration = endpoint.register(name)
    if (registration === null) throw new Error('the endpoint registered nobody')
    const url = (server: string): string => registration.launch.servers.find((s) => s.name === server)?.url ?? ''
    return { ...registration, browser: url('helm-browser'), sessions: url('helm-sessions') }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'helm mcp-'))
    settings = { ...DEFAULT_SETTINGS }
    browsers = fakeBrowsers()
    endpoint = make()
  })

  afterEach(async () => {
    await Promise.all([endpoint, ...others.splice(0)].map((host) => host.stop()))
    rmSync(dir, { recursive: true, force: true })
  })

  describe('the listener', () => {
    it('binds 127.0.0.1 on a port the kernel chose, and nothing else', async () => {
      expect(await endpoint.start()).toEqual({ started: true, problem: null })
      const bound = endpoint.address()
      expect(bound).toEqual({ address: '127.0.0.1', family: 'IPv4', port: expect.any(Number) as number })
      const port = bound?.port ?? 0
      expect(port).toBeGreaterThan(0)

      // Ephemeral: a second endpoint is handed a different port, not a fixed one.
      const second = make()
      others.push(second)
      await second.start()
      expect(second.address()?.port).not.toBe(port)

      // The IPv4 loopback and not the IPv6 one: `::` would have answered both.
      expect(await accepts('127.0.0.1', port)).toBe(true)
      expect(await accepts('::1', port)).toBe(false)
    })

    it('answers 401 before reading anything to a request without the exact token', async () => {
      await endpoint.start()
      const alpha = register('alpha')
      const offByOne = `${alpha.token.slice(0, -1)}${alpha.token.endsWith('0') ? '1' : '0'}`
      const wrong = [
        {},
        { Authorization: `Bearer ${offByOne}` },
        { Authorization: `Bearer ${alpha.token}0` },
        { Authorization: `Bearer ${alpha.token.slice(1)}` },
        { Authorization: `Basic ${alpha.token}` },
        { Authorization: alpha.token }
      ]
      for (const url of [alpha.browser, alpha.sessions]) {
        for (const headers of wrong) {
          // A body that is not JSON: a parse error here would mean it was read.
          const answer = await send(url, { body: '{ not json', headers })
          expect(answer.status).toBe(401)
          expect(answer.headers['www-authenticate']).toBe('Bearer')
        }
      }
      // Without a token, a path that does not exist is no different from one that does.
      const origin = new URL(alpha.browser).origin
      expect((await send(`${origin}/nothing-here`, { body: '{}' })).status).toBe(401)
      expect((await send(alpha.browser, { method: 'GET' })).status).toBe(401)
    })

    it('answers a wrong path with 404 and anything but POST with 405, to a caller holding the token', async () => {
      await endpoint.start()
      const alpha = register('alpha')
      const origin = new URL(alpha.browser).origin
      const auth = { Authorization: `Bearer ${alpha.token}` }
      for (const path of ['/', '/mcp/', '/MCP', '/mcp/browser', '/mcp/sessions/list', '/health']) {
        expect((await send(`${origin}${path}`, { body: '{}', headers: auth })).status, path).toBe(404)
      }
      for (const url of [alpha.browser, alpha.sessions]) {
        const get = await send(url, { method: 'GET', headers: auth })
        expect(get.status).toBe(405)
        expect(get.headers['allow']).toBe('POST')
        expect((await send(url, { method: 'DELETE', headers: auth })).status).toBe(405)
      }
    })

    it('refuses a request from a web page, whatever token it carries', async () => {
      await endpoint.start()
      const alpha = register('alpha')
      const fromPage = await rpc(alpha.browser, alpha.token, 'tools/list', undefined, { Origin: 'https://example.com' })
      expect(fromPage.status).toBe(403)
      const fromLoopback = await rpc(alpha.browser, alpha.token, 'tools/list', undefined, { Origin: 'http://localhost:3000' })
      expect(fromLoopback.status).toBe(200)
    })

    it('serves exactly the ten browser tools on the browser route', async () => {
      await endpoint.start()
      const alpha = register('alpha')
      expect((await toolNames(alpha.browser, alpha.token)).sort()).toEqual(BROWSER_TOOLS)
    })

    it('serves exactly the two session tools on the sessions route, and says they are read-only', async () => {
      await endpoint.start()
      const alpha = register('alpha')
      const { tools } = await rpcResult<{ tools: { name: string; description: string }[] }>(
        alpha.sessions,
        alpha.token,
        'tools/list'
      )
      expect(tools.map((tool) => tool.name).sort()).toEqual(['session_detail', 'sessions_list'])
      for (const tool of tools) expect(tool.description, tool.name).toMatch(/read-only/i)
      const init = await rpcResult<{ instructions: string }>(alpha.sessions, alpha.token, 'initialize', {})
      expect(init.instructions).toMatch(/read-only/i)
    })

    it('names each family on its own route of one port, and negotiates the protocol version', async () => {
      await endpoint.start()
      const alpha = register('alpha')
      const port = endpoint.address()?.port ?? 0
      expect(alpha.token).toMatch(/^[0-9a-f]{64}$/)
      expect(alpha.launch).toEqual({
        dir,
        servers: [
          { name: 'helm-browser', url: `http://127.0.0.1:${String(port)}/mcp`, headers: { Authorization: `Bearer ${alpha.token}` } },
          {
            name: 'helm-sessions',
            url: `http://127.0.0.1:${String(port)}/mcp/sessions`,
            headers: { Authorization: `Bearer ${alpha.token}` }
          }
        ]
      })

      type Init = { protocolVersion: string; serverInfo: { name: string }; instructions: string }
      const browser = await rpcResult<Init>(alpha.browser, alpha.token, 'initialize', { protocolVersion: '2025-03-26' })
      expect(browser.serverInfo.name).toBe('helm-browser')
      expect(browser.protocolVersion).toBe('2025-03-26')
      expect(browser.instructions).toContain('browser pane')
      const sessions = await rpcResult<Init>(alpha.sessions, alpha.token, 'initialize', { protocolVersion: '1999-01-01' })
      expect(sessions.serverInfo.name).toBe('helm-sessions')
      expect(sessions.protocolVersion).toBe('2025-06-18')
    })

    it('answers a notification with 202 and no body, and refuses what it does not speak', async () => {
      await endpoint.start()
      const alpha = register('alpha')
      const auth = { Authorization: `Bearer ${alpha.token}` }

      const notification = await send(alpha.browser, {
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        headers: auth
      })
      expect(notification.status).toBe(202)
      expect(notification.text).toBe('')

      const codeOf = (answer: { json: unknown }): number | undefined => (answer.json as { error?: { code: number } }).error?.code
      expect(codeOf(await rpc(alpha.browser, alpha.token, 'resources/list'))).toBe(-32601)
      expect(codeOf(await send(alpha.browser, { body: '{ not json', headers: auth }))).toBe(-32700)
      expect(codeOf(await send(alpha.browser, { body: '[]', headers: auth }))).toBe(-32600)
      expect(await rpcResult(alpha.browser, alpha.token, 'ping')).toEqual({})
    })

    it('gives every registration a token of its own', async () => {
      await endpoint.start()
      const alpha = register('alpha')
      const beta = register('beta')
      expect(beta.token).not.toBe(alpha.token)
      expect(beta.browser).toBe(alpha.browser)
      for (const who of [alpha, beta]) {
        expect((await rpc(who.browser, who.token, 'ping')).status).toBe(200)
        expect((await rpc(who.sessions, who.token, 'ping')).status).toBe(200)
      }
    })

    it('with every family off, binds nothing and mints no token', async () => {
      settings = { ...settings, browserMcp: false, sessionMcp: false }
      const answer = await endpoint.start()
      expect(answer.started).toBe(false)
      expect(answer.problem).toContain('both off')
      expect(endpoint.running()).toBe(false)
      expect(endpoint.address()).toBeNull()
      expect(endpoint.register('alpha')).toBeNull()
      expect(endpoint.servedNames()).toEqual([])
    })

    it('takes a family away at once when it is switched off, and gives it back when it is switched on', async () => {
      await endpoint.start()
      const alpha = register('alpha')
      expect(endpoint.servedNames()).toEqual(['helm-browser', 'helm-sessions'])

      settings = { ...settings, sessionMcp: false }
      expect((await rpc(alpha.sessions, alpha.token, 'tools/list')).status).toBe(404)
      expect((await rpc(alpha.browser, alpha.token, 'tools/list')).status).toBe(200)
      expect(endpoint.servedNames()).toEqual(['helm-browser'])
      // A session launched now is told about the browser tools only.
      expect(register('beta').launch.servers.map((server) => server.name)).toEqual(['helm-browser'])

      settings = { ...settings, sessionMcp: true }
      expect((await rpc(alpha.sessions, alpha.token, 'tools/list')).status).toBe(200)
      expect(endpoint.servedNames()).toEqual(['helm-browser', 'helm-sessions'])

      settings = { ...settings, browserMcp: false }
      expect((await rpc(alpha.browser, alpha.token, 'tools/list')).status).toBe(404)
      expect((await rpc(alpha.sessions, alpha.token, 'tools/list')).status).toBe(200)
      expect(endpoint.servedNames()).toEqual(['helm-sessions'])
    })

    it('revokes one token and its file on release, and every token and file on stop', async () => {
      await endpoint.start()
      const alpha = register('alpha')
      const beta = register('beta')
      const alphaFile = writeSessionMcpConfig(dir, alpha.launch.servers)
      const betaFile = writeSessionMcpConfig(dir, beta.launch.servers)
      expect(alphaFile !== null && existsSync(alphaFile)).toBe(true)
      expect(betaFile !== null && existsSync(betaFile)).toBe(true)
      endpoint.attach(alpha.token, alphaFile)
      endpoint.attach(beta.token, betaFile)

      endpoint.release(alpha.token)
      expect((await rpc(alpha.browser, alpha.token, 'ping')).status).toBe(401)
      expect((await rpc(alpha.sessions, alpha.token, 'ping')).status).toBe(401)
      expect(existsSync(alphaFile!)).toBe(false)
      expect((await rpc(beta.browser, beta.token, 'ping')).status).toBe(200)
      expect(existsSync(betaFile!)).toBe(true)
      endpoint.release(alpha.token)
      endpoint.release(null)

      const port = endpoint.address()?.port ?? 0
      await endpoint.stop()
      expect(endpoint.running()).toBe(false)
      expect(existsSync(betaFile!)).toBe(false)
      expect(await accepts('127.0.0.1', port)).toBe(false)

      // A restarted endpoint knows none of the tokens it handed out before.
      await endpoint.start()
      const after = register('gamma')
      expect((await rpc(after.browser, beta.token, 'ping')).status).toBe(401)
      expect((await rpc(after.browser, after.token, 'ping')).status).toBe(200)
    })

    it('says a session tool cannot answer yet while the app is still starting', async () => {
      await endpoint.start()
      const alpha = register('alpha')
      const answer = await callTool(alpha.sessions, alpha.token, 'sessions_list')
      expect(answer.isError).toBe(true)
      expect(answer.text).toContain('still starting up')
    })
  })

  describe('the browser tools', () => {
    let alpha: ReturnType<typeof register>
    let beta: ReturnType<typeof register>

    beforeEach(async () => {
      await endpoint.start()
      alpha = register('alpha')
      beta = register('beta')
    })

    const open = async (who: typeof alpha, url: string): Promise<number> => {
      const answer = await callTool(who.browser, who.token, 'browser_open', { url })
      const id = Number(/^tab: (\d+)$/m.exec(answer.text)?.[1])
      if (answer.isError || !Number.isInteger(id)) throw new Error(`browser_open failed: ${answer.text}`)
      return id
    }

    /** The block `browser_tabs` printed for one tab. */
    const blockFor = (text: string, id: number): string =>
      text.split(/\n(?=#)/).find((block) => block.startsWith(`#${String(id)} `)) ?? ''

    it('opens a tab for the calling session, and answers with its id, address and title', async () => {
      const answer = await callTool(alpha.browser, alpha.token, 'browser_open', { url: 'http://127.0.0.1:5173/' })
      expect(answer.isError).toBe(false)
      expect(answer.text).toBe('tab: 1\nurl: http://127.0.0.1:5173/\ntitle: Page at 127.0.0.1:5173')
      expect(browsers.calls.find((call) => call.method === 'openFor')?.detail).toEqual({
        opener: { key: alpha.token, name: 'alpha' },
        url: 'http://127.0.0.1:5173/'
      })

      // A bare port is a dev server on this machine, as in the address bar.
      const port = await callTool(alpha.browser, alpha.token, 'browser_open', { url: '3000' })
      expect(port.text).toContain('url: http://localhost:3000/')
    })

    it('tells a session which of the open tabs are its own', async () => {
      const mine = await open(alpha, 'http://127.0.0.1:5173/a')
      const theirs = await open(beta, 'http://127.0.0.1:5173/b')
      const user = browsers.add('http://127.0.0.1:5173/user', null)

      const listed = (await callTool(alpha.browser, alpha.token, 'browser_tabs')).text
      expect(blockFor(listed, mine)).toMatch(/http:\/\/127\.0\.0\.1:5173\/a[\s\S]*yours$/)
      expect(blockFor(listed, theirs)).toMatch(/opened by the session "beta"$/)
      expect(blockFor(listed, user)).toMatch(/opened by the user$/)
      expect(blockFor((await callTool(beta.browser, beta.token, 'browser_tabs')).text, theirs)).toMatch(/yours$/)
    })

    it('never reads or drives a tab the user opened', async () => {
      const user = browsers.add('http://127.0.0.1:5173/private', null)
      const attempts: [string, Record<string, unknown>][] = [
        ['browser_snapshot', {}],
        ['browser_screenshot', {}],
        ['browser_evaluate', { expression: 'document.cookie' }],
        ['browser_console', {}],
        ['browser_click', { x: 10, y: 10 }],
        ['browser_type', { text: 'x' }],
        ['browser_press', { key: 'Enter' }],
        ['browser_close', {}],
        ['browser_open', { url: 'http://127.0.0.1:5173/elsewhere' }],
        ['browser_navigate', { url: 'http://127.0.0.1:5173/elsewhere' }],
        ['browser_text', {}],
        ['browser_hover', { x: 10, y: 10 }],
        ['browser_select', { selector: 'select', values: ['a'] }],
        ['browser_scroll', { dy: 100 }],
        ['browser_wait_for', { text: 'x', timeout: 0.1 }]
      ]
      for (const [name, args] of attempts) {
        const answer = await callTool(alpha.browser, alpha.token, name, { ...args, tab: user })
        expect(answer.isError, name).toBe(true)
        expect(answer.text, name).toContain(`Browser tab ${String(user)} was opened by the user`)
      }
      expect(browsers.calls.filter((call) => call.id === user)).toEqual([])
      expect(browsers.tabs.get(user)?.state.url).toBe('http://127.0.0.1:5173/private')
    })

    it("refuses to close or drive another session's tab, naming its owner", async () => {
      const theirs = await open(alpha, 'http://127.0.0.1:5173/a')
      const before = browsers.calls.length
      for (const name of ['browser_close', 'browser_snapshot', 'browser_screenshot']) {
        const answer = await callTool(beta.browser, beta.token, name, { tab: theirs })
        expect(answer.isError, name).toBe(true)
        expect(answer.text, name).toContain(`Browser tab ${String(theirs)} belongs to the session "alpha"`)
      }
      expect(browsers.calls.slice(before)).toEqual([])
      expect(browsers.tabs.has(theirs)).toBe(true)
    })

    it('lets a session close its own tab; when it ends, its tabs stay and its token is refused', async () => {
      const first = await open(alpha, 'http://127.0.0.1:5173/one')
      const closed = await callTool(alpha.browser, alpha.token, 'browser_close', { tab: first })
      expect(closed).toMatchObject({ isError: false, text: `Closed tab #${String(first)}.` })
      expect(browsers.tabs.has(first)).toBe(false)

      const second = await open(alpha, 'http://127.0.0.1:5173/two')
      endpoint.release(alpha.token)
      expect((await rpc(alpha.browser, alpha.token, 'tools/list')).status).toBe(401)
      expect(browsers.tabs.get(second)?.state.openedBy).toBe('alpha')
      expect(browsers.calls.filter((call) => call.method === 'closeFor' && call.id === second)).toEqual([])
      // And it is still nobody else's to close.
      const answer = await callTool(beta.browser, beta.token, 'browser_close', { tab: second })
      expect(answer.text).toContain('belongs to the session "alpha"')
    })

    it('reaches off the machine only when the pane may and the tools are not held to it', async () => {
      const postures: { browserReach: AppSettings['browserReach']; browserMcpLocalOnly: boolean; offMachine: boolean }[] = [
        { browserReach: 'web', browserMcpLocalOnly: false, offMachine: true },
        { browserReach: 'web', browserMcpLocalOnly: true, offMachine: false },
        { browserReach: 'local', browserMcpLocalOnly: false, offMachine: false },
        { browserReach: 'local', browserMcpLocalOnly: true, offMachine: false }
      ]
      for (const posture of postures) {
        settings = { ...settings, ...posture }
        const label = JSON.stringify(posture)
        const opened = (): number => browsers.calls.filter((call) => call.method === 'openFor').length

        const before = opened()
        const away = await callTool(alpha.browser, alpha.token, 'browser_open', { url: 'https://example.com/' })
        expect(away.isError, label).toBe(!posture.offMachine)
        expect(opened() - before, label).toBe(posture.offMachine ? 1 : 0)
        if (!posture.offMachine) expect(away.text, label).toMatch(/^[A-Z].*\.$/s)

        const here = await callTool(alpha.browser, alpha.token, 'browser_open', { url: 'http://127.0.0.1:5173/' })
        expect(here.isError, label).toBe(false)

        const file = await callTool(alpha.browser, alpha.token, 'browser_open', { url: 'file:///C:/Windows/win.ini' })
        expect(file.isError, label).toBe(true)
      }
    })

    it('answers browser_console with a cursor, and with only what is new after it', async () => {
      const tab = await open(alpha, 'http://127.0.0.1:5173/')
      const logged = browsers.tabs.get(tab)!.console
      logged.push(
        { level: 'log', message: 'first', source: 'http://127.0.0.1:5173/app.js', line: 3, at: Date.UTC(2026, 0, 1, 9, 30, 0) },
        { level: 'error', message: 'second', source: '', line: 0, at: Date.UTC(2026, 0, 1, 9, 30, 1) }
      )

      const all = await callTool(alpha.browser, alpha.token, 'browser_console', {})
      expect(all.text).toBe(
        'cursor: 2\n[09:30:00] log: first  (http://127.0.0.1:5173/app.js:3)\n[09:30:01] error: second'
      )
      expect((await callTool(alpha.browser, alpha.token, 'browser_console', { cursor: 2 })).text).toBe(
        'cursor: 2\n(nothing new)'
      )
      logged.push({ level: 'warn', message: 'third', source: 'helm', line: 0, at: Date.UTC(2026, 0, 1, 9, 30, 2) })
      expect((await callTool(alpha.browser, alpha.token, 'browser_console', { cursor: 2 })).text).toBe(
        'cursor: 3\n[09:30:02] warn: third'
      )
    })

    it("answers browser_evaluate with the page's value, and a throw as the page's error", async () => {
      await open(alpha, 'http://127.0.0.1:5173/')
      browsers.evaluateWith((_id, source) =>
        source === '6 * 7'
          ? { ok: true, value: '42', error: null }
          : source === '""'
            ? { ok: true, value: '', error: null }
            : { ok: false, value: '', error: 'ReferenceError: boom is not defined' }
      )
      expect(await callTool(alpha.browser, alpha.token, 'browser_evaluate', { expression: '6 * 7' })).toMatchObject({
        isError: false,
        text: '42'
      })
      expect((await callTool(alpha.browser, alpha.token, 'browser_evaluate', { expression: '""' })).text).toBe('(empty string)')
      expect(await callTool(alpha.browser, alpha.token, 'browser_evaluate', { expression: 'boom()' })).toMatchObject({
        isError: true,
        text: 'The page raised: ReferenceError: boom is not defined'
      })
    })

    it('puts the caret in the named field before typing, replacing what is there when asked', async () => {
      const tab = await open(alpha, 'http://127.0.0.1:5173/')
      browsers.evaluateWith((_id, source) => ({
        ok: true,
        value: source.includes('"9.9"') ? 'missing' : source.includes('"1.4"') ? 'not-focusable' : 'focused',
        error: null
      }))
      const from = browsers.calls.length

      const typed = await callTool(alpha.browser, alpha.token, 'browser_type', {
        ref: '1.2',
        text: 'Hello',
        clear: true,
        submit: true
      })
      expect(typed).toMatchObject({ isError: false, text: 'Typed "Hello" into [ref=1.2] and pressed Enter.' })
      const made = browsers.calls.slice(from)
      expect(made.map((call) => call.method)).toEqual(['evaluate', 'typeInto', 'press'])
      expect(made[0]?.detail).toContain('"1.2"')
      expect(made[0]?.detail).toContain('el.select()')
      expect(made[1]).toEqual({ method: 'typeInto', id: tab, detail: 'Hello' })
      expect(made[2]).toMatchObject({ method: 'press', id: tab, detail: { key: 'Enter' } })

      for (const [ref, says] of [
        ['9.9', 'Nothing is at [ref=9.9] any more'],
        ['1.4', 'cannot take the caret']
      ] as const) {
        const before = browsers.calls.length
        const refused = await callTool(alpha.browser, alpha.token, 'browser_type', { ref, text: 'x' })
        expect(refused.isError).toBe(true)
        expect(refused.text).toContain(says)
        expect(browsers.calls.slice(before).map((call) => call.method)).toEqual(['evaluate'])
      }
    })

    it('presses one key with the modifiers it knows, and drops the ones it does not', async () => {
      const tab = await open(alpha, 'http://127.0.0.1:5173/')
      const backspace = await callTool(alpha.browser, alpha.token, 'browser_press', { key: 'Backspace' })
      expect(backspace.text).toBe(`Pressed Backspace in tab #${String(tab)}.`)
      const chord = await callTool(alpha.browser, alpha.token, 'browser_press', { key: 'a', modifiers: ['control', 'hyper'] })
      expect(chord.text).toBe(`Pressed control+a in tab #${String(tab)}.`)
      expect(browsers.calls.filter((call) => call.method === 'press').map((call) => call.detail)).toEqual([
        { key: 'Backspace', modifiers: [] },
        { key: 'a', modifiers: ['control'] }
      ])
    })

    it('clicks the middle of the element it names, at the page zoom', async () => {
      const tab = await open(alpha, 'http://127.0.0.1:5173/')
      let box: Record<string, unknown> = { x: 110, y: 55, width: 20, height: 10 }
      browsers.evaluateWith(() => ({ ok: true, value: JSON.stringify(box), error: null }))
      const pointed = (): unknown[] => browsers.calls.filter((call) => call.method === 'pointer').map((call) => call.detail)

      expect((await callTool(alpha.browser, alpha.token, 'browser_click', { ref: '1.0' })).text).toBe(
        'Clicked [ref=1.0] at (110, 55).'
      )
      browsers.zoomTo(1.5)
      await callTool(alpha.browser, alpha.token, 'browser_click', { selector: '#go', button: 'right', clickCount: 2 })
      await callTool(alpha.browser, alpha.token, 'browser_click', { x: 4, y: 5 })
      expect(pointed()).toEqual([
        { x: 110, y: 55, options: {} },
        { x: 165, y: 82.5, options: { button: 'right', clickCount: 2 } },
        { x: 4, y: 5, options: {} }
      ])

      box = { x: 0, y: 0, width: 0, height: 10 }
      const hidden = await callTool(alpha.browser, alpha.token, 'browser_click', { ref: '1.1', tab })
      expect(hidden.isError).toBe(true)
      expect(hidden.text).toContain('has no size on screen')
      const nowhere = await callTool(alpha.browser, alpha.token, 'browser_click', {})
      expect(nowhere.isError).toBe(true)
      expect(pointed()).toHaveLength(3)
    })

    it("answers browser_screenshot with the tab's own PNG, and refuses an empty capture", async () => {
      const tab = await open(alpha, 'http://127.0.0.1:5173/')
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7])
      browsers.captureAs({ width: 1280, height: 800, png })
      const shot = await callTool(alpha.browser, alpha.token, 'browser_screenshot', {})
      expect(shot.text).toBe(`Tab #${String(tab)}, 1280x800.`)
      expect(shot.images).toEqual([{ mimeType: 'image/png', data: png.toString('base64') }])

      browsers.captureAs({ width: 1, height: 1, png })
      const empty = await callTool(alpha.browser, alpha.token, 'browser_screenshot', {})
      expect(empty.isError).toBe(true)
      expect(empty.images).toEqual([])
    })

    it('tells a session with no tab to open one, and names a tab that is gone', async () => {
      const none = await callTool(alpha.browser, alpha.token, 'browser_snapshot', {})
      expect(none.isError).toBe(true)
      expect(none.text).toContain('Call browser_open')
      const gone = await callTool(alpha.browser, alpha.token, 'browser_snapshot', { tab: 99 })
      expect(gone.isError).toBe(true)
      expect(gone.text).toContain('There is no browser tab 99')
    })

    describe('a tab the user shares', () => {
      const opener = (who: typeof alpha, name: string): BrowserOpener => ({ key: who.token, name })

      it('is driven by the session it is shared with, and listed as such to every session', async () => {
        const user = browsers.add('http://127.0.0.1:5173/mine', null)
        browsers.share(user, opener(alpha, 'alpha'))

        // With no tab named and none used yet, the shared one is the one meant.
        const read = await callTool(alpha.browser, alpha.token, 'browser_evaluate', { expression: '1' })
        expect(read.isError).toBe(false)
        expect(browsers.calls.at(-1)).toMatchObject({ method: 'evaluate', id: user })

        expect(blockFor((await callTool(alpha.browser, alpha.token, 'browser_tabs')).text, user)).toMatch(
          /opened by the user, shared with you: read and drive it, but it is theirs to close$/
        )
        expect(blockFor((await callTool(beta.browser, beta.token, 'browser_tabs')).text, user)).toMatch(
          /opened by the user, shared with the session "alpha"$/
        )

        const moved = await callTool(alpha.browser, alpha.token, 'browser_navigate', { url: 'http://127.0.0.1:5173/next' })
        expect(moved.isError).toBe(false)
        expect(browsers.calls.find((call) => call.method === 'navigateFor')).toMatchObject({ id: user })
      })

      it('is not driven by any other session, and not closed by the one it is shared with', async () => {
        const user = browsers.add('http://127.0.0.1:5173/mine', null)
        browsers.share(user, opener(alpha, 'alpha'))
        const before = browsers.calls.length

        const other = await callTool(beta.browser, beta.token, 'browser_snapshot', { tab: user })
        expect(other.isError).toBe(true)
        expect(other.text).toBe(
          `Browser tab ${String(user)} was opened by the user and is shared with the session "alpha", not this one.`
        )
        expect(browsers.calls.slice(before)).toEqual([])

        const closing = await callTool(alpha.browser, alpha.token, 'browser_close', { tab: user })
        expect(closing.isError).toBe(true)
        expect(browsers.tabs.has(user)).toBe(true)
      })

      it('stops being driven when the user takes it back, and when the session ends', async () => {
        const user = browsers.add('http://127.0.0.1:5173/mine', null)
        browsers.share(user, opener(alpha, 'alpha'))
        expect((await callTool(alpha.browser, alpha.token, 'browser_evaluate', { tab: user, expression: '1' })).isError).toBe(false)

        browsers.share(user, null)
        const unshared = await callTool(alpha.browser, alpha.token, 'browser_text', { tab: user })
        expect(unshared.isError).toBe(true)
        expect(unshared.text).toContain("ask the user to share this one from the Share button in Helm's browser bar")

        // The token is the identity a share is made to, so ending the session revokes it.
        browsers.share(user, opener(alpha, 'alpha'))
        endpoint.release(alpha.token)
        expect(browsers.calls.filter((call) => call.method === 'revoke').map((call) => call.detail)).toEqual([
          alpha.token
        ])
        expect(browsers.tabs.get(user)?.shared).toBeNull()

        await endpoint.stop()
        expect(browsers.calls.filter((call) => call.method === 'revoke').map((call) => call.detail)).toEqual([
          alpha.token,
          beta.token
        ])
      })

      it('is held to the tools\' reach: off the machine is refused while they are confined to it', async () => {
        const away = browsers.add('https://example.com/account', null)
        browsers.share(away, opener(alpha, 'alpha'))
        settings = { ...settings, browserMcpLocalOnly: true }
        const refused = await callTool(alpha.browser, alpha.token, 'browser_screenshot', { tab: away })
        expect(refused.isError).toBe(true)
        expect(refused.text).toBe(
          `Browser tab ${String(away)} is at https://example.com/account. Helm's browser tools are held to this machine in Settings > Browser, so this session may not read or drive a page anywhere else.`
        )
        expect(browsers.calls.filter((call) => call.id === away)).toEqual([])

        settings = { ...settings, browserMcpLocalOnly: false }
        expect((await callTool(alpha.browser, alpha.token, 'browser_screenshot', { tab: away })).isError).toBe(false)
      })
    })

    it('navigates a tab to a URL, or back, forward or reloads it - one or the other', async () => {
      const tab = await open(alpha, 'http://127.0.0.1:5173/one')
      const to = await callTool(alpha.browser, alpha.token, 'browser_navigate', { url: '5173' })
      expect(to.text).toBe(`tab: ${String(tab)}\nurl: http://localhost:5173/\ntitle: Page at 127.0.0.1:5173`)

      const nowhere = await callTool(alpha.browser, alpha.token, 'browser_navigate', { go: 'back' })
      expect(nowhere).toMatchObject({ isError: true, text: `Tab #${String(tab)} has nothing to go back to.` })
      browsers.tabs.get(tab)!.state = { ...browsers.tabs.get(tab)!.state, canGoBack: true }
      expect((await callTool(alpha.browser, alpha.token, 'browser_navigate', { go: 'back' })).isError).toBe(false)
      expect((await callTool(alpha.browser, alpha.token, 'browser_navigate', { go: 'reload' })).isError).toBe(false)
      expect(browsers.calls.filter((call) => ['back', 'forward', 'reload'].includes(call.method))).toEqual([
        { method: 'back', id: tab },
        { method: 'reload', id: tab }
      ])

      for (const args of [{}, { url: '5173', go: 'back' }]) {
        const both = await callTool(alpha.browser, alpha.token, 'browser_navigate', args)
        expect(both.isError).toBe(true)
        expect(both.text).toContain('one of the two')
      }
    })

    it("reads the page's text in pieces, with the blank runs a layout leaves cut down", async () => {
      const tab = await open(alpha, 'http://127.0.0.1:5173/')
      let text = 'Title\r\n\n\n\nFirst line   \nSecond'
      browsers.evaluateWith(() => ({ ok: true, value: JSON.stringify({ text, url: 'http://127.0.0.1:5173/' }), error: null }))
      expect((await callTool(alpha.browser, alpha.token, 'browser_text')).text).toBe(
        `tab: ${String(tab)}\nurl: http://127.0.0.1:5173/\ncharacters: 0-24 of 24\n\nTitle\n\nFirst line\nSecond`
      )

      text = 'x'.repeat(450)
      const first = await callTool(alpha.browser, alpha.token, 'browser_text', { maxChars: 200 })
      expect(first.text).toContain('characters: 0-200 of 450')
      expect(first.text.endsWith('(more: pass offset 200)')).toBe(true)
      const last = await callTool(alpha.browser, alpha.token, 'browser_text', { maxChars: 200, offset: 400 })
      expect(last.text).toContain('characters: 400-450 of 450')
      expect(last.text).not.toContain('(more')

      browsers.evaluateWith(() => ({ ok: true, value: JSON.stringify({ missing: true }), error: null }))
      const missing = await callTool(alpha.browser, alpha.token, 'browser_text', { ref: '4.4' })
      expect(missing).toMatchObject({ isError: true })
      expect(missing.text).toContain('Nothing is at [ref=4.4] any more')
    })

    it('hovers over the middle of the element it names, pressing nothing', async () => {
      const tab = await open(alpha, 'http://127.0.0.1:5173/')
      browsers.evaluateWith(() => ({ ok: true, value: JSON.stringify({ x: 110, y: 55, width: 20, height: 10 }), error: null }))
      expect((await callTool(alpha.browser, alpha.token, 'browser_hover', { ref: '1.0' })).text).toBe(
        'The pointer is over [ref=1.0] at (110, 55).'
      )
      expect(browsers.calls.filter((call) => call.method === 'hover')).toEqual([
        { method: 'hover', id: tab, detail: { x: 110, y: 55 } }
      ])
      expect(browsers.calls.filter((call) => call.method === 'pointer')).toEqual([])
      const nowhere = await callTool(alpha.browser, alpha.token, 'browser_hover', {})
      expect(nowhere.text).toBe(
        'browser_hover needs somewhere to point at: a ref from browser_snapshot, a CSS selector, or both x and y.'
      )
    })

    it('chooses options in a select by value or label, and says which exist when one does not', async () => {
      await open(alpha, 'http://127.0.0.1:5173/')
      browsers.evaluateWith(() => ({ ok: true, value: JSON.stringify({ chosen: ['Two'] }), error: null }))
      expect(await callTool(alpha.browser, alpha.token, 'browser_select', { selector: '#pick', values: ['2'] })).toMatchObject({
        isError: false,
        text: 'Chose "Two" in "#pick".'
      })
      expect(browsers.calls.at(-1)?.detail).toContain('["2"]')

      browsers.evaluateWith(() => ({
        ok: true,
        value: JSON.stringify({ unknown: 'Nine', options: [{ value: '1', label: 'One' }, { value: 'two', label: 'two' }], more: 3 }),
        error: null
      }))
      expect((await callTool(alpha.browser, alpha.token, 'browser_select', { selector: '#pick', values: ['Nine'] })).text).toBe(
        '"#pick" has no option "Nine". It has: "One" (value "1"), "two", and 3 more.'
      )
      browsers.evaluateWith(() => ({ ok: true, value: JSON.stringify({ notSelect: 'div' }), error: null }))
      expect((await callTool(alpha.browser, alpha.token, 'browser_select', { ref: '1.2', values: ['a'] })).text).toContain(
        'is a <div>, not a <select>'
      )
      const unnamed = await callTool(alpha.browser, alpha.token, 'browser_select', { values: ['a'] })
      expect(unnamed).toMatchObject({ isError: true })
      expect(unnamed.text).toContain('needs the select')
    })

    it('scrolls with the wheel at the middle of the page, at the page zoom, and says what moved', async () => {
      const tab = await open(alpha, 'http://127.0.0.1:5173/')
      const place = (y: number, what = 'page'): string =>
        JSON.stringify({ what, x: 0, y, width: 1280, height: 2400, viewWidth: 1280, viewHeight: 800 })
      const answers = [place(0), place(400)]
      browsers.evaluateWith(() => ({ ok: true, value: answers.shift() ?? place(400), error: null }))
      expect((await callTool(alpha.browser, alpha.token, 'browser_scroll', { dy: 400 })).text).toBe(
        'Scrolled the page down 400px. It is at 400 of 2400 down (800 showing).'
      )
      expect(browsers.calls.filter((call) => call.method === 'scroll').at(-1)).toEqual({
        method: 'scroll',
        id: tab,
        detail: { x: 640, y: 400, dx: 0, dy: 400 }
      })

      browsers.zoomTo(1.5)
      answers.push(place(400, 'div#list'), place(400, 'div#list'))
      expect((await callTool(alpha.browser, alpha.token, 'browser_scroll', { dy: 100, x: 10, y: 20 })).text).toBe(
        'Nothing moved. <div#list> is already at its end, or nothing under (10, 20) scrolls that way.'
      )
      expect(browsers.calls.filter((call) => call.method === 'scroll').at(-1)?.detail).toEqual({
        x: 15,
        y: 30,
        dx: 0,
        dy: 150
      })

      const still = await callTool(alpha.browser, alpha.token, 'browser_scroll', {})
      expect(still).toMatchObject({ isError: true })
    })

    it('waits for text, its going, a selector or the load, and says when it never came', async () => {
      const tab = await open(alpha, 'http://127.0.0.1:5173/')
      const looks = ['no', 'no', 'yes']
      browsers.evaluateWith(() => ({ ok: true, value: looks.shift() ?? 'yes', error: null }))
      const came = await callTool(alpha.browser, alpha.token, 'browser_wait_for', { text: 'Ready' })
      expect(came.text).toMatch(/^"Ready" appeared after \d+\.\ds\.$/)
      expect(browsers.calls.filter((call) => call.method === 'evaluate')).toHaveLength(3)

      browsers.evaluateWith(() => ({ ok: true, value: 'no', error: null }))
      expect(await callTool(alpha.browser, alpha.token, 'browser_wait_for', { textGone: 'Saving', timeout: 0.2 })).toMatchObject({
        isError: true,
        text: `Waited 0.2s, and "Saving" was still there in tab #${String(tab)}.`
      })

      browsers.evaluateWith(() => ({ ok: true, value: 'bad:not a valid selector', error: null }))
      expect((await callTool(alpha.browser, alpha.token, 'browser_wait_for', { selector: '##' })).text).toBe(
        '"##" is not a selector the page accepts: not a valid selector'
      )
      expect((await callTool(alpha.browser, alpha.token, 'browser_wait_for', {})).text).toMatch(/^Loaded after /)
      expect((await callTool(alpha.browser, alpha.token, 'browser_wait_for', { text: 'a', seconds: 1 })).isError).toBe(true)
      expect((await callTool(alpha.browser, alpha.token, 'browser_wait_for', { seconds: 0.05 })).text).toBe('Waited 0.05s.')
    })
  })
})
