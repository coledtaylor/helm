import type { BrowserWindow } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessSnapshot, SessionRecord, SessionResources } from '@helm/core'
import { createResourcesService, type ResourcesService } from './resources'
import type { SessionHost } from './sessions'

vi.mock('electron', async () => (await import('../../test/electron')).electronFake())

/**
 * The process-and-ports pass behind the sessions pane, against a machine
 * arranged by hand: which sessions it reports, at which pid, and when it is
 * allowed to cost anything at all.
 */

function record(id: number, status: SessionRecord['status'] = 'running'): SessionRecord {
  return {
    id,
    name: `session ${String(id)}`,
    label: null,
    cwd: `C:\\work\\${String(id)}`,
    branch: null,
    projectPath: null,
    profileId: null,
    argv: [],
    claudeSessionId: null,
    status,
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: null,
    exitCode: status === 'running' ? null : 0
  }
}

/**
 * Two hosted sessions alive (ptys 100 and 200), one ended (pty 300, still in
 * its tab), and a `claude` Helm did not start (999) holding the same port as a
 * child of the first session.
 */
const MACHINE: ProcessSnapshot = {
  processes: [
    { pid: 100, parentPid: 4, name: 'cmd.exe', commandLine: 'cmd.exe /c claude.cmd' },
    { pid: 101, parentPid: 100, name: 'node.exe', commandLine: 'node claude.js' },
    { pid: 102, parentPid: 101, name: 'vite.exe', commandLine: 'vite --port 5173' },
    { pid: 200, parentPid: 4, name: 'cmd.exe', commandLine: 'cmd.exe /c claude.cmd' },
    { pid: 201, parentPid: 200, name: 'node.exe', commandLine: null },
    { pid: 300, parentPid: 4, name: 'cmd.exe', commandLine: 'cmd.exe /c claude.cmd' },
    { pid: 999, parentPid: 4, name: 'claude.exe', commandLine: 'claude' }
  ],
  ports: [
    { pid: 102, port: 5173, address: '127.0.0.1' },
    { pid: 999, port: 5173, address: '0.0.0.0' }
  ],
  atMs: 1_000,
  durationMs: 400
}

/** Every service a test made, stopped after it. */
const services: ResourcesService[] = []

interface Harness {
  service: ResourcesService
  read: ReturnType<typeof vi.fn<() => Promise<ProcessSnapshot>>>
  /** Every `sessions:resources` push, in order. */
  pushes: SessionResources[][]
}

function harness(read: () => Promise<ProcessSnapshot>): Harness {
  const records = [record(1), record(2), record(3, 'exited'), record(4)]
  // Session 4 is running by its row, but its tab has just been closed and the
  // host no longer holds a pid for it.
  const pids = new Map<number, number | null>([
    [1, 100],
    [2, 200],
    [3, 300],
    [4, null]
  ])
  const host = {
    list: () => records,
    pid: (id: number) => pids.get(id) ?? null
  } as unknown as SessionHost
  const pushes: SessionResources[][] = []
  const window = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: SessionResources[]) => {
        if (channel === 'sessions:resources') pushes.push(payload)
      }
    }
  } as unknown as BrowserWindow
  const spy = vi.fn(read)
  const service = createResourcesService({ sessions: host, window: () => window, read: spy })
  services.push(service)
  return { service, read: spy, pushes }
}

afterEach(() => {
  for (const service of services.splice(0)) service.stop()
  vi.useRealTimers()
})

describe('resources service', () => {
  it('reports each running hosted session once, rooted at the pty pid the host holds, and invents none', async () => {
    const { service, read, pushes } = harness(() => Promise.resolve(MACHINE))
    service.watch(true)
    await service.refresh()

    expect(read).toHaveBeenCalledTimes(1)
    const snapshots = service.snapshots()
    expect(snapshots.map((s) => [s.id, s.rootPid])).toEqual([
      [1, 100],
      [2, 200]
    ])
    expect(snapshots[0]?.processes?.map((p) => [p.pid, p.depth])).toEqual([
      [100, 0],
      [101, 1],
      [102, 2]
    ])
    // The port the outside `claude` holds is not this session's, whatever its number.
    expect(snapshots[0]?.ports).toEqual([{ port: 5173, pid: 102, process: 'vite.exe', addresses: ['127.0.0.1'] }])
    expect(snapshots[1]?.processes?.map((p) => p.pid)).toEqual([200, 201])
    expect(snapshots[1]?.ports).toEqual([])
    expect(pushes).toEqual([snapshots])

    // The same machine again moves nothing, so nothing is pushed.
    await service.refresh()
    expect(read).toHaveBeenCalledTimes(2)
    expect(pushes).toHaveLength(1)
  })

  it('costs nothing while nobody is watching, joins a pass already running, and polls only while watched', async () => {
    vi.useFakeTimers()
    let land: (snapshot: ProcessSnapshot) => void = () => undefined
    const { service, read } = harness(
      () =>
        new Promise<ProcessSnapshot>((resolve) => {
          land = resolve
        })
    )

    await service.refresh()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(read).not.toHaveBeenCalled()

    // Watching starts a pass at once; asking again while it runs joins it.
    service.watch(true)
    const joined = service.refresh()
    expect(read).toHaveBeenCalledTimes(1)
    land(MACHINE)
    await joined
    expect(service.snapshots().map((s) => s.id)).toEqual([1, 2])

    await vi.advanceTimersByTimeAsync(4_000)
    expect(read).toHaveBeenCalledTimes(2)
    land(MACHINE)

    // The last thing seen stays on screen; the passes stop.
    service.watch(false)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(read).toHaveBeenCalledTimes(2)
    expect(service.snapshots().map((s) => s.id)).toEqual([1, 2])
  })

  it('reports a machine it could not ask as unknown, and survives a reader that throws', async () => {
    let answer: () => Promise<ProcessSnapshot> = () =>
      Promise.resolve({ processes: null, ports: null, atMs: 2_000, durationMs: 15_000 })
    const { service } = harness(() => answer())
    service.watch(true)
    await service.refresh()
    expect(service.snapshots().map((s) => [s.id, s.processes, s.ports])).toEqual([
      [1, null, null],
      [2, null, null]
    ])

    answer = () => Promise.reject(new Error('powershell.exe is not there'))
    await expect(service.refresh()).resolves.toBeUndefined()
    expect(service.snapshots().map((s) => s.processes)).toEqual([null, null])
  })
})
