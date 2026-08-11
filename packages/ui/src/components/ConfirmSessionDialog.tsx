import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { cn } from '../lib/cn'
import { TerminalIcon } from './icons'

export interface ConfirmSessionDialogProps {
  /** Ending one tab's session, or ending every session because Helm is quitting. */
  kind: 'close-session' | 'quit'
  message: string
  detail: string
  /** What the agreeing button says; main decides, because it counts them. */
  confirmLabel: string
  /** The sessions this ends. Listed when there is more than one. */
  sessionNames: readonly string[]
  onConfirm: () => void
  onCancel: () => void
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
  confirmLabel,
  sessionNames,
  onConfirm,
  onCancel
}: ConfirmSessionDialogProps): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Focus lands on Cancel, not on the destructive button: a stray Enter from
  // the terminal the user was just typing into must not end the session.
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const listed = sessionNames.slice(0, LIST_LIMIT)
  const rest = sessionNames.length - listed.length

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={message}
        data-confirm-session={kind}
        className={cn(
          // The modal island, same as NewHarnessDialog: 12px radius, stronger
          // hairline, and the one shadow the system allows (DESIGN.md).
          'flex max-h-full w-full max-w-[440px] flex-col overflow-hidden rounded-xl',
          'border border-border-strong bg-surface shadow-panel'
        )}
      >
        <div className="px-[22px] pt-[18px]">
          <header className="flex items-start gap-[9px]">
            <TerminalIcon width={13} height={13} className="mt-[3px] shrink-0 text-accent" />
            <h2 className="text-[15px] leading-[1.35] font-medium tracking-tight text-fg">
              {message}
            </h2>
          </header>

          <p className="mt-2 text-[12px] leading-[1.55] text-fg-muted">{detail}</p>

          {/* One session is already named in the message; listing it again
              would be the same string twice. */}
          {sessionNames.length > 1 && (
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
          <button
            type="button"
            data-confirm-accept
            onClick={onConfirm}
            className={cn(
              // Danger is carried by the text and the hover wash, not by a
              // solid fill: the accent never solid-fills anything and neither
              // does this (DESIGN.md).
              'rounded-well border border-danger/50 px-3.5 py-1.5 text-[12px] font-medium',
              'text-danger transition-colors hover:bg-danger/10'
            )}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  )
}
