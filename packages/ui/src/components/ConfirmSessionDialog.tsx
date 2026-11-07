import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { cn } from '../lib/cn'
import { ChildMarkIcon, type ChildMarkView } from './ChildMark'
import { TerminalIcon } from './icons'
import { Overlay } from './Overlay'

/** A session started by the one whose tab closes, as the question lists it. */
export interface ConfirmChild {
  id: number
  name: string
  /** Its dot, or a terminal glyph for a command. */
  mark: ChildMarkView
  /** At the right, in mono: its role and branch, or `command` for one that runs a command. */
  meta: string
}

export interface ConfirmSessionDialogProps {
  /**
   * Ending one tab's session, ending sessions because Helm is quitting, or
   * stopping this PC's host, which ends every session in it.
   */
  kind: 'close-session' | 'quit' | 'stop-host' | 'restart-host'
  message: string
  detail: string
  /**
   * The folder `detail` names, as it appears there. Set in mono, as machine
   * data is; `detail` reads as written when it does not hold it.
   */
  folder?: string | undefined
  /** What the agreeing button says; main decides, because it counts them. */
  confirmLabel: string
  /**
   * How the agreeing button is drawn: `danger` (the default) when agreeing
   * ends something, `primary` when it ends nothing, such as a restart that
   * hands every session over.
   */
  confirmTone?: 'danger' | 'primary' | undefined
  /**
   * The quit question's third answer: quit and leave them running in the
   * host. No button without it.
   */
  keepLabel?: string | undefined
  /** The sessions this ends. Listed unless the message already names the only one. */
  sessionNames: readonly string[]
  /**
   * Closing a parent: the running children that end with it, listed with their
   * dot or glyph in place of `sessionNames`, which names the same sessions.
   */
  ends?: readonly ConfirmChild[] | undefined
  /** Closing a parent: the running children started to outlive it, named in a sentence. They keep running. */
  outlives?: readonly ConfirmChild[] | undefined
  onConfirm: () => void
  onKeep?: (() => void) | undefined
  onCancel: () => void
}

/**
 * The detail sentence with the folder it names set as machine data: mono, in
 * the body colour, and free to break anywhere, since a path has no spaces to
 * wrap at. Only the first mention is set; a sentence names its folder once.
 */
function DetailText({ detail, folder }: { detail: string; folder: string | undefined }): JSX.Element {
  const at = folder === undefined || folder === '' ? -1 : detail.indexOf(folder)
  if (folder === undefined || at < 0) return <>{detail}</>
  return (
    <>
      {detail.slice(0, at)}
      <span data-confirm-folder className="font-mono text-[11.5px] text-fg [overflow-wrap:anywhere]">
        {folder}
      </span>
      {detail.slice(at + folder.length)}
    </>
  )
}

/** The children started to outlive the parent, in one sentence: they go on after it ends. */
function outlivesSentence(items: readonly ConfirmChild[]): string {
  const names = items.map(({ name }) => name)
  const last = names.pop()
  const who = names.length === 0 ? (last ?? '') : `${names.join(', ')} and ${last ?? ''}`
  return items.length === 1
    ? `${who} was started to outlive it and keeps running.`
    : `${who} were started to outlive it and keep running.`
}

/**
 * The children a parent's close names, one row each: the mark, the name and,
 * in mono at the right, what it is. Past the limit the rest are counted.
 */
function ChildList({ kind, items }: { kind: 'ends'; items: readonly ConfirmChild[] }): JSX.Element {
  const listed = items.slice(0, LIST_LIMIT)
  const rest = items.length - listed.length
  return (
    <ul data-confirm-children={kind} className="mt-3 space-y-0.5">
      {listed.map(({ id, name, mark, meta }) => (
        <li
          key={id}
          data-confirm-child={id}
          className="flex h-[26px] items-center gap-2 rounded-raised bg-surface-raised px-2 text-[12.5px] text-fg"
        >
          <ChildMarkIcon mark={mark} />
          <span className="min-w-0 truncate" title={name}>
            {name}
          </span>
          <span className="ml-auto shrink-0 truncate font-mono text-[11px] text-fg-subtle">{meta}</span>
        </li>
      ))}
      {rest > 0 && (
        <li className="px-2 text-[11px] text-fg-subtle">
          and {rest} more session{rest === 1 ? '' : 's'}
        </li>
      )}
    </ul>
  )
}

/** Above this many, the list is summarised rather than printed - a quit that
 * ends a dozen sessions should not push its own buttons off the screen. */
const LIST_LIMIT = 6

/**
 * The confirmation before a live `claude` session is killed.
 *
 * This was `dialog.showMessageBox` until it wasn't. A native message box is a
 * Win32 window: system typeface, system ground, a blue circled "i", and no
 * amount of configuration makes it a Helm island. It also said less than it
 * could - it named one session and never the others a quit was about to end.
 *
 * Cancel is the default. The destructive button has to be chosen deliberately,
 * and Escape and the backdrop both mean "no", because the cost of the two
 * answers is not symmetric: cancelling costs a click, agreeing costs whatever
 * the session had not finished saying.
 */
export function ConfirmSessionDialog({
  kind,
  message,
  detail,
  folder,
  confirmLabel,
  confirmTone = 'danger',
  keepLabel,
  sessionNames,
  ends = [],
  outlives = [],
  onConfirm,
  onKeep,
  onCancel
}: ConfirmSessionDialogProps): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Focus lands on Cancel, not on the destructive button: a stray Enter from
  // the terminal the user was just typing into must not end the session.
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  const listed = sessionNames.slice(0, LIST_LIMIT)
  const rest = sessionNames.length - listed.length
  // One session the message already names is not listed again: that would be
  // the same string twice. One it only counts is.
  const only = sessionNames.length === 1 ? sessionNames[0] : undefined
  const family = ends.length > 0 || outlives.length > 0
  const list = !family && (sessionNames.length > 1 || (only !== undefined && !message.includes(only)))

  return (
    // Escape and the backdrop both mean "no", and both are `Overlay`'s - see
    // its header for why the scrim is not described here any more.
    <Overlay
      role="alertdialog"
      aria-label={message}
      data-confirm-session={kind}
      className="max-w-[440px]"
      onDismiss={onCancel}
    >
      <div className="px-[22px] pt-[18px]">
        <header className="flex items-start gap-[9px]">
          <TerminalIcon width={13} height={13} className="mt-[3px] shrink-0 text-accent" />
          <h2 className="text-[15px] leading-[1.35] font-medium tracking-tight text-fg">
            {message}
          </h2>
        </header>

        <p className="mt-2 text-[12px] leading-[1.55] text-fg-muted">
          <DetailText detail={detail} folder={folder} />
        </p>

        {ends.length > 0 && <ChildList kind="ends" items={ends} />}
        {outlives.length > 0 && (
          <p data-confirm-outlives className="mt-3 text-[12px] leading-[1.55] text-fg-muted">
            {outlivesSentence(outlives)}
          </p>
        )}

        {list && (
          <ul className="mt-3 space-y-0.5 rounded-raised border border-border bg-surface-raised px-3 py-2">
            {listed.map((name) => (
              <li key={name} className="truncate font-mono text-[11px] text-fg-muted" title={name}>
                {name}
              </li>
            ))}
            {rest > 0 && (
              <li className="text-[11px] text-fg-subtle">
                and {rest} more session{rest === 1 ? '' : 's'}
              </li>
            )}
          </ul>
        )}
      </div>

      <footer className="mx-[22px] mt-4 flex shrink-0 items-center justify-end gap-2 border-t border-border py-3.5">
        <button
          ref={cancelRef}
          type="button"
          data-confirm-cancel
          onClick={onCancel}
          className={cn(
            'rounded-well border border-border-strong px-3.5 py-1.5 text-[12px] text-fg',
            'transition-colors hover:bg-hover',
            // `:focus`, not the global `:focus-visible`. Focus is placed here
            // by script when the dialog opens, and Chromium does not count
            // that as visible focus - so the ring the rest of the app gets
            // for free never paints, and the one button Enter would press
            // looks no different from the one it would not. The indication is
            // the form-field one - border turns accent, no offset ring - and
            // the global ring is suppressed so tabbing here matches opening.
            'focus:border-accent focus:outline-none'
          )}
        >
          Cancel
        </button>
        {keepLabel !== undefined && onKeep !== undefined && (
          // Not destructive: the sessions go on running. A plain bordered
          // button beside Cancel, and never the default.
          <button
            type="button"
            data-confirm-keep
            onClick={onKeep}
            className="rounded-well border border-border-strong px-3.5 py-1.5 text-[12px] text-fg transition-colors hover:bg-hover"
          >
            {keepLabel}
          </button>
        )}
        <button
          type="button"
          data-confirm-accept={confirmTone}
          onClick={onConfirm}
          className={cn(
            'rounded-well border px-3.5 py-1.5 text-[12px] font-medium transition-colors',
            // Danger is carried by the text and the hover wash, not by a
            // solid fill: the accent never solid-fills anything and neither
            // does this (DESIGN.md). An answer that ends nothing is the
            // primary button, outlined in the accent.
            confirmTone === 'danger'
              ? 'border-danger/50 text-danger hover:bg-danger/10'
              : 'border-accent text-accent-text hover:bg-accent-soft'
          )}
        >
          {confirmLabel}
        </button>
      </footer>
    </Overlay>
  )
}
