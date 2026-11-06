import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type AppSettings } from '@helm/core'
import { FakeConnection, fakeLink } from '../../test/host-connection'
import type { ToolAnswer as McpToolAnswer } from '../../test/mcp-client'
import type { BrowserHost, BrowserOpener } from './browser'
import {
  BROWSER_TOOL_TABLE,
  createBrowserMcp,
  pairBrowserTools,
  SNAPSHOT_MAX_NODES,
  TEXT_MAX_CHARS,
  WAIT_DEFAULT_S,
  WAIT_MAX_S,
  type BrowserMcpHost,
  type BrowserToolResult
} from './browser-mcp'
import { ANSWER_TOO_LARGE, createBrowserToolRelay, NOT_A_BROWSER_SESSION } from './host/browser-tools'
import { MAX_FRAME_LEN } from './host/protocol'
import type * as P from './host/protocol'
import type { BrowserConsoleEntry, BrowserState } from '../shared/ipc'

/**
 * Helm's browser tools, as the local host relays its sessions' calls to them
 * over a connection the test drives: what the tools let a session do to tabs
 * it does and does not own, and where they may reach.
 *
 * The browser host is a fake that records every call: what is under test here
 * is the tools' gate in front of the host. The tools against a real page are
 * `e2e/agent-tools.spec.ts`.
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

/** A relayed answer as the agent reads it. */
function answerOf({ outcome }: P.AgentBrowserToolAnswer): McpToolAnswer {
  if (outcome.status === 'failed') return { text: outcome.message, isError: true, images: [] }
  const result = outcome.value as BrowserToolResult
  return {
    text: result.content.flatMap((part) => (part.type === 'text' && part.text !== undefined ? [part.text] : [])).join('\n'),
    isError: result.isError === true,
    images: result.content.flatMap((part) =>
      part.type === 'image' && part.data !== undefined && part.mimeType !== undefined
        ? [{ data: part.data, mimeType: part.mimeType }]
        : []
    )
  }
}

describe('the browser tools', () => {
  let settings: AppSettings
  let browsers: ReturnType<typeof fakeBrowsers>
  let endpoint: BrowserMcpHost

  const make = (): BrowserMcpHost => createBrowserMcp({ browsers: browsers.host, settings: () => settings })

  beforeEach(() => {
    settings = { ...DEFAULT_SETTINGS }
    browsers = fakeBrowsers()
    endpoint = make()
  })

  /**
   * A session in the local host calling the browser tools, whose calls the
   * host relays to the window (`host/browser-tools.ts`) over a connection the
   * test drives.
   */
  interface Caller {
    /** Its identity at the tools: the key main minted for a host session. */
    key: string
    call(tool: string, args?: Record<string, unknown>): Promise<McpToolAnswer>
    /** The session ends. */
    end(): void
    /** Asserts that a call made after the session ended is refused. */
    refusedAfterEnd(): Promise<void>
  }

  /** Callers relayed from a fake host connection, each a running host session with a key of its own. */
  const relayedCallers = async (): Promise<(name: string) => Caller> => {
    const connection = new FakeConnection()
    const link = fakeLink(connection)
    const openers = new Map<number, BrowserOpener>()
    const waiting = new Map<number, (answer: P.AgentBrowserToolAnswer) => void>()
    connection.answer('agentBrowser:answer', (answer) => {
      waiting.get(answer.callId)?.(answer)
      waiting.delete(answer.callId)
      return null
    })
    createBrowserToolRelay({
      link,
      opener: (session) => openers.get(session) ?? null,
      run: (opener, tool, args) => endpoint.runBrowserTool(opener, tool, args),
      log: () => undefined
    })
    await link.connect()
    let nextSession = 1
    let nextCall = 1
    return (name) => {
      const session = nextSession++
      const opener: BrowserOpener = { key: `host-session-key-${name}`, name }
      openers.set(session, opener)
      const call = async (tool: string, args: Record<string, unknown> = {}): Promise<McpToolAnswer> => {
        const callId = nextCall++
        const answered = new Promise<P.AgentBrowserToolAnswer>((resolve) => waiting.set(callId, resolve))
        connection.push('agentBrowser:call', { callId, session, tool, arguments: args })
        return answerOf(await answered)
      }
      return {
        key: opener.key,
        call,
        // What the host sessions do when a session ends (`host/sessions.ts`).
        end: () => {
          openers.delete(session)
          endpoint.forgetOpener(opener.key)
        },
        refusedAfterEnd: async () => {
          expect(await call('browser_tabs')).toEqual({ text: NOT_A_BROWSER_SESSION, isError: true, images: [] })
        }
      }
    }
  }

  describe('called from the local host', () => {
    let alpha: Caller
    let beta: Caller

    beforeEach(async () => {
      const caller = await relayedCallers()
      alpha = caller('alpha')
      beta = caller('beta')
    })

    const open = async (who: typeof alpha, url: string): Promise<number> => {
      const answer = await who.call('browser_open', { url })
      const id = Number(/^tab: (\d+)$/m.exec(answer.text)?.[1])
      if (answer.isError || !Number.isInteger(id)) throw new Error(`browser_open failed: ${answer.text}`)
      return id
    }

    /** The block `browser_tabs` printed for one tab. */
    const blockFor = (text: string, id: number): string =>
      text.split(/\n(?=#)/).find((block) => block.startsWith(`#${String(id)} `)) ?? ''

    it('opens a tab for the calling session, and answers with its id, address and title', async () => {
      const answer = await alpha.call('browser_open', { url: 'http://127.0.0.1:5173/' })
      expect(answer.isError).toBe(false)
      expect(answer.text).toBe('tab: 1\nurl: http://127.0.0.1:5173/\ntitle: Page at 127.0.0.1:5173')
      expect(browsers.calls.find((call) => call.method === 'openFor')?.detail).toEqual({
        opener: { key: alpha.key, name: 'alpha' },
        url: 'http://127.0.0.1:5173/'
      })

      // A bare port is a dev server on this machine, as in the address bar.
      const port = await alpha.call('browser_open', { url: '3000' })
      expect(port.text).toContain('url: http://localhost:3000/')
    })

    it('tells a session which of the open tabs are its own', async () => {
      const mine = await open(alpha, 'http://127.0.0.1:5173/a')
      const theirs = await open(beta, 'http://127.0.0.1:5173/b')
      const user = browsers.add('http://127.0.0.1:5173/user', null)

      const listed = (await alpha.call('browser_tabs')).text
      expect(blockFor(listed, mine)).toMatch(/http:\/\/127\.0\.0\.1:5173\/a[\s\S]*yours$/)
      expect(blockFor(listed, theirs)).toMatch(/opened by the session "beta"$/)
      expect(blockFor(listed, user)).toMatch(/opened by the user$/)
      expect(blockFor((await beta.call('browser_tabs')).text, theirs)).toMatch(/yours$/)
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
        const answer = await alpha.call(name, { ...args, tab: user })
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
        const answer = await beta.call(name, { tab: theirs })
        expect(answer.isError, name).toBe(true)
        expect(answer.text, name).toContain(`Browser tab ${String(theirs)} belongs to the session "alpha"`)
      }
      expect(browsers.calls.slice(before)).toEqual([])
      expect(browsers.tabs.has(theirs)).toBe(true)
    })

    it('lets a session close its own tab; when it ends, its tabs stay and its token is refused', async () => {
      const first = await open(alpha, 'http://127.0.0.1:5173/one')
      const closed = await alpha.call('browser_close', { tab: first })
      expect(closed).toMatchObject({ isError: false, text: `Closed tab #${String(first)}.` })
      expect(browsers.tabs.has(first)).toBe(false)

      const second = await open(alpha, 'http://127.0.0.1:5173/two')
      alpha.end()
      await alpha.refusedAfterEnd()
      expect(browsers.tabs.get(second)?.state.openedBy).toBe('alpha')
      expect(browsers.calls.filter((call) => call.method === 'closeFor' && call.id === second)).toEqual([])
      // And it is still nobody else's to close.
      const answer = await beta.call('browser_close', { tab: second })
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
        const away = await alpha.call('browser_open', { url: 'https://example.com/' })
        expect(away.isError, label).toBe(!posture.offMachine)
        expect(opened() - before, label).toBe(posture.offMachine ? 1 : 0)
        if (!posture.offMachine) expect(away.text, label).toMatch(/^[A-Z].*\.$/s)

        const here = await alpha.call('browser_open', { url: 'http://127.0.0.1:5173/' })
        expect(here.isError, label).toBe(false)

        const file = await alpha.call('browser_open', { url: 'file:///C:/Windows/win.ini' })
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

      const all = await alpha.call('browser_console', {})
      expect(all.text).toBe(
        'cursor: 2\n[09:30:00] log: first  (http://127.0.0.1:5173/app.js:3)\n[09:30:01] error: second'
      )
      expect((await alpha.call('browser_console', { cursor: 2 })).text).toBe(
        'cursor: 2\n(nothing new)'
      )
      logged.push({ level: 'warn', message: 'third', source: 'helm', line: 0, at: Date.UTC(2026, 0, 1, 9, 30, 2) })
      expect((await alpha.call('browser_console', { cursor: 2 })).text).toBe(
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
      expect(await alpha.call('browser_evaluate', { expression: '6 * 7' })).toMatchObject({
        isError: false,
        text: '42'
      })
      expect((await alpha.call('browser_evaluate', { expression: '""' })).text).toBe('(empty string)')
      expect(await alpha.call('browser_evaluate', { expression: 'boom()' })).toMatchObject({
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

      const typed = await alpha.call('browser_type', {
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
        const refused = await alpha.call('browser_type', { ref, text: 'x' })
        expect(refused.isError).toBe(true)
        expect(refused.text).toContain(says)
        expect(browsers.calls.slice(before).map((call) => call.method)).toEqual(['evaluate'])
      }
    })

    it('presses one key with the modifiers it knows, and drops the ones it does not', async () => {
      const tab = await open(alpha, 'http://127.0.0.1:5173/')
      const backspace = await alpha.call('browser_press', { key: 'Backspace' })
      expect(backspace.text).toBe(`Pressed Backspace in tab #${String(tab)}.`)
      const chord = await alpha.call('browser_press', { key: 'a', modifiers: ['control', 'hyper'] })
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

      expect((await alpha.call('browser_click', { ref: '1.0' })).text).toBe(
        'Clicked [ref=1.0] at (110, 55).'
      )
      browsers.zoomTo(1.5)
      await alpha.call('browser_click', { selector: '#go', button: 'right', clickCount: 2 })
      await alpha.call('browser_click', { x: 4, y: 5 })
      expect(pointed()).toEqual([
        { x: 110, y: 55, options: {} },
        { x: 165, y: 82.5, options: { button: 'right', clickCount: 2 } },
        { x: 4, y: 5, options: {} }
      ])

      box = { x: 0, y: 0, width: 0, height: 10 }
      const hidden = await alpha.call('browser_click', { ref: '1.1', tab })
      expect(hidden.isError).toBe(true)
      expect(hidden.text).toContain('has no size on screen')
      const nowhere = await alpha.call('browser_click', {})
      expect(nowhere.isError).toBe(true)
      expect(pointed()).toHaveLength(3)
    })

    it("answers browser_screenshot with the tab's own PNG, and refuses an empty capture", async () => {
      const tab = await open(alpha, 'http://127.0.0.1:5173/')
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7])
      browsers.captureAs({ width: 1280, height: 800, png })
      const shot = await alpha.call('browser_screenshot', {})
      expect(shot.text).toBe(`Tab #${String(tab)}, 1280x800.`)
      expect(shot.images).toEqual([{ mimeType: 'image/png', data: png.toString('base64') }])

      browsers.captureAs({ width: 1, height: 1, png })
      const empty = await alpha.call('browser_screenshot', {})
      expect(empty.isError).toBe(true)
      expect(empty.images).toEqual([])
    })

    it('tells a session with no tab to open one, and names a tab that is gone', async () => {
      const none = await alpha.call('browser_snapshot', {})
      expect(none.isError).toBe(true)
      expect(none.text).toContain('Call browser_open')
      const gone = await alpha.call('browser_snapshot', { tab: 99 })
      expect(gone.isError).toBe(true)
      expect(gone.text).toContain('There is no browser tab 99')
    })

    describe('a tab the user shares', () => {
      const opener = (who: Caller, name: string): BrowserOpener => ({ key: who.key, name })

      it('is driven by the session it is shared with, and listed as such to every session', async () => {
        const user = browsers.add('http://127.0.0.1:5173/mine', null)
        browsers.share(user, opener(alpha, 'alpha'))

        // With no tab named and none used yet, the shared one is the one meant.
        const read = await alpha.call('browser_evaluate', { expression: '1' })
        expect(read.isError).toBe(false)
        expect(browsers.calls.at(-1)).toMatchObject({ method: 'evaluate', id: user })

        expect(blockFor((await alpha.call('browser_tabs')).text, user)).toMatch(
          /opened by the user, shared with you: read and drive it, but it is theirs to close$/
        )
        expect(blockFor((await beta.call('browser_tabs')).text, user)).toMatch(
          /opened by the user, shared with the session "alpha"$/
        )

        const moved = await alpha.call('browser_navigate', { url: 'http://127.0.0.1:5173/next' })
        expect(moved.isError).toBe(false)
        expect(browsers.calls.find((call) => call.method === 'navigateFor')).toMatchObject({ id: user })
      })

      it('is not driven by any other session, and not closed by the one it is shared with', async () => {
        const user = browsers.add('http://127.0.0.1:5173/mine', null)
        browsers.share(user, opener(alpha, 'alpha'))
        const before = browsers.calls.length

        const other = await beta.call('browser_snapshot', { tab: user })
        expect(other.isError).toBe(true)
        expect(other.text).toBe(
          `Browser tab ${String(user)} was opened by the user and is shared with the session "alpha", not this one.`
        )
        expect(browsers.calls.slice(before)).toEqual([])

        const closing = await alpha.call('browser_close', { tab: user })
        expect(closing.isError).toBe(true)
        expect(browsers.tabs.has(user)).toBe(true)
      })

      it('stops being driven when the user takes it back, and when the session ends', async () => {
        const user = browsers.add('http://127.0.0.1:5173/mine', null)
        browsers.share(user, opener(alpha, 'alpha'))
        expect((await alpha.call('browser_evaluate', { tab: user, expression: '1' })).isError).toBe(false)

        browsers.share(user, null)
        const unshared = await alpha.call('browser_text', { tab: user })
        expect(unshared.isError).toBe(true)
        expect(unshared.text).toContain("ask the user to share this one from the Share button in Helm's browser bar")

        // The key is the identity a share is made to, so ending the session revokes it.
        browsers.share(user, opener(alpha, 'alpha'))
        alpha.end()
        expect(browsers.calls.filter((call) => call.method === 'revoke').map((call) => call.detail)).toEqual([alpha.key])
        expect(browsers.tabs.get(user)?.shared).toBeNull()

      })

      it('is held to the tools\' reach: off the machine is refused while they are confined to it', async () => {
        const away = browsers.add('https://example.com/account', null)
        browsers.share(away, opener(alpha, 'alpha'))
        settings = { ...settings, browserMcpLocalOnly: true }
        const refused = await alpha.call('browser_screenshot', { tab: away })
        expect(refused.isError).toBe(true)
        expect(refused.text).toBe(
          `Browser tab ${String(away)} is at https://example.com/account. Helm's browser tools are held to this machine in Settings > Browser, so this session may not read or drive a page anywhere else.`
        )
        expect(browsers.calls.filter((call) => call.id === away)).toEqual([])

        settings = { ...settings, browserMcpLocalOnly: false }
        expect((await alpha.call('browser_screenshot', { tab: away })).isError).toBe(false)
      })
    })

    it('navigates a tab to a URL, or back, forward or reloads it - one or the other', async () => {
      const tab = await open(alpha, 'http://127.0.0.1:5173/one')
      const to = await alpha.call('browser_navigate', { url: '5173' })
      expect(to.text).toBe(`tab: ${String(tab)}\nurl: http://localhost:5173/\ntitle: Page at 127.0.0.1:5173`)

      const nowhere = await alpha.call('browser_navigate', { go: 'back' })
      expect(nowhere).toMatchObject({ isError: true, text: `Tab #${String(tab)} has nothing to go back to.` })
      browsers.tabs.get(tab)!.state = { ...browsers.tabs.get(tab)!.state, canGoBack: true }
      expect((await alpha.call('browser_navigate', { go: 'back' })).isError).toBe(false)
      expect((await alpha.call('browser_navigate', { go: 'reload' })).isError).toBe(false)
      expect(browsers.calls.filter((call) => ['back', 'forward', 'reload'].includes(call.method))).toEqual([
        { method: 'back', id: tab },
        { method: 'reload', id: tab }
      ])

      for (const args of [{}, { url: '5173', go: 'back' }]) {
        const both = await alpha.call('browser_navigate', args)
        expect(both.isError).toBe(true)
        expect(both.text).toContain('one of the two')
      }
    })

    it("reads the page's text in pieces, with the blank runs a layout leaves cut down", async () => {
      const tab = await open(alpha, 'http://127.0.0.1:5173/')
      let text = 'Title\r\n\n\n\nFirst line   \nSecond'
      browsers.evaluateWith(() => ({ ok: true, value: JSON.stringify({ text, url: 'http://127.0.0.1:5173/' }), error: null }))
      expect((await alpha.call('browser_text')).text).toBe(
        `tab: ${String(tab)}\nurl: http://127.0.0.1:5173/\ncharacters: 0-24 of 24\n\nTitle\n\nFirst line\nSecond`
      )

      text = 'x'.repeat(450)
      const first = await alpha.call('browser_text', { maxChars: 200 })
      expect(first.text).toContain('characters: 0-200 of 450')
      expect(first.text.endsWith('(more: pass offset 200)')).toBe(true)
      const last = await alpha.call('browser_text', { maxChars: 200, offset: 400 })
      expect(last.text).toContain('characters: 400-450 of 450')
      expect(last.text).not.toContain('(more')

      browsers.evaluateWith(() => ({ ok: true, value: JSON.stringify({ missing: true }), error: null }))
      const missing = await alpha.call('browser_text', { ref: '4.4' })
      expect(missing).toMatchObject({ isError: true })
      expect(missing.text).toContain('Nothing is at [ref=4.4] any more')
    })

    it('hovers over the middle of the element it names, pressing nothing', async () => {
      const tab = await open(alpha, 'http://127.0.0.1:5173/')
      browsers.evaluateWith(() => ({ ok: true, value: JSON.stringify({ x: 110, y: 55, width: 20, height: 10 }), error: null }))
      expect((await alpha.call('browser_hover', { ref: '1.0' })).text).toBe(
        'The pointer is over [ref=1.0] at (110, 55).'
      )
      expect(browsers.calls.filter((call) => call.method === 'hover')).toEqual([
        { method: 'hover', id: tab, detail: { x: 110, y: 55 } }
      ])
      expect(browsers.calls.filter((call) => call.method === 'pointer')).toEqual([])
      const nowhere = await alpha.call('browser_hover', {})
      expect(nowhere.text).toBe(
        'browser_hover needs somewhere to point at: a ref from browser_snapshot, a CSS selector, or both x and y.'
      )
    })

    it('chooses options in a select by value or label, and says which exist when one does not', async () => {
      await open(alpha, 'http://127.0.0.1:5173/')
      browsers.evaluateWith(() => ({ ok: true, value: JSON.stringify({ chosen: ['Two'] }), error: null }))
      expect(await alpha.call('browser_select', { selector: '#pick', values: ['2'] })).toMatchObject({
        isError: false,
        text: 'Chose "Two" in "#pick".'
      })
      expect(browsers.calls.at(-1)?.detail).toContain('["2"]')

      browsers.evaluateWith(() => ({
        ok: true,
        value: JSON.stringify({ unknown: 'Nine', options: [{ value: '1', label: 'One' }, { value: 'two', label: 'two' }], more: 3 }),
        error: null
      }))
      expect((await alpha.call('browser_select', { selector: '#pick', values: ['Nine'] })).text).toBe(
        '"#pick" has no option "Nine". It has: "One" (value "1"), "two", and 3 more.'
      )
      browsers.evaluateWith(() => ({ ok: true, value: JSON.stringify({ notSelect: 'div' }), error: null }))
      expect((await alpha.call('browser_select', { ref: '1.2', values: ['a'] })).text).toContain(
        'is a <div>, not a <select>'
      )
      const unnamed = await alpha.call('browser_select', { values: ['a'] })
      expect(unnamed).toMatchObject({ isError: true })
      expect(unnamed.text).toContain('needs the select')
    })

    it('scrolls with the wheel at the middle of the page, at the page zoom, and says what moved', async () => {
      const tab = await open(alpha, 'http://127.0.0.1:5173/')
      const place = (y: number, what = 'page'): string =>
        JSON.stringify({ what, x: 0, y, width: 1280, height: 2400, viewWidth: 1280, viewHeight: 800 })
      const answers = [place(0), place(400)]
      browsers.evaluateWith(() => ({ ok: true, value: answers.shift() ?? place(400), error: null }))
      expect((await alpha.call('browser_scroll', { dy: 400 })).text).toBe(
        'Scrolled the page down 400px. It is at 400 of 2400 down (800 showing).'
      )
      expect(browsers.calls.filter((call) => call.method === 'scroll').at(-1)).toEqual({
        method: 'scroll',
        id: tab,
        detail: { x: 640, y: 400, dx: 0, dy: 400 }
      })

      browsers.zoomTo(1.5)
      answers.push(place(400, 'div#list'), place(400, 'div#list'))
      expect((await alpha.call('browser_scroll', { dy: 100, x: 10, y: 20 })).text).toBe(
        'Nothing moved. <div#list> is already at its end, or nothing under (10, 20) scrolls that way.'
      )
      expect(browsers.calls.filter((call) => call.method === 'scroll').at(-1)?.detail).toEqual({
        x: 15,
        y: 30,
        dx: 0,
        dy: 150
      })

      const still = await alpha.call('browser_scroll', {})
      expect(still).toMatchObject({ isError: true })
    })

    it('waits for text, its going, a selector or the load, and says when it never came', async () => {
      const tab = await open(alpha, 'http://127.0.0.1:5173/')
      const looks = ['no', 'no', 'yes']
      browsers.evaluateWith(() => ({ ok: true, value: looks.shift() ?? 'yes', error: null }))
      const came = await alpha.call('browser_wait_for', { text: 'Ready' })
      expect(came.text).toMatch(/^"Ready" appeared after \d+\.\ds\.$/)
      expect(browsers.calls.filter((call) => call.method === 'evaluate')).toHaveLength(3)

      browsers.evaluateWith(() => ({ ok: true, value: 'no', error: null }))
      expect(await alpha.call('browser_wait_for', { textGone: 'Saving', timeout: 0.2 })).toMatchObject({
        isError: true,
        text: `Waited 0.2s, and "Saving" was still there in tab #${String(tab)}.`
      })

      browsers.evaluateWith(() => ({ ok: true, value: 'bad:not a valid selector', error: null }))
      expect((await alpha.call('browser_wait_for', { selector: '##' })).text).toBe(
        '"##" is not a selector the page accepts: not a valid selector'
      )
      expect((await alpha.call('browser_wait_for', {})).text).toMatch(/^Loaded after /)
      expect((await alpha.call('browser_wait_for', { text: 'a', seconds: 1 })).isError).toBe(true)
      expect((await alpha.call('browser_wait_for', { seconds: 0.05 })).text).toBe('Waited 0.05s.')
    })
  })

  describe('browser tool calls relayed from the local host', () => {
    let caller: (name: string) => Caller

    beforeEach(async () => {
      caller = await relayedCallers()
    })

    it('answers a session that is not running in the host with a sentence, and drives nothing', async () => {
      const gone = caller('gone')
      gone.end()
      const before = browsers.calls.length
      expect(await gone.call('browser_open', { url: 'http://127.0.0.1:5173/' })).toEqual({
        text: NOT_A_BROWSER_SESSION,
        isError: true,
        images: []
      })
      expect(browsers.calls.slice(before).filter((call) => call.method !== 'revoke')).toEqual([])
    })

    it('answers a call for an agents tool, which only the host serves, as a tool it does not have, and drives nothing', async () => {
      const alpha = caller('alpha')
      const before = browsers.calls.length
      for (const tool of ['agents_start', 'agents_list', 'agents_stop', 'agents_roles']) {
        const answer = await alpha.call(tool, { task: 'review it' })
        expect(answer.isError).toBe(true)
        expect(answer.text).toContain(`has no tool called "${tool}"`)
        // And the tools it says it has are the browser's, none of them an agents tool.
        expect(answer.text.split('It has: ')[1]).not.toContain('agents_')
      }
      expect(browsers.calls.length).toBe(before)
    })

    it('refuses every call while the browser tools are switched off, and answers again once they are on', async () => {
      const alpha = caller('alpha')
      settings = { ...settings, browserMcp: false }
      const off = await alpha.call('browser_open', { url: 'http://127.0.0.1:5173/' })
      expect(off).toEqual({
        text: "Helm's browser tools are switched off in Settings > Browser, so this session has none to call.",
        isError: true,
        images: []
      })
      expect(browsers.calls).toEqual([])

      settings = { ...settings, browserMcp: true }
      expect((await alpha.call('browser_open', { url: 'http://127.0.0.1:5173/' })).isError).toBe(false)
    })

    it('answers with a sentence in place of an answer too large for one protocol frame', async () => {
      const alpha = caller('alpha')
      expect((await alpha.call('browser_open', { url: 'http://127.0.0.1:5173/' })).isError).toBe(false)
      // Base64 makes four bytes of every three: past the frame once encoded.
      browsers.captureAs({ width: 1280, height: 800, png: Buffer.alloc(Math.ceil((MAX_FRAME_LEN * 3) / 4) + 1, 7) })
      expect(await alpha.call('browser_screenshot')).toEqual({ text: ANSWER_TOO_LARGE, isError: true, images: [] })

      // And an answer that fits goes back whole, its image included.
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
      browsers.captureAs({ width: 1280, height: 800, png })
      expect((await alpha.call('browser_screenshot')).images).toEqual([{ mimeType: 'image/png', data: png.toString('base64') }])
    })
  })

  describe('the shared browser tool table', () => {
    it('has a run for every tool in the table and no run outside it', () => {
      // Building an endpoint pairs the table with the runs, and throws on a
      // tool in one and not the other.
      expect(() => make()).not.toThrow()
      expect(BROWSER_TOOL_TABLE.tools.map((tool) => tool.name).sort()).toEqual(BROWSER_TOOLS)
    })

    it('refuses a table and runs that disagree, naming each tool in one and not the other', () => {
      const spec = (name: string) => ({ name, description: name, inputSchema: { type: 'object' } })
      const run = (): void => undefined
      expect(() => pairBrowserTools([spec('browser_open'), spec('browser_fly')], { browser_open: run })).toThrow(
        'in the browser tool table with nothing to run them: browser_fly'
      )
      expect(() => pairBrowserTools([spec('browser_open')], { browser_open: run, browser_dig: run })).toThrow(
        'run but not in the browser tool table: browser_dig'
      )
      const paired = pairBrowserTools([spec('browser_open')], { browser_open: run })
      expect(paired).toEqual([{ ...spec('browser_open'), run }])
    })

    it('states the limits the tools apply in their descriptions', () => {
      const describe = (name: string): string =>
        JSON.stringify(BROWSER_TOOL_TABLE.tools.find((tool) => tool.name === name)?.inputSchema ?? null)
      expect(describe('browser_snapshot')).toContain(`Default ${String(SNAPSHOT_MAX_NODES)}.`)
      expect(describe('browser_text')).toContain(`Default ${String(TEXT_MAX_CHARS)}.`)
      expect(describe('browser_wait_for')).toContain(`up to ${String(WAIT_MAX_S)}.`)
      expect(describe('browser_wait_for')).toContain(
        `Default ${String(WAIT_DEFAULT_S)}, at most ${String(WAIT_MAX_S)}.`
      )
    })
  })
})
