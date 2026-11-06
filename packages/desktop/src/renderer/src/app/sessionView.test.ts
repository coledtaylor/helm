import { describe, expect, it } from 'vitest'
import type { SessionActivity, SessionActivityState, SessionRecord } from '@helm/core/types'
import { childStatus, crumbStatus, indicatorOf, sessionNote, statusCounts, statusHint } from './sessionView'

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

function said(
  activity: SessionActivity | null,
  waitingFor: string | null = null,
  message: string | null = null
): SessionActivityState {
  return { id: 1, activity, waitingFor, message, claudeSessionId: activity === null ? null : 'conversation' }
}

const MINUTE = 60_000

describe('indicatorOf', () => {
  it('paints a running session with what its record says it is doing', () => {
    expect(indicatorOf(session(), said('busy'))).toBe('busy')
    expect(indicatorOf(session(), said('waiting', 'permission prompt'))).toBe('waiting')
    expect(indicatorOf(session(), said('idle'))).toBe('idle')
    expect(indicatorOf(session(), said('shell'))).toBe('shell')
  })

  it('paints a plain tab with what its program reports: working, idle, needs you or error', () => {
    expect(indicatorOf(session(), said('busy'))).toBe('busy')
    expect(indicatorOf(session(), said('idle'))).toBe('idle')
    expect(indicatorOf(session(), said('waiting', 'question'))).toBe('waiting')
    expect(indicatorOf(session(), said('error', null, 'build failed'))).toBe('error')
    // A program that has exited is over, whatever it last reported.
    expect(indicatorOf(session({ status: 'exited', exitCode: 1 }), said('error', null, 'x'))).toBe('failed')
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

  it('says a reported error, with the program\'s message in the crumb, in the danger tone', () => {
    expect(sessionNote('error', now - 4 * MINUTE, now)).toBe('error')
    expect(crumbStatus(session(), 'error', now - 4 * MINUTE, now, 'build failed')).toEqual({
      text: 'Error · build failed',
      tone: 'danger'
    })
    expect(crumbStatus(session(), 'error', null, now)).toEqual({ text: 'Error', tone: 'danger' })
    const longest = 'm'.repeat(200)
    expect(crumbStatus(session(), 'error', null, now, longest).text).toBe(`Error · ${longest}`)
  })

  it('names what a reported block waits on, and a reported error, in the hint', () => {
    expect(statusHint(said('waiting', 'permission prompt'))).toBe('Waiting: permission prompt')
    expect(statusHint(said('waiting', 'question'))).toBe('Waiting: question')
    expect(statusHint(said('waiting', 'sign-in'))).toBe('Waiting: sign-in')
    expect(statusHint(said('error', null, 'build failed'))).toBe('Error: build failed')
    expect(statusHint(said('error'))).toBeNull()
  })

  it('says nothing more for a plain tab whose program never reports', () => {
    expect(indicatorOf(session(), said(null))).toBe('running')
    expect(sessionNote('running', null, now)).toBe('')
    expect(crumbStatus(session(), 'running', null, now)).toEqual({ text: 'Running', tone: 'subtle' })
    expect(statusHint(said(null))).toBeNull()
    expect(statusHint(undefined)).toBeNull()
  })

  it('says how a session ended', () => {
    const ended = session({ status: 'exited', exitCode: 0, durationMs: 3 * 60 * MINUTE })
    expect(crumbStatus(ended, 'ended', null, now)).toEqual({ text: 'Ended after 3h', tone: 'subtle' })
    const failed = session({ status: 'exited', exitCode: 3, durationMs: 5_000 })
    expect(crumbStatus(failed, 'failed', null, now)).toEqual({ text: 'Exited 3', tone: 'danger' })
  })

  it('says a child’s state in its card header, with how long for every state that has been going a while', () => {
    expect(childStatus(session(), 'busy', now - 4 * MINUTE, now)).toBe('Working · 4m')
    expect(childStatus(session(), 'waiting', now - MINUTE, now)).toBe('Needs you · 1m')
    expect(childStatus(session(), 'idle', now - 20 * MINUTE, now)).toBe('Idle · 20m')
    expect(childStatus(session(), 'shell', now - MINUTE, now)).toBe('Idle · 1m')
    expect(childStatus(session(), 'idle', null, now)).toBe('Idle')
    expect(childStatus(session(), 'busy', null, now)).toBe('Working')
    expect(childStatus(session(), 'running', null, now)).toBe('Running')
  })

  it('keeps a child’s reported error to one word in its header, the program’s message being the crumb’s', () => {
    expect(childStatus(session(), 'error', now - 4 * MINUTE, now)).toBe('Error')
  })
})

describe('statusCounts', () => {
  it('counts a session whose program reports an error as in error, never as idle', () => {
    const states = new Map<number, ReturnType<typeof indicatorOf>>([
      [1, 'busy'],
      [2, 'waiting'],
      [3, 'error'],
      [4, 'idle'],
      [5, 'running'],
      [6, 'shell']
    ])
    const running = [...states.keys()].map((id) => session({ id }))
    const ended = session({ id: 7, status: 'exited', exitCode: 0 })
    expect(statusCounts([...running, ended], (each) => states.get(each.id) ?? 'ended')).toEqual({
      working: 1,
      waiting: 1,
      error: 1,
      idle: 3
    })
  })
})
