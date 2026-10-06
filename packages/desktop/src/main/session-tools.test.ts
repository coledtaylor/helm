import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createProfile, type PortRow, type ProcessRow, type ProcessSnapshot, type SessionRecord } from '@helm/core'
import { bearerOf, callTool, readMcpConfig, rpc, type ToolAnswer } from '../../test/mcp-client'
import { createWorld, disposeWorld, fakeClaudeLogs, type FakeClaudeLog, type World } from '../../test/world'
import type { ActivityService } from './activity'
import type { BrowserHost } from './browser'
import type { BrowserMcpHost } from './browser-mcp'
import type { ResourcesService } from './resources'
import type { SessionToolsWorld } from './session-tools'
import type { SessionHost } from './sessions'
import type { Services } from './services'

vi.mock('electron', async () => (await import('../../test/electron')).electronFake())

/**
 * The session tools as a session reaches them: real sessions running the fake
 * `claude`, the registry it writes read by the real activity poller, and every
 * answer fetched over HTTP with the bearer token from the session's own
 * `--mcp-config` file - which is the whole of who is asking.
 *
 * The process table is the one thing arranged rather than read: a pass costs a
 * `powershell.exe`, and what is under test is what a tool says about a pass,
 * so the resource service is handed a machine whose children carry a secret on
 * their command lines.
 */

/** On every planted child's command line. No answer may carry it. */
const CHILD_SECRET = `child-secret-${randomUUID()}`

interface Hosted {
  record: SessionRecord
  run: FakeClaudeLog
  configFile: string
  token: string
  /** The sessions family's URL, from the session's own config file. */
  url: string
}

describe('the session tools', () => {
  let world: World
  let services: Services
  let host: SessionHost
  let endpoint: BrowserMcpHost
  let activity: ActivityService
  let resources: ResourcesService
  let mcpDir: string
  let claudeJson: Buffer
  const output = new Map<number, string>()
  /** How many times the resource service has asked the machine. */
  let passes = 0

  let alpha: Hosted
  let beta: Hosted
  let prompted: Hosted
  const openingPrompt = `opening-prompt-${randomUUID()}`
  const firstMessage = `first-message-${randomUUID()}`
  const outside = { pid: process.pid, sessionId: randomUUID() }

  /** One child per hosted session, listening on a port, with the secret on its command line. */
  const childOf = (id: number): number => 4_000_000 + id
  const portOf = (id: number): number => 5_170 + id
  const machine = (): ProcessSnapshot => {
    const processes: ProcessRow[] = []
    const ports: PortRow[] = []
    for (const record of host.list()) {
      const pid = host.pid(record.id)
      if (pid === null) continue
      processes.push({ pid, parentPid: 1, name: 'cmd.exe', commandLine: `cmd.exe /d /s /c "claude ${record.argv.join(' ')}"` })
      processes.push({ pid: childOf(record.id), parentPid: pid, name: 'node.exe', commandLine: `node server.js ${CHILD_SECRET}` })
      ports.push({ pid: childOf(record.id), port: portOf(record.id), address: '127.0.0.1' })
    }
    return { processes, ports, atMs: Date.now(), durationMs: 1 }
  }

  /** The fake CLI's record of a session's run, found by the conversation id Helm gave it. */
  const runOf = async (record: SessionRecord): Promise<FakeClaudeLog> => {
    let found: FakeClaudeLog | undefined
    await vi.waitFor(() => {
      found = fakeClaudeLogs(world).find((log) => log.sessionId === record.claudeSessionId)
      expect(found).toBeDefined()
    })
    return found as FakeClaudeLog
  }

  const configOf = (run: FakeClaudeLog): string => {
    const at = run.argv.indexOf('--mcp-config')
    const file = run.argv[at + 1]
    if (at < 0 || file === undefined) throw new Error(`no --mcp-config in ${run.argv.join(' ')}`)
    return file
  }

  const hosted = async (record: SessionRecord): Promise<Hosted> => {
    const run = await runOf(record)
    const configFile = configOf(run)
    const servers = readMcpConfig(configFile).mcpServers
    const sessions = servers['helm-sessions']
    if (sessions === undefined) throw new Error(`no helm-sessions in ${configFile}`)
    return { record, run, configFile, token: bearerOf(sessions), url: sessions.url }
  }

  const ready = (record: SessionRecord): Promise<void> =>
    vi.waitFor(() => expect(output.get(record.id)).toContain('? for shortcuts'), { timeout: 10_000 })

  const list = (who: Hosted): Promise<ToolAnswer> => callTool(who.url, who.token, 'sessions_list')
  const detail = (who: Hosted, args: Record<string, unknown> = {}): Promise<ToolAnswer> =>
    callTool(who.url, who.token, 'session_detail', args)

  /** The block `sessions_list` printed for one pid. */
  const blockFor = (text: string, pid: number): string =>
    text.split('\n\n').find((block) => block.startsWith(`#${String(pid)}  `)) ?? ''

  beforeAll(async () => {
    world = createWorld()
    // The data directory and Claude's home are read when the modules load,
    // so the world is in place before they are imported.
    Object.assign(process.env, {
      PORTABLE_EXECUTABLE_DIR: world.portableDir,
      USERPROFILE: world.home,
      HOME: world.home
    })
    delete process.env['CLAUDE_CONFIG_DIR']
    claudeJson = readFileSync(join(world.home, '.claude.json'))

    const { createServices } = await import('./services')
    const { createSessionHost } = await import('./sessions')
    const { setClaudeOverride } = await import('./claude-cli')
    const { createBrowserMcp } = await import('./browser-mcp')
    const { createActivityService } = await import('./activity')
    const { createResourcesService } = await import('./resources')
    const { sessionToolsWorld } = await import('./session-tools')
    const { mcpConfigDir } = await import('./paths')
    mcpDir = mcpConfigDir
    setClaudeOverride(world.claude)
    services = createServices()

    // Assembled in the order `index.ts` assembles them, and for its reason:
    // the endpoint exists before what its session tools read.
    let tools: SessionToolsWorld | null = null
    endpoint = createBrowserMcp({
      // The browser half is `browser-mcp.test.ts`'s; nothing here calls it.
      browsers: {} as BrowserHost,
      settings: () => services.settings,
      dir: mcpConfigDir,
      sessions: () => tools
    })
    host = createSessionHost({
      services,
      window: () => null,
      browserMcp: () => endpoint,
      observer: { onOutput: (id, chunk) => output.set(id, (output.get(id) ?? '') + chunk) },
      confirm: () => Promise.resolve(true)
    })
    activity = createActivityService({ sessions: host, window: () => null, claudeHome: world.claudeDir })
    resources = createResourcesService({
      sessions: host,
      window: () => null,
      read: () => {
        passes++
        return Promise.resolve(machine())
      }
    })
    tools = sessionToolsWorld({ store: services.store, sessions: host, activity, resources })
    expect((await endpoint.start()).started).toBe(true)

    // A session somebody started in a terminal: a live process with a record.
    mkdirSync(join(world.claudeDir, 'sessions'), { recursive: true })
    writeFileSync(
      join(world.claudeDir, 'sessions', `${String(outside.pid)}.json`),
      JSON.stringify({
        pid: outside.pid,
        sessionId: outside.sessionId,
        cwd: join(world.projectsDir, 'elsewhere'),
        startedAt: Date.now(),
        version: '2.1.999',
        entrypoint: 'cli',
        name: 'outside',
        status: 'busy',
        statusUpdatedAt: Date.now()
      })
    )

    // A profile with an opening prompt, so one session's argv carries a prompt
    // the tools must never repeat to another.
    const profile = createProfile(services.store, {
      name: 'prompted',
      root: world.projects.alpha,
      overlays: [],
      access: [],
      model: null,
      effort: null,
      permissionMode: null,
      agent: null,
      mcp: [],
      openingPrompt,
      pinnedOrder: null
    })
    const grid = { cols: 100, rows: 30 }
    const records = await Promise.all([
      host.start({ cwd: world.projects.alpha, projectPath: world.projects.alpha, name: 'alpha', ...grid }),
      host.start({ cwd: world.projects.beta, projectPath: world.projects.beta, name: 'beta', ...grid }),
      host.launchProfile({ profileId: profile.id, ...grid }).then((launched) => launched.session)
    ])
    ;[alpha, beta, prompted] = await Promise.all([hosted(records[0]), hosted(records[1]), hosted(records[2])])
    await Promise.all(records.map(ready))

    // Beta's first message, which is now in its transcript and in history.jsonl.
    host.input(beta.record.id, `${firstMessage}\r`)
    await vi.waitFor(() => expect(output.get(beta.record.id)).toContain(`You said: ${firstMessage}`))

    // Every hosted session joined to its registry record.
    await vi.waitFor(() => {
      activity.refresh()
      expect(activity.overview().sessions.filter((s) => s.helmSessionId !== null && s.registered)).toHaveLength(3)
    })
  })

  afterAll(async () => {
    for (const session of host.list()) {
      if (session.status === 'running') await host.close({ id: session.id, force: true })
    }
    await vi.waitFor(() => expect(host.list().filter((s) => s.status === 'running')).toEqual([]), {
      timeout: 10_000
    })
    // In before-quit's order: the endpoint, then the sessions - a killed pty
    // can report its exit later, and the host must not write it to a store
    // that has been closed.
    await endpoint.stop()
    host.shutdown()
    activity.stop()
    resources.stop()
    services.store.close()
    disposeWorld(world)
  })

  it('hands each session a token of its own, in a file under the data directory, and writes nothing of the user’s', () => {
    for (const session of [alpha, beta, prompted]) {
      expect(resolve(session.configFile).toLowerCase().startsWith(`${resolve(world.dataDir).toLowerCase()}${sep}`)).toBe(
        true
      )
      const { mcpServers } = readMcpConfig(session.configFile)
      expect(Object.keys(mcpServers)).toEqual(['helm-browser', 'helm-sessions'])
      expect(mcpServers['helm-browser']?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
      expect(mcpServers['helm-sessions']?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/sessions$/)
      for (const server of Object.values(mcpServers)) {
        expect(server.type).toBe('http')
        expect(server.headers).toEqual({ Authorization: `Bearer ${session.token}` })
      }
    }
    expect(new Set([alpha.token, beta.token, prompted.token]).size).toBe(3)

    expect(claudeJson.toString('utf8')).toContain('hasCompletedOnboarding')
    expect(readFileSync(join(world.home, '.claude.json'))).toEqual(claudeJson)
    expect(existsSync(join(world.projects.alpha, '.mcp.json'))).toBe(false)
    expect(existsSync(join(world.projects.beta, '.mcp.json'))).toBe(false)
  })

  it('refuses the sessions route without the exact token', async () => {
    const offByOne = `${alpha.token.slice(0, -1)}${alpha.token.endsWith('0') ? '1' : '0'}`
    expect((await rpc(alpha.url, null, 'tools/list')).status).toBe(401)
    expect((await rpc(alpha.url, offByOne, 'tools/list')).status).toBe(401)
    expect((await rpc(alpha.url, alpha.token, 'tools/list')).status).toBe(200)
  })

  it('lists every live session with its status, and marks the caller alone', async () => {
    const listing = (await list(alpha)).text
    expect(listing).toContain('4 Claude Code sessions running on this machine, 3 of them hosted by Helm.')

    for (const session of [alpha, beta, prompted]) {
      const block = blockFor(listing, session.run.pid)
      expect(block).toContain(`working in   ${session.record.cwd}`)
      expect(block).toMatch(/\n {4}status {7}\S/)
      expect(block).toContain(`hosted       yes, in Helm tab ${String(session.record.id)}`)
    }
    const elsewhere = blockFor(listing, outside.pid)
    expect(elsewhere).toContain('"outside"')
    expect(elsewhere).toContain('status       busy')
    expect(elsewhere).toContain('hosted       no - started somewhere else')

    expect(listing.match(/\(this session\)/g)).toHaveLength(1)
    expect(blockFor(listing, alpha.run.pid).split('\n')[0]).toBe(`#${String(alpha.run.pid)}  "alpha"  (this session)`)

    // The same question with beta's token moves the mark to beta.
    const asBeta = (await list(beta)).text
    expect(asBeta.match(/\(this session\)/g)).toHaveLength(1)
    expect(blockFor(asBeta, beta.run.pid).split('\n')[0]).toBe(`#${String(beta.run.pid)}  "beta"  (this session)`)
  })

  it('details another hosted session as that session, from a pass the call itself took', async () => {
    const before = passes
    const answer = await detail(alpha, { pid: beta.run.pid })
    expect(passes).toBe(before + 1)

    expect(answer.isError).toBe(false)
    const lines = answer.text.split('\n')
    expect(lines[0]).toBe(`#${String(beta.run.pid)}  "beta"`)
    expect(answer.text).toContain(`working in   ${world.projects.beta}`)
    expect(answer.text).not.toContain(world.projects.alpha)
    expect(answer.text).toContain(`Helm tab     ${String(beta.record.id)}`)
    expect(answer.text).toContain('branch       feature/beta (the branch at spawn')
    expect(answer.text).toContain(`node.exe #${String(childOf(beta.record.id))}  listening on ${String(portOf(beta.record.id))}`)
    expect(answer.text).toMatch(new RegExp(`port ${String(portOf(beta.record.id))} +node\\.exe #${String(childOf(beta.record.id))} on 127\\.0\\.0\\.1`))

    // The watch was let go: with nobody looking, a refresh asks the machine nothing.
    await resources.refresh()
    expect(passes).toBe(before + 1)
  })

  it('answers session_detail with no pid for the caller, whatever else the caller says', async () => {
    const own = `#${String(alpha.run.pid)}  "alpha"  (this session)`
    expect((await detail(alpha)).text.split('\n')[0]).toBe(own)
    const claimed = await detail(alpha, {
      session: beta.record.id,
      helmSessionId: beta.record.id,
      sessionId: beta.record.claudeSessionId,
      token: beta.token
    })
    expect(claimed.text.split('\n')[0]).toBe(own)
  })

  it('lets a token with no session behind it list, unmarked, and gives it no detail of its own', async () => {
    const stray = endpoint.register('stray')
    if (stray === null) throw new Error('the endpoint registered nobody')
    const url = stray.launch.servers.find((server) => server.name === 'helm-sessions')?.url ?? ''
    try {
      const listing = await callTool(url, stray.token, 'sessions_list')
      expect(listing.isError).toBe(false)
      expect(listing.text).toContain('4 Claude Code sessions running')
      expect(listing.text).not.toContain('(this session)')

      const own = await callTool(url, stray.token, 'session_detail', {})
      expect(own.isError).toBe(true)
      expect(own.text).toContain('Helm has no live session for this token')
    } finally {
      endpoint.release(stray.token)
    }
  })

  it('says what a waiting session is waiting on, in the words its record used', async () => {
    host.input(beta.record.id, '/wait\r')
    await vi.waitFor(async () => {
      expect(blockFor((await list(alpha)).text, beta.run.pid)).toContain('status       waiting on the user (permission prompt)')
    })
    expect((await detail(alpha, { pid: beta.run.pid })).text).toContain('status       waiting on the user (permission prompt)')
    host.input(beta.record.id, 'y')
    await vi.waitFor(() => expect(output.get(beta.record.id)).toContain('Allowed.'))
  })

  it('never answers with any part of another session’s conversation or launch', async () => {
    // What is planted, checked first: an empty expectation would pass on nothing.
    expect(prompted.run.argv).toContain(openingPrompt)
    expect(readFileSync(join(world.claudeDir, 'history.jsonl'), 'utf8')).toContain(firstMessage)
    for (const session of [alpha, beta, prompted]) {
      expect(session.run.sessionId).toBe(session.record.claudeSessionId)
      expect(session.record.argv).toContain(session.configFile)
    }
    expect(machine().processes?.some((row) => row.commandLine?.includes(CHILD_SECRET))).toBe(true)

    const forbidden = [
      openingPrompt,
      firstMessage,
      CHILD_SECRET,
      outside.sessionId,
      '--mcp-config',
      '--session-id',
      ...[alpha, beta, prompted].flatMap((session) => [
        session.token,
        session.configFile,
        session.run.sessionId
      ])
    ]

    const answers: string[] = []
    const pids = [alpha, beta, prompted].map((session) => session.run.pid).concat(outside.pid)
    for (const caller of [alpha, beta, prompted]) {
      answers.push((await list(caller)).text, (await detail(caller)).text)
      for (const pid of pids) answers.push((await detail(caller, { pid })).text)
    }
    expect(answers).toHaveLength(3 * (2 + pids.length))
    for (const answer of answers) {
      for (const secret of forbidden) expect(answer).not.toContain(secret)
    }
  })

  it('forgets a session that has ended: no list entry, no detail, no token and no config file', async () => {
    host.input(prompted.record.id, '/exit\r')
    await vi.waitFor(() => expect(host.list().find((s) => s.id === prompted.record.id)?.status).toBe('exited'), {
      timeout: 10_000
    })

    expect(existsSync(prompted.configFile)).toBe(false)
    expect((await rpc(prompted.url, prompted.token, 'tools/list')).status).toBe(401)

    const listing = (await list(alpha)).text
    expect(listing).toContain('3 Claude Code sessions running on this machine, 2 of them hosted by Helm.')
    expect(blockFor(listing, prompted.run.pid)).toBe('')
    const gone = await detail(alpha, { pid: prompted.run.pid })
    expect(gone.isError).toBe(true)
    expect(gone.text.split('\n')[0]).toBe(`No Claude Code session with pid ${String(prompted.run.pid)} is running on this machine.`)
  })

  it('launches with the browser tools only while sessionMcp is off, and with no --mcp-config once both are off', async () => {
    const { updateSettings } = await import('./services')
    updateSettings(services, { sessionMcp: false })
    const browserOnly = await runOf(
      await host.start({ cwd: world.projects.beta, projectPath: world.projects.beta, name: 'browser only', cols: 80, rows: 24 })
    )
    expect(Object.keys(readMcpConfig(configOf(browserOnly)).mcpServers)).toEqual(['helm-browser'])

    // What writing the settings does with both unticked: the endpoint stops.
    updateSettings(services, { browserMcp: false })
    await endpoint.stop()
    const bare = await runOf(
      await host.start({ cwd: world.projects.beta, projectPath: world.projects.beta, name: 'bare', cols: 80, rows: 24 })
    )
    expect(bare.argv).not.toContain('--mcp-config')
    expect(readdirSync(mcpDir)).toEqual([])
  })
})
