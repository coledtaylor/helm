import type { JSX, ReactNode, Ref } from 'react'
import { cn } from '../lib/cn'
import { shortcutLabel } from '../lib/platform'
import { ChildMarkIcon, type ChildMarkView } from './ChildMark'
import { CloseIcon, MaximizeIcon, SplitIcon, UnmaximizeIcon } from './icons'

/** "First pane", "Second pane", ... and past the words, "Pane 9". */
const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth']

export function paneName(index: number): string {
  const word = ORDINALS[index]
  return word === undefined ? `Pane ${String(index + 1)}` : `${word} pane`
}

export interface PaneGroupProps {
  /** Its place in reading order, which names it: `data-pane-group="0"`, "First pane". */
  index: number
  /** Its group's id, which stays its own while panes move around it: `data-pane-id`. */
  id: number
  /** The pane a new tab opens into and the keyboard means. */
  focused: boolean
  /**
   * A session in this pane is waiting on you. The island's edge turns amber,
   * so the pane that needs you is findable before any of its tabs is read.
   */
  attention: boolean
  /** The tab strip, or nothing for an empty pane. */
  strip?: ReactNode | undefined
  /** The crumb row under the strip, for a tab that has one. */
  crumb?: ReactNode | undefined
  /** The drop zones for a dragged tab (`PaneDrop`), drawn over the pane. */
  drop?: ReactNode | undefined
  /** The body, measured by the caller to open a pty at the right size. */
  bodyRef?: Ref<HTMLDivElement> | undefined
  /** Any press inside the pane gives it the focus. */
  onFocus: () => void
  children: ReactNode
}

/**
 * The pane and its body clip what overflows them, but only this far past their
 * edge: the page's focus ring is 2px wide at 2px offset, so a control that
 * fills the pane's width or sits at its top (a report note) is drawn whole in
 * the gutter instead of cut off at the island's edge. `overflow-clip` rather
 * than `overflow-hidden`, because `overflow-clip-margin` applies to it alone.
 * The margin widens the clip's rounded corners too, which leaves a terminal's
 * square ground showing at the island's bottom corners, so the body also takes
 * `pane-body` (theme.css), a clip of its own that keeps those corners round.
 */
export const FOCUS_RING_ROOM = '[overflow-clip-margin:4px]'

/**
 * One pane: an island holding a tab strip, a crumb row and whatever the front
 * tab shows.
 *
 * The focus is taken on `pointerdown` in **capture**, before anything inside
 * sees the press - so clicking into a terminal, a list or the strip all make
 * this the pane a new tab opens into, and none of them has to know that panes
 * exist.
 */
export function PaneGroup({
  index,
  id,
  focused,
  attention,
  strip,
  crumb,
  drop,
  bodyRef,
  onFocus,
  children
}: PaneGroupProps): JSX.Element {
  return (
    <section
      data-pane-group={index}
      data-pane-id={id}
      data-pane-focused={focused ? 'true' : undefined}
      data-pane-attention={attention ? 'true' : undefined}
      aria-label={paneName(index)}
      onPointerDownCapture={focused ? undefined : onFocus}
      className={cn(
        'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-clip rounded-island border bg-surface transition-colors',
        FOCUS_RING_ROOM,
        attention ? 'border-warn/45' : 'border-border'
      )}
    >
      {strip}
      {crumb}
      <div ref={bodyRef} className={cn('pane-body relative min-h-0 flex-1 overflow-clip', FOCUS_RING_ROOM)}>
        {children}
      </div>
      {drop}
    </section>
  )
}

/** A tone for the crumb's status, from the session's state. */
export type CrumbTone = 'accent' | 'warn' | 'success' | 'danger' | 'subtle'

const CRUMB_TONE: Record<CrumbTone, string> = {
  accent: 'text-accent-text',
  warn: 'text-warn',
  success: 'text-success',
  danger: 'text-danger',
  subtle: 'text-fg-subtle'
}

/**
 * One child of the session in front, as a chip in its crumb: its dot or
 * glyph and its name. The chips stand in for the family view in a pane that
 * has no room for it, so the children are on screen with the sidebar closed.
 */
export interface CrumbChip {
  /** Names the chip to the window, which finds it to place the peek under it. */
  chipKey: string
  name: string
  mark: ChildMarkView
  /** What the mark says in words, for the chip's label. */
  stateLabel: string
  /** The child waits on a person: its words are in warn. */
  needsYou: boolean
  /** Its peek is open, opened from this chip. */
  open: boolean
  onPress: () => void
}

export interface PaneCrumbProps {
  /** Where the session is: its project, as named in the tree. */
  place: string
  /** The children of the session, as chips, when its pane has no room for the family view. */
  chips?: readonly CrumbChip[] | undefined
  /** The branch its folder was on when it started, when it is a repository. */
  branch?: string | null | undefined
  /** The profile it was launched from, if it was one. */
  profile?: string | null | undefined
  /** What it is doing, and for how long. */
  status?: { text: string; tone: CrumbTone } | undefined
  /** Hover text for the place - the full working directory. */
  hint?: string | undefined
}

/**
 * The row under a session's tab: project › branch · profile, and on the right
 * what the session is doing and for how long.
 *
 * The tab above is one line, so what told two sessions on one project apart -
 * the branch - lives here, in mono, where it has the whole width of the pane to
 * be read in rather than a 240px tab's second line.
 */
export function PaneCrumb({ place, chips, branch, profile, status, hint }: PaneCrumbProps): JSX.Element {
  const withChips = chips !== undefined && chips.length > 0
  return (
    <div
      data-pane-crumb
      className="flex h-[26px] shrink-0 items-center gap-1.5 border-b border-border px-3 font-mono text-[11px] text-fg-subtle"
    >
      <span data-crumb="place" title={hint} className="min-w-0 shrink-0 truncate text-fg-muted">
        {place}
      </span>
      {branch !== null && branch !== undefined && branch !== '' && (
        <>
          <span aria-hidden>›</span>
          <span data-crumb="branch" className="min-w-0 truncate">
            {branch}
          </span>
        </>
      )}
      {profile !== null && profile !== undefined && profile !== '' && (
        <>
          <span aria-hidden>·</span>
          <span data-crumb="profile" className="min-w-0 truncate">
            {profile} profile
          </span>
        </>
      )}
      {/* The status takes only the room the place, branch and profile leave,
          right-aligned in it: a program's error message can be 200 characters,
          so it ends in an ellipsis rather than squeezing the branch, and its
          hover text has it whole. */}
      {withChips && (
        // The chips take the room the place leaves, at the end of the row,
        // with the status after them, as the design draws it.
        <span data-crumb="chips" className="ml-auto flex min-w-0 shrink-0 gap-1 overflow-hidden">
          {chips.map((chip) => (
            <button
              key={chip.chipKey}
              type="button"
              data-crumb-chip={chip.chipKey}
              aria-haspopup="dialog"
              aria-expanded={chip.open}
              aria-label={`${chip.name}, ${chip.stateLabel}, peek`}
              onClick={chip.onPress}
              className={cn(
                'inline-flex h-[18px] shrink-0 items-center gap-[5px] rounded-full border-0 bg-surface-raised px-[7px] font-sans text-[11px] whitespace-nowrap transition-colors focus-visible:outline-offset-[-1px]',
                chip.needsYou ? 'text-warn hover:bg-active' : 'text-fg-muted hover:bg-active hover:text-fg',
                chip.open && 'bg-active',
                chip.open && !chip.needsYou && 'text-fg'
              )}
            >
              <ChildMarkIcon mark={chip.mark} />
              {chip.name}
            </button>
          ))}
        </span>
      )}
      {status !== undefined && (
        <span
          data-crumb="status"
          title={status.text}
          className={cn(
            'min-w-0 truncate text-right font-sans tabular-nums',
            // Without chips the status takes the rest of the row; with them
            // the chips are pushed to the end and the status follows.
            withChips ? 'shrink pl-1.5' : 'flex-1 basis-0',
            CRUMB_TONE[status.tone]
          )}
        >
          {status.text}
        </span>
      )}
    </div>
  )
}

/**
 * A pane's own controls at the end of its strip: split, maximize and, while
 * there is more than one pane, close.
 *
 * Close hands the pane's tabs to the pane that takes its room rather than
 * closing them - a control on the pane that ended the sessions in it would be
 * a destructive button dressed as a layout one.
 */
export function PaneActions({
  split,
  maximized,
  canMaximize,
  canClose,
  onSplit,
  onMaximize,
  onClose
}: {
  /**
   * What the split button would do with the front tab: open a pane of its own
   * for it, move it to the pane beside this one (`besideOf`), or - for a lone
   * tab in a lone pane - nothing, in which case there is no button.
   */
  split: 'new' | 'other' | null
  maximized: boolean
  canMaximize: boolean
  canClose: boolean
  onSplit: () => void
  onMaximize: () => void
  onClose: () => void
}): JSX.Element {
  return (
    <>
      {split !== null && (
        <PaneButton
          label={
            split === 'new'
              ? `Split: move this tab to a pane of its own (${shortcutLabel('\\')})`
              : `Move this tab to the pane beside it (${shortcutLabel('\\')})`
          }
          onClick={onSplit}
          data-pane-split={split}
        >
          <SplitIcon width={14} height={14} />
        </PaneButton>
      )}
      {canMaximize && (
        <PaneButton
          label={maximized ? 'Restore the panes' : 'Give this pane the whole window'}
          onClick={onMaximize}
          data-maximize={maximized ? 'restore' : 'pane'}
        >
          {maximized ? (
            <UnmaximizeIcon width={13} height={13} />
          ) : (
            <MaximizeIcon width={13} height={13} />
          )}
        </PaneButton>
      )}
      {canClose && (
        <PaneButton label="Close this pane, keeping its tabs" onClick={onClose} data-pane-close>
          <CloseIcon width={13} height={13} />
        </PaneButton>
      )}
    </>
  )
}

function PaneButton({
  label,
  onClick,
  children,
  ...rest
}: {
  label: string
  onClick: () => void
  children: ReactNode
} & Record<`data-${string}`, unknown>): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid size-[26px] shrink-0 place-items-center rounded-raised text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
      {...rest}
    >
      {children}
    </button>
  )
}
