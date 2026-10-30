import { describe, expect, it } from 'vitest'
import type { ToolSession } from '@coledtaylor/helm-plugin-sdk'
import { FakeConnection, fakeLink } from '../../../test/host-connection'
import { pluginInstructions, pluginToolResult } from '../browser-mcp'
import type { ToolAnswer, ToolCallRequest, ToolServer } from '../plugins/tools'
import { MAX_FRAME_LEN } from './protocol'
import type * as P from './protocol'
import { createPluginToolRelay, NOT_A_PLUGIN_SESSION, PLUGIN_ANSWER_TOO_LARGE } from './plugin-tools'

/**
 * The plugins' tools for sessions in the local host: what Helm offers the
 * host, and how each call the host relays is answered, over a connection the
 * test drives in place of the host.
 */

const NOTES: ToolServer = {
  plugin: 'notes',
  name: 'Notes',
  server: 'helm-plugin-notes',
  instructions: 'Search the notes before writing one.',
  tools: [
    {
      name: 'find',
      description: 'Finds notes.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      readOnly: true
    },
    { name: 'write', description: 'Writes a note.', inputSchema: { type: 'object', properties: {} }, readOnly: false }
  ]
}

/** Host session 7 is running, as `alpha` in /work/alpha; nothing else is. */
const ALPHA: ToolSession = { id: 'minted-for-alpha', name: 'alpha', cwd: '/work/alpha' }

interface Call {
  request: ToolCallRequest
  signal: AbortSignal
  answer(answer: ToolAnswer): void
}

function world() {
  const connection = new FakeConnection()
  const link = fakeLink(connection)
  const servers = { value: [NOTES] }
  const calls: Call[] = []
  const callMade: Array<(call: Call) => void> = []
  const answers = new Map<number, (answer: P.AgentPluginToolAnswer) => void>()
  connection.answer('agentPlugin:answer', (answer) => {
    answers.get(answer.callId)?.(answer)
    return null
  })
  const relay = createPluginToolRelay({
    link,
    servers: () => servers.value,
    call: (request, signal) =>
      new Promise<ToolAnswer>((resolve) => {
        const call = { request, signal, answer: resolve }
        calls.push(call)
        callMade.shift()?.(call)
      }),
    caller: (session) => (session === 7 ? ALPHA : null),
    log: () => undefined
  })
  return {
    connection,
    link,
    servers,
    relay,
    calls,
    /** The next call the relay hands the plugins. */
    nextCall: () => new Promise<Call>((resolve) => callMade.push(resolve)),
    /** The host relays a call, and what Helm answers it with. */
    relayCall(call: P.AgentPluginToolCall): Promise<P.AgentPluginToolAnswer> {
      const answered = new Promise<P.AgentPluginToolAnswer>((resolve) => answers.set(call.callId, resolve))
      connection.push('agentPlugin:call', call)
      return answered
    }
  }
}

describe('the plugins’ tools through the local host', () => {
  it('listens for calls, then offers the host every plugin tool server as Helm’s own listener serves it', async () => {
    const w = world()
    await w.link.connect()

    expect([...w.connection.subscriptions.keys()]).toEqual(['agentPlugin:call', 'agentPlugin:cancel'])
    expect(w.connection.payloads('agentPlugin:offer')).toEqual([
      {
        servers: [
          {
            name: 'helm-plugin-notes',
            plugin: 'notes',
            instructions: pluginInstructions(NOTES),
            tools: [
              {
                name: 'find',
                description: 'Finds notes.',
                inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
                readOnly: true
              },
              { name: 'write', description: 'Writes a note.', inputSchema: { type: 'object', properties: {} }, readOnly: false }
            ]
          }
        ]
      }
    ])
    // The provenance line, then the plugin's own words.
    expect(pluginInstructions(NOTES)).toMatch(/^These tools come from "Notes", a plugin the user added to Helm/)
    expect(pluginInstructions(NOTES)).toMatch(/\n\nSearch the notes before writing one\.$/)
  })

  it('offers again when a plugin’s tools come or go, and offers nothing with no host connected', async () => {
    const w = world()
    w.relay.offer()
    expect(w.connection.payloads('agentPlugin:offer')).toEqual([])

    await w.link.connect()
    w.servers.value = []
    w.relay.offer()
    expect(w.connection.payloads('agentPlugin:offer')).toEqual([
      expect.objectContaining({ servers: [expect.objectContaining({ plugin: 'notes' })] }),
      { servers: [] }
    ])
  })

  it('runs a call as the plugins answer one from Helm’s own listener, naming the session by the id minted for it', async () => {
    const w = world()
    await w.link.connect()

    const made = w.nextCall()
    const answered = w.relayCall({ callId: 1, session: 7, plugin: 'notes', tool: 'find', arguments: { query: 'release' } })
    const call = await made
    expect(call.request).toEqual({ plugin: 'notes', tool: 'find', args: { query: 'release' }, session: ALPHA })
    call.answer({ ok: true, text: 'Found 2 notes.' })
    expect(await answered).toEqual({
      callId: 1,
      outcome: { status: 'done', value: pluginToolResult({ ok: true, text: 'Found 2 notes.' }) }
    })
    expect(pluginToolResult({ ok: true, text: 'Found 2 notes.' })).toEqual({
      content: [{ type: 'text', text: 'Found 2 notes.' }]
    })

    // A plugin's refusal is the agent's to read, as an error result.
    const refusing = w.nextCall()
    const refused = w.relayCall({ callId: 2, session: 7, plugin: 'notes', tool: 'write', arguments: {} })
    ;(await refusing).answer({ ok: false, message: 'Notes is read-only today.' })
    expect((await refused).outcome).toEqual({
      status: 'done',
      value: { content: [{ type: 'text', text: 'Notes is read-only today.' }], isError: true }
    })
  })

  it('answers a call for a session not running in the host with a sentence, and never calls a plugin for it', async () => {
    const w = world()
    await w.link.connect()
    const answered = await w.relayCall({ callId: 3, session: 99, plugin: 'notes', tool: 'find', arguments: {} })
    expect(answered.outcome).toEqual({ status: 'failed', message: NOT_A_PLUGIN_SESSION })
    expect(w.calls).toEqual([])
  })

  it('withdraws a call from the plugin when the host cancels it, and sends no answer for it', async () => {
    const w = world()
    await w.link.connect()
    const made = w.nextCall()
    void w.relayCall({ callId: 4, session: 7, plugin: 'notes', tool: 'write', arguments: {} })
    const call = await made
    const aborted = new Promise<void>((resolve) => call.signal.addEventListener('abort', () => resolve()))

    w.connection.push('agentPlugin:cancel', { callId: 4 })
    await aborted
    call.answer({ ok: false, message: 'The call was cancelled.' })
    // Settled after the plugin's answer: a barrier, then nothing was sent.
    await Promise.resolve()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(w.connection.payloads('agentPlugin:answer')).toEqual([])
  })

  it('withdraws every call in flight when Helm stops answering', async () => {
    const w = world()
    await w.link.connect()
    const made = w.nextCall()
    void w.relayCall({ callId: 5, session: 7, plugin: 'notes', tool: 'write', arguments: {} })
    const call = await made
    w.relay.stop()
    expect(call.signal.aborted).toBe(true)
    expect(w.connection.subscriptions.size).toBe(0)
  })

  it('answers with a sentence in place of a result too large for one frame', async () => {
    const w = world()
    await w.link.connect()
    const made = w.nextCall()
    const answered = w.relayCall({ callId: 6, session: 7, plugin: 'notes', tool: 'find', arguments: {} })
    ;(await made).answer({ ok: true, text: 'x'.repeat(MAX_FRAME_LEN) })
    expect((await answered).outcome).toEqual({ status: 'failed', message: PLUGIN_ANSWER_TOO_LARGE })
  })
})
