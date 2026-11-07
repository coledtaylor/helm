import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeRef,
  CARD_GUTTER_X_PX,
  CARD_GUTTER_Y_PX,
  DEFAULT_SETTINGS,
  familiesHere,
  familyOf,
  fromSaved,
  LOCAL_HOST_KEY,
  paneId,
  PARENT_GUTTER_PX,
  sessionRef,
  type PaneLayout,
  type SavedPane,
  type SessionRecord
} from '@helm/core/types'
import { FAMILY_HEADER_PX, type TabIndicator } from '@helm/ui'
import { bridge } from './bridge.testkit'
import { familyCapacity, familyRoomFits } from './familyRooms'
import { FamilyTab } from './FamilyTab'
import { indicatorOf } from './sessionView'
import { FakeResizeObserver, layout, Terminal, type Box } from './terminal.testkit'
import { TerminalPane } from './TerminalPane'
import { disposeTerminal, getTerminal } from './terminals'
import { applyTerminalSettings } from './termprefs'

vi.mock('@xterm/xterm', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-fit', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-unicode11', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-webgl', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-serialize', () => import('./terminal.testkit'))
vi.mock('@xterm/addon-web-links', () => import('./terminal.testkit'))
vi.mock('./bridge', () => import('./bridge.testkit'))

/**
 * A parent's tab with its children in it, drawn by the real tab over the real
 * terminals (xterm and the layout engine faked, as every terminal test does).
 * The test plays the window: it holds the layout the presses change, and the
 * sessions the host lists.
 */

const MINUTE = 60_000
const NOW = Date.parse('2026-10-29T12:00:00.000Z')
const SAMPLE = 'W'.repeat(32)

/** Cells of 8 by 16 CSS pixels, so a pane's grid is worked out by hand. */
const CELL = { width: 8, height: 16 }

/** Wide enough for 80 columns at 55% in the terminal's gutter and 60 beside it; cards of 8 rows fit three. */
const WIDE: Box = { width: 1300, height: 640 }
/** The same width, too short for more than two cards and two headers of four children. */
const SHORT: Box = { width: 1300, height: 420 }
/** Taller than wide, with room for two cards side by side under the parent. */
const TALL: Box = { width: 1100, height: 1400 }
/** Fits the family at a cell of 8px across and not at one of 8.5. */
const EDGE: Box = { width: 1250, height: 640 }
/** Not wide enough for 80 columns at 55%. */
const NARROW: Box = { width: 900, height: 600 }

function session(id: number, fields: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    name: `session-${String(id)}`,
    label: null,
    cwd: 'C:\\work\\alpha',
    branch: 'main',
    projectPath: 'C:\\work\\alpha',
    profileId: null,
    argv: [],
    claudeSessionId: null,
    status: 'running',
    startedAt: '2026-10-29T09:00:00.000Z',
    endedAt: null,
    durationMs: null,
    exitCode: null,
    ...fields
  }
}

const LEAD = session(1, { name: 'lead' })
const child = (id: number, name: string, fields: Partial<SessionRecord> = {}): SessionRecord =>
  session(id, { name, parentId: 1, parentName: 'lead', ...fields })
/** A child the user stopped, at 14:52 where the test runs. */
const stopped = (id: number, name: string): SessionRecord =>
  child(id, name, {
    status: 'exited',
    exitCode: null,
    stopped: true,
    endedAt: new Date(2026, 9, 29, 14, 52).toISOString()
  })

const TAB = paneId(sessionRef(1))
const START: PaneLayout = fromSaved({ root: { panes: [sessionRef(1)] as SavedPane[], activeId: null }, focused: 0 })

interface Doing {
  state: TabIndicator
  since: number | null
}

interface HarnessProps {
  /** The sessions the host lists, the parent among them. */
  sessions: SessionRecord[]
  /** What each is doing, by id; a running child with none is just running. */
  doing?: Record<number, Doing>
  front?: boolean
  /** This device shows children in their parent's tab. */
  enabled?: boolean
  /** The children that run a command and not an agent. */
  commands?: number[]
  onStop?: (id: number) => Promise<boolean> | void
}

function Harness({
  sessions,
  doing = {},
  front = true,
  enabled = true,
  commands = [],
  onStop = vi.fn()
}: HarnessProps): JSX.Element {
  const [panes, setPanes] = useState(START)
  const parent = sessions.find((each) => each.id === 1)!
  const kids = enabled
    ? (familiesHere(panes, sessions).get(1) ?? []).map((member) => {
        const each = sessions.find((candidate) => candidate.id === member.id)!
        return {
          session: each,
          state: doing[each.id]?.state ?? indicatorOf(each, undefined),
          since: doing[each.id]?.since ?? null,
          command: commands.includes(each.id)
        }
      })
    : []
  const group = panes.groups[0]!
  return (
    <>
      <FamilyTab
        tab={TAB}
        host={LOCAL_HOST_KEY}
        front={front}
        own={parent}
        kids={kids}
        family={familyOf(panes, TAB)}
        now={NOW}
        windowsBuild={null}
        arrange={setPanes}
        onStop={onStop}
        parent={<TerminalPane session={parent} active={front} windowsBuild={null} onClose={vi.fn()} />}
      />
      <p data-tabs>{group.tabs.map(paneId).join(',')}</p>
      <p data-front>{paneId(activeRef(group)!)}</p>
    </>
  )
}

/** A pane of `box` with the tab in it. */
function mount(box: Box, sessions: SessionRecord[], props: Omit<HarnessProps, 'sessions'> = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  layout.set(host, box)
  const view = render(<Harness sessions={sessions} {...props} />, { container: host })
  return {
    ...view,
    host,
    /** The pane is drawn at another size, and the browser says so. */
    resize(next: Box): void {
      layout.set(host, next)
      act(() => FakeResizeObserver.notifyAll())
    },
    /** The host lists these sessions now. */
    list(next: SessionRecord[], more: Omit<HarnessProps, 'sessions'> = props): void {
      view.rerender(<Harness sessions={next} {...more} />)
    }
  }
}

const cardNames = (root: HTMLElement): (string | null)[] =>
  [...root.querySelectorAll('[data-family-card]')].map((card) => card.getAttribute('data-family-card'))

/** The names on the one-line headers, in order. */
const headerNames = (root: HTMLElement): string[] =>
  [...root.querySelectorAll('[data-family-header="header"], [data-family-header="ended"]')].map((header) =>
    (header.querySelector('button')!.getAttribute('aria-label') ?? '').replace(/^(Show|Shrink) /, '').split(',')[0]!
  )

const card = (root: HTMLElement, name: string): HTMLElement => {
  const found = root.querySelector<HTMLElement>(`[data-family-card="${name}"]`)
  if (found === null) throw new Error(`no card for ${name}`)
  return found
}

beforeEach(() => {
  layout.install()
  layout.text((element) =>
    element.textContent === SAMPLE ? { width: CELL.width * SAMPLE.length, height: CELL.height } : null
  )
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true })
})

afterEach(() => {
  cleanup()
  for (let id = 1; id <= 6; id++) disposeTerminal(id)
  document.body.replaceChildren()
  applyTerminalSettings(DEFAULT_SETTINGS)
  layout.text(null)
  bridge.reset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a parent’s tab with children', () => {
  it('S1: takes the left 55% for the parent’s terminal and stands each child as a card in a column on the right of a pane at least as wide as it is tall', () => {
    const { container } = mount(WIDE, [LEAD, child(2, 'reviewer'), child(3, 'tester')])

    const frame = container.querySelector<HTMLElement>('[data-family-view]')!
    expect(frame.getAttribute('data-family-view')).toBe('column')
    expect(frame.className).toContain('flex-row')
    const parent = container.querySelector<HTMLElement>('[data-family-parent]')!
    expect(parent.style.flex).toBe('0 0 55%')
    expect(parent.contains(getTerminal(1)!.element)).toBe(true)

    expect(container.querySelector('[data-family-kids]')!.className).toContain('border-l')
    expect(container.querySelector('[data-family-cards]')!.className).toContain('flex-col')
    expect(cardNames(container)).toEqual(['reviewer', 'tester'])
    for (const [id, name] of [[2, 'reviewer'], [3, 'tester']] as const) {
      expect(card(container, name).contains(getTerminal(id)!.element)).toBe(true)
    }
  })

  it('S2: puts the parent on the top 55% of a taller pane and the cards side by side in a row across the bottom', () => {
    const { container } = mount(TALL, [LEAD, child(2, 'reviewer'), child(3, 'tester')])

    const frame = container.querySelector<HTMLElement>('[data-family-view]')!
    expect(frame.getAttribute('data-family-view')).toBe('row')
    expect(frame.className).toContain('flex-col')
    expect(container.querySelector<HTMLElement>('[data-family-parent]')!.style.flex).toBe('0 0 55%')
    expect(container.querySelector('[data-family-kids]')!.className).toContain('border-t')
    expect(container.querySelector('[data-family-cards]')!.className).toContain('flex-row')
    expect(cardNames(container)).toEqual(['reviewer', 'tester'])
  })

  it('shows the parent alone, filling its tab, when the pane has no room for 80 columns at 55% beside cards of 60', () => {
    const { container } = mount(NARROW, [LEAD, child(2, 'reviewer')])

    expect(container.querySelector('[data-family-view]')).toBeNull()
    expect(container.querySelector<HTMLElement>('[data-family-parent]')!.style.flex).toBe('1 1 0%')
    expect(cardNames(container)).toEqual([])
    // The window is told, so the child is not counted as open here.
    expect(familyRoomFits(TAB)).toBe(false)
    expect(familyCapacity(TAB)).toBeNull()
  })

  it('tells the window how many cards the pane holds, follows the pane as it changes size, and forgets the tab when it closes', () => {
    const view = mount(WIDE, [LEAD, child(2, 'reviewer'), child(3, 'tester')])
    expect(familyRoomFits(TAB)).toBe(true)
    expect(familyCapacity(TAB)).toBe(2)

    view.resize(NARROW)
    expect(view.container.querySelector('[data-family-view]')).toBeNull()
    expect(familyRoomFits(TAB)).toBe(false)

    view.resize(WIDE)
    expect(cardNames(view.container)).toEqual(['reviewer', 'tester'])

    view.unmount()
    // Unmeasured counts as having room, and has no capacity to give.
    expect(familyRoomFits(TAB)).toBe(true)
    expect(familyCapacity(TAB)).toBeNull()
  })

  it('has the answer ready for the first child: a tab with none is measured as if it had one', () => {
    const view = mount(WIDE, [LEAD])
    expect(familyRoomFits(TAB)).toBe(true)
    expect(view.container.querySelector('[data-family-view]')).toBeNull()

    view.list([LEAD, child(2, 'reviewer')])
    expect(cardNames(view.container)).toEqual(['reviewer'])
  })

  it('S5: hides the parent’s terminal and every card when another tab comes to the front, and shows the family as it was when this one returns', () => {
    const view = mount(WIDE, [LEAD, child(2, 'reviewer'), child(3, 'tester')])
    const reviewer = card(view.container, 'reviewer')
    const tester = card(view.container, 'tester')
    const made = Terminal.instances.length

    // The pane the tab is in draws nothing for it, and so measures nothing.
    view.resize({ width: 0, height: 0 })
    view.list([LEAD, child(2, 'reviewer'), child(3, 'tester')], { front: false })
    const body = view.host.firstElementChild as HTMLElement
    expect(body.className).toContain('hidden')
    expect(body.getAttribute('aria-hidden')).toBe('true')
    expect(body.contains(getTerminal(1)!.element)).toBe(true)
    expect(cardNames(view.container)).toEqual(['reviewer', 'tester'])

    view.resize(WIDE)
    view.list([LEAD, child(2, 'reviewer'), child(3, 'tester')], { front: true })
    expect(body.className).not.toContain('hidden')
    expect(body.getAttribute('aria-hidden')).toBe('false')
    // The very same cards and terminals: nothing was rebuilt.
    expect(card(view.container, 'reviewer')).toBe(reviewer)
    expect(card(view.container, 'tester')).toBe(tester)
    expect(Terminal.instances).toHaveLength(made)
  })

  it('S6: puts a running card’s terminal under a one-line header with its state dot, name, role, state and for how long, Open as tab and Stop', () => {
    const { container } = mount(WIDE, [LEAD, child(2, 'reviewer', { role: 'reviewer' })], {
      doing: { 2: { state: 'busy', since: NOW - 4 * MINUTE } }
    })

    const header = within(card(container, 'reviewer')).getByRole('button', { name: 'Shrink reviewer, Working · 4m' })
      .parentElement!
    expect(header.getAttribute('data-family-header')).toBe('card')
    expect(header.querySelector('[data-family-dot]')!.getAttribute('data-family-dot')).toBe('busy')
    expect(header.querySelector('[data-family-role]')!.textContent).toBe('reviewer')
    expect(header.querySelector('[data-family-status]')!.textContent).toBe('Working · 4m')
    expect(within(header).getByRole('button', { name: 'Open reviewer as a tab' })).toBeTruthy()
    expect(within(header).getByRole('button', { name: 'Stop reviewer' })).toBeTruthy()
    // The terminal is under the header, in the same card.
    expect(card(container, 'reviewer').contains(getTerminal(2)!.element)).toBe(true)
    expect(header.nextElementSibling!.contains(getTerminal(2)!.element)).toBe(true)
  })

  it('S7: a parent starting a child keeps the keyboard and its caret, and the new card’s terminal is made without it and draws the hollow cursor of a terminal without focus', () => {
    const view = mount(WIDE, [LEAD])
    const parentTerminal = getTerminal(1)!.term as unknown as Terminal
    expect(parentTerminal.hasFocus).toBe(true)

    view.list([LEAD, child(2, 'reviewer')])
    expect(cardNames(view.container)).toEqual(['reviewer'])
    const cardTerminal = getTerminal(2)!.term as unknown as Terminal
    expect(parentTerminal.hasFocus).toBe(true)
    expect(cardTerminal.hasFocus).toBe(false)
    // A terminal without the keyboard draws its cursor as an outline, not solid.
    expect(cardTerminal.options['cursorInactiveStyle']).toBe('outline')
    expect(parentTerminal.options['cursorInactiveStyle']).toBe('outline')
  })

  it('S8: pressing a card’s terminal gives it the keyboard and a solid cursor, turns the parent’s hollow, and what is typed goes to that child', async () => {
    const { container } = mount(WIDE, [LEAD, child(2, 'reviewer')])
    const parentTerminal = getTerminal(1)!.term as unknown as Terminal
    const cardTerminal = getTerminal(2)!.term as unknown as Terminal
    expect(parentTerminal.hasFocus).toBe(true)

    await userEvent.click(card(container, 'reviewer').querySelector('[data-terminal-card]')!)
    expect(cardTerminal.hasFocus).toBe(true)
    expect(parentTerminal.hasFocus).toBe(false)
    expect(parentTerminal.options['cursorInactiveStyle']).toBe('outline')

    cardTerminal.type('hello')
    expect(bridge.sent('session:input')).toEqual([{ id: 2, data: 'hello' }])
  })

  it('S9: Stop asks the window to end that child and nothing else; the question is the window’s, not the card’s', async () => {
    const onStop = vi.fn()
    const { container } = mount(WIDE, [LEAD, child(2, 'reviewer'), child(3, 'tester')], { onStop })

    await userEvent.click(within(card(container, 'reviewer')).getByRole('button', { name: 'Stop reviewer' }))
    expect(onStop).toHaveBeenCalledExactlyOnceWith(2)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('S9: a child the user stopped, once they agreed, shrinks to a header reading Stopped by you and the time', async () => {
    const onStop = vi.fn(() => Promise.resolve(true))
    const view = mount(WIDE, [LEAD, child(2, 'reviewer'), child(3, 'tester')], { onStop })

    await userEvent.click(within(card(view.container, 'reviewer')).getByRole('button', { name: 'Stop reviewer' }))
    view.list([LEAD, stopped(2, 'reviewer'), child(3, 'tester')], { onStop })

    const header = view.container.querySelector('[data-family-header="ended"]')!
    expect(header.querySelector('[data-family-status]')!.textContent).toBe('Stopped by you · 14:52')
  })

  it('S9: a child whose Stop the user declined, and that was stopped by another, reads Stopped and the time', async () => {
    const onStop = vi.fn(() => Promise.resolve(false))
    const view = mount(WIDE, [LEAD, child(2, 'reviewer'), child(3, 'tester')], { onStop })

    await userEvent.click(within(card(view.container, 'reviewer')).getByRole('button', { name: 'Stop reviewer' }))
    view.list([LEAD, stopped(2, 'reviewer'), child(3, 'tester')], { onStop })

    const header = view.container.querySelector('[data-family-header="ended"]')!
    expect(header.querySelector('[data-family-status]')!.textContent).toBe('Stopped · 14:52')
  })

  it('S9: a child that was stopped shrinks to a header reading Stopped and the time, with Close and no terminal', () => {
    const view = mount(WIDE, [LEAD, child(2, 'reviewer'), child(3, 'tester')])
    view.list([LEAD, stopped(2, 'reviewer'), child(3, 'tester')])

    expect(cardNames(view.container)).toEqual(['tester'])
    expect(headerNames(view.container)).toEqual(['reviewer'])
    const header = view.container.querySelector('[data-family-header="ended"]')!
    expect(header.querySelector('[data-family-status]')!.textContent).toBe('Stopped · 14:52')
    expect(header.querySelector('[data-family-dot]')!.getAttribute('data-family-dot')).toBe('ended')
    expect(within(header as HTMLElement).getByRole('button', { name: 'Close reviewer' })).toBeTruthy()
    expect(within(header as HTMLElement).queryByRole('button', { name: /Stop reviewer/ })).toBeNull()
    // Its terminal is kept for the last screen, but no card holds it.
    expect(view.container.querySelector('[data-family-cards]')!.contains(getTerminal(2)!.element)).toBe(false)
  })

  it('S17: leaves every ended child’s header its row, though the pane had room for a card for each child', () => {
    const view = mount(WIDE, [LEAD, child(2, 'reviewer'), child(3, 'worker'), child(4, 'tester'), child(5, 'docs')])
    view.list([LEAD, stopped(2, 'reviewer'), stopped(3, 'worker'), child(4, 'tester'), child(5, 'docs')])

    expect(cardNames(view.container)).toEqual(['tester', 'docs'])
    expect(headerNames(view.container)).toEqual(['reviewer', 'worker'])
    const headers = view.container.querySelector<HTMLElement>('[data-family-headers]')!
    expect(parseFloat(headers.style.maxHeight)).toBeGreaterThanOrEqual(2 * FAMILY_HEADER_PX)
  })

  it('S13: shows as cards the children that fit at 8 rows and the rest as one-line headers at the end of the column', () => {
    const { container } = mount(SHORT, [
      LEAD,
      child(2, 'alpha'),
      child(3, 'beta'),
      child(4, 'gamma'),
      child(5, 'delta')
    ])

    expect(cardNames(container)).toEqual(['alpha', 'beta'])
    expect(headerNames(container)).toEqual(['gamma', 'delta'])
    const headers = container.querySelector('[data-family-headers]')!
    expect(headers.querySelectorAll('[data-family-header="header"]')).toHaveLength(2)
    // A header is its dot, name and state only: no tag, no buttons beside it.
    expect(headers.querySelector('[data-family-role]')).toBeNull()
    expect(within(headers as HTMLElement).getAllByRole('button')).toHaveLength(2)
    // The headers come after the cards in the column.
    const kids = container.querySelector('[data-family-kids]')!
    expect(kids.lastElementChild).toBe(headers)
    expect(familyCapacity(TAB)).toBe(2)
  })

  it('S14: pressing a shrunk header shows that child as a card and shrinks the last card to a header in its place', async () => {
    const { container } = mount(SHORT, [
      LEAD,
      child(2, 'alpha'),
      child(3, 'beta'),
      child(4, 'gamma'),
      child(5, 'delta')
    ])

    await userEvent.click(within(container).getByRole('button', { name: /^Show delta/ }))
    expect(cardNames(container)).toEqual(['alpha', 'delta'])
    expect(headerNames(container)).toEqual(['gamma', 'beta'])
    expect(card(container, 'delta').contains(getTerminal(5)!.element)).toBe(true)
  })

  it('S15: pressing a shown card’s header shrinks it to a one-line header', async () => {
    const { container } = mount(WIDE, [LEAD, child(2, 'reviewer'), child(3, 'tester')])

    await userEvent.click(within(card(container, 'reviewer')).getByRole('button', { name: /^Shrink reviewer/ }))
    expect(cardNames(container)).toEqual(['tester'])
    expect(headerNames(container)).toEqual(['reviewer'])

    // And it comes back the same way.
    await userEvent.click(within(container).getByRole('button', { name: /^Show reviewer/ }))
    expect(cardNames(container).sort()).toEqual(['reviewer', 'tester'])
  })

  it('S18: pressing an ended child’s header shows its last screen with no input, and Close takes it out of the family view', async () => {
    const sessions = [LEAD, stopped(2, 'reviewer'), child(3, 'tester')]
    const { container, list } = mount(WIDE, sessions)
    expect(cardNames(container)).toEqual(['tester'])

    await userEvent.click(within(container).getByRole('button', { name: /^Show reviewer, Stopped/ }))
    expect(cardNames(container)).toEqual(['reviewer', 'tester'])
    const screenCard = card(container, 'reviewer')
    expect(screenCard.querySelector('[data-family-header="screen"]')).not.toBeNull()
    expect(screenCard.contains(getTerminal(2)!.element)).toBe(true)
    // The last screen takes no keys: no stdin, no blinking caret, no Stop beside it.
    expect(getTerminal(2)!.term.options).toMatchObject({ disableStdin: true, cursorBlink: false })
    expect(within(screenCard).queryByRole('button', { name: /^Stop/ })).toBeNull()
    expect(within(screenCard).queryByRole('button', { name: /^Open/ })).toBeNull()

    await userEvent.click(within(screenCard).getByRole('button', { name: 'Close reviewer' }))
    expect(cardNames(container)).toEqual(['tester'])
    expect(headerNames(container)).toEqual([])
    // Its row is the Sessions tree's: the host still lists it, and a new list changes nothing here.
    list(sessions)
    expect(headerNames(container)).toEqual([])
  })

  it('S19: Open as tab gives the child a tab right after its parent’s, in front, and it leaves the family view', async () => {
    const { container } = mount(WIDE, [LEAD, child(2, 'reviewer'), child(3, 'tester')])
    expect(container.querySelector('[data-tabs]')!.textContent).toBe('session:1')

    await userEvent.click(within(card(container, 'reviewer')).getByRole('button', { name: 'Open reviewer as a tab' }))

    expect(container.querySelector('[data-tabs]')!.textContent).toBe('session:1,session:2')
    expect(container.querySelector('[data-front]')!.textContent).toBe('session:2')
    expect(cardNames(container)).toEqual(['tester'])
    expect(container.querySelector('[data-family-header]')).not.toBeNull()
  })

  it('S24: shows the parent alone when this device does not show children in their tab, without touching its terminal, and the family again with its arrangement when it does', async () => {
    const sessions = [LEAD, child(2, 'reviewer'), child(3, 'tester')]
    const view = mount(WIDE, sessions)
    await userEvent.click(within(card(view.container, 'reviewer')).getByRole('button', { name: /^Shrink reviewer/ }))
    const parentElement = getTerminal(1)!.element
    const made = Terminal.instances.length

    view.list(sessions, { enabled: false })
    expect(view.container.querySelector('[data-family-view]')).toBeNull()
    expect(view.container.querySelector<HTMLElement>('[data-family-parent]')!.style.flex).toBe('1 1 0%')
    expect(cardNames(view.container)).toEqual([])
    expect(getTerminal(1)!.element).toBe(parentElement)

    view.list(sessions, { enabled: true })
    expect(view.container.querySelector('[data-family-view]')).not.toBeNull()
    expect(cardNames(view.container)).toEqual(['tester'])
    expect(headerNames(view.container)).toEqual(['reviewer'])
    expect(getTerminal(1)!.element).toBe(parentElement)
    expect(Terminal.instances).toHaveLength(made)
  })

  it('draws terminals in the gutter the room rule counts: 10px around a parent’s, and 10 across by 8 down in a card’s', () => {
    const { container } = mount(WIDE, [LEAD, child(2, 'reviewer')])
    // Tailwind's spacing step is 4px.
    const parentGutter = getTerminal(1)!.element.parentElement!.parentElement!
    expect(parentGutter.className).toContain(`p-${String(PARENT_GUTTER_PX / 4)}`)
    const cardGutter = card(container, 'reviewer').querySelector<HTMLElement>('[data-terminal-card]')!
    expect(cardGutter.className).toContain(`px-${String(CARD_GUTTER_X_PX / 4)}`)
    expect(cardGutter.className).toContain(`py-${String(CARD_GUTTER_Y_PX / 4)}`)
  })

  it('S11: shows the parent alone for lack of room, brings the family view back by itself when the pane gains room, and takes it away again when the room goes', () => {
    const view = mount(NARROW, [LEAD, child(2, 'reviewer'), child(3, 'tester')])
    expect(view.container.querySelector('[data-family-view]')).toBeNull()
    const parentElement = getTerminal(1)!.element

    // The window grew, the pane was maximized or a split beside it closed.
    view.resize(WIDE)
    expect(cardNames(view.container)).toEqual(['reviewer', 'tester'])
    expect(familyRoomFits(TAB)).toBe(true)

    // A split opened again.
    view.resize(NARROW)
    expect(view.container.querySelector('[data-family-view]')).toBeNull()
    expect(familyRoomFits(TAB)).toBe(false)

    view.resize(WIDE)
    expect(cardNames(view.container)).toEqual(['reviewer', 'tester'])
    expect(getTerminal(1)!.element).toBe(parentElement)
  })

  it('S11: judges a tab that is not in front by the last size it had, and again at the size it comes back at', () => {
    const view = mount(WIDE, [LEAD, child(2, 'reviewer')])
    const body = view.host.firstElementChild as HTMLElement

    // A tab that is not drawn measures nothing, which is not news.
    layout.set(body, { width: 0, height: 0 })
    act(() => FakeResizeObserver.notifyAll())
    expect(familyRoomFits(TAB)).toBe(true)
    expect(cardNames(view.container)).toEqual(['reviewer'])

    // The window shrank while it was hidden.
    layout.set(body, NARROW)
    act(() => FakeResizeObserver.notifyAll())
    expect(view.container.querySelector('[data-family-view]')).toBeNull()
    expect(familyRoomFits(TAB)).toBe(false)
  })

  it('S12: judges the room at the terminal font in Settings, so a larger font needs more pixels for the same floors and a pane that held the family shows the parent alone', () => {
    // The font measures in proportion to its size; the default is 14px.
    layout.text((element) => {
      if (element.textContent !== SAMPLE) return null
      const scale = Number.parseFloat(element.style.fontSize) / 14
      return { width: CELL.width * SAMPLE.length * scale, height: CELL.height * scale }
    })
    const view = mount(WIDE, [LEAD, child(2, 'reviewer')])
    expect(cardNames(view.container)).toEqual(['reviewer'])

    act(() => applyTerminalSettings({ ...DEFAULT_SETTINGS, terminalFontSize: 20 }))
    expect(view.container.querySelector('[data-family-view]')).toBeNull()
    expect(familyRoomFits(TAB)).toBe(false)

    act(() => applyTerminalSettings(DEFAULT_SETTINGS))
    expect(cardNames(view.container)).toEqual(['reviewer'])
    expect(familyRoomFits(TAB)).toBe(true)
  })

  it('judges the room again when the window moves to a screen with another pixel ratio, which changes the cell without changing the pane', () => {
    layout.text((element) => (element.textContent === SAMPLE ? { width: 8.7 * SAMPLE.length, height: CELL.height } : null))
    const changes = new Set<() => void>()
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: (_type: string, listener: () => void) => changes.add(listener),
      removeEventListener: (_type: string, listener: () => void) => changes.delete(listener)
    }))
    const ratio = (value: number): void => {
      Object.defineProperty(window, 'devicePixelRatio', { value, configurable: true })
      act(() => [...changes].forEach((listener) => listener()))
    }

    // At 1x a cell is 8px across and the parent keeps 81 columns; at 2x it is 8.5 and keeps 76.
    const view = mount(EDGE, [LEAD, child(2, 'reviewer')])
    expect(cardNames(view.container)).toEqual(['reviewer'])
    ratio(2)
    expect(view.container.querySelector('[data-family-view]')).toBeNull()
    ratio(1)
    expect(cardNames(view.container)).toEqual(['reviewer'])
  })

  it('S16: keeps the parent’s terminal at the same 55%, in the same place and at the same size as cards shrink, swap, end and close', async () => {
    const sessions = [LEAD, child(2, 'alpha'), child(3, 'beta'), child(4, 'gamma'), child(5, 'delta')]
    const view = mount(SHORT, sessions)
    const parentElement = getTerminal(1)!.element
    const parentResizes = (): number =>
      bridge.sent('session:resize').filter((sent) => (sent as { id: number }).id === 1).length
    const resizes = parentResizes()
    const parentFlex = (): string => view.container.querySelector<HTMLElement>('[data-family-parent]')!.style.flex
    const unchanged = (): void => {
      expect(parentFlex()).toBe('0 0 55%')
      expect(getTerminal(1)!.element).toBe(parentElement)
      expect(parentElement.closest('[data-family-parent]')).toBe(view.container.querySelector('[data-family-parent]'))
      expect(parentResizes()).toBe(resizes)
    }
    unchanged()

    await userEvent.click(within(view.container).getByRole('button', { name: /^Show delta/ }))
    unchanged()
    await userEvent.click(within(card(view.container, 'alpha')).getByRole('button', { name: /^Shrink alpha/ }))
    unchanged()

    view.list([LEAD, stopped(2, 'alpha'), child(3, 'beta'), child(4, 'gamma'), child(5, 'delta')])
    unchanged()
    await userEvent.click(within(view.container).getByRole('button', { name: /^Show alpha, Stopped/ }))
    await userEvent.click(within(card(view.container, 'alpha')).getByRole('button', { name: 'Close alpha' }))
    unchanged()

    view.list([LEAD, stopped(2, 'alpha'), child(3, 'beta')])
    unchanged()
  })
})

describe('a child’s report note', () => {
  const REPORT = 'Two bugs in ledger.rs: a record with no start time passes the reuse guard (line 212).'
  const reported = (id: number, name: string, state: string, text = REPORT): SessionRecord =>
    child(id, name, { lastReport: { state, text, at: '2026-11-06T10:00:00.000Z' } })
  const noteOf = (root: HTMLElement, name: string): HTMLElement | null =>
    card(root, name).querySelector<HTMLElement>('[data-family-note]')

  it('shows "Reported done", "Reported stuck" or "Note" and the start of the report under the card’s header', () => {
    const { container } = mount(WIDE, [
      LEAD,
      reported(2, 'reviewer', 'done'),
      reported(3, 'tester', 'stuck', 'Which table, A or B?')
    ])
    const done = noteOf(container, 'reviewer')!
    expect(done.querySelector('[data-family-note-label]')!.textContent).toBe('Reported done')
    expect(done.querySelector('[data-family-note-text]')!.textContent).toBe(REPORT)
    // Under the header and above the child's terminal.
    const parts = [...card(container, 'reviewer').children]
    expect(parts[0]!.hasAttribute('data-family-header')).toBe(true)
    expect(parts[1]).toBe(done)
    expect(parts[2]!.contains(getTerminal(2)!.element)).toBe(true)
    expect(noteOf(container, 'tester')!.querySelector('[data-family-note-label]')!.textContent).toBe('Reported stuck')
  })

  it('says "Note" for a note the child made on the way', () => {
    const { container } = mount(WIDE, [LEAD, reported(2, 'reviewer', 'note', 'Half way through.')])
    expect(noteOf(container, 'reviewer')!.querySelector('[data-family-note-label]')!.textContent).toBe('Note')
  })

  it('shows all of the report when the note is pressed', async () => {
    const { container } = mount(WIDE, [LEAD, reported(2, 'reviewer', 'done')])
    const text = noteOf(container, 'reviewer')!.querySelector('[data-family-note-text]')!
    expect(text.className).toContain('whitespace-nowrap')

    await userEvent.click(within(card(container, 'reviewer')).getByRole('button', { name: /^Reported done/ }))
    expect(text.className).toContain('whitespace-normal')
    expect(text.className).not.toContain('whitespace-nowrap')
    expect(text.textContent).toBe(REPORT)
    // Pressing the note is not pressing the header: the card stays.
    expect(cardNames(container)).toEqual(['reviewer'])
  })

  it('loses the note when the child’s next turn starts and the host lists its row without the report', () => {
    const view = mount(WIDE, [LEAD, reported(2, 'reviewer', 'done')])
    expect(noteOf(view.container, 'reviewer')).not.toBeNull()

    view.list([LEAD, child(2, 'reviewer')])
    expect(noteOf(view.container, 'reviewer')).toBeNull()
    expect(cardNames(view.container)).toEqual(['reviewer'])
  })

  it('shows a later report as a new note, folded', async () => {
    const view = mount(WIDE, [LEAD, reported(2, 'reviewer', 'done')])
    await userEvent.click(within(card(view.container, 'reviewer')).getByRole('button', { name: /^Reported done/ }))
    expect(noteOf(view.container, 'reviewer')!.getAttribute('aria-expanded')).toBe('true')

    view.list([
      LEAD,
      child(2, 'reviewer', { lastReport: { state: 'stuck', text: 'Which table?', at: '2026-11-06T10:30:00.000Z' } })
    ])
    const next = noteOf(view.container, 'reviewer')!
    expect(next.querySelector('[data-family-note-label]')!.textContent).toBe('Reported stuck')
    expect(next.getAttribute('aria-expanded')).toBe('false')
  })

  it('never shows one on a command child’s card, and none on a child that has reported nothing', () => {
    const { container } = mount(
      WIDE,
      [LEAD, reported(2, 'tests', 'done'), child(3, 'tester')],
      { commands: [2] }
    )
    expect(cardNames(container)).toEqual(['tests', 'tester'])
    expect(noteOf(container, 'tests')).toBeNull()
    expect(noteOf(container, 'tester')).toBeNull()
  })

  describe('in the tab of a child that was opened as a tab', () => {
    // The tab's own session is a child of another session, which is not open here.
    const OWN = (fields: Partial<SessionRecord> = {}): SessionRecord =>
      session(1, {
        name: 'worker',
        parentId: 9,
        parentName: 'boss',
        lastReport: { state: 'done', text: REPORT, at: '2026-11-06T10:00:00.000Z' },
        ...fields
      })
    /** The same session once the host lists it without a report. */
    const QUIET = (): SessionRecord => {
      const row = OWN()
      delete row.lastReport
      return row
    }
    const ownNote = (root: HTMLElement): HTMLElement | null =>
      root.querySelector<HTMLElement>('[data-family-parent] [data-family-note]')

    it('draws the report above its terminal, as it is drawn in its parent’s card', () => {
      const { container } = mount(WIDE, [OWN()])
      const note = ownNote(container)!
      expect(note.querySelector('[data-family-note-label]')!.textContent).toBe('Reported done')
      expect(note.querySelector('[data-family-note-text]')!.textContent).toBe(REPORT)
      const column = container.querySelector('[data-family-parent]')!.firstElementChild!
      expect([...column.children].map((part) => part === note)).toEqual([true, false])
      expect(column.children[1]!.contains(getTerminal(1)!.element)).toBe(true)
    })

    it('shows all of it when pressed, and takes it away without remounting the terminal when the next turn starts', async () => {
      const view = mount(WIDE, [OWN()])
      await userEvent.click(within(view.container).getByRole('button', { name: /^Reported done/ }))
      expect(ownNote(view.container)!.getAttribute('aria-expanded')).toBe('true')

      const terminal = getTerminal(1)!.element
      const made = Terminal.instances.length
      view.list([QUIET()])
      expect(ownNote(view.container)).toBeNull()
      expect(getTerminal(1)!.element).toBe(terminal)
      expect(Terminal.instances).toHaveLength(made)
    })

    it('has none when it has reported nothing', () => {
      expect(ownNote(mount(WIDE, [QUIET()]).container)).toBeNull()
    })

    it('is drawn with the family view around the terminal when the child has children of its own', () => {
      const { container } = mount(WIDE, [OWN(), child(2, 'reviewer', { parentName: 'worker' })])
      expect(cardNames(container)).toEqual(['reviewer'])
      expect(ownNote(container)).not.toBeNull()
      expect(card(container, 'reviewer').querySelector('[data-family-note]')).toBeNull()
    })
  })

  it('has no note on a header or on an ended child’s last screen', async () => {
    const ended = child(3, 'tester', {
      status: 'exited',
      exitCode: null,
      stopped: true,
      endedAt: new Date(2026, 9, 29, 14, 52).toISOString(),
      lastReport: { state: 'done', text: REPORT, at: '2026-11-06T10:00:00.000Z' }
    })
    const { container } = mount(SHORT, [LEAD, reported(2, 'reviewer', 'done'), reported(4, 'worker', 'done'), ended])
    expect(container.querySelectorAll('[data-family-note]')).toHaveLength(cardNames(container).length)
    expect(container.querySelector('[data-family-header="header"] [data-family-note]')).toBeNull()

    await userEvent.click(within(container).getByRole('button', { name: /^Show tester, Stopped/ }))
    expect(noteOf(container, 'tester')).toBeNull()
  })
})
