import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import type { HelmTheme } from '@coledtaylor/helm-plugin-sdk'
import type { PluginToolCall } from '../../shared/ipc'
import type { PluginHost } from './host'
import type { BackgroundHost } from './background'
import { PATIENCE } from '../../../../../test/patience'

vi.mock('electron', async () => (await import('../../../test/electron')).electronFake())

const { createPluginHost } = await import('./host')

/**
 * What Helm keeps of plugins for its own pages: the runtime and theme they
 * paint with, which pages frame them, and a session's tool call handed to the
 * background page and answered from there. The window and the background host
 * are fakes that record what they were sent, so every assertion is about what
 * the plugin host decided.
 */

interface Sent {
  to: 'window' | 'background'
  channel: string
  payload: unknown
}

let sent: Sent[]
let closed: number
let background: BackgroundHost
let host: PluginHost

const THEME: HelmTheme = { kind: 'dark', tokens: {} as HelmTheme['tokens'], radius: 3, density: 'comfortable' }
const SESSION = { id: 'a1b2c3', name: 'alpha', cwd: 'C:/work/alpha' }

function contents(id: number, to: Sent['to']): WebContents {
  return { id, isDestroyed: () => false, send: (channel: string, payload: unknown) => sent.push({ to, channel, payload }) } as unknown as WebContents
}

const fakeWindow = { isDestroyed: () => false, webContents: contents(1, 'window') } as unknown as BrowserWindow

beforeEach(() => {
  sent = []
  closed = 0
  background = { sync: () => undefined, contents: () => contents(2, 'background'), shutdown: () => (closed += 1) }
  host = createPluginHost({ window: () => fakeWindow, theme: () => THEME, bridge: 'bridge', stylesheet: 'css', background })
})

afterEach(() => {
  host.shutdown()
})

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const events = (channel: string, to?: Sent['to']): unknown[] =>
  sent.filter((one) => one.channel === channel && (to === undefined || one.to === to)).map((one) => one.payload)
const toolCalls = (): PluginToolCall[] => events('plugins:tool', 'background') as PluginToolCall[]
const runTool = (signal = new AbortController().signal, host_?: string): ReturnType<PluginHost['runTool']> =>
  host.runTool({ plugin: 'tracker', tool: 'add_card', args: { all: true }, session: SESSION, ...(host_ !== undefined ? { host: host_ } : {}) }, signal)

describe('the pages that frame plugins', () => {
  it('are the window and the background host, and nothing else', () => {
    expect(host.framesPlugins(1)).toBe(true)
    expect(host.framesPlugins(2)).toBe(true)
    expect(host.framesPlugins(3)).toBe(false)
  })

  it('are served the runtime, with the theme a page paints first', () => {
    expect(host.runtime.bridge()).toBe('bridge')
    expect(host.runtime.css()).toBe('css')
    expect(JSON.parse(host.runtime.boot('tracker'))).toEqual({ theme: THEME })
  })

  it('are told about a theme change, both of them', () => {
    const light: HelmTheme = { ...THEME, kind: 'light' }
    host.pushTheme(light)
    expect(events('plugins:theme', 'window')).toEqual([light])
    expect(events('plugins:theme', 'background')).toEqual([light])
  })
})

describe("a session's call to a plugin's tool", () => {
  it('goes to the background host and is answered with what came back from there, and only from there', async () => {
    const answer = runTool()
    await vi.waitFor(() => expect(toolCalls()).toHaveLength(1), { timeout: PATIENCE })
    const call = toolCalls()[0]!
    expect(call).toEqual({ id: expect.any(String) as string, plugin: 'tracker', name: 'add_card', args: { all: true }, session: SESSION })

    let settled = false
    void answer.then(() => (settled = true))
    host.toolResult({ id: call.id, ok: true, text: 'from the window' }, 1)
    await tick()
    expect(settled).toBe(false)
    host.toolResult({ id: call.id, ok: true, text: 'added' }, 2)
    await expect(answer).resolves.toEqual({ ok: true, text: 'added' })
  })

  it("names the remote host whose background page answers a call from that host's session", async () => {
    void runTool(new AbortController().signal, 'build-box')
    await vi.waitFor(() => expect(toolCalls()).toHaveLength(1), { timeout: PATIENCE })
    expect(toolCalls()[0]).toMatchObject({ host: 'build-box', plugin: 'tracker' })
  })

  it('cancels at the page when the session stops waiting, and ends every call at shutdown', async () => {
    const controller = new AbortController()
    const cancelled = runTool(controller.signal)
    await vi.waitFor(() => expect(toolCalls()).toHaveLength(1), { timeout: PATIENCE })
    controller.abort()
    await expect(cancelled).resolves.toEqual({ ok: false, message: 'The call was cancelled.' })
    expect(events('plugins:toolCancel', 'background')).toEqual([{ id: toolCalls()[0]!.id }])

    const waiting = runTool()
    await vi.waitFor(() => expect(toolCalls()).toHaveLength(2), { timeout: PATIENCE })
    host.shutdown()
    await expect(waiting).resolves.toEqual({ ok: false, message: 'Helm is shutting down.' })
    expect(await runTool()).toEqual({ ok: false, message: 'Helm is shutting down.' })
    expect(closed).toBeGreaterThan(0)
  })
})
