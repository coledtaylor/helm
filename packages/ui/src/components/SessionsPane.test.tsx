import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { LiveSession, SessionProcess, SessionRecord, SessionResources } from '@helm/core'
import { SessionsPane, type SessionsPaneProps } from './SessionsPane'

function live(over: Partial<LiveSession> & Pick<LiveSession, 'pid'>): LiveSession {
  return {
    helmSessionId: null,
    registered: true,
    cwd: null,
    name: null,
    activity: 'idle',
    waitingFor: null,
    statusSinceMs: null,
    version: '2.1.999',
    entrypoint: 'cli',
    startedAtMs: Date.now() - 60_000,
    claudeSessionId: null,
    ...over
  }
}

function row(id: number, name: string, cwd: string): SessionRecord {
  return {
    id,
    name,
    label: null,
    cwd,
    branch: 'main',
    projectPath: cwd,
    profileId: null,
    argv: ['-n', name],
    claudeSessionId: null,
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: null,
    exitCode: null
  }
}

function proc(pid: number, parentPid: number, name: string, depth: number, ports: number[] | null = []): SessionProcess {
  return { pid, parentPid, name, commandLine: `${name} --flag`, depth, ports }
}

const SHOP = live({ helmSessionId: 1, pid: 4100, cwd: 'C:\\work\\shop', name: 'shop' })
const DOCS = live({ helmSessionId: 2, pid: 4200, cwd: 'C:\\work\\docs', name: 'docs', activity: 'busy' })
const QUIET = live({ helmSessionId: 3, pid: 4300, cwd: 'C:\\work\\quiet', name: 'quiet' })
const OUTSIDE = live({
  pid: 5100,
  cwd: 'C:\\work\\api',
  name: 'terminal session',
  activity: 'waiting',
  waitingFor: 'dialog open'
})

const RESOURCES: [number, SessionResources][] = [
  [
    1,
    {
      id: 1,
      rootPid: 300,
      processes: [proc(300, 4, 'cmd.exe', 0), proc(301, 300, 'node.exe', 1, [5173])],
      rootSeen: true,
      ports: [{ port: 5173, pid: 301, process: 'node.exe', addresses: ['127.0.0.1'] }],
      opaque: 0,
      atMs: 1_000
    }
  ],
  [
    2,
    {
      id: 2,
      rootPid: 400,
      processes: [proc(400, 4, 'cmd.exe', 0), proc(401, 400, 'python.exe', 1, [8000])],
      rootSeen: true,
      ports: [{ port: 8000, pid: 401, process: 'python.exe', addresses: ['0.0.0.0'] }],
      opaque: 0,
      atMs: 1_000
    }
  ],
  [3, { id: 3, rootPid: 500, processes: [proc(500, 4, 'cmd.exe', 0)], rootSeen: true, ports: [], opaque: 0, atMs: 1_000 }]
]

function renderPane(overrides: Partial<SessionsPaneProps> = {}): SessionsPaneProps {
  const props: SessionsPaneProps = {
    sessions: [SHOP, DOCS, QUIET, OUTSIDE],
    readAtMs: Date.now(),
    records: new Map([
      [1, row(1, 'shop', 'C:\\work\\shop')],
      [2, row(2, 'docs', 'C:\\work\\docs')],
      [3, row(3, 'quiet', 'C:\\work\\quiet')]
    ]),
    resources: new Map(RESOURCES),
    selectedPid: null,
    onSelect: vi.fn(),
    onOpenSession: vi.fn(),
    onReveal: vi.fn(),
    ...overrides
  }
  render(<SessionsPane {...props} />)
  return props
}

const items = (region: HTMLElement): string[] =>
  within(region)
    .queryAllByRole('listitem')
    .map((item) => item.textContent ?? '')

describe('SessionsPane', () => {
  it('lists Helm’s sessions and everything else on the machine apart, each with its own folder', async () => {
    const props = renderPane()
    const inHelm = screen.getByRole('region', { name: 'In Helm' })
    const elsewhere = screen.getByRole('region', { name: 'Elsewhere on this machine' })

    const hosted = within(inHelm).getAllByRole('button')
    expect(hosted).toHaveLength(3)
    for (const [i, session] of [SHOP, DOCS, QUIET].entries()) {
      expect(hosted[i]?.textContent).toContain(session.name)
      expect(hosted[i]?.textContent).toContain(session.cwd)
    }

    const outside = within(elsewhere).getByRole('button', { name: /^terminal session/ })
    expect(outside.textContent).toContain('C:\\work\\api')
    expect(within(inHelm).queryByRole('button', { name: /^terminal session/ })).toBeNull()

    await userEvent.click(outside)
    expect(props.onSelect).toHaveBeenCalledWith(OUTSIDE)
  })

  it('shows a hosted session’s own children and ports, and nothing of another session’s', async () => {
    const props = renderPane({ selectedPid: SHOP.pid })
    expect(screen.getByRole('heading', { level: 2, name: 'shop' })).toBeDefined()

    const tree = screen.getByRole('region', { name: 'Process tree' })
    expect(items(tree)).toEqual([
      expect.stringMatching(/^cmd\.exe300/),
      expect.stringMatching(/^node\.exe301:5173/)
    ])
    const ports = screen.getByRole('region', { name: 'Listening ports' })
    expect(items(ports)).toHaveLength(1)
    expect(items(ports)[0]).toContain('5173')
    expect(items(ports)[0]).toContain('loopback')
    for (const text of [...items(tree), ...items(ports)]) {
      expect(text).not.toContain('python.exe')
      expect(text).not.toContain('8000')
    }

    await userEvent.click(screen.getByRole('button', { name: 'Show the terminal' }))
    expect(props.onOpenSession).toHaveBeenCalledWith(1)
  })

  it('says a session with no children is running nothing but itself, and draws no tree rows', () => {
    renderPane({ selectedPid: QUIET.pid })
    const tree = screen.getByRole('region', { name: 'Process tree' })
    expect(items(tree)).toEqual([])
    expect(tree.textContent).toContain('Nothing but the session itself was running')
  })

  it('says unknown for both the tree and the ports when the machine could not be asked, never nothing', () => {
    const [, shop] = RESOURCES[0] as [number, SessionResources]
    renderPane({
      selectedPid: SHOP.pid,
      resources: new Map([[1, { ...shop, processes: null, rootSeen: false, ports: null }]])
    })
    const tree = screen.getByRole('region', { name: 'Process tree' })
    const ports = screen.getByRole('region', { name: 'Listening ports' })
    expect(tree.textContent).toContain('Unknown')
    expect(tree.textContent).not.toContain('Nothing but the session itself')
    expect(ports.textContent).toContain('Unknown')
    expect(ports.textContent).not.toContain('is listening')
  })

  it('says unknown for the ports alone when only the socket query failed', () => {
    const [, shop] = RESOURCES[0] as [number, SessionResources]
    renderPane({
      selectedPid: SHOP.pid,
      resources: new Map([
        [1, { ...shop, ports: null, processes: (shop.processes ?? []).map((p) => ({ ...p, ports: null })) }]
      ])
    })
    const tree = screen.getByRole('region', { name: 'Process tree' })
    const ports = screen.getByRole('region', { name: 'Listening ports' })
    expect(items(tree)).toHaveLength(2)
    expect(tree.textContent).not.toContain('Unknown')
    expect(ports.textContent).toContain('Unknown')
    expect(items(ports)).toEqual([])
  })

  it('says what is knowable about a session Helm did not start, and no more', () => {
    renderPane({ selectedPid: OUTSIDE.pid })
    expect(screen.getByRole('heading', { level: 2, name: 'terminal session' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'C:\\work\\api' })).toBeDefined()
    expect(screen.getByRole('region', { name: 'What Helm knows' }).textContent).toContain(
      'Helm did not start this session'
    )
    expect(screen.queryByRole('region', { name: 'Process tree' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Listening ports' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Show the terminal' })).toBeNull()
  })
})
