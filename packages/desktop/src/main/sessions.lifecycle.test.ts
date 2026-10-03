import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readSessions, sessionLabel, type SessionRecord } from '@helm/core'
import { DISPOSE_TIMEOUT_MS, hostInWorld, processAlive, type HostedWorld } from '../../test/hosted'
import type { ConfirmRequest } from './sessions'

const notifications = vi.hoisted(() => [] as { title: string; body: string }[])

vi.mock('electron', async () => {
  const fake = (await import('../../test/electron')).electronFake()
  // Shown and recorded, where the shared fake says notifications are not
  // supported: whether an exit raises one is part of what this file is about.
  class Notification {
    static isSupported(): boolean {
      return true
    }
    private readonly options: { title: string; body: string }
    constructor(options: { title: string; body: string }) {
      this.options = options
    }
    on(): void {}
    show(): void {
      notifications.push(this.options)
    }
  }
  return { ...fake, Notification }
})

/**
 * A session's life in the host, against real ptys running the fake `claude`:
 * started, ended on its own, renamed, and closed with the user's say-so.
 */
describe('session lifecycle', () => {
  let h: HostedWorld
  /** What the host told the window, other than the screen bytes. */
  const sent: { channel: string; payload: unknown }[] = []
  /** Whether the window has the OS focus. */
  const screen = { focused: true }
  const asked: ConfirmRequest[] = []
  const answer = { agree: false }

  const fakeWindow = {
    isDestroyed: () => false,
    isFocused: () => screen.focused,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => {
        if (channel !== 'session:data') sent.push({ channel, payload })
      }
    }
  } as unknown as BrowserWindow

  beforeAll(async () => {
    h = await hostInWorld({
      window: () => fakeWindow,
      confirm: (request) => {
        asked.push(request)
        return Promise.resolve(answer.agree)
      }
    })
  }, DISPOSE_TIMEOUT_MS)

  afterAll(async () => {
    await h.dispose()
  }, DISPOSE_TIMEOUT_MS)

  beforeEach(() => {
    sent.length = 0
    asked.length = 0
    notifications.length = 0
    screen.focused = true
  })

  const start = (cwd: string, name: string): Promise<SessionRecord> =>
    h.host.start({ cwd, projectPath: cwd, name, cols: 80, rows: 24 })

  const row = (id: number): SessionRecord | undefined =>
    readSessions(h.services.store).find((session) => session.id === id)

  const listed = (id: number): SessionRecord | undefined =>
    h.host.list().find((session) => session.id === id)

  /** Closes tabs without asking and waits for their processes to be gone. */
  const end = async (...records: SessionRecord[]): Promise<void> => {
    for (const record of records) await h.host.close({ id: record.id, force: true })
    await vi.waitFor(() => expect(records.filter((r) => h.host.pid(r.id) !== null)).toEqual([]), {
      timeout: 10_000
    })
  }

  it('runs three sessions at once, one per folder, each its own process at the prompt', async () => {
    const gamma = join(h.world.projectsDir, 'gamma')
    mkdirSync(gamma)
    const folders = [h.world.projects.alpha, h.world.projects.beta, gamma]

    const records = await Promise.all([
      start(h.world.projects.alpha, 'alpha'),
      start(h.world.projects.beta, 'beta'),
      start(gamma, 'gamma')
    ])
    await Promise.all(records.map((record) => h.ready(record.id)))
    const runs = await Promise.all(records.map((record) => h.run(record)))

    expect(new Set(records.map((record) => record.id)).size).toBe(3)
    expect(runs.map((run) => run.cwd.toLowerCase())).toEqual(folders.map((f) => f.toLowerCase()))
    expect(new Set(runs.map((run) => run.pid)).size).toBe(3)
    expect(runs.every((run) => processAlive(run.pid))).toBe(true)
    const byId = (a: number, b: number): number => a - b
    expect(
      h.host
        .list()
        .filter((s) => s.status === 'running')
        .map((s) => s.id)
        .sort(byId)
    ).toEqual(records.map((record) => record.id).sort(byId))

    await end(...records)
  })

  it('keeps the tab of a session that exits on its own, records how it ended, and notifies only when it was out of sight', async () => {
    const [front, back] = await Promise.all([
      start(h.world.projects.alpha, 'alpha'),
      start(h.world.projects.beta, 'beta')
    ])
    await Promise.all([h.ready(front.id), h.ready(back.id)])
    // `front` is the tab on screen; `back` sits behind it, in a focused window.
    h.host.setFocus([front.id])

    h.host.input(back.id, '/exit\r')
    h.host.input(front.id, '/crash\r')
    await vi.waitFor(
      () => {
        expect(row(back.id)).toMatchObject({ status: 'exited', exitCode: 0 })
        expect(row(front.id)).toMatchObject({ status: 'exited', exitCode: 3 })
      },
      { timeout: 10_000 }
    )
    expect(row(back.id)?.durationMs).toBeGreaterThan(0)
    expect(row(front.id)?.durationMs).toBeGreaterThan(0)

    // Still listed, so a reloaded window adopts the ended tabs with their scrollback.
    expect(listed(back.id)).toMatchObject({ status: 'exited', exitCode: 0 })
    expect(listed(front.id)).toMatchObject({ status: 'exited', exitCode: 3 })
    expect(sent).toContainEqual({
      channel: 'session:exit',
      payload: expect.objectContaining({ id: back.id, status: 'exited', exitCode: 0 })
    })

    // Only the background tab's ending is announced: the session somebody is
    // looking at needs no toast to be seen.
    expect(notifications).toEqual([{ title: 'beta finished', body: h.world.projects.beta }])

    // An ended tab closes without a question: there is nothing left to end.
    await expect(h.host.close({ id: back.id })).resolves.toEqual({ closed: true })
    await expect(h.host.close({ id: front.id })).resolves.toEqual({ closed: true })
    expect(asked).toEqual([])
    expect(listed(back.id)).toBeUndefined()
    expect(listed(front.id)).toBeUndefined()
  })

  it('renames a tab without touching the name the CLI got, and asks under that name before ending it', async () => {
    const record = await start(h.world.projects.alpha, 'alpha')
    await h.ready(record.id)
    const run = await h.run(record)
    expect(run.argv.slice(run.argv.indexOf('-n'), run.argv.indexOf('-n') + 2)).toEqual(['-n', 'alpha'])

    expect(h.host.rename({ id: record.id, label: '  review  ' })).toMatchObject({
      label: 'review',
      name: 'alpha'
    })
    expect(listed(record.id)).toMatchObject({ label: 'review', name: 'alpha' })
    expect(row(record.id)).toMatchObject({ label: 'review', name: 'alpha' })

    // Declined: the tab and the process both stay.
    answer.agree = false
    await expect(h.host.close({ id: record.id })).resolves.toEqual({ closed: false })
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({
      kind: 'close-session',
      message: '“review” is still running.',
      confirmLabel: 'End session'
    })
    expect(asked[0]?.sessions.map(sessionLabel)).toEqual(['review'])
    expect(listed(record.id)?.status).toBe('running')
    expect(row(record.id)?.status).toBe('running')
    expect(processAlive(run.pid)).toBe(true)

    // An emptied label is no label: the tab goes back to the CLI's name.
    const cleared = h.host.rename({ id: record.id, label: '' })
    expect(cleared.label).toBeNull()
    expect(sessionLabel(cleared)).toBe('alpha')
    expect(row(record.id)?.label).toBeNull()

    // Agreed: the process ends, the tab goes, and the row says how long it ran.
    answer.agree = true
    await expect(h.host.close({ id: record.id })).resolves.toEqual({ closed: true })
    expect(asked).toHaveLength(2)
    expect(listed(record.id)).toBeUndefined()
    await vi.waitFor(() => expect(processAlive(run.pid)).toBe(false), { timeout: 10_000 })
    await vi.waitFor(() => expect(row(record.id)?.status).toBe('exited'), { timeout: 10_000 })
    expect(row(record.id)?.durationMs).toBeGreaterThan(0)
  })

  it('does not give a new launch the name of an ended tab that is still open', async () => {
    const first = await start(h.world.projects.alpha, 'alpha')
    await h.ready(first.id)
    h.host.input(first.id, '/exit\r')
    await vi.waitFor(() => expect(listed(first.id)?.status).toBe('exited'), { timeout: 10_000 })

    const second = await start(h.world.projects.alpha, 'alpha')
    expect(first.name).toBe('alpha')
    expect(second.name).toBe('alpha 2')
    expect(h.host.list().map(sessionLabel)).toEqual(['alpha', 'alpha 2'])

    await end(first, second)
  })

  it('captures the branch at spawn as git reports it, and keeps it when the checkout moves on', async () => {
    const beta = h.world.projects.beta
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: beta, encoding: 'utf8' }).trim()
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature/beta')

    const before = await start(beta, 'beta')
    expect(before.branch).toBe('feature/beta')
    expect(row(before.id)?.branch).toBe('feature/beta')

    git('checkout', '-q', '-b', 'later')
    const after = await start(beta, 'beta')
    expect(after.branch).toBe('later')
    expect(row(before.id)?.branch).toBe('feature/beta')
    expect(listed(before.id)?.branch).toBe('feature/beta')

    await end(before, after)
  })
})
