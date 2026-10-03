import { fireEvent, render, screen } from '@testing-library/react'
import { useRef, type JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { layout } from './terminal.testkit'
import { usePaneSplit } from './paneSplit'

/**
 * The divider between two panes. The boundary is `--split` on the row - the
 * second pane's share of it - and a drag writes that property and nothing
 * else until it lands, when it writes the setting once.
 *
 * The row here is the app's in miniature: two columns either side of the
 * divider, with the hook App uses. jsdom does no layout, so the row's box is
 * declared and the boundary is read off the property the CSS lays out from.
 */

/** The row spans x = 100 to 1100. */
const ROW = { left: 100, top: 0, width: 1000, height: 600 }

let renders = 0

function SplitRow({ saved, write }: { saved: number; write: (patch: { paneSplitPct: number }) => void }): JSX.Element {
  renders++
  const rowRef = useRef<HTMLDivElement>(null)
  const startDrag = usePaneSplit(rowRef, saved, write)
  return (
    <div ref={rowRef} role="group" aria-label="Panes">
      <section aria-label="First pane">
        <ul aria-label="History">
          <li>yesterday</li>
        </ul>
      </section>
      <div role="separator" aria-orientation="vertical" aria-label="Resize the panes" onMouseDown={startDrag} />
      <section aria-label="Second pane" />
    </div>
  )
}

const row = (): HTMLElement => screen.getByRole('group', { name: 'Panes' })
const divider = (): HTMLElement => screen.getByRole('separator', { name: 'Resize the panes' })
const split = (): number => Number(row().style.getPropertyValue('--split'))

const grab = (): boolean => fireEvent.mouseDown(divider(), { clientX: 650, buttons: 1 })
const moveTo = (clientX: number, buttons = 1): boolean => fireEvent.mouseMove(window, { clientX, buttons })
const letGo = (clientX: number): boolean => fireEvent.mouseUp(window, { clientX })

function renderRow(saved = 45): { write: ReturnType<typeof vi.fn>; rerender: (saved: number) => void } {
  const write = vi.fn()
  const view = render(<SplitRow saved={saved} write={write} />)
  layout.set(row(), ROW)
  return { write, rerender: (next) => view.rerender(<SplitRow saved={next} write={write} />) }
}

beforeEach(() => {
  layout.install()
  renders = 0
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the pane divider', () => {
  it('lays the second pane out at the remembered share, and follows the setting', () => {
    const { rerender } = renderRow(62)
    expect(split()).toBe(0.62)

    rerender(30)
    expect(split()).toBe(0.3)
  })

  it('tracks the pointer while the button is held, and writes once when it lands', () => {
    const { write } = renderRow()

    grab()
    moveTo(600)
    // The pointer is 500px from the row's right edge: half the row.
    expect(split()).toBeCloseTo(0.5, 10)
    moveTo(752)
    // 348px of 1000 to the pointer's right is the second pane's share.
    expect(split()).toBeCloseTo(0.348, 10)
    expect(write).not.toHaveBeenCalled()

    letGo(752)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith({ paneSplitPct: 35 })
    // Snapped to what the setting holds, so its echo moves nothing.
    expect(split()).toBe(0.35)
  })

  it('keeps both panes at least a fifth of the row', () => {
    const { write } = renderRow()

    grab()
    moveTo(1090)
    expect(split()).toBeCloseTo(0.2, 10)
    moveTo(110)
    expect(split()).toBeCloseTo(0.8, 10)
    letGo(110)

    expect(write.mock.calls).toEqual([[{ paneSplitPct: 80 }]])
  })

  it('writes nothing for a press that never moved, or a drag that landed where it started', () => {
    const { write } = renderRow(45)

    grab()
    letGo(650)
    grab()
    moveTo(800)
    moveTo(650) // 450px of 1000: the 45 it was
    letGo(650)

    expect(write).not.toHaveBeenCalled()
  })

  it('stops following once a move arrives with no button held', () => {
    renderRow()

    grab()
    moveTo(600)
    // Released outside the window: no mouseup ever arrives, only a bare move.
    moveTo(700, 0)
    moveTo(900)

    expect(split()).toBeCloseTo(0.5, 10)
  })

  it('ignores the pointer when no drag is running', () => {
    const { write } = renderRow(45)

    moveTo(600)
    letGo(600)

    expect(split()).toBe(0.45)
    expect(write).not.toHaveBeenCalled()
  })

  it('is not moved by the setting changing underneath a drag', () => {
    const { rerender } = renderRow(45)

    grab()
    moveTo(600)
    rerender(70)

    expect(split()).toBeCloseTo(0.5, 10)
  })

  it('writes only the row’s --split while dragging: no attribute on either column, no render', () => {
    renderRow()
    const rendered = renders
    const changes: MutationRecord[] = []
    const observer = new MutationObserver((records) => changes.push(...records))
    observer.observe(row(), { attributes: true, childList: true, subtree: true, characterData: true })

    grab()
    moveTo(600)
    moveTo(700)
    moveTo(800)
    changes.push(...observer.takeRecords())
    observer.disconnect()

    expect(changes.length).toBeGreaterThan(0)
    for (const change of changes) {
      expect(change.type).toBe('attributes')
      expect(change.target).toBe(row())
      expect(change.attributeName).toBe('style')
    }
    expect(row().getAttribute('style')).toMatch(/^--split: [\d.]+;?$/)
    expect(renders).toBe(rendered)
  })
})
