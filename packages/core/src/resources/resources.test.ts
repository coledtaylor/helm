import { describe, expect, it } from 'vitest'
import { liveSessionsIn, type LiveSession } from '../types'
import {
  noProcessSnapshot,
  sessionResources,
  type PortRow,
  type ProcessRow,
  type ProcessSnapshot
} from './resources'

/**
 * A machine, arranged.
 *
 * Every fixture here is written out rather than derived from a real
 * enumeration, because the cases that matter are the ones a real machine will
 * not produce on demand: a command line the querying user may not read, a cycle
 * in the process table, a socket query that failed while the process query did
 * not.
 */
function proc(pid: number, parentPid: number, name: string, commandLine: string | null = null): ProcessRow {
  return { pid, parentPid, name, commandLine }
}

function snap(
  processes: ProcessRow[] | null,
  ports: PortRow[] | null = [],
  atMs = 1_000
): ProcessSnapshot {
  return { processes, ports, atMs, durationMs: 7 }
}

describe('sessionResources', () => {
  it('walks the tree under the pty pid, breadth first, with depths', () => {
    const result = sessionResources(
      3,
      100,
      snap([
        proc(1, 0, 'System'),
        proc(100, 42, 'claude.exe', 'claude --add-dir "C:\\Program Files\\x"'),
        proc(200, 100, 'bash.exe', 'bash -c "npm run dev"'),
        proc(300, 200, 'node.exe', 'node vite'),
        proc(400, 100, 'docker.exe', 'docker compose up'),
        // Somebody else's process, one pid away from the tree.
        proc(500, 42, 'chrome.exe', 'chrome')
      ])
    )

    expect(result.rootSeen).toBe(true)
    expect(result.processes?.map((p) => p.pid)).toEqual([100, 200, 400, 300])
    expect(result.processes?.map((p) => p.depth)).toEqual([0, 1, 1, 2])
    expect(result.processes?.some((p) => p.pid === 500)).toBe(false)
    expect(result.id).toBe(3)
    expect(result.rootPid).toBe(100)
    expect(result.atMs).toBe(1_000)
  })

  it('reports null for an enumeration that could not run, never an empty tree', () => {
    const result = sessionResources(1, 100, noProcessSnapshot(2_000, 15))
    expect(result.processes).toBeNull()
    expect(result.ports).toBeNull()
    expect(result.rootSeen).toBe(false)
    expect(result.atMs).toBe(2_000)
  })

  it('tells a session that has exited from a session with no children', () => {
    // The pass ran and the root was not in it.
    const gone = sessionResources(1, 100, snap([proc(1, 0, 'System')]))
    expect(gone.processes).toEqual([])
    expect(gone.rootSeen).toBe(false)

    // The pass ran and the root is there, holding nothing.
    const quiet = sessionResources(1, 100, snap([proc(100, 42, 'claude.exe', 'claude')]))
    expect(quiet.rootSeen).toBe(true)
    expect(quiet.processes).toHaveLength(1)
    expect(quiet.processes?.[0]?.pid).toBe(100)
  })

  it('counts the command lines the host would not give up', () => {
    const result = sessionResources(
      1,
      100,
      snap([
        proc(100, 42, 'claude.exe', 'claude'),
        proc(200, 100, 'svchost.exe', null),
        proc(300, 100, 'audiodg.exe', null)
      ])
    )
    expect(result.opaque).toBe(2)
    expect(result.processes?.map((p) => p.commandLine)).toEqual(['claude', null, null])
  })

  it('never follows pid 0, which is the parent of every reparented process', () => {
    // 900's real parent has exited, so Windows reports 0. Following that edge
    // would make this session's tree the whole machine.
    const result = sessionResources(
      1,
      100,
      snap([
        proc(0, 0, 'System Idle Process'),
        proc(100, 0, 'claude.exe', 'claude'),
        proc(900, 0, 'somebody-elses.exe', 'not mine')
      ])
    )
    expect(result.processes?.map((p) => p.pid)).toEqual([100])
  })

  it('terminates on a process table that contains a cycle', () => {
    // Two rows read at slightly different instants, or a pid reused between
    // them, and the table stops being a tree. The walk is bounded whatever the
    // edges say.
    const result = sessionResources(
      1,
      100,
      snap([proc(100, 200, 'a.exe', 'a'), proc(200, 100, 'b.exe', 'b')])
    )
    expect(result.processes?.map((p) => p.pid)).toEqual([100, 200])
  })

  it('attributes only ports held inside the tree', () => {
    const result = sessionResources(
      1,
      100,
      snap(
        [proc(100, 42, 'claude.exe', 'claude'), proc(200, 100, 'node.exe', 'vite')],
        [
          { pid: 200, port: 5173, address: '127.0.0.1' },
          // Somebody else's dev server on the same port, one pid outside.
          { pid: 999, port: 5173, address: '0.0.0.0' },
          { pid: 200, port: 24678, address: '::1' }
        ]
      )
    )
    expect(result.ports?.map((p) => ({ port: p.port, pid: p.pid }))).toEqual([
      { port: 5173, pid: 200 },
      { port: 24678, pid: 200 }
    ])
    expect(result.ports?.[0]?.process).toBe('node.exe')
  })

  it('collapses one port bound twice into one row keeping both addresses', () => {
    const result = sessionResources(
      1,
      100,
      snap(
        [proc(100, 42, 'claude.exe', 'claude'), proc(200, 100, 'node.exe', 'server')],
        [
          { pid: 200, port: 3000, address: '::' },
          { pid: 200, port: 3000, address: '0.0.0.0' },
          { pid: 200, port: 3000, address: '0.0.0.0' }
        ]
      )
    )
    expect(result.ports).toHaveLength(1)
    expect(result.ports?.[0]?.addresses).toEqual(['0.0.0.0', '::'])
  })

  it('puts the ports on the process holding them', () => {
    const result = sessionResources(
      1,
      100,
      snap(
        [proc(100, 42, 'claude.exe', 'claude'), proc(200, 100, 'node.exe', 'vite')],
        [{ pid: 200, port: 5173, address: '127.0.0.1' }]
      )
    )
    expect(result.processes?.find((p) => p.pid === 100)?.ports).toEqual([])
    expect(result.processes?.find((p) => p.pid === 200)?.ports).toEqual([5173])
  })

  it('leaves per-process ports null when the socket query itself failed', () => {
    // Not `[]`, which would be a claim that nothing in this tree is listening -
    // the exact merge of "could not look" and "nothing there" the shape exists
    // to prevent. The two queries fail independently and are reported so.
    const result = sessionResources(
      1,
      100,
      snap([proc(100, 42, 'claude.exe', 'claude'), proc(200, 100, 'node.exe', 'vite')], null)
    )
    expect(result.processes).toHaveLength(2)
    expect(result.ports).toBeNull()
    for (const process of result.processes ?? []) expect(process.ports).toBeNull()
  })

  it('ignores rows with an impossible pid rather than failing the pass', () => {
    const result = sessionResources(
      1,
      100,
      snap([
        proc(100, 42, 'claude.exe', 'claude'),
        proc(Number.NaN, 100, 'broken.exe', null),
        proc(-1, 100, 'broken.exe', null),
        proc(200, 100, 'node.exe', 'real')
      ])
    )
    expect(result.processes?.map((p) => p.pid)).toEqual([100, 200])
  })
})

describe('liveSessionsIn', () => {
  const live = (cwd: string | null, name: string, helmSessionId: number | null): LiveSession => ({
    statusSinceMs: null,
    helmSessionId,
    pid: 1,
    registered: true,
    cwd,
    name,
    activity: 'idle',
    waitingFor: null,
    version: '2.1.238',
    entrypoint: 'cli',
    startedAtMs: 1,
    claudeSessionId: null
  })

  it('matches on case alone, the way the sidebar groups', () => {
    const sessions = [
      live('C:\\Repos\\Storefront', 'cart work', 7),
      live('C:\\Repos\\other', 'elsewhere', null)
    ]
    expect(liveSessionsIn(sessions, 'c:\\repos\\storefront').map((s) => s.name)).toEqual([
      'cart work'
    ])
  })

  it('finds a session Helm does not host, which is the case the warning exists for', () => {
    const sessions = [live('C:\\Repos\\Storefront', 'terminal session', null)]
    const found = liveSessionsIn(sessions, 'C:\\Repos\\Storefront')
    expect(found).toHaveLength(1)
    expect(found[0]?.helmSessionId).toBeNull()
  })

  it('never counts a session whose directory is unknown as being here', () => {
    expect(liveSessionsIn([live(null, 'no cwd', null)], 'C:\\anywhere')).toEqual([])
  })
})
