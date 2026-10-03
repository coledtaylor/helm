import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_INVENTORY, type DiscoveryResult, type Project } from '@helm/core/types'
import { SessionTree, type SessionTreeProps, type TreeReveal, type TreeSession } from './SessionTree'

/**
 * A tab clicked asks the tree for its row: whatever is folded over it opens,
 * and the tree scrolls to it.
 */

const ZETA = 'C:\\work\\north\\repos\\zeta'

const project = (path: string): Project => ({
  path,
  name: path.split('\\').pop() ?? path,
  kind: 'repo',
  harnessPath: 'C:\\work\\north',
  hasClaudeDir: false,
  inventory: EMPTY_INVENTORY,
  git: null
})

const DISCOVERY: DiscoveryResult = {
  roots: ['C:\\work'],
  harnesses: [{ path: 'C:\\work\\north', name: 'north', template: null, version: null, repoPaths: [ZETA] }],
  projects: [project(ZETA)],
  errors: [],
  scannedAt: '2026-10-03T00:00:00.000Z',
  durationMs: 1
}

const session = (shown: TreeSession['shown']): TreeSession => ({
  id: 'session:7',
  label: 'review',
  state: 'idle',
  note: '',
  hint: ZETA,
  outside: false,
  shown
})

let scrolled: string[] = []
const scrollIntoView = Element.prototype.scrollIntoView
beforeEach(() => {
  scrolled = []
  Element.prototype.scrollIntoView = function record(this: Element) {
    scrolled.push(this.getAttribute('aria-label') ?? this.getAttribute('title') ?? '')
  }
})
afterEach(() => {
  Element.prototype.scrollIntoView = scrollIntoView
})

function renderTree(shown: TreeSession['shown'], reveal: TreeReveal | null) {
  const props: SessionTreeProps = {
    discovery: DISCOVERY,
    scanning: false,
    selectedPath: null,
    pinnedPaths: [],
    onTogglePin: vi.fn(),
    sessionsByPath: new Map([[ZETA.toLowerCase(), [session(shown)]]]),
    elsewhere: [],
    onSelect: vi.fn(),
    onLaunch: vi.fn(),
    launchingPath: null,
    onOpenSession: vi.fn(),
    onAddRoot: vi.fn(),
    reveal
  }
  const view = render(<SessionTree {...props} />)
  return (next: Partial<SessionTreeProps>) => view.rerender(<SessionTree {...props} {...next} />)
}

const sessionRow = () => screen.queryByRole('button', { name: 'review, ready' })

describe('SessionTree: revealing a row', () => {
  it('opens the harness and the project folded over a session, and scrolls to it', async () => {
    const rerender = renderTree(null, null)
    await userEvent.click(screen.getByRole('button', { name: 'Fold the sessions in zeta' }))
    await userEvent.click(screen.getByRole('button', { name: 'north, 1 project' }))
    expect(sessionRow()).toBeNull()

    // The session's tab is clicked: it is in front, and asked for.
    rerender({
      sessionsByPath: new Map([[ZETA.toLowerCase(), [session('focused')]]]),
      reveal: { seq: 1, kind: 'session', id: 'session:7' }
    })
    expect(sessionRow()?.getAttribute('aria-current')).toBe('true')
    expect(scrolled).toEqual(['review, ready'])
  })

  it('asks once per request, so folding the row again afterwards holds', async () => {
    const reveal: TreeReveal = { seq: 1, kind: 'session', id: 'session:7' }
    const rerender = renderTree('focused', reveal)
    await userEvent.click(screen.getByRole('button', { name: 'Fold the sessions in zeta' }))
    rerender({ reveal })
    expect(sessionRow()).toBeNull()

    rerender({ reveal: { ...reveal, seq: 2 } })
    expect(sessionRow()).not.toBeNull()
  })

  it('opens the Pinned section over a pinned project’s session', async () => {
    const rerender = renderTree(null, null)
    rerender({ pinnedPaths: [ZETA] })
    await userEvent.click(screen.getByRole('button', { name: 'Pinned, 1 project' }))
    expect(sessionRow()).toBeNull()

    rerender({
      pinnedPaths: [ZETA],
      sessionsByPath: new Map([[ZETA.toLowerCase(), [session('focused')]]]),
      reveal: { seq: 1, kind: 'session', id: 'session:7' }
    })
    expect(sessionRow()?.getAttribute('aria-current')).toBe('true')
  })

  it('opens the harness a project page belongs to', async () => {
    const rerender = renderTree(null, null)
    await userEvent.click(screen.getByRole('button', { name: 'north, 1 project' }))
    expect(screen.queryAllByTitle(ZETA)).toHaveLength(0)

    rerender({ selectedPath: ZETA, reveal: { seq: 1, kind: 'project', path: ZETA } })
    const current = document.querySelectorAll('[aria-current="true"]')
    expect([...current].map((row) => row.getAttribute('title'))).toEqual([ZETA])
    expect(scrolled).toEqual([ZETA])
  })
})
