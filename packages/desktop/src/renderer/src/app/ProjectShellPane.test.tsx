import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type DetectedShell } from '@helm/core/types'
import { bridge } from './bridge.testkit'
import { FakeResizeObserver, layout } from './terminal.testkit'
import { ProjectShellPane } from './ProjectShellPane'
import { disposeShell } from './pterms'
import { applyTerminalSettings } from './termprefs'

vi.mock('@xterm/xterm', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-fit', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-unicode11', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-webgl', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-serialize', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-web-links', () => import('./terminal.testkit'))
vi.mock('./bridge', () => import('./bridge.testkit'))

/**
 * A project shell's pane: the grid its pty is opened at, and the header's
 * picker, which runs a different shell in this pane and no other.
 */

const ALPHA = 'C:\\work\\alpha'
const BETA = 'C:\\work\\beta'
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'
const SHELLS: DetectedShell[] = [
  { path: PWSH, name: 'pwsh.exe', label: 'PowerShell 7', args: ['-NoLogo'] },
  { path: BASH, name: 'bash.exe', label: 'Bash', args: [] }
]

function box(label: string): HTMLElement {
  const element = document.createElement('section')
  element.setAttribute('aria-label', label)
  document.body.appendChild(element)
  layout.set(element, { width: 1000, height: 600 })
  return element
}

let nextId = 1

beforeEach(() => {
  layout.install()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true })
  // Main's answer: the pane's own pick if it made one, the default otherwise.
  bridge.answer('pterm:open', ({ shell }) => ({
    id: nextId++,
    shell: shell ?? PWSH,
    requested: null,
    problem: null
  }))
  bridge.answer('pterm:close', () => undefined)
})

afterEach(async () => {
  await disposeShell(ALPHA)
  await disposeShell(BETA)
  document.body.replaceChildren()
  applyTerminalSettings(DEFAULT_SETTINGS)
  layout.text(null)
  bridge.reset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ProjectShellPane', () => {
  it('opens its pty at a grid estimated in the configured font size', async () => {
    // What the font measures here: 11.72px across and 23.4px down at 20px.
    layout.text((element) =>
      element.textContent === 'W'.repeat(32) && element.style.fontSize === '20px'
        ? { width: 11.72 * 32, height: 23.4 }
        : null
    )
    applyTerminalSettings({ ...DEFAULT_SETTINGS, terminalFontSize: 20 })

    render(<ProjectShellPane path={ALPHA} windowsBuild={null} visible shells={SHELLS} heightPct={30} />, {
      container: box('alpha')
    })

    // An 11px cell (floored) and a 24px row (rounded up) in a 1000x600 box,
    // less the 14px ruler: 986 / 11 = 89.6 and 600 / 24 = 25.
    await waitFor(() => expect(bridge.invoked('pterm:open')).toEqual([{ path: ALPHA, cols: 89, rows: 25 }]))
  })

  it('runs a picked shell in that pane only; the others keep the default', async () => {
    const user = userEvent.setup()
    const alpha = box('alpha')
    const beta = box('beta')
    render(<ProjectShellPane path={ALPHA} windowsBuild={null} visible shells={SHELLS} heightPct={30} />, {
      container: alpha
    })
    render(<ProjectShellPane path={BETA} windowsBuild={null} visible shells={SHELLS} heightPct={30} />, {
      container: beta
    })
    await within(alpha).findByTitle(PWSH)
    await within(beta).findByTitle(PWSH)
    const opened = bridge.invoked('pterm:open')
    expect(opened.map((request) => [request.path, request.shell])).toEqual([
      [ALPHA, undefined],
      [BETA, undefined]
    ])

    await user.selectOptions(within(alpha).getByRole('combobox', { name: 'Shell for this pane' }), 'bash.exe')

    await within(alpha).findByTitle(BASH)
    expect(within(beta).getByTitle(PWSH)).toBeDefined()
    // A shell cannot become another program: alpha's is closed and reopened,
    // and beta's is never touched.
    expect(bridge.invoked('pterm:close')).toHaveLength(1)
    expect(bridge.invoked('pterm:open').slice(2).map((request) => [request.path, request.shell])).toEqual([
      [ALPHA, BASH]
    ])

    // "Default" goes back to whatever the setting says, by asking for nothing.
    await user.selectOptions(within(alpha).getByRole('combobox', { name: 'Shell for this pane' }), 'Default')
    await within(alpha).findByTitle(PWSH)
    expect(bridge.invoked('pterm:open').at(-1)).not.toHaveProperty('shell')
    expect(screen.getAllByTitle(PWSH)).toHaveLength(2)
  })
})
