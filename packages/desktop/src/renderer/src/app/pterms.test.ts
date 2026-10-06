import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridge } from './bridge.testkit'
import { FakeResizeObserver, layout, type Terminal } from './terminal.testkit'
import { disposeShell, getShell, mountShell, terminalShellKey } from './pterms'

vi.mock('@xterm/xterm', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-fit', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-unicode11', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-webgl', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-serialize', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-web-links', () => import('./terminal.testkit'))
vi.mock('./bridge', () => import('./bridge.testkit'))

/**
 * The project shell registry: one shell per project, outliving every box that
 * shows it, and one shell per box.
 */

const ALPHA = 'C:\\work\\alpha'
const BETA = 'C:\\work\\beta'
const IDS: Record<string, number> = { [ALPHA]: 11, [BETA]: 12 }
const OPTS = { windowsBuild: null, cols: 100, rows: 20 }

function box(): HTMLDivElement {
  const element = document.createElement('div')
  document.body.appendChild(element)
  layout.set(element, { width: 700, height: 350 })
  return element
}

const termOf = (path: string): Terminal => {
  const term = getShell(path)?.term as unknown as Terminal | undefined
  if (term === undefined) throw new Error(`no shell for ${path}`)
  return term
}

beforeEach(() => {
  layout.install()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  bridge.answer('pterm:open', ({ path }) => ({
    id: IDS[path] ?? 99,
    shell: 'C:\\Shells\\pwsh.exe',
    requested: null,
    problem: null
  }))
  bridge.answer('pterm:close', () => undefined)
})

afterEach(async () => {
  await disposeShell(ALPHA)
  await disposeShell(BETA)
  document.body.replaceChildren()
  bridge.reset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('project shells', () => {
  it('hold one terminal per box: another project replaces it, and the first stays alive, detached', async () => {
    const pane = box()
    await mountShell(ALPHA, pane, OPTS)
    await mountShell(BETA, pane, OPTS)

    expect([...pane.children]).toEqual([getShell(BETA)?.element])
    expect(getShell(ALPHA)?.element.isConnected).toBe(false)
    expect(termOf(ALPHA).disposed).toBe(false)
    expect(bridge.invoked('pterm:close')).toEqual([])

    // Its process is still running and its output still lands.
    bridge.emit('pterm:data', { id: IDS[ALPHA] ?? 0, data: 'built in 2.1s' })
    expect(termOf(ALPHA).written).toContain('built in 2.1s')

    // Shown again, the same shell comes back rather than a second one.
    await mountShell(ALPHA, pane, OPTS)
    expect([...pane.children]).toEqual([getShell(ALPHA)?.element])
    expect(bridge.invoked('pterm:open').map((request) => request.path)).toEqual([ALPHA, BETA])
  })

  it('end only when their project closes, and then for good', async () => {
    await mountShell(ALPHA, box(), OPTS)
    const term = termOf(ALPHA)

    await disposeShell(ALPHA)

    expect(term.disposed).toBe(true)
    expect(getShell(ALPHA)).toBeUndefined()
    expect(bridge.invoked('pterm:close')).toEqual([{ id: IDS[ALPHA] }])
  })
})

describe('terminal tabs', () => {
  it('get a shell each, separate from the project’s, and end with their tab alone', async () => {
    let next = 20
    bridge.answer('pterm:open', () => ({ id: next++, shell: 'C:\\Shells\\pwsh.exe', requested: null, problem: null }))
    await mountShell(ALPHA, box(), OPTS)
    await mountShell(ALPHA, box(), { ...OPTS, key: terminalShellKey(1) })
    await mountShell(ALPHA, box(), { ...OPTS, key: terminalShellKey(2) })

    expect(bridge.invoked('pterm:open')).toEqual([
      { path: ALPHA, cols: 100, rows: 20 },
      { path: ALPHA, cols: 100, rows: 20, separate: true },
      { path: ALPHA, cols: 100, rows: 20, separate: true }
    ])
    expect(new Set([getShell(ALPHA), getShell(terminalShellKey(1)), getShell(terminalShellKey(2))]).size).toBe(3)

    await disposeShell(terminalShellKey(1))
    expect(bridge.invoked('pterm:close')).toEqual([{ id: 21 }])
    expect(getShell(ALPHA)).toBeDefined()
    expect(getShell(terminalShellKey(2))).toBeDefined()
    await disposeShell(terminalShellKey(2))
  })
})
