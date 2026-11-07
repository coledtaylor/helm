import { useState, type JSX, type ReactNode } from 'react'
import { FAMILY_PARENT_SHARE, type FamilyAxis } from '@helm/core/types'
import { cn } from '../lib/cn'
import { SESSION_STATE_DOT, SESSION_STATE_LABEL, type SessionState } from '../lib/sessionstate'

/**
 * The family view: one session tab holding the parent's terminal and its
 * children's cards (DESIGN.md "Family view").
 *
 * Drawing only. Which children are cards, which are headers, how many cards the
 * pane has room for and what each button does are decided where the window
 * keeps its panes, so these components take the answers as props and own no
 * rule of their own.
 */

/**
 * A one-line header's height, in CSS pixels: a card's own, and a shrunk or
 * ended child's. The room rule counts it, so it is one number the view and the
 * rule share.
 */
export const FAMILY_HEADER_PX = 26

export interface FamilyFrameProps {
  /**
   * Where the children go: `column` beside the parent in a pane at least as
   * wide as it is tall, `row` below it in a taller one, or null for the parent
   * alone, which then fills the pane.
   */
  axis: FamilyAxis | null
  /** The parent's own terminal. It stays in the same place in the tree whatever the axis, so it never remounts. */
  parent: ReactNode
  /**
   * The tab's own report note, above the terminal, when the session in this tab
   * is itself a child that has reported. It is a slot beside the terminal, so
   * its coming and going never remounts the terminal.
   */
  note?: ReactNode
  /** The children (`FamilyKids`), drawn only while there is an axis. */
  children?: ReactNode
}

/**
 * The parent's terminal on the pane's long side at its fixed share, and the
 * children on the rest. The share is the same for any number of cards and
 * headers, which is what keeps the parent's terminal from reflowing as they
 * shrink, swap, end or close.
 */
export function FamilyFrame({ axis, parent, note, children }: FamilyFrameProps): JSX.Element {
  return (
    <div
      data-family-view={axis ?? undefined}
      className={cn('flex size-full min-h-0 min-w-0', axis === 'row' ? 'flex-col' : 'flex-row')}
    >
      <div
        data-family-parent
        className="relative min-h-0 min-w-0"
        style={{ flex: axis === null ? '1 1 0%' : `0 0 ${String(Math.round(FAMILY_PARENT_SHARE * 1000) / 10)}%` }}
      >
        <div className="absolute inset-0 flex flex-col">
          {note}
          <div className="relative min-h-0 flex-1">
            <div className="absolute inset-0">{parent}</div>
          </div>
        </div>
      </div>
      {axis !== null && children}
    </div>
  )
}

export interface FamilyKidsProps {
  axis: FamilyAxis
  /** The cards, each a `FamilyCard`. */
  cards: ReactNode
  /** How many cards there are, so a family with none says what to press. */
  cardCount: number
  /** The shrunk and ended children, each a `ChildHeader`. */
  headers: ReactNode
  /** The most height the headers take before they scroll, so the cards keep their rows. */
  headersMax: number
}

/**
 * The children's share of the tab: the cards side by side in a row, or stacked
 * in a column, and the one-line headers at the end of them.
 */
export function FamilyKids({ axis, cards, cardCount, headers, headersMax }: FamilyKidsProps): JSX.Element {
  return (
    <div
      data-family-kids
      className={cn(
        'flex min-h-0 min-w-0 flex-1 basis-0 flex-col border-border-strong bg-surface',
        axis === 'column' ? 'border-l' : 'border-t'
      )}
    >
      {cardCount > 0 ? (
        <div
          data-family-cards
          className={cn(
            'flex min-h-0 min-w-0 flex-1 basis-0 divide-border-strong',
            axis === 'column' ? 'flex-col divide-y' : 'flex-row divide-x'
          )}
        >
          {cards}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 basis-0 place-items-center p-3 text-center text-[11.5px] text-fg-subtle">
          Press a header to show that child here.
        </div>
      )}
      <div data-family-headers className="shrink-0 overflow-y-auto" style={{ maxHeight: headersMax }}>
        {headers}
      </div>
    </div>
  )
}

/**
 * A card: the child's terminal under its header, on the terminal's own ground,
 * and between them the child's report when it has one (`ReportNote`).
 */
export function FamilyCard({
  header,
  note,
  children,
  name
}: {
  header: ReactNode
  /** The report note under the header, or nothing. */
  note?: ReactNode
  /** The child's terminal. */
  children: ReactNode
  name: string
}): JSX.Element {
  return (
    <div
      data-family-card={name}
      className="relative flex min-h-0 min-w-0 flex-1 basis-0 flex-col bg-terminal"
    >
      {header}
      {note}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">{children}</div>
      </div>
    </div>
  )
}

export interface ReportNoteProps {
  /** What the report is: "Reported done", "Reported stuck" or "Note". */
  label: string
  /** All of the report, in the child's own words. */
  text: string
}

/**
 * A child's report as a note under its card's header (or above its terminal,
 * in a child's own tab): what it is and the start of what it says on one line,
 * in `accent-text` on `accent-soft`, with the 2px accent edge a selected row
 * wears, drawn inside the note as a zero-blur inset line. Pressing it shows
 * all of the report, wrapped, and pressing it again folds it back to the line.
 *
 * What the note says and whether there is one are decided where the window
 * keeps its sessions (`reportNote`); a card with no report is drawn without
 * this. A new report is a new note, so the card keys it by the report and it
 * starts folded.
 */
export function ReportNote({ label, text }: ReportNoteProps): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <button
      type="button"
      data-family-note
      onClick={() => setOpen((was) => !was)}
      aria-expanded={open}
      className="flex min-h-[30px] w-full shrink-0 cursor-pointer items-baseline gap-2 border-b border-border bg-accent-soft pt-[7px] pr-2.5 pb-1.5 pl-3 text-left text-[11.5px] leading-[1.45] text-accent-text shadow-[inset_2px_0_0_var(--color-accent)] hover:bg-accent-soft-hover focus-visible:outline-offset-[-2px]"
    >
      <span data-family-note-label className="shrink-0 font-medium">
        {label}
      </span>
      <span
        data-family-note-text
        className={cn('min-w-0 overflow-hidden text-ellipsis', open ? 'whitespace-normal' : 'whitespace-nowrap')}
      >
        {text}
      </span>
    </button>
  )
}

/** How a child shows in its parent's tab. */
export type ChildHeaderShape =
  /** A running child's card: its terminal is under this header. */
  | 'card'
  /** An ended child's last screen, input off, under this header. */
  | 'screen'
  /** A running child shrunk to this header. */
  | 'header'
  /** An ended child as this header, saying how and when. */
  | 'ended'

export interface ChildHeaderProps {
  shape: ChildHeaderShape
  name: string
  /** What its dot says. */
  state: SessionState
  /** Its role, drawn as a tag on a card; null for a child started with none. */
  role?: string | null | undefined
  /** The state and for how long ("Working · 4m"), or how and when it ended ("Stopped · 14:52"). */
  status: string
  /** The header pressed: a card or last screen shrinks, a header shows as a card, an ended header opens its last screen. */
  onPress: () => void
  /** A running card's Open as tab. */
  onOpenAsTab?: (() => void) | undefined
  /** A running card's Stop, which the window asks about before it ends the child. */
  onStop?: (() => void) | undefined
  /** An ended child's Close, which takes it out of the family view. */
  onClose?: (() => void) | undefined
}

/** Line height is the font's own, as the frame's buttons have it: with 1px of padding and border they stand about 17px tall in the 26px header. */
const SMALL_BUTTON =
  'shrink-0 whitespace-nowrap rounded-well border px-[5px] py-px text-[10.5px] font-medium leading-[normal] transition-colors'

/**
 * A child's one-line header.
 *
 * On a card it carries the state dot, the name, the role as a tag, the state
 * and for how long, then Open as tab and Stop. Shrunk it is the dot, the name
 * and the state; ended it says how and when with Close. Pressing the words
 * is the header's one action, and the buttons are beside it, never inside it.
 */
export function ChildHeader({
  shape,
  name,
  state,
  role,
  status,
  onPress,
  onOpenAsTab,
  onStop,
  onClose
}: ChildHeaderProps): JSX.Element {
  const open = shape === 'card' || shape === 'screen'
  return (
    <div
      data-family-header={shape}
      className={cn(
        'flex min-w-0 shrink-0 items-center gap-0.5 bg-surface pr-[3px]',
        open ? 'border-b border-border' : 'border-t border-border'
      )}
      style={{ height: FAMILY_HEADER_PX }}
    >
      <button
        type="button"
        onClick={onPress}
        aria-expanded={open}
        aria-label={`${open ? 'Shrink' : 'Show'} ${name}, ${status}`}
        className="flex h-full min-w-0 flex-1 items-center gap-1 whitespace-nowrap pr-1 pl-[7px] text-left text-[11.5px] text-fg transition-colors hover:bg-hover focus-visible:outline-offset-[-2px]"
      >
        <span
          aria-hidden
          title={SESSION_STATE_LABEL[state]}
          data-family-dot={state}
          className={cn('size-1.5 shrink-0 rounded-full', SESSION_STATE_DOT[state])}
        />
        <span className="shrink-0 font-medium">{name}</span>
        {open && role !== undefined && role !== null && role !== '' && (
          <span
            data-family-role
            className="shrink-0 rounded-full bg-accent-soft px-[5px] text-[10px] leading-4 font-medium text-accent-text"
          >
            {role}
          </span>
        )}
        <span data-family-status className="ml-auto min-w-0 truncate pl-0.5 text-[10.5px] text-fg-muted">
          {status}
        </span>
      </button>
      {onOpenAsTab !== undefined && (
        <button
          type="button"
          onClick={onOpenAsTab}
          aria-label={`Open ${name} as a tab`}
          className={cn(SMALL_BUTTON, 'border-border-strong text-fg hover:bg-hover')}
        >
          Open as tab
        </button>
      )}
      {onStop !== undefined && (
        <button
          type="button"
          onClick={onStop}
          aria-label={`Stop ${name}`}
          className={cn(SMALL_BUTTON, 'border-danger/45 text-danger hover:bg-danger/10')}
        >
          Stop
        </button>
      )}
      {onClose !== undefined && (
        <button
          type="button"
          onClick={onClose}
          aria-label={`Close ${name}`}
          className={cn(SMALL_BUTTON, 'border-border-strong text-fg hover:bg-hover')}
        >
          Close
        </button>
      )}
    </div>
  )
}
