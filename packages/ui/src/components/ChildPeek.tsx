import type { JSX, ReactNode, RefObject } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { usePopup, type PopupAnchor } from '../lib/popup'
import { ChildMarkIcon, type ChildMarkView } from './ChildMark'
import { CloseIcon } from './icons'

/** How a state chip is toned: the same tones the state dots use. */
export type PeekTone = 'working' | 'needs' | 'idle' | 'danger' | 'neutral'

const TONE: Record<PeekTone, string> = {
  working: 'border-accent/40 text-accent-text',
  needs: 'border-warn/40 text-warn',
  idle: 'border-success/40 text-success',
  danger: 'border-danger/40 text-danger',
  neutral: 'border-border-strong text-fg-muted'
}

export interface ChildPeekProps {
  /** The child, as every surface names it. */
  name: string
  mark: ChildMarkView
  /** What it is doing, in a word or two ("working", "needs you"). */
  state: { label: string; tone: PeekTone }
  /** An agent child's role, or null for one started with none. Ignored for a command. */
  role: string | null
  /** A command child's command line; undefined for an agent child, which has a role and a mode. */
  command?: string | undefined
  /** The folder it runs in, as named on screen, and the whole path for its hover text. */
  folder: string
  folderPath?: string | undefined
  /** The branch the folder was on, or null. */
  branch: string | null
  /** The permission mode it was launched in, or null. Ignored for a command. */
  mode: string | null
  /** Where a command child runs, when the window knows ("your shell, pwsh"). */
  runsIn?: string | undefined
  /** What it last told its parent: its state ("done") and its words; null when it has told nothing. */
  report: { state: string; text: string } | null
  /** The child's screen, live and read-only. */
  screen: ReactNode
  /** Where the popover goes: beside a row (a point), or under a chip. */
  at: PopupAnchor
  /** The row or chip it opened from, whose press is not outside the peek. */
  anchorRef?: RefObject<HTMLElement | null> | undefined
  onClose: () => void
  /** Stop: the window asks before it ends the child. Settles when the question is answered. */
  onStop: () => Promise<void> | void
  onOpen: () => void
}

const BUTTON = 'rounded-well border px-[9px] py-[3px] text-[11.5px] font-medium whitespace-nowrap transition-colors'

/**
 * The peek: a popover beside the row, or under the crumb chip, it was opened
 * from, for a running child that has nowhere on screen here. It shows the
 * child's screen live and read-only, who it is (its role, or its command), its
 * folder, branch and mode, what it last reported, and Stop and Open.
 *
 * It is an overlay (`usePopup`), so a browser tab's native view stands down for
 * it; Escape and its close button close it, and so does a press outside it. The
 * press that answers Stop's question is not outside: the peek holds open while
 * the question is up, and closes when the child ends. Focus goes to the close
 * button when it opens and back to what had it when it closes, which is the row
 * or chip the user pressed.
 *
 * Drawing only: the screen is a slot, and every button is the window's.
 */
export function ChildPeek({
  name,
  mark,
  state,
  role,
  command,
  folder,
  folderPath,
  branch,
  mode,
  runsIn,
  report,
  screen,
  at,
  anchorRef,
  onClose,
  onStop,
  onOpen
}: ChildPeekProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const [asking, setAsking] = useState(false)
  const place = usePopup({ ref, at, anchorRef, holdOpen: asking, onDismiss: onClose })

  // Focus: the close button while it is open, and back where it came from.
  useEffect(() => {
    const before = document.activeElement
    closeRef.current?.focus({ preventScroll: true })
    return () => {
      if (!(before instanceof HTMLElement) || !before.isConnected) return
      const now = document.activeElement
      // The peek is gone, so focus it held fell to the body.
      if (now === null || now === document.body) before.focus({ preventScroll: true })
    }
  }, [])

  // Escape closes it, except while the question about stopping is up: that
  // dialog's own Escape means "no", and the peek stays for it.
  useEffect(() => {
    if (asking) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [asking, onClose])

  const stop = (): void => {
    setAsking(true)
    void Promise.resolve(onStop()).finally(() => setAsking(false))
  }

  const rows: Array<{ label: string; value: string; title?: string | undefined; strong?: boolean }> =
    command === undefined
      ? [
          { label: 'Role', value: role ?? 'none' },
          { label: 'Folder', value: folder, title: folderPath },
          { label: 'Branch', value: branch ?? 'none' },
          { label: 'Mode', value: mode ?? 'default' }
        ]
      : [
          { label: 'Command', value: command, title: command, strong: true },
          { label: 'Folder', value: folder, title: folderPath },
          { label: 'Branch', value: branch ?? 'none' },
          ...(runsIn === undefined ? [] : [{ label: 'Runs in', value: runsIn }])
        ]

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-child-peek={name}
      style={{
        position: 'fixed',
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        visibility: place === null ? 'hidden' : 'visible'
      }}
      className="z-50 flex w-[560px] max-w-[calc(100vw-16px)] flex-col rounded-well border border-border-strong bg-surface-raised"
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <ChildMarkIcon mark={mark} />
        <span id={titleId} className="min-w-0 truncate text-[13px] font-medium text-fg">
          {name}
        </span>
        <span
          data-peek-state={state.tone}
          className={cn('shrink-0 rounded-full border px-[7px] py-px text-[10.5px] font-medium', TONE[state.tone])}
        >
          {state.label}
        </span>
        <button
          ref={closeRef}
          type="button"
          aria-label="Close peek"
          onClick={onClose}
          className="ml-auto grid size-[22px] shrink-0 place-items-center rounded-well text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
        >
          <CloseIcon width={11} height={11} />
        </button>
      </div>

      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-3 pb-2 text-[11.5px]">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-fg-subtle">{row.label}</dt>
            <dd
              title={row.title}
              className={cn(
                'm-0 truncate font-mono text-[11px]',
                row.strong === true ? 'text-fg' : 'text-fg-muted'
              )}
            >
              {row.value}
            </dd>
          </div>
        ))}
      </dl>

      <div
        data-peek-screen
        className="relative mx-3 h-[190px] overflow-hidden rounded-raised border border-border bg-terminal"
      >
        {screen}
      </div>

      {report !== null && (
        <div
          data-peek-report
          className="mx-3 mt-2 rounded-r-raised bg-accent-soft px-2.5 py-2 text-[11.5px] leading-[1.45] text-fg shadow-[inset_2px_0_0_var(--color-accent)]"
        >
          <span className="mb-0.5 block text-[10px] leading-[1.4] font-medium tracking-[0.07em] text-fg-subtle uppercase">
            Last report · {report.state}
          </span>
          <span>{report.text}</span>
        </div>
      )}

      <div className="flex items-center gap-1.5 px-3 py-2.5">
        <span className="mr-auto text-[11px] text-fg-subtle">Watching only. Open it to type.</span>
        <button
          type="button"
          data-peek-stop
          onClick={stop}
          className={cn(BUTTON, 'border-danger/45 text-danger hover:bg-danger/10')}
        >
          Stop
        </button>
        <button
          type="button"
          data-peek-open
          onClick={onOpen}
          className={cn(BUTTON, 'border-accent text-accent-text hover:bg-accent-soft')}
        >
          Open
        </button>
      </div>
    </div>
  )
}
