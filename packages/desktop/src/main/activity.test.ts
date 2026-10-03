import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SessionActivityState, SessionRecord } from '@helm/core'
import { DISPOSE_TIMEOUT_MS, hostInWorld, processAlive, type HostedWorld } from '../../test/hosted'
import type { ActivityService } from './activity'
import type { SessionHost } from './sessions'

vi.mock('electron', async () => (await import('../../test/electron')).electronFake())

/**
 * What each hosted session is doing, joined from Claude Code's registry:
 * first against real sessions of the fake `claude`, which writes the registry
 * the way the CLI does, then against a registry arranged by hand with the
 * records a real machine leaves lying about.
 */
describe('activity service', () => {
  describe('over hosted sessions', () => {
    let h: HostedWorld
    let activity: ActivityService

    beforeAll(async () => {
      h = await hostInWorld()
      const { createActivityService } = await import('./activity')
      activity = createActivityService({
        sessions: h.host,
        window: () => null,
        claudeHome: h.world.claudeDir
      })
      // Passes are driven by the test, not by the timer.
      activity.stop()
    }, DISPOSE_TIMEOUT_MS)

    afterAll(async () => {
      await h.dispose()
    }, DISPOSE_TIMEOUT_MS)

    const WAIT = { timeout: 10_000 }

    const stateOf = (id: number): SessionActivityState | undefined => {
      activity.refresh()
      return activity.states().find((state) => state.id === id)
    }

    it('joins each session to its own record, through the .cmd shim: idle, waiting with its reason, busy', async () => {
      const { alpha: alphaDir, beta: betaDir } = h.world.projects
      const [alpha, beta] = await Promise.all([
        h.host.start({ cwd: alphaDir, projectPath: alphaDir, name: 'alpha', cols: 80, rows: 24 }),
        h.host.start({ cwd: betaDir, projectPath: betaDir, name: 'beta', cols: 80, rows: 24 })
      ])
      await Promise.all([h.ready(alpha.id), h.ready(beta.id)])

      await vi.waitFor(() => {
        expect(stateOf(alpha.id)).toEqual({
          id: alpha.id,
          activity: 'idle',
          waitingFor: null,
          claudeSessionId: alpha.claudeSessionId
        })
        expect(stateOf(beta.id)?.activity).toBe('idle')
      }, WAIT)

      // The pty is `cmd.exe`, and the CLI registered under its own pid beneath it.
      const run = await h.run(alpha)
      expect(run.pid).not.toBe(h.host.pid(alpha.id))
      expect(activity.overview().sessions.find((s) => s.helmSessionId === alpha.id)).toMatchObject({
        pid: run.pid,
        registered: true,
        cwd: alphaDir,
        name: 'alpha',
        activity: 'idle'
      })

      h.host.input(alpha.id, '/wait\r')
      await vi.waitFor(() => {
        expect(stateOf(alpha.id)).toMatchObject({ activity: 'waiting', waitingFor: 'permission prompt' })
      }, WAIT)
      expect(stateOf(beta.id)?.activity).toBe('idle')

      h.host.input(alpha.id, 'y')
      // Busy for far longer than the test needs, so a slow machine cannot see it finish first.
      h.host.input(beta.id, '/busy 30000\r')
      await vi.waitFor(() => {
        expect(stateOf(alpha.id)).toMatchObject({ activity: 'idle', waitingFor: null })
        expect(stateOf(beta.id)?.activity).toBe('busy')
      }, WAIT)
    })
  })

  describe('over a registry as a machine leaves it', () => {
    const home = mkdtempSync(join(tmpdir(), 'helm activity-'))
    const dir = join(home, 'sessions')
    const sent: { channel: string; payload: unknown }[] = []
    const window = {
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) }
    } as unknown as BrowserWindow

    /** A process that has come and gone, so its pid answers as dead. */
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid as number
    const hosted: SessionRecord = {
      id: 7,
      name: 'shop',
      label: null,
      cwd: 'C:\\work\\shop',
      branch: 'main',
      projectPath: 'C:\\work\\shop',
      profileId: null,
      argv: ['-n', 'shop', '--session-id', 'hosted-conversation'],
      claudeSessionId: 'hosted-conversation',
      status: 'running',
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationMs: null,
      exitCode: null
    }
    const ptyPid = deadPid + 1_000_000
    const host = { list: () => [hosted], pid: () => ptyPid } as unknown as SessionHost
    const now = Date.now()

    const files: Record<string, string> = {
      // Left by a hard kill: the process is gone and the record still claims busy.
      [`${String(deadPid)}.json`]: JSON.stringify({
        pid: deadPid,
        sessionId: 'hosted-conversation',
        cwd: hosted.cwd,
        startedAt: now - 60_000,
        status: 'busy',
        statusUpdatedAt: now - 30_000
      }),
      // A pid that is alive now, in a record from before this machine booted.
      [`${String(process.ppid)}.json`]: JSON.stringify({
        pid: process.ppid,
        sessionId: 'hosted-conversation',
        cwd: hosted.cwd,
        startedAt: 1_000,
        status: 'waiting',
        waitingFor: 'permission prompt'
      }),
      // A claude somebody started in a terminal, in the same folder.
      [`${String(process.pid)}.json`]: JSON.stringify({
        pid: process.pid,
        sessionId: 'outside-conversation',
        cwd: hosted.cwd,
        name: 'terminal session',
        version: '2.1.999',
        entrypoint: 'cli',
        startedAt: now - 5_000,
        status: 'waiting',
        waitingFor: 'dialog open',
        statusUpdatedAt: now - 1_000
      }),
      // The credential the CLI keeps beside a record, and a record cut off mid-write.
      [`${String(process.pid)}.0123abcd.key`]: '{"peerToken":"not-for-helm"}',
      'junk.json': '{"pid": 12'
    }

    let activity: ActivityService

    beforeAll(async () => {
      mkdirSync(dir, { recursive: true })
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
      const { createActivityService } = await import('./activity')
      activity = createActivityService({ sessions: host, window: () => window, claudeHome: home })
      activity.stop()
    })

    afterAll(() => {
      rmSync(home, { recursive: true, force: true })
    })

    const snapshot = (): Record<string, string> =>
      Object.fromEntries(
        readdirSync(dir).map((name) => [name, readFileSync(join(dir, name)).toString('base64')])
      )

    it('drops a dead process’s record and a pre-boot one, lists the rest, and leaves every file as it found it', () => {
      expect(processAlive(deadPid)).toBe(false)
      expect(processAlive(ptyPid)).toBe(false)
      expect(processAlive(process.ppid)).toBe(true)
      const before = snapshot()
      expect(Object.keys(before).sort()).toEqual(Object.keys(files).sort())

      activity.refresh()

      // Neither stale record speaks for the hosted session: no busy, no waiting.
      expect(activity.states()).toEqual([
        { id: hosted.id, activity: null, waitingFor: null, claudeSessionId: null }
      ])
      expect(activity.entries().map((entry) => entry.file)).toEqual([`${String(process.pid)}.json`])
      expect(activity.overview().sessions).toEqual([
        expect.objectContaining({
          helmSessionId: hosted.id,
          pid: ptyPid,
          registered: false,
          cwd: hosted.cwd,
          name: 'shop',
          activity: null
        }),
        expect.objectContaining({
          helmSessionId: null,
          pid: process.pid,
          registered: true,
          cwd: hosted.cwd,
          name: 'terminal session',
          activity: 'waiting',
          waitingFor: 'dialog open'
        })
      ])

      // Read-only: the stale records stay for the CLI's own sweep.
      expect(snapshot()).toEqual(before)
    })

    it('tells the window only when something moved', () => {
      sent.length = 0
      activity.refresh()
      activity.refresh()
      expect(sent).toEqual([])

      writeFileSync(
        join(dir, `${String(process.pid)}.json`),
        JSON.stringify({ pid: process.pid, sessionId: 'outside-conversation', cwd: hosted.cwd, status: 'idle' })
      )
      activity.refresh()
      activity.refresh()
      expect(sent.map((event) => event.channel)).toEqual(['sessions:overview'])
    })
  })
})
