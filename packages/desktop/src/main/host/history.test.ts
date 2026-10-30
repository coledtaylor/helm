import { describe, expect, it } from 'vitest'
import { FakeConnection, fakeLink } from '../../../test/host-connection'
import { createHostHistory } from './history'
import type * as P from './protocol'
import { CLAUDE_CODE_BACKEND } from './sessions'

const ONE = 'c0ffee00-0000-4000-8000-000000000001'

const SUMMARY: P.HistorySummary = {
  sessions: 1,
  prompts: 2,
  projects: 1,
  resumable: 1,
  latestAt: 1_790_848_800_000,
  historyFile: '/home/.claude/history.jsonl',
  indexedBytes: 420,
  error: null
}

const SESSION: P.HistorySession = {
  sessionId: ONE,
  backend: CLAUDE_CODE_BACKEND,
  project: '/work/alpha',
  projectName: 'alpha',
  promptCount: 2,
  firstAt: 1_790_848_700_000,
  lastAt: 1_790_848_800_000,
  firstPrompt: 'plan the release',
  title: 'plan the release',
  titleFallback: false,
  label: null,
  transcriptFile: '/home/.claude/projects/alpha/one.jsonl',
  transcriptBytes: 900,
  projectExists: true,
  archive: 'archived',
  archivedMessages: 2,
  match: null
}

const STATS: P.ArchiveStats = {
  sessions: 1,
  evictedSessions: 0,
  messages: 2,
  rawBytes: 40,
  storedBytes: 30,
  maxBytes: 1024 ** 3,
  oldestAt: 1_790_848_800_000,
  newestAt: 1_790_848_800_000
}

const CONVERSATION: P.ArchivedConversation = {
  sessionId: ONE,
  sourceFile: '/home/.claude/projects/alpha/one.jsonl',
  state: 'archived',
  firstAt: 1_790_848_700_000,
  lastAt: 1_790_848_800_000,
  messageCount: 2,
  rawBytes: 40,
  storedBytes: 30,
  capturedAt: '2026-10-30T10:00:00.000Z',
  evictedAt: null,
  messages: [
    { uuid: 'u1', role: 'user', at: 1_790_848_700_000, text: 'plan the release' },
    { uuid: 'u2', role: 'assistant', at: 1_790_848_800_000, text: 'You said: plan the release' }
  ]
}

const reading = (backend: string, percent: number): P.UsageSnapshot => ({
  backend,
  file: '/home/.claude.json',
  fetchedAtMs: 1_790_848_800_000,
  limits: [
    {
      kind: 'session',
      group: 'session',
      percent,
      severity: 'normal',
      resetsAtMs: 1_790_860_000_000,
      scope: null,
      isActive: true
    }
  ],
  problem: null,
  spend: null
})

const UNREACHABLE = 'No local host answered on its socket; turn off “Run sessions in the local host” in Settings.'

/** The host side: one conversation in its index and archive, and a usage reading per backend. */
function world(connection: FakeConnection | null = new FakeConnection()) {
  connection
    ?.answer('history:summary', () => SUMMARY)
    .answer('history:sessions', () => ({ sessions: [SESSION], total: 1, tookMs: 1 }))
    .answer('history:prompts', () => [{ sessionId: ONE, seq: 1, text: 'plan the release', at: 1_790_848_700_000 }])
    .answer('history:projects', () => [
      { project: '/work/alpha', name: 'alpha', sessions: 1, prompts: 2, lastAt: 1_790_848_800_000, resumable: 1, exists: true }
    ])
    .answer('history:refresh', () => ({ ...SUMMARY, sessions: 2 }))
    .answer('history:rename', ({ sessionId, name }) => (sessionId === ONE ? { ...SESSION, label: name } : null))
    .answer('archive:conversation', ({ sessionId }) => (sessionId === ONE ? CONVERSATION : null))
    .answer('archive:stats', () => STATS)
    .answer('usage:read', () => [reading('pi', 10), reading(CLAUDE_CODE_BACKEND, 42)])
  const link = fakeLink(connection, UNREACHABLE)
  const emitted: Array<{ channel: string; payload: unknown }> = []
  const logged: string[] = []
  const history = createHostHistory({
    link,
    emit: (channel, payload) => emitted.push({ channel, payload }),
    log: (line) => logged.push(line)
  })
  return { connection: connection ?? new FakeConnection(), link, history, emitted, logged }
}

describe('history, the archive and usage through the local host', () => {
  it('answers each read from the host, in the window’s words', async () => {
    const w = world()

    expect(await w.history.summary()).toEqual({
      sessions: 1,
      prompts: 2,
      projects: 1,
      resumable: 1,
      latestAt: 1_790_848_800_000,
      historyFile: '/home/.claude/history.jsonl',
      indexedBytes: 420
    })
    const page = await w.history.sessions({ search: 'release', scope: 'messages' })
    expect(w.connection.payloads('history:sessions')).toEqual([
      { search: 'release', scope: 'messages', project: null, resumableOnly: null, limit: null }
    ])
    expect(page.total).toBe(1)
    expect(page.sessions[0]).not.toHaveProperty('backend')
    expect(page.sessions[0]).not.toHaveProperty('match')
    expect(page.sessions[0]).toMatchObject({ sessionId: ONE, project: '/work/alpha', archive: 'archived' })

    expect(await w.history.prompts(ONE)).toEqual([expect.objectContaining({ text: 'plan the release' })])
    expect(w.connection.payloads('history:prompts')).toEqual([{ sessionId: ONE }])
    expect((await w.history.projects()).map((p) => p.name)).toEqual(['alpha'])
    expect((await w.history.refresh()).sessions).toBe(2)
    expect(await w.history.conversation(ONE)).toEqual(CONVERSATION)
    expect(await w.history.conversation('never-archived')).toBeNull()
    expect(await w.history.archiveStats()).toEqual(STATS)
  })

  it('renames through the host and names what it answered, or nothing for a conversation it does not have', async () => {
    const w = world()
    const renamed = await w.history.rename(ONE, 'Release prep')
    expect(renamed).toMatchObject({ sessionId: ONE, label: 'Release prep' })
    expect(renamed).not.toHaveProperty('backend')
    expect(await w.history.rename('not-a-session', 'x')).toBeNull()
    expect(w.connection.payloads('history:rename')).toEqual([
      { sessionId: ONE, name: 'Release prep' },
      { sessionId: 'not-a-session', name: 'x' }
    ])
  })

  it('carries a search’s match, and the summary’s error when the record could not be read', async () => {
    const w = world()
    w.connection
      .answer('history:sessions', () => ({ sessions: [{ ...SESSION, match: 'plan the release' }], total: 1, tookMs: 1 }))
      .answer('history:summary', () => ({ ...SUMMARY, error: 'history.jsonl could not be read.' }))
    expect((await w.history.sessions({ search: 'plan' })).sessions[0]?.match).toBe('plan the release')
    expect((await w.history.summary()).error).toBe('history.jsonl could not be read.')
  })

  it('reads Claude Code’s usage out of the host’s reading per backend', async () => {
    const w = world()
    const usage = await w.history.usage()
    expect(usage).toEqual({
      file: '/home/.claude.json',
      fetchedAtMs: 1_790_848_800_000,
      limits: [expect.objectContaining({ kind: 'session', percent: 42 })],
      problem: null,
      spend: null
    })
  })

  it('forwards each state the host pushes to the window, converted, after every connect', async () => {
    const w = world()
    await w.link.connect()
    w.connection.snapshot('history:changed', SUMMARY)
    w.connection.push('history:changed', { ...SUMMARY, sessions: 2, error: null })
    w.connection.push('archive:changed', { ...STATS, sessions: 2 })
    w.connection.push('usage:changed', [reading(CLAUDE_CODE_BACKEND, 77)])

    expect(w.emitted.map((e) => e.channel)).toEqual([
      'history:changed',
      'history:changed',
      'archive:changed',
      'usage:changed'
    ])
    expect(w.emitted[1]?.payload).toMatchObject({ sessions: 2 })
    expect(w.emitted[1]?.payload).not.toHaveProperty('error')
    expect(w.emitted[2]?.payload).toMatchObject({ sessions: 2 })
    expect(w.emitted[3]?.payload).toMatchObject({ limits: [expect.objectContaining({ percent: 77 })] })
    expect(w.emitted[3]?.payload).not.toHaveProperty('backend')

    w.history.shutdown()
    expect([...w.connection.subscriptions.keys()]).toEqual([])
  })

  it('gives a read asked before the first connect has finished the host’s answer, not an empty one', async () => {
    const w = world()
    // Nothing has connected yet: each read joins the first connect.
    expect(w.link.current()).toBeNull()
    const [summary, stats, page, usage] = await Promise.all([
      w.history.summary(),
      w.history.archiveStats(),
      w.history.sessions({}),
      w.history.usage()
    ])
    expect(summary.sessions).toBe(1)
    expect(stats.sessions).toBe(1)
    expect(page.sessions.map((s) => s.sessionId)).toEqual([ONE])
    expect(usage.limits.map((l) => l.percent)).toEqual([42])
    // And what the window needs pushed was subscribed before any of them was answered.
    expect([...w.connection.subscriptions.keys()].sort()).toEqual(['archive:changed', 'history:changed', 'usage:changed'])
  })

  it('says the link’s sentence when the host cannot be reached, never an empty list or zero counts', async () => {
    const w = world(null)
    await expect(w.history.summary()).rejects.toThrow(UNREACHABLE)
    await expect(w.history.sessions({})).rejects.toThrow(UNREACHABLE)
    await expect(w.history.prompts(ONE)).rejects.toThrow(UNREACHABLE)
    await expect(w.history.projects()).rejects.toThrow(UNREACHABLE)
    await expect(w.history.conversation(ONE)).rejects.toThrow(UNREACHABLE)
    await expect(w.history.archiveStats()).rejects.toThrow(UNREACHABLE)
    expect(await w.history.usage()).toEqual({
      file: '',
      fetchedAtMs: null,
      limits: [],
      problem: { kind: 'unreadable', detail: UNREACHABLE },
      spend: null
    })
  })

  it('says why usage paints nothing when the host has no reading for Claude Code', async () => {
    const w = world()
    w.connection.answer('usage:read', () => [reading('pi', 10)])
    expect((await w.history.usage()).problem).toEqual({
      kind: 'unreadable',
      detail: 'The local host has no usage reading for Claude Code.'
    })
  })
})
