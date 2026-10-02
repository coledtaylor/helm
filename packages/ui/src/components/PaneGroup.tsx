import type { JSX, ReactNode, Ref } from 'react'
import { cn } from '../lib/cn'
import { CloseIcon, MaximizeIcon, SplitIcon, UnmaximizeIcon } from './icons'

export interface PaneGroupProps {
  /** Its place in the row, for the drivers: `data-pane-group="0"`. */
  index: number
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
  /** Layout classes from the row: which side of the split this is. */
  className?: string | undefined
  /** The body, measured by the caller to open a pty at the right size. */
  bodyRef?: Ref<HTMLDivElement> | undefined
  /** Any press inside the pane gives it the focus. */
  onFocus: () => void
  children: ReactNode
}

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
  focused,
  attention,
  strip,
  crumb,
  className,
  bodyRef,
  onFocus,
  children
}: PaneGroupProps): JSX.Element {
  return (
    <section
      data-pane-group={index}
      data-pane-focused={focused ? 'true' : undefined}
      data-pane-attention={attention ? 'true' : undefined}
      aria-label={index === 0 ? 'First pane' : 'Second pane'}
      onPointerDownCapture={focused ? undefined : onFocus}
      className={cn(
        'flex min-h-0 min-w-0 flex-col overflow-hidden rounded-island border bg-surface transition-colors',
        attention ? 'border-warn/45' : 'border-border',
        className
      )}
    >
      {strip}
      {crumb}
      <div ref={bodyRef} className="relative min-h-0 flex-1 overflow-hidden">
        {children}
      </div>
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

export interface PaneCrumbProps {
  /** Where the session is: its project, as named in the tree. */
  place: string
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
export function PaneCrumb({ place, branch, profile, status, hint }: PaneCrumbProps): JSX.Element {
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
      <span className="flex-1" />
      {status !== undefined && (
        <span
          data-crumb="status"
          className={cn('shrink-0 font-sans tabular-nums', CRUMB_TONE[status.tone])}
        >
          {status.text}
        </span>
      )}
    </div>
  )
}

/**
 * A pane's own controls at the end of its strip: split, maximize and, on the
 * second pane, close.
 *
 * Close hands the pane's tabs to the other one rather than closing them - a
 * control on the pane that ended the sessions in it would be a destructive
 * button dressed as a layout one.
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
   * for it, move it to the pane already beside this one, or - for a lone tab
   * in a lone pane - nothing, in which case there is no button.
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
              ? 'Split: move this tab to a pane of its own (Ctrl+\\)'
              : 'Move this tab to the other pane (Ctrl+\\)'
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
