import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginToolCall } from '../../shared/ipc'
import { createToolCalls, TOOL_CALL_TIMEOUT_MS, type ToolCalls } from './tools'

/**
 * The tool calls in flight between a session's MCP request and a plugin's
 * background page: each one is answered exactly once, whatever happens to the
 * page, the session or the plugin on the way.
 */

const SESSION = { id: 'a1b2c3', name: 'alpha', cwd: 'C:/work/alpha' }
const CALL = { plugin: 'sample', name: 'list_items', args: { all: true }, session: SESSION }

let sent: PluginToolCall[]
let cancelled: string[]
let reachable: boolean
let calls: ToolCalls

beforeEach(() => {
  vi.useFakeTimers()
  sent = []
  cancelled = []
  reachable = true
  calls = createToolCalls({
    send: (call) => {
      if (!reachable) return false
      sent.push(call)
      return true
    },
    cancel: (id) => cancelled.push(id)
  })
})

afterEach(() => {
  vi.useRealTimers()
})

const owner = { plugin: 'sample' }

describe('a tool call', () => {
  it("is sent with an id of its own, and settles with the page's answer, once", async () => {
    const answer = calls.call(CALL, owner, new AbortController().signal)
    expect(sent).toEqual([{ ...CALL, id: expect.any(String) as string }])
    const id = sent[0]!.id
    calls.answer({ id, ok: true, text: 'two items' })
    calls.answer({ id, ok: false, message: 'a second answer' })
    await expect(answer).resolves.toEqual({ ok: true, text: 'two items' })
    expect(calls.pending()).toBe(0)
    expect(cancelled).toEqual([])
  })

  it("carries the page's failure through, and drops an answer for a call nobody made", async () => {
    calls.answer({ id: 'nobody', ok: true, text: 'stray' })
    const answer = calls.call(CALL, owner, new AbortController().signal)
    calls.answer({ id: sent[0]!.id, ok: false, message: 'The board is locked.' })
    await expect(answer).resolves.toEqual({ ok: false, message: 'The board is locked.' })
  })

  it('refuses an answer longer than a tool may give, whatever the page let through', async () => {
    const answer = calls.call(CALL, owner, new AbortController().signal)
    calls.answer({ id: sent[0]!.id, ok: true, text: 'x'.repeat(1_000_001) })
    await expect(answer).resolves.toMatchObject({ ok: false, message: expect.stringContaining('more than 1000000 characters') as string })
  })

  it('fails at once when there is no background host to send it to', async () => {
    reachable = false
    await expect(calls.call(CALL, owner, new AbortController().signal)).resolves.toEqual({
      ok: false,
      message: "The plugin's background page is not running."
    })
    expect(calls.pending()).toBe(0)
  })

  it('is cancelled at the page when the session stops waiting, and is never sent when it already has', async () => {
    const controller = new AbortController()
    const answer = calls.call(CALL, owner, controller.signal)
    controller.abort()
    await expect(answer).resolves.toEqual({ ok: false, message: 'The call was cancelled.' })
    expect(cancelled).toEqual([sent[0]!.id])

    await expect(calls.call(CALL, owner, controller.signal)).resolves.toMatchObject({ ok: false })
    expect(sent).toHaveLength(1)
  })

  it('times out, and the page is told to stop', async () => {
    const answer = calls.call(CALL, owner, new AbortController().signal)
    vi.advanceTimersByTime(TOOL_CALL_TIMEOUT_MS - 1)
    expect(calls.pending()).toBe(1)
    vi.advanceTimersByTime(1)
    await expect(answer).resolves.toEqual({ ok: false, message: 'The plugin did not answer within 10 minutes.' })
    expect(cancelled).toEqual([sent[0]!.id])
  })

  it("ends with its plugin, and only its plugin's calls do", async () => {
    const mine = calls.call(CALL, owner, new AbortController().signal)
    const theirs = calls.call({ ...CALL, plugin: 'other' }, { plugin: 'other' }, new AbortController().signal)
    calls.end(owner, 'The plugin stopped before it answered.')
    await expect(mine).resolves.toEqual({ ok: false, message: 'The plugin stopped before it answered.' })
    expect(cancelled).toEqual([sent[0]!.id])
    expect(calls.pending()).toBe(1)
    calls.shutdown()
    await expect(theirs).resolves.toEqual({ ok: false, message: 'Helm is shutting down.' })
    expect(calls.pending()).toBe(0)
  })
})
