import { createEvent, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PaneDropZone } from '../lib/paneGeometry'
import { PaneDrop } from './PaneDrop'
import { TAB_MIME } from './TabBar'

/** The pane the zones are measured against. */
let pane = { width: 900, height: 600 }

beforeEach(() => {
  pane = { width: 900, height: 600 }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: pane.width,
    height: pane.height,
    right: pane.width,
    bottom: pane.height,
    toJSON: () => ({})
  }))
})

afterEach(() => vi.restoreAllMocks())

const tabDrag = (tab = 'session:1') => ({
  types: [TAB_MIME, 'text/plain'],
  getData: (type: string) => (type === TAB_MIME ? tab : ''),
  dropEffect: 'none'
})

function renderDrop(
  props: { active?: boolean; allows?: (zone: PaneDropZone) => boolean } = {}
): { target: HTMLElement; preview: () => string | null; onDrop: ReturnType<typeof vi.fn> } {
  const onDrop = vi.fn()
  const { container } = render(
    <section>
      <PaneDrop active={props.active ?? true} allows={props.allows ?? (() => true)} onDrop={onDrop} />
    </section>
  )
  return {
    target: container.querySelector<HTMLElement>('[data-pane-drop]')!,
    preview: () => container.querySelector('[data-pane-drop-preview]')?.getAttribute('data-pane-drop-preview') ?? null,
    onDrop
  }
}

type DragKind = 'dragEnter' | 'dragOver' | 'drop'

/**
 * A drag event at (`x`, `y`). jsdom has no `DragEvent`, so Testing Library
 * builds a plain `Event` and drops the pointer's coordinates; they are put
 * back by hand.
 */
function drag(kind: DragKind, target: HTMLElement, x: number, y: number, dataTransfer = tabDrag()): void {
  const event = createEvent[kind](target, { dataTransfer })
  Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y } })
  fireEvent(target, event)
}

function over(target: HTMLElement, x: number, y: number, dataTransfer = tabDrag()): void {
  drag('dragEnter', target, x, y, dataTransfer)
  drag('dragOver', target, x, y, dataTransfer)
}

describe('PaneDrop', () => {
  it('previews the part of the pane a tab would take, and lands it there', () => {
    const { target, preview, onDrop } = renderDrop()

    over(target, 450, 300)
    expect(preview()).toBe('center')
    over(target, 860, 300)
    expect(preview()).toBe('right')
    over(target, 450, 580)
    expect(preview()).toBe('bottom')

    drag('drop', target, 450, 580, tabDrag('file:C:\\a.ts'))
    expect(onDrop).toHaveBeenCalledWith('file:C:\\a.ts', 'bottom')
    expect(preview()).toBeNull()
  })

  it('takes no drag and shows nothing while no tab is being dragged', () => {
    const { target, preview } = renderDrop({ active: false })
    over(target, 450, 300)
    expect(preview()).toBeNull()
    expect(target.className).toContain('pointer-events-none')
  })

  it('ignores a drag that is not a tab', () => {
    const { target, preview } = renderDrop()
    over(target, 450, 300, { types: ['text/plain'], getData: () => 'hello', dropEffect: 'none' })
    expect(preview()).toBeNull()
  })

  it('previews nothing and drops nothing where the drop would do nothing', () => {
    const { target, preview, onDrop } = renderDrop({ allows: (zone) => zone !== 'center' })
    over(target, 450, 300)
    expect(preview()).toBeNull()
    drag('drop', target, 450, 300)
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('will not halve a pane too narrow or too short for two, and means the middle there', () => {
    pane = { width: 380, height: 260 }
    const { target, preview } = renderDrop()
    over(target, 10, 130)
    expect(preview()).toBe('center')
    over(target, 190, 5)
    expect(preview()).toBe('center')
  })

  it('clears the preview when the drag leaves the pane', () => {
    const { target, preview } = renderDrop()
    over(target, 860, 300)
    fireEvent.dragLeave(target, { relatedTarget: document.body })
    expect(preview()).toBeNull()
  })
})
