import { describe, expect, it } from 'vitest'
import type { SessionActivity, SessionActivityState, SessionRecord } from '@helm/core/types'
import { crumbStatus, indicatorOf, sessionNote } from './sessionView'

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 1,
    name: 'shop',
    label: null,
    cwd: 'C:\\work\\shop',
    branch: 'main',
    projectPath: 'C:\\work\\shop',
    profileId: null,
    argv: [],
    claudeSessionId: 'conversation',
    status: 'running',
    startedAt: '2026-10-02T10:00:00.000Z',
    endedAt: null,
    durationMs: null,
    exitCode: null,
    ...over
  }
}

function said(activity: SessionActivity | null, waitingFor: string | null = null): SessionActivityState {
  return { id: 1, activity, waitingFor, claudeSessionId: activity === null ? null : 'conversation' }
}

const MINUTE = 60_000

describe('indicatorOf', () => {
  it('paints a running session with what its record says it is doing', () => {
    expect(indicatorOf(session(), said('busy'))).toBe('busy')
    expect(indicatorOf(session(), said('waiting', 'permission prompt'))).toBe('waiting')
    expect(indicatorOf(session(), said('idle'))).toBe('idle')
    expect(indicatorOf(session(), said('shell'))).toBe('shell')
  })

  it('paints running, never a guess, where no live record speaks for the session', () => {
    // A stale record is dropped before it gets here, which leaves no activity.
    expect(indicatorOf(session(), said(null))).toBe('running')
    expect(indicatorOf(session(), undefined)).toBe('running')
  })

  it('lets how a session ended outrank the last thing its record said', () => {
    expect(indicatorOf(session({ status: 'exited', exitCode: 0 }), said('busy'))).toBe('ended')
    expect(indicatorOf(session({ status: 'exited', exitCode: 3 }), said('waiting'))).toBe('failed')
    expect(indicatorOf(session({ status: 'exited', exitCode: null }), undefined)).toBe('ended')
    expect(indicatorOf(session({ status: 'lost' }), said('busy'))).toBe('ended')
  })
})

describe('what the tree row and the crumb say', () => {
  const now = Date.parse('2026-10-02T12:00:00.000Z')

  it('says a waiting session needs you and how long a working one has been at it', () => {
    expect(sessionNote('waiting', now - 4 * MINUTE, now)).toBe('needs you')
    expect(sessionNote('busy', now - 4 * MINUTE, now)).toBe('4m')
    expect(sessionNote('busy', null, now)).toBe('')
    expect(sessionNote('idle', null, now)).toBe('idle')
    expect(sessionNote('failed', null, now)).toBe('failed')

    expect(crumbStatus(session(), 'waiting', now - 4 * MINUTE, now)).toEqual({ text: 'Needs you · 4m', tone: 'warn' })
    expect(crumbStatus(session(), 'busy', now - 90 * MINUTE, now)).toEqual({ text: 'Working · 1h', tone: 'accent' })
    expect(crumbStatus(session(), 'idle', null, now)).toEqual({ text: 'Idle', tone: 'success' })
    expect(crumbStatus(session(), 'running', null, now)).toEqual({ text: 'Running', tone: 'subtle' })
  })

  it('says how a session ended', () => {
    const ended = session({ status: 'exited', exitCode: 0, durationMs: 3 * 60 * MINUTE })
    expect(crumbStatus(ended, 'ended', null, now)).toEqual({ text: 'Ended after 3h', tone: 'subtle' })
    const failed = session({ status: 'exited', exitCode: 3, durationMs: 5_000 })
    expect(crumbStatus(failed, 'failed', null, now)).toEqual({ text: 'Exited 3', tone: 'danger' })
  })
})
