import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FOCUS_RING_ROOM, PaneGroup } from './PaneGroup'
import { ReportNote } from './FamilyView'

describe('PaneGroup focus ring room', () => {
  it('lets the page’s focus ring, 2px at 2px offset, be drawn whole past the pane’s and its body’s edge', () => {
    const { container } = render(
      <PaneGroup index={0} id={1} focused attention={false} onFocus={() => undefined}>
        <ReportNote label="Reported done" text="Tests pass." />
      </PaneGroup>
    )
    const note = container.querySelector<HTMLElement>('[data-family-note]')!
    const body = note.parentElement!
    const pane = container.querySelector<HTMLElement>('[data-pane-group]')!
    expect(body.parentElement).toBe(pane)
    // The ring reaches 4px outside the note; `overflow-clip-margin` is honoured by `overflow: clip` only.
    expect(FOCUS_RING_ROOM).toBe('[overflow-clip-margin:4px]')
    for (const clipping of [pane, body]) {
      expect(clipping.className).toContain('overflow-clip')
      expect(clipping.className).not.toContain('overflow-hidden')
      expect(clipping.className).toContain(FOCUS_RING_ROOM)
    }
  })

  it('keeps the island’s bottom corners round past the room the ring has, with a clip of the body’s own', () => {
    const { container } = render(
      <PaneGroup index={0} id={1} focused attention={false} onFocus={() => undefined}>
        <ReportNote label="Reported done" text="Tests pass." />
      </PaneGroup>
    )
    const body = container.querySelector<HTMLElement>('[data-family-note]')!.parentElement!
    expect(body.className).toContain('pane-body')
  })
})
