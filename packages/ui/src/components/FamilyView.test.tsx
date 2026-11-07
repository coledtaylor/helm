import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  ChildHeader,
  FAMILY_HEADER_PX,
  FamilyCard,
  FamilyFrame,
  FamilyKids,
  ReportNote,
  type ChildHeaderProps
} from './FamilyView'

/**
 * The family view as it is drawn: the parent's share, the column or the row the
 * children stand in, the card's header and the shrunk and ended headers. What
 * each press does is the window's; these check what is on screen and which
 * handler each control calls.
 */

function header(props: Partial<ChildHeaderProps> = {}): ChildHeaderProps {
  return {
    shape: 'card',
    name: 'reviewer',
    state: 'busy',
    role: 'reviewer',
    status: 'Working · 4m',
    onPress: vi.fn(),
    onOpenAsTab: vi.fn(),
    onStop: vi.fn(),
    ...props
  }
}

describe('FamilyFrame', () => {
  it('gives the parent 55% of the pane beside a column of children in a pane at least as wide as it is tall', () => {
    const { container } = render(
      <FamilyFrame axis="column" parent={<p>parent terminal</p>}>
        <div data-testid="kids" />
      </FamilyFrame>
    )
    const frame = container.querySelector<HTMLElement>('[data-family-view]')
    expect(frame?.getAttribute('data-family-view')).toBe('column')
    expect(frame?.className).toContain('flex-row')
    const parent = container.querySelector<HTMLElement>('[data-family-parent]')
    expect(parent?.style.flex).toBe('0 0 55%')
    expect(parent?.textContent).toBe('parent terminal')
    expect(screen.getByTestId('kids')).toBeTruthy()
  })

  it('gives the parent the top 55% of a taller pane with the children in a row below it', () => {
    const { container } = render(
      <FamilyFrame axis="row" parent={<p>parent terminal</p>}>
        <div data-testid="kids" />
      </FamilyFrame>
    )
    const frame = container.querySelector<HTMLElement>('[data-family-view]')
    expect(frame?.getAttribute('data-family-view')).toBe('row')
    expect(frame?.className).toContain('flex-col')
    expect(container.querySelector<HTMLElement>('[data-family-parent]')?.style.flex).toBe('0 0 55%')
  })

  it('shows the parent alone, filling the pane, with no axis, and keeps the parent in the same place in the tree', () => {
    const { container, rerender } = render(
      <FamilyFrame axis={null} parent={<p>parent terminal</p>}>
        <div data-testid="kids" />
      </FamilyFrame>
    )
    expect(container.querySelector('[data-family-view]')).toBeNull()
    expect(screen.queryByTestId('kids')).toBeNull()
    const alone = screen.getByText('parent terminal')
    expect(container.querySelector<HTMLElement>('[data-family-parent]')?.style.flex).toBe('1 1 0%')

    rerender(
      <FamilyFrame axis="column" parent={<p>parent terminal</p>}>
        <div data-testid="kids" />
      </FamilyFrame>
    )
    // The very same element: it was not rebuilt when the children came.
    expect(screen.getByText('parent terminal')).toBe(alone)
  })
})

describe('FamilyKids', () => {
  it('stands the cards in a column beside the parent, a hairline between them, and the headers at the end', () => {
    const { container } = render(
      <FamilyKids
        axis="column"
        cardCount={2}
        cards={<span>cards</span>}
        headers={<span>headers</span>}
        headersMax={52}
      />
    )
    expect(container.querySelector('[data-family-kids]')?.className).toContain('border-l')
    const cards = container.querySelector<HTMLElement>('[data-family-cards]')
    expect(cards?.className).toContain('flex-col')
    expect(cards?.className).toContain('divide-y')
    expect(container.querySelector<HTMLElement>('[data-family-headers]')?.style.maxHeight).toBe('52px')
  })

  it('stands the cards side by side below the parent in a row', () => {
    const { container } = render(
      <FamilyKids axis="row" cardCount={2} cards={<span>cards</span>} headers={null} headersMax={0} />
    )
    expect(container.querySelector('[data-family-kids]')?.className).toContain('border-t')
    const cards = container.querySelector<HTMLElement>('[data-family-cards]')
    expect(cards?.className).toContain('flex-row')
    expect(cards?.className).toContain('divide-x')
  })

  it('says what to press when every child is a header', () => {
    const { container } = render(
      <FamilyKids axis="column" cardCount={0} cards={null} headers={<span>headers</span>} headersMax={52} />
    )
    expect(container.querySelector('[data-family-cards]')).toBeNull()
    expect(screen.getByText('Press a header to show that child here.')).toBeTruthy()
    expect(screen.getByText('headers')).toBeTruthy()
  })
})

describe('FamilyCard', () => {
  it('is the child’s terminal on the terminal’s own ground under its header', () => {
    const { container } = render(
      <FamilyCard name="reviewer" header={<header>the header</header>}>
        <p>the terminal</p>
      </FamilyCard>
    )
    const card = container.querySelector<HTMLElement>('[data-family-card="reviewer"]')
    expect(card?.className).toContain('bg-terminal')
    expect(card?.firstElementChild?.textContent).toBe('the header')
    expect(card?.textContent).toBe('the headerthe terminal')
  })
})

describe('ReportNote', () => {
  const REPORT =
    'Two bugs in ledger.rs: a record with no start time passes the reuse guard (line 212), and a cleared conversation drops its pin (line 340).'

  it.each([['Reported done'], ['Reported stuck'], ['Note']])(
    'says %s and the report on one line, in accent-text on accent-soft',
    (label) => {
      const { container } = render(<ReportNote label={label} text={REPORT} />)
      const note = container.querySelector<HTMLElement>('[data-family-note]')!
      // The note is the one button, as the frame's `.b-rep` is.
      expect(note.tagName).toBe('BUTTON')
      // Laid directly on the card's ground, as the frame's `.b-rep` is on `.fc`.
      expect(note.className).toContain('bg-accent-soft')
      expect(note.className).not.toContain('bg-surface')
      expect(note.className).toContain('text-accent-text')
      expect(container.querySelector('[data-family-note-label]')?.textContent).toBe(label)
      const text = container.querySelector('[data-family-note-text]')!
      expect(text.textContent).toBe(REPORT)
      // On one line, cut short by the width of the card.
      expect(text.className).toContain('whitespace-nowrap')
      expect(text.className).toContain('text-ellipsis')
      expect(note.getAttribute('aria-expanded')).toBe('false')
    }
  )

  it('shows all of the report, wrapped with no height limit, when pressed, and folds it back to a line when pressed again', async () => {
    const { container } = render(<ReportNote label="Reported done" text={REPORT} />)
    const press = screen.getByRole('button', { name: /Reported done/ })
    const text = container.querySelector('[data-family-note-text]')!

    await userEvent.click(press)
    expect(press.getAttribute('aria-expanded')).toBe('true')
    expect(text.className).toContain('whitespace-normal')
    expect(text.className).not.toContain('whitespace-nowrap')
    // The frame's open note has no height limit and keeps no line breaks.
    expect(text.className).not.toMatch(/max-h|overflow-y|pre-wrap|break-words/)
    expect(text.textContent).toBe(REPORT)

    await userEvent.click(press)
    expect(press.getAttribute('aria-expanded')).toBe('false')
    expect(text.className).toContain('whitespace-nowrap')
  })

  it('is one button that carries its fill, its line below, its hover tint and its 2px edge, with no transition', () => {
    const { container } = render(<ReportNote label="Reported stuck" text={'Which table?\nA or B.\nI suggest A.'} />)
    const note = container.querySelector<HTMLElement>('[data-family-note]')!
    expect(note.className).toContain('border-b border-border')
    expect(note.className).toContain('hover:bg-accent-soft-hover')
    expect(note.className).toContain('shadow-[inset_2px_0_0_var(--color-accent)]')
    expect(note.className).not.toContain('transition')
    // Nothing else draws the edge, and nothing wraps the button.
    expect(note.querySelector('span[aria-hidden]')).toBeNull()
    expect(note.parentElement).toBe(container)
    const classes = [note, ...note.querySelectorAll('*')].map((element) => element.getAttribute('class') ?? '').join(' ')
    expect(classes).not.toMatch(/font-(semibold|bold|extrabold|black)/)
    expect(classes).not.toMatch(/#[0-9a-f]{3,8}/i)
  })
})

describe('ReportNote focus', () => {
  it('takes the page’s focus ring outside the note, not an inset one, and sits above the terminal that follows it', () => {
    const { container } = render(<ReportNote label="Reported done" text="Tests pass." />)
    const note = container.querySelector<HTMLElement>('[data-family-note]')!
    // No utility sets the ring: the global `:focus-visible` (2px accent at 2px offset) does.
    expect(note.className).not.toMatch(/outline|ring-/)
    // A positioned terminal after the note would paint over the ring's lower edge.
    expect(note.className).toContain('relative')
    expect(note.className).toContain('z-[1]')
  })

  it('is not inside anything that clips the ring, in a card or in a child’s own tab', () => {
    const note = <ReportNote label="Reported done" text="Tests pass." />
    const card = render(
      <FamilyKids
        axis="column"
        cardCount={1}
        headersMax={100}
        headers={null}
        cards={
          <FamilyCard name="worker" header={<header>the header</header>} note={note}>
            <p>the terminal</p>
          </FamilyCard>
        }
      />
    )
    const own = render(<FamilyFrame axis={null} parent={<p>terminal</p>} note={note} />)
    for (const { container } of [card, own]) {
      const found = container.querySelector<HTMLElement>('[data-family-note]')!
      for (let up = found.parentElement; up !== null && up !== container.parentElement; up = up.parentElement) {
        expect(up.className, up.outerHTML.slice(0, 80)).not.toMatch(/overflow-(hidden|clip|auto|scroll|x-|y-)/)
      }
    }
  })
})

describe('FamilyFrame with a report note', () => {
  it('draws the note above the parent’s terminal without moving the terminal when the note comes and goes', () => {
    const terminal = <p data-testid="terminal">parent terminal</p>
    const { container, rerender } = render(<FamilyFrame axis={null} parent={terminal} />)
    expect(container.querySelector('[data-family-note]')).toBeNull()
    const before = screen.getByTestId('terminal')

    rerender(<FamilyFrame axis={null} parent={terminal} note={<ReportNote label="Reported done" text="Tests pass." />} />)
    const slot = container.querySelector<HTMLElement>('[data-family-parent]')!
    const column = slot.firstElementChild!
    expect([...column.children].map((part) => part.hasAttribute('data-family-note'))).toEqual([true, false])
    expect(column.children[1]!.contains(before)).toBe(true)
    // The same element: the terminal was not remounted.
    expect(screen.getByTestId('terminal')).toBe(before)

    rerender(<FamilyFrame axis={null} parent={terminal} />)
    expect(container.querySelector('[data-family-note]')).toBeNull()
    expect(screen.getByTestId('terminal')).toBe(before)
  })
})

describe('FamilyCard with a report note', () => {
  it('puts the note between the header and the terminal', () => {
    const { container } = render(
      <FamilyCard
        name="worker"
        header={<header>the header</header>}
        note={<ReportNote label="Reported done" text="Tests pass." />}
      >
        <p>the terminal</p>
      </FamilyCard>
    )
    const card = container.querySelector<HTMLElement>('[data-family-card="worker"]')!
    expect([...card.children].map((part) => part.tagName.toLowerCase())).toEqual(['header', 'button', 'div'])
    expect(card.children[1]?.hasAttribute('data-family-note')).toBe(true)
    expect(card.textContent).toBe('the headerReported doneTests pass.the terminal')
  })

  it('has no note when it is given none, as a command child’s card is not', () => {
    const { container } = render(
      <FamilyCard name="tests" header={<header>the header</header>}>
        <p>the terminal</p>
      </FamilyCard>
    )
    expect(container.querySelector('[data-family-note]')).toBeNull()
  })
})

describe('ChildHeader on a card', () => {
  it('shows the state dot, the name, the role as a tag, the state and for how long, Open as tab and Stop', async () => {
    const props = header()
    const { container } = render(<ChildHeader {...props} />)
    const row = container.querySelector<HTMLElement>('[data-family-header="card"]')!
    expect(row.style.height).toBe(`${String(FAMILY_HEADER_PX)}px`)
    expect(container.querySelector('[data-family-dot="busy"]')?.className).toContain('bg-accent')
    const press = within(row).getByRole('button', { name: 'Shrink reviewer, Working · 4m' })
    expect(press.getAttribute('aria-expanded')).toBe('true')
    expect(press.textContent).toBe('reviewerreviewerWorking · 4m')
    expect(container.querySelector('[data-family-role]')?.textContent).toBe('reviewer')
    expect(container.querySelector('[data-family-status]')?.textContent).toBe('Working · 4m')

    // The small buttons take the font's own line height, so they stand about 17px tall in the 26px header.
    for (const name of ['Open reviewer as a tab', 'Stop reviewer']) {
      const button = within(row).getByRole('button', { name })
      expect(button.className).toContain('leading-[normal]')
      expect(button.className).not.toContain('leading-[1.55]')
    }

    await userEvent.click(within(row).getByRole('button', { name: 'Open reviewer as a tab' }))
    expect(props.onOpenAsTab).toHaveBeenCalledTimes(1)
    await userEvent.click(within(row).getByRole('button', { name: 'Stop reviewer' }))
    expect(props.onStop).toHaveBeenCalledTimes(1)
    expect(props.onPress).not.toHaveBeenCalled()

    await userEvent.click(press)
    expect(props.onPress).toHaveBeenCalledTimes(1)
  })

  it('is 26px on the island ground with the frame’s padding and gaps, the name at medium and the state in the muted 10.5px', () => {
    const { container } = render(<ChildHeader {...header()} />)
    const row = container.querySelector<HTMLElement>('[data-family-header="card"]')!
    for (const token of ['bg-surface', 'pr-[3px]', 'gap-0.5', 'border-b', 'border-border']) {
      expect(row.className).toContain(token)
    }
    const press = screen.getByRole('button', { name: 'Shrink reviewer, Working · 4m' })
    expect(press.className).toContain('text-[11.5px]')
    expect(press.className).toContain('pl-[7px]')
    expect(press.className).toContain('gap-1')
    const name = [...press.querySelectorAll('span')].find((span) => span.textContent === 'reviewer' && !span.hasAttribute('data-family-role'))
    expect(name?.className).toContain('font-medium')
    const tag = container.querySelector('[data-family-role]')
    expect(tag?.className).toContain('bg-accent-soft')
    expect(tag?.className).toContain('text-accent-text')
    expect(tag?.className).toContain('text-[10px]')
    const status = container.querySelector('[data-family-status]')
    expect(status?.className).toContain('text-fg-muted')
    expect(status?.className).toContain('text-[10.5px]')
    expect(status?.className).toContain('ml-auto')
  })

  it('draws Open as tab in the strong border and Stop in danger with its edge at 45%, both at the frame’s padding and radius', () => {
    render(<ChildHeader {...header()} />)
    const open = screen.getByRole('button', { name: 'Open reviewer as a tab' })
    for (const token of ['border-border-strong', 'text-fg', 'px-[5px]', 'py-px', 'rounded-well', 'font-medium', 'hover:bg-hover']) {
      expect(open.className).toContain(token)
    }
    const stop = screen.getByRole('button', { name: 'Stop reviewer' })
    for (const token of ['border-danger/45', 'text-danger', 'px-[5px]', 'py-px', 'rounded-well', 'hover:bg-danger/10']) {
      expect(stop.className).toContain(token)
    }
    expect(stop.className).not.toContain('border-border-strong')
  })

  it('draws no tag for a child started with no role', () => {
    const { container } = render(<ChildHeader {...header({ role: null })} />)
    expect(container.querySelector('[data-family-role]')).toBeNull()
  })

  it('keeps every weight at medium or lighter and the buttons to the header’s own size', () => {
    const { container } = render(<ChildHeader {...header()} />)
    const classes = [...container.querySelectorAll('*')].map((element) => element.getAttribute('class') ?? '').join(' ')
    expect(classes).not.toMatch(/font-(semibold|bold|extrabold|black)/)
    expect(screen.getByRole('button', { name: 'Stop reviewer' }).className).toContain('text-[10.5px]')
  })
})

describe('ChildHeader shrunk', () => {
  it('is the dot, the name and the state, and pressing it shows the child', async () => {
    const props = header({ shape: 'header', onOpenAsTab: undefined, onStop: undefined })
    const { container } = render(<ChildHeader {...props} />)
    const row = container.querySelector('[data-family-header="header"]')!
    const press = within(row as HTMLElement).getByRole('button', { name: 'Show reviewer, Working · 4m' })
    expect(press.getAttribute('aria-expanded')).toBe('false')
    // A shrunk header has no tag and no buttons of its own.
    expect(container.querySelector('[data-family-role]')).toBeNull()
    expect(within(row as HTMLElement).getAllByRole('button')).toHaveLength(1)
    expect(row.className).toContain('border-t')
    await userEvent.click(press)
    expect(props.onPress).toHaveBeenCalledTimes(1)
  })
  it('keeps the state in the muted 10.5px and stands under the cards on a hairline', () => {
    const { container } = render(<ChildHeader {...header({ shape: 'header', onOpenAsTab: undefined, onStop: undefined })} />)
    const row = container.querySelector<HTMLElement>('[data-family-header="header"]')!
    expect(row.className).toContain('border-border')
    expect(row.style.height).toBe(`${String(FAMILY_HEADER_PX)}px`)
    expect(container.querySelector('[data-family-status]')?.className).toContain('text-fg-muted')
    expect(container.querySelector('[data-family-dot="busy"]')?.className).toContain('size-1.5')
  })
})

describe('ChildHeader ended', () => {
  it('says how and when it ended with Close, and pressing the words opens its last screen', async () => {
    const props = header({
      shape: 'ended',
      state: 'ended',
      status: 'Stopped · 14:52',
      onOpenAsTab: undefined,
      onStop: undefined,
      onClose: vi.fn()
    })
    const { container } = render(<ChildHeader {...props} />)
    const row = container.querySelector<HTMLElement>('[data-family-header="ended"]')!
    expect(container.querySelector('[data-family-dot="ended"]')?.className).toContain('bg-fg-subtle')
    expect(container.querySelector('[data-family-status]')?.textContent).toBe('Stopped · 14:52')
    expect(within(row).queryByRole('button', { name: /Stop reviewer/ })).toBeNull()

    await userEvent.click(within(row).getByRole('button', { name: 'Close reviewer' }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(props.onPress).not.toHaveBeenCalled()
    await userEvent.click(within(row).getByRole('button', { name: 'Show reviewer, Stopped · 14:52' }))
    expect(props.onPress).toHaveBeenCalledTimes(1)
  })

  it('reads Stopped by you and the time for a child the user stopped, with Close drawn as the card’s small buttons are', async () => {
    const props = header({
      shape: 'ended',
      state: 'ended',
      status: 'Stopped by you · 14:53',
      onOpenAsTab: undefined,
      onStop: undefined,
      onClose: vi.fn()
    })
    const { container } = render(<ChildHeader {...props} />)
    const row = container.querySelector<HTMLElement>('[data-family-header="ended"]')!
    expect(container.querySelector('[data-family-status]')?.textContent).toBe('Stopped by you · 14:53')
    expect(container.querySelector('[data-family-status]')?.className).toContain('text-fg-muted')
    expect(container.querySelector('[data-family-role]')).toBeNull()
    expect(row.className).toContain('border-t')
    const close = within(row).getByRole('button', { name: 'Close reviewer' })
    for (const token of ['border-border-strong', 'text-fg', 'text-[10.5px]', 'px-[5px]', 'leading-[normal]', 'hover:bg-hover']) {
      expect(close.className).toContain(token)
    }
    await userEvent.click(close)
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('on its last screen, shrinks back when pressed and still offers Close', () => {
    const { container } = render(
      <ChildHeader {...header({ shape: 'screen', state: 'ended', status: 'Done · 14:52', onOpenAsTab: undefined, onStop: undefined, onClose: vi.fn() })} />
    )
    expect(container.querySelector('[data-family-header="screen"]')?.className).toContain('border-b')
    expect(screen.getByRole('button', { name: 'Shrink reviewer, Done · 14:52' }).getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Close reviewer' })).toBeTruthy()
  })
})
