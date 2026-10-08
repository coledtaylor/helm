import { describe, expect, it } from 'vitest'
import { describePluginSessions, type PluginSessionFacts } from './plugin-sessions'
import type { LiveSession } from '../types'

const NOW = 1_787_280_000_000

function live(over: Partial<LiveSession> = {}): LiveSession {
  return {
    helmSessionId: 7,
    pid: 4242,
    registered: true,
    cwd: 'C:\\repos\\api',
    name: 'api',
    activity: 'waiting',
    waitingFor: 'Allow Bash(rm -rf build) in C:\\repos\\api?',
    statusSinceMs: NOW - 90_000,
    version: '2.1.238',
    entrypoint: 'cli',
    startedAtMs: NOW - 600_000,
    claudeSessionId: 'fcbc98b5-5d39-41eb-aa14-e2379c06d662',
    ...over
  }
}

function fact(over: Partial<PluginSessionFacts> = {}): PluginSessionFacts {
  return {
    id: 'a1b2',
    helmSessionId: 7,
    name: 'API-12',
    cwd: 'C:\\repos\\api',
    running: true,
    startedAtMs: NOW - 600_000,
    endedAtMs: null,
    ...over
  }
}

describe('describePluginSessions', () => {
  it('says what a running session is doing and since when, and nothing of its conversation', () => {
    const [session] = describePluginSessions([fact()], [live()])
    expect(session).toEqual({
      id: 'a1b2',
      name: 'API-12',
      cwd: 'C:\\repos\\api',
      state: 'running',
      activity: 'waiting',
      activitySince: NOW - 90_000,
      startedAt: NOW - 600_000,
      endedAt: null
    })
    // Not the CLI's sentence, not the conversation id, not Helm's row id.
    const said = JSON.stringify(session)
    expect(said).not.toContain('Allow Bash')
    expect(said).not.toContain('fcbc98b5')
    expect(said).not.toContain('"helmSessionId"')
  })

  it('says "cannot tell" for a running session the registry has not got, rather than guessing', () => {
    expect(describePluginSessions([fact()], [live({ helmSessionId: 8 })])[0]).toMatchObject({
      state: 'running',
      activity: null,
      activitySince: null
    })
    expect(describePluginSessions([fact()], [live({ activity: null })])[0]).toMatchObject({ activity: null, activitySince: null })
    expect(describePluginSessions([fact()], [live({ statusSinceMs: null })])[0]).toMatchObject({
      activity: 'waiting',
      activitySince: null
    })
  })

  it('gives an ended session its end and no activity, whatever a stale registry record says', () => {
    const [session] = describePluginSessions([fact({ running: false, endedAtMs: NOW - 1000 })], [live({ activity: 'busy' })])
    expect(session).toMatchObject({ state: 'ended', activity: null, activitySince: null, endedAt: NOW - 1000 })
  })

  it('keeps the order it was given', () => {
    const sessions = describePluginSessions([fact({ id: 'one' }), fact({ id: 'two', helmSessionId: 8 })], [])
    expect(sessions.map((session) => session.id)).toEqual(['one', 'two'])
  })
})
