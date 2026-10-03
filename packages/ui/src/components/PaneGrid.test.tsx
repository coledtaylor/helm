import type { JSX } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneNode } from '@helm/core/types'
import { PANES_MOVED_EVENT } from '../lib/paneGeometry'
import { PaneGrid } from './PaneGrid'

const ROW: PaneNode = { axis: 'row', children: [{ group: 1 }, { group: 2 }], sizes: [0.5, 0.5] }

/** The box every pane is placed in: jsdom lays nothing out, so its size is given. */
let width = 1006
let height = 600

beforeEach(() => {
  width = 1006
  height = 600
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function panesFor(root: PaneNode): Map<number, JSX.Element> {
  const ids: number[] = []
  const walk = (node: PaneNode): void => {
    if ('axis' in node) node.children.forEach(walk)
    else ids.push(node.group)
  }
  walk(root)
  return new Map(ids.map((id) => [id, <section key={id} aria-label={`pane ${String(id)}`} />]))
}

function renderGrid(root: PaneNode, onResize = vi.fn(), maximized: number | null = null) {
  const view = render(<PaneGrid root={root} maximized={maximized} gap={6} panes={panesFor(root)} onResize={onResize} />)
  return {
    ...view,
    onResize,
    slot: (id: number) => view.container.querySelector<HTMLElement>(`[data-pane-slot="${String(id)}"]`)!,
    rerenderWith: (next: PaneNode, nextMax: number | null = null) =>
      view.rerender(<PaneGrid root={next} maximized={nextMax} gap={6} panes={panesFor(next)} onResize={onResize} />)
  }
}

describe('PaneGrid', () => {
  it('places every pane and a divider in each gutter, in pixels, and says it has', () => {
    const moved = vi.fn()
    window.addEventListener(PANES_MOVED_EVENT, moved)
    const { slot } = renderGrid(ROW)
    window.removeEventListener(PANES_MOVED_EVENT, moved)

    expect(slot(1).style).toMatchObject({ left: '0px', top: '0px', width: '500px', height: '600px' })
    expect(slot(2).style).toMatchObject({ left: '506px', width: '500px' })
    const divider = screen.getByRole('separator')
    expect(divider.getAttribute('aria-orientation')).toBe('vertical')
    expect(divider.style).toMatchObject({ left: '500px', width: '6px' })
    expect(moved).toHaveBeenCalled()
  })

  it('stands a column’s divider on its side', () => {
    renderGrid({ axis: 'column', children: [{ group: 1 }, { group: 2 }], sizes: [0.5, 0.5] })
    expect(screen.getByRole('separator').getAttribute('aria-orientation')).toBe('horizontal')
  })

  it('never remounts a pane when the tree is split around it', () => {
    const { slot, rerenderWith } = renderGrid(ROW)
    const second = slot(2)
    const inside = second.firstElementChild

    rerenderWith({
      axis: 'row',
      children: [{ group: 1 }, { axis: 'column', children: [{ group: 2 }, { group: 3 }], sizes: [0.5, 0.5] }],
      sizes: [0.5, 0.5]
    })

    expect(slot(2)).toBe(second)
    expect(slot(2).firstElementChild).toBe(inside)
    expect(slot(2).style).toMatchObject({ top: '0px', height: '297px' })
    expect(slot(3).style).toMatchObject({ top: '303px', height: '297px' })
  })

  it('moves the boxes with the pointer and writes the shares once, on release', () => {
    const { slot, onResize } = renderGrid(ROW)
    const divider = screen.getByRole('separator')

    fireEvent.mouseDown(divider, { button: 0, clientX: 503 })
    fireEvent.mouseMove(window, { buttons: 1, clientX: 603 })
    fireEvent.mouseMove(window, { buttons: 1, clientX: 703 })

    expect(slot(1).style.width).toBe('700px')
    expect(slot(2).style).toMatchObject({ left: '706px', width: '300px' })
    expect(onResize).not.toHaveBeenCalled()

    fireEvent.mouseUp(window)
    expect(onResize).toHaveBeenCalledTimes(1)
    expect(onResize.mock.calls[0]![0]).toEqual([])
    expect(onResize.mock.calls[0]![1][0]).toBeCloseTo(0.7)
  })

  it('keeps a drag going through a new copy of the same tree, and through a change elsewhere', () => {
    const { slot, rerenderWith, onResize } = renderGrid(ROW)
    fireEvent.mouseDown(screen.getByRole('separator'), { button: 0, clientX: 503 })
    fireEvent.mouseMove(window, { buttons: 1, clientX: 603 })

    // The settings write after a drop comes back as a new object, same panes.
    rerenderWith(JSON.parse(JSON.stringify(ROW)) as PaneNode)
    expect(slot(1).style.width).toBe('600px')
    // A pane split elsewhere: the divider being held is still the root's.
    rerenderWith({
      axis: 'row',
      children: [{ group: 1 }, { axis: 'column', children: [{ group: 2 }, { group: 3 }], sizes: [0.5, 0.5] }],
      sizes: [0.5, 0.5]
    })
    fireEvent.mouseMove(window, { buttons: 1, clientX: 703 })
    expect(slot(1).style.width).toBe('700px')

    fireEvent.mouseUp(window)
    expect(onResize).toHaveBeenCalledTimes(1)
    expect(onResize.mock.calls[0]![1][0]).toBeCloseTo(0.7)
  })

  it('ends a drag whose divider has gone', () => {
    const { rerenderWith, onResize } = renderGrid(ROW)
    fireEvent.mouseDown(screen.getByRole('separator'), { button: 0, clientX: 503 })
    fireEvent.mouseMove(window, { buttons: 1, clientX: 603 })
    rerenderWith({ group: 1 })
    fireEvent.mouseUp(window)
    expect(onResize).not.toHaveBeenCalled()
  })

  it('stops a pane at its minimum, and writes nothing for a press that never moved', () => {
    const { slot, onResize } = renderGrid(ROW)
    const divider = screen.getByRole('separator')

    fireEvent.mouseDown(divider, { button: 0, clientX: 503 })
    fireEvent.mouseMove(window, { buttons: 1, clientX: 5 })
    expect(slot(1).style.width).toBe('200px')
    fireEvent.mouseUp(window)
    expect(onResize).toHaveBeenCalledTimes(1)

    fireEvent.mouseDown(divider, { button: 0, clientX: 203 })
    fireEvent.mouseUp(window)
    expect(onResize).toHaveBeenCalledTimes(1)
  })

  it('takes a move with no button held as a release outside the window', () => {
    const { onResize } = renderGrid(ROW)
    fireEvent.mouseDown(screen.getByRole('separator'), { button: 0, clientX: 503 })
    fireEvent.mouseMove(window, { buttons: 1, clientX: 553 })
    fireEvent.mouseMove(window, { buttons: 0, clientX: 600 })
    expect(onResize).toHaveBeenCalledTimes(1)
    fireEvent.mouseMove(window, { buttons: 1, clientX: 700 })
    expect(onResize).toHaveBeenCalledTimes(1)
  })

  it('shares a split evenly on a double-click', () => {
    const { onResize } = renderGrid({ axis: 'row', children: [{ group: 1 }, { group: 2 }, { group: 3 }], sizes: [0.2, 0.3, 0.5] })
    fireEvent.doubleClick(screen.getAllByRole('separator')[1]!)
    expect(onResize).toHaveBeenCalledWith([], [1 / 3, 1 / 3, 1 / 3])
  })

  it('draws a maximized pane over the whole box and no other', () => {
    const { container } = renderGrid(ROW, vi.fn(), 2)
    expect(container.querySelectorAll('[data-pane-slot]')).toHaveLength(1)
    expect(container.querySelector<HTMLElement>('[data-pane-slot="2"]')!.style).toMatchObject({
      left: '0px',
      width: '1006px'
    })
    expect(screen.queryByRole('separator')).toBeNull()
  })
})
