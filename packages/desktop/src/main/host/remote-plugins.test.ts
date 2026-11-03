import { describe, expect, it } from 'vitest'
import { LOCAL_HOST_KEY } from '@helm/core/types'
import { FakeConnection, fakeLink } from '../../../test/host-connection'
import type { ToolAnswer, ToolCallRequest } from '../plugins/tools'
import { createPluginToolRelay } from './plugin-tools'
import { createHostPlugins } from './plugins'
import type * as P from './protocol'
import { createBackgroundNeeds, createRemotePlugins } from './remote-plugins'

const BUILD_BOX = 'build-box'

const TOOLS = (server: string): P.PluginAgentInfo => ({
  enabled: true,
  server,
  instructions: null,
  tools: [{ name: 'find', description: 'Finds things.', inputSchema: { type: 'object', properties: {} }, readOnly: true }]
})

/** A plugin as a host lists it: on, with a background page and its tools on. */
const listed = (id: string, patch: Partial<P.PluginInfo> = {}): P.PluginInfo => ({
  path: `/plugins/${id}`,
  id,
  name: id,
  version: '1.0.0',
  description: null,
  enabled: true,
  error: null,
  warnings: [],
  revision: 1,
  icon: null,
  rail: null,
  panels: { main: { title: id, url: `helm-plugin://${id}/panel.html`, actions: [] } },
  tabs: {},
  pageStrip: false,
  background: { url: `helm-plugin://${id}/background.html`, state: 'stopped', error: null },
  commands: [],
  settings: [],
  settingValues: {},
  network: [],
  secrets: [],
  exec: [],
  service: null,
  runsPrograms: false,
  agent: TOOLS(`helm-plugin-${id}`),
  startsSessions: false,
  seesSessions: false,
  status: null,
  badge: null,
  ...patch
})

const SESSION_CALL = (callId: number, plugin: string): P.AgentPluginToolCall => ({
  callId,
  session: 7,
  caller: { id: 'minted', label: 'alpha', folder: '/home/me/alpha' },
  plugin,
  tool: 'find',
  arguments: { q: 'release' }
})

/**
 * This PC's host and build-box, each with its own connection, plugins and
 * tool relay, and one hidden window answering every host's tool calls.
 */
function twoHosts() {
  const local = new FakeConnection()
  const remote = new FakeConnection()
  for (const connection of [local, remote]) {
    connection.answer('agentPlugin:offer', () => null)
    connection.answer('agentPlugin:answer', () => null)
  }
  const runs: Array<{ request: ToolCallRequest; answer: (answer: ToolAnswer) => void }> = []
  const ran: Array<() => void> = []
  const runTool = (request: ToolCallRequest): Promise<ToolAnswer> =>
    new Promise((resolve) => {
      runs.push({ request, answer: resolve })
      ran.shift()?.()
    })
  const synced: boolean[] = []
  const needs = createBackgroundNeeds({ sync: (needed) => synced.push(needed) })
  let reportsTold = 0

  const localLink = fakeLink(local)
  let localRelay: ReturnType<typeof createPluginToolRelay> | null = null
  const localPlugins = createHostPlugins({
    link: localLink,
    reportsChanged: () => undefined,
    runTool,
    onToolsChanged: () => localRelay?.offer(),
    background: needs.forHost(LOCAL_HOST_KEY),
    log: () => undefined
  })
  localRelay = createPluginToolRelay({
    link: localLink,
    servers: () => localPlugins.toolServers(),
    call: (request, signal) => localPlugins.callTool(request, signal),
    log: () => undefined
  })

  const remotePlugins = createRemotePlugins({
    runTool,
    background: needs,
    reportsChanged: () => {
      reportsTold += 1
    },
    log: () => undefined
  })
  const remoteLink = fakeLink(remote)
  const attached = remotePlugins.attach(BUILD_BOX, remoteLink)
  return {
    local,
    remote,
    localLink,
    remoteLink,
    localPlugins,
    remotePlugins,
    attached,
    runs,
    synced,
    reportsTold: () => reportsTold,
    nextRun: () => new Promise<void>((resolve) => ran.push(resolve))
  }
}

const offered = (connection: FakeConnection): string[][] =>
  (connection.payloads('agentPlugin:offer') as P.AgentPluginServers[]).map((offer) =>
    offer.servers.map((server) => server.plugin)
  )

describe('each remote host’s plugins and tool relay', () => {
  it('s21: offers build-box only the tools of the plugins build-box lists, never one only This PC has', async () => {
    const w = twoHosts()
    await w.localLink.connect()
    await w.remoteLink.connect()
    w.local.snapshot('plugins:changed', [listed('trackr'), listed('notes')])
    w.remote.snapshot('plugins:changed', [listed('trackr')])
    expect(offered(w.local).at(-1)).toEqual(['trackr', 'notes'])
    expect(offered(w.remote).at(-1)).toEqual(['trackr'])
    expect(offered(w.remote).flat()).not.toContain('notes')

    // build-box switching its tools off is offered to build-box alone.
    const localOffers = offered(w.local).length
    w.remote.push('plugins:changed', [listed('trackr', { agent: { ...TOOLS('helm-plugin-trackr'), enabled: false } })])
    expect(offered(w.remote).at(-1)).toEqual([])
    expect(offered(w.local)).toHaveLength(localOffers)
  })

  it('s21: answers build-box’s call to a plugin it does not list as not offered, and This PC’s background page never sees it', async () => {
    const w = twoHosts()
    await w.remoteLink.connect()
    w.remote.snapshot('plugins:changed', [listed('trackr')])
    w.remote.push('agentPlugin:call', SESSION_CALL(1, 'notes'))
    await expect.poll(() => w.remote.payloads('agentPlugin:answer')).toHaveLength(1)
    const [answer] = w.remote.payloads('agentPlugin:answer') as P.AgentPluginToolAnswer[]
    expect(answer?.outcome.status).toBe('done')
    expect(JSON.stringify(answer?.outcome)).toContain('not offering tools')
    expect(w.runs).toEqual([])
  })

  it('s20: a build-box session’s call is answered by build-box’s background page over build-box’s connection, and This PC’s by This PC’s', async () => {
    const w = twoHosts()
    await w.localLink.connect()
    await w.remoteLink.connect()
    w.local.snapshot('plugins:changed', [listed('trackr')])
    w.remote.snapshot('plugins:changed', [listed('trackr')])
    w.localPlugins.backgroundState('trackr', 1, 'running', null)
    w.remotePlugins.forHost(BUILD_BOX)?.backgroundState('trackr', 1, 'running', null)

    const theirs = w.nextRun()
    w.remote.push('agentPlugin:call', SESSION_CALL(1, 'trackr'))
    await theirs
    expect(w.runs[0]?.request).toMatchObject({ plugin: 'trackr', tool: 'find', host: BUILD_BOX })
    w.runs[0]?.answer({ ok: true, text: 'from build-box' })
    await expect.poll(() => w.remote.payloads('agentPlugin:answer')).toHaveLength(1)
    expect(w.local.payloads('agentPlugin:answer')).toEqual([])

    const ours = w.nextRun()
    w.local.push('agentPlugin:call', SESSION_CALL(1, 'trackr'))
    await ours
    expect(w.runs[1]?.request.host).toBeUndefined()
    w.runs[1]?.answer({ ok: true, text: 'from This PC' })
    await expect.poll(() => w.local.payloads('agentPlugin:answer')).toHaveLength(1)
    expect(w.remote.payloads('agentPlugin:answer')).toHaveLength(1)
  })

  it('s19: has build-box’s pages on build-box’s origin, its reports name it, and it is found by its label', async () => {
    const w = twoHosts()
    await w.remoteLink.connect()
    w.remote.snapshot('plugins:changed', [listed('trackr')])
    const plugins = w.remotePlugins.byLabel(BUILD_BOX)
    expect(plugins).toBe(w.remotePlugins.forHost(BUILD_BOX))
    expect(w.remotePlugins.byLabel('lab')).toBeNull()
    expect(await plugins?.serves('trackr')).toBe(true)
    expect(await plugins?.serves('notes')).toBe(false)

    plugins?.backgroundState('trackr', 1, 'running', null)
    expect(w.remotePlugins.reports()).toEqual([
      { plugin: 'trackr', revision: 1, state: 'running', error: null, host: BUILD_BOX }
    ])
    expect(w.reportsTold()).toBeGreaterThan(0)
  })

  it('keeps the hidden window open while any host’s background page needs it, and lets go of a host removed', async () => {
    const w = twoHosts()
    await w.localLink.connect()
    await w.remoteLink.connect()
    w.local.snapshot('plugins:changed', [])
    w.remote.snapshot('plugins:changed', [listed('trackr')])
    expect(w.synced.at(-1)).toBe(true)
    w.local.push('plugins:changed', [])
    expect(w.synced.at(-1)).toBe(true)
    w.attached.stop()
    expect(w.synced.at(-1)).toBe(false)
    expect(w.remotePlugins.forHost(BUILD_BOX)).toBeNull()
  })
})
