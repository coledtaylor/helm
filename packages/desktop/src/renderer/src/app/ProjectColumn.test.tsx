import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridge } from './bridge.testkit'
import { FakeResizeObserver, layout, type Terminal } from './terminal.testkit'
import { ProjectColumn, type ProjectColumnProps } from './ProjectColumn'
import { disposeShell, getShell } from './pterms'

vi.mock('@xterm/xterm', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-fit', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-unicode11', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-webgl', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-serialize', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-web-links', () => import('./terminal.testkit'))
vi.mock('./bridge', () => import('./bridge.testkit'))

/**
 * A project's page over its shell, and the handle between them.
 *
 * The drag moves the shell's own height between renders and writes the setting
 * once when it lands, so these drive it with pointer events against a column
 * whose box the test declares - jsdom does no layout - and read the height the
 * drag put on the shell.
 */

const ALPHA = 'C:\\work\\alpha'
const BETA = 'C:\\work\\beta'
const IDS: Record<string, number> = { [ALPHA]: 21, [BETA]: 22 }

/** The column is 1000px tall; at 30% the shell's top edge is at 700. */
const COLUMN = { top: 0, left: 0, width: 800, height: 1000 }
const HANDLE = { top: 692, left: 0, width: 800, height: 8 }

function renderColumn(overrides: Partial<ProjectColumnProps> = {}): {
  props: ProjectColumnProps
  rerender: (next: Partial<ProjectColumnProps>) => void
} {
  const props: ProjectColumnProps = {
    path: ALPHA,
    windowsBuild: null,
    shells: [],
    heightPct: 30,
    onHeightChange: vi.fn(),
    children: <h1>alpha</h1>,
    ...overrides
  }
  const view = render(<ProjectColumn {...props} />)
  return { props, rerender: (next) => view.rerender(<ProjectColumn {...props} {...next} />) }
}

const handle = (): HTMLElement => screen.getByRole('separator', { name: 'Resize the shell' })

/** The shell's island: the thing the handle is above. */
const shell = (): HTMLElement => {
  const island = handle().nextElementSibling
  if (!(island instanceof HTMLElement)) throw new Error('no shell under the handle')
  return island
}

/** Puts the column and the handle where a 30% shell would have them. */
function layOut(): void {
  const column = handle().parentElement
  if (column === null) throw new Error('no column')
  layout.set(column, COLUMN)
  layout.set(handle(), HANDLE)
}

const press = (clientY: number): boolean => fireEvent.pointerDown(handle(), { pointerId: 1, clientY, buttons: 1 })
const drag = (clientY: number): boolean => fireEvent.pointerMove(handle(), { pointerId: 1, clientY, buttons: 1 })
const release = (clientY: number): boolean => fireEvent.pointerUp(handle(), { pointerId: 1, clientY })

/** jsdom has no pointer capture; this keeps the one fact the drag reads. */
function stubPointerCapture(): void {
  const captured = new WeakMap<Element, Set<number>>()
  const held = (element: Element): Set<number> => {
    let set = captured.get(element)
    if (set === undefined) {
      set = new Set()
      captured.set(element, set)
    }
    return set
  }
  Object.assign(Element.prototype, {
    setPointerCapture(this: Element, id: number) {
      held(this).add(id)
    },
    releasePointerCapture(this: Element, id: number) {
      held(this).delete(id)
    },
    hasPointerCapture(this: Element, id: number) {
      return held(this).has(id)
    }
  })
}

beforeEach(() => {
  layout.install()
  stubPointerCapture()
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
  const prototype = Element.prototype as unknown as Record<string, unknown>
  delete prototype['setPointerCapture']
  delete prototype['releasePointerCapture']
  delete prototype['hasPointerCapture']
  bridge.reset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the shell handle', () => {
  it('stops at half the column and at the 180px floor, and writes once when it lands', async () => {
    const { props } = renderColumn()
    await waitFor(() => expect(getShell(ALPHA)).toBeDefined())
    layOut()
    expect(shell().style.height).toBe('30%')

    // Grabbed 4px above the handle's bottom edge, which stays under the pointer.
    press(696)
    drag(496) // top edge at 500: 500px of 1000
    expect(shell().style.height).toBe('50%')
    drag(196) // top edge at 200 would be 800px: held at half the column
    expect(shell().style.height).toBe('50%')
    drag(896) // top edge at 900 would be 100px: held at the 180px floor
    expect(shell().style.height).toBe('18%')
    drag(646) // top edge at 650: 350px
    expect(shell().style.height).toBe('35%')
    expect(props.onHeightChange).not.toHaveBeenCalled()

    release(646)
    expect(props.onHeightChange).toHaveBeenCalledTimes(1)
    expect(props.onHeightChange).toHaveBeenCalledWith(35)
  })

  it('refits the shell as the drag moves it, and only when the height changed', async () => {
    renderColumn()
    await waitFor(() => expect(getShell(ALPHA)).toBeDefined())
    layOut()
    const host = getShell(ALPHA)
    if (host === undefined) throw new Error('no shell')
    const refit = vi.spyOn(host, 'refit')

    press(696)
    drag(496)
    drag(196) // still 50%: nothing moved
    drag(646)
    release(646)

    expect(refit).toHaveBeenCalledTimes(2)
  })

  it('writes nothing for a press that never moved, or a drag that came back', async () => {
    const { props } = renderColumn()
    await waitFor(() => expect(getShell(ALPHA)).toBeDefined())
    layOut()

    press(696)
    release(696)
    press(696)
    drag(496)
    drag(696) // back to the 30% it started at
    release(696)

    expect(props.onHeightChange).not.toHaveBeenCalled()
  })

  it('ignores a move that is not part of a drag', async () => {
    const { props } = renderColumn()
    await waitFor(() => expect(getShell(ALPHA)).toBeDefined())
    layOut()

    drag(496)
    release(496)

    expect(shell().style.height).toBe('30%')
    expect(props.onHeightChange).not.toHaveBeenCalled()
  })

  it('puts the shell back to the 30% default on a double-click', async () => {
    const { props } = renderColumn({ heightPct: 45 })
    await waitFor(() => expect(getShell(ALPHA)).toBeDefined())

    fireEvent.doubleClick(handle())

    expect(props.onHeightChange).toHaveBeenCalledTimes(1)
    expect(props.onHeightChange).toHaveBeenCalledWith(30)
  })
})

describe('switching project', () => {
  it('shows only the new project’s shell, and leaves the old one running', async () => {
    const { rerender } = renderColumn()
    await waitFor(() => expect(getShell(ALPHA)).toBeDefined())
    const alpha = getShell(ALPHA)

    rerender({ path: BETA, children: <h1>beta</h1> })
    await waitFor(() => expect(getShell(BETA)).toBeDefined())

    expect(getShell(BETA)?.element.isConnected).toBe(true)
    expect(shell().contains(getShell(BETA)?.element ?? null)).toBe(true)
    expect(alpha?.element.isConnected).toBe(false)
    expect((alpha?.term as unknown as Terminal).disposed).toBe(false)
    expect(bridge.invoked('pterm:close')).toEqual([])
  })
})
