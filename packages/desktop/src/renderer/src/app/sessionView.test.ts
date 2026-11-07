import { describe, expect, it } from 'vitest'
import type { SessionActivity, SessionActivityState, SessionRecord } from '@helm/core/types'
import { childCrumb, childStatus, childTab, crumbStatus, indicatorOf, sessionNote, statusCounts, statusHint } from './sessionView'

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

describe('the crumb of a session that handed control back', () => {
  const now = Date.parse('2026-10-02T12:00:00.000Z')

  it('says Idle with how long, as the card’s header does, for ready and for background task still running', () => {
    expect(crumbStatus(session(), 'idle', now - MINUTE, now)).toEqual({ text: 'Idle · 1m', tone: 'success' })
    expect(crumbStatus(session(), 'shell', now - MINUTE, now)).toEqual({ text: 'Idle · 1m', tone: 'success' })
    expect(crumbStatus(session(), 'idle', now - 20 * MINUTE, now).text).toBe(childStatus(session(), 'idle', now - 20 * MINUTE, now))
  })

  it('says Idle alone where no time is known', () => {
    expect(crumbStatus(session(), 'idle', null, now)).toEqual({ text: 'Idle', tone: 'success' })
    expect(crumbStatus(session(), 'shell', null, now).text).toBe('Idle')
  })
})

describe('childTab', () => {
  const command = { command: 'pnpm test', parentName: 'api-refactor' }

  it('draws a command child as the terminal glyph in the glyph’s state, saying running or exited <code>', () => {
    expect(childTab(session({ ...command }), 'busy')).toEqual({
      indicator: 'running',
      command: true,
      stateWord: 'running',
      badge: 'api-refactor',
      startedBy: 'api-refactor'
    })
    expect(childTab(session({ ...command, status: 'exited', exitCode: 0 }), 'ended')).toMatchObject({
      indicator: 'ended',
      stateWord: 'exited 0'
    })
    expect(childTab(session({ ...command, status: 'exited', exitCode: 2 }), 'failed')).toMatchObject({
      indicator: 'failed',
      stateWord: 'exited 2'
    })
  })

  it('keeps an agent child’s own dot and gives it the parent’s name as its badge', () => {
    expect(childTab(session({ role: 'reviewer', parentName: 'api-refactor' }), 'busy')).toEqual({
      indicator: 'busy',
      badge: 'api-refactor',
      startedBy: 'api-refactor'
    })
  })

  it('gives a session nobody started no badge', () => {
    expect(childTab(session(), 'idle')).toEqual({ indicator: 'idle' })
    expect(childTab(session({ parentName: '' }), 'idle')).toEqual({ indicator: 'idle' })
  })
})

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
    expect(crumbStatus(session(), 'running', now - 4 * MINUTE, now)).toEqual({ text: 'Running · 4m', tone: 'subtle' })
    expect(crumbStatus(session(), 'running', now - 10_000, now)).toEqual({ text: 'Running · 10s', tone: 'subtle' })
    expect(crumbStatus(session(), 'running', now - 59_999, now).text).toBe('Running · 59s')
    expect(crumbStatus(session(), 'running', now - 60_000, now).text).toBe('Running · 1m')
    expect(crumbStatus(session(), 'running', now, now).text).toBe('Running · 1s')
  })

  it("says a reported error, with the program's message in the crumb, in the danger tone", () => {
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

  describe('of a command child', () => {
    const command = (over: Partial<SessionRecord> = {}): SessionRecord =>
      session({ command: 'pnpm test', startedAt: new Date(now - 4 * MINUTE).toISOString(), ...over })
    const exited = (exitCode: number | null): SessionRecord =>
      command({ status: 'exited', exitCode, endedAt: new Date(2026, 9, 29, 14, 52).toISOString() })

    it('S30: counts its run in the success tone from when it started, in seconds until a minute', () => {
      const started = (ago: number): SessionRecord => command({ startedAt: new Date(now - ago).toISOString() })
      expect(crumbStatus(started(1000), 'running', null, now)).toEqual({ text: 'Running · 1s', tone: 'success' })
      expect(crumbStatus(started(2000), 'running', null, now)).toEqual({ text: 'Running · 2s', tone: 'success' })
      expect(crumbStatus(started(59_999), 'running', null, now).text).toBe('Running · 59s')
      expect(crumbStatus(started(MINUTE), 'running', null, now)).toEqual({ text: 'Running · 1m', tone: 'success' })
      expect(crumbStatus(command(), 'running', null, now).text).toBe('Running · 4m')
    })

    it('S30: takes its state and its start from the command, not from the registry or the indicator', () => {
      expect(crumbStatus(command(), 'busy', now - 10_000, now)).toEqual({ text: 'Running · 4m', tone: 'success' })
      expect(crumbStatus(command(), 'waiting', null, now).tone).toBe('success')
      expect(crumbStatus(command(), 'idle', null, now).text).toBe('Running · 4m')
    })

    it('S30: says only Running where its start is not a time', () => {
      expect(crumbStatus(command({ startedAt: 'never' }), 'running', null, now)).toEqual({
        text: 'Running',
        tone: 'success'
      })
    })

    it('S31: says exited 0 and when in fg-subtle, as its ended header does', () => {
      expect(crumbStatus(exited(0), 'ended', null, now)).toEqual({ text: 'exited 0 · 14:52', tone: 'subtle' })
    })

    it('S31: says any other exit code in danger', () => {
      expect(crumbStatus(exited(1), 'failed', null, now)).toEqual({ text: 'exited 1 · 14:52', tone: 'danger' })
      expect(crumbStatus(exited(137), 'failed', null, now)).toEqual({ text: 'exited 137 · 14:52', tone: 'danger' })
    })

    it('S31: keeps the ended header’s wording in fg-subtle for a code that was never seen', () => {
      expect(crumbStatus(exited(null), 'ended', null, now)).toEqual({ text: 'Done · 14:52', tone: 'subtle' })
      expect(crumbStatus(command({ status: 'lost' }), 'ended', null, now)).toEqual({ text: 'Lost', tone: 'subtle' })
    })

    it('leaves an agent’s and a plain session’s crumb as it was', () => {
      expect(crumbStatus(session(), 'running', now - 4 * MINUTE, now)).toEqual({ text: 'Running · 4m', tone: 'subtle' })
      expect(
        crumbStatus(session({ status: 'exited', exitCode: 0, durationMs: 3 * 60 * MINUTE }), 'ended', null, now)
      ).toEqual({
        text: 'Ended after 3h',
        tone: 'subtle'
      })
    })

    it('keeps its card header’s text', () => {
      expect(childStatus(command(), 'running', null, now)).toBe('Running · 4m')
    })
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
      running: 0,
      idle: 3
    })
  })

  it('counts a command child whose command runs as running, never as idle, and one that exited not at all', () => {
    const sessions = [
      session({ id: 1 }),
      session({ id: 2, command: 'pnpm test' }),
      session({ id: 3, command: 'pnpm build' }),
      session({ id: 4, command: 'pnpm lint', status: 'exited', exitCode: 0 })
    ]
    expect(statusCounts(sessions, () => 'running')).toEqual({
      working: 0,
      waiting: 0,
      error: 0,
      running: 2,
      idle: 1
    })
  })
})

describe('childCrumb', () => {
  const open = (): void => {}
  const lists = (): boolean => true
  const parentOf = { parentId: 7, parentName: 'api-refactor' }

  it('S32: a command child is tagged command', () => {
    const { tag, parent } = childCrumb(session({ ...parentOf, command: 'pnpm test' }), open, lists)
    expect(tag).toEqual({ kind: 'command', text: 'command' })
    expect(parent?.name).toBe('api-refactor')
  })

  it('S32: an agent child is tagged with its role, and one with no role has no tag', () => {
    expect(childCrumb(session({ ...parentOf, role: 'reviewer' }), open, lists).tag).toEqual({
      kind: 'role',
      text: 'reviewer'
    })
    expect(childCrumb(session({ ...parentOf, role: null }), open, lists).tag).toBeUndefined()
    expect(childCrumb(session({ ...parentOf, role: '' }), open, lists).tag).toBeUndefined()
  })

  it('S32: the link opens the parent by its id where the window lists it, and is plain text where not', () => {
    const opened: number[] = []
    const listed = childCrumb(session(parentOf), (id) => opened.push(id), lists)
    listed.parent?.onOpen?.()
    expect(opened).toEqual([7])
    const unlisted = childCrumb(
      session(parentOf),
      (id) => opened.push(id),
      () => false
    )
    expect(unlisted.parent).toEqual({ name: 'api-refactor', onOpen: undefined })
  })

  it('a session nobody started has neither tag nor link', () => {
    expect(childCrumb(session(), open, lists)).toEqual({ tag: undefined, parent: undefined })
  })
})
