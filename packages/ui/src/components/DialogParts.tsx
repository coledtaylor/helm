import type { JSX, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { CloseIcon, WarnIcon } from './icons'

/**
 * The pieces a form dialog is drawn with (DESIGN.md 3 and 4): a header with
 * the dialog's glyph, title and close; fields in the sunken well; a footer of
 * outlined buttons. The island, scrim and Escape are `Overlay`'s.
 */

export const dialogInput = cn(
  'h-[30px] w-full rounded-well border border-border bg-surface-sunken px-2.5 text-[12.5px]',
  'text-fg placeholder:text-fg-subtle select-text transition-colors',
  'hover:border-border-strong focus:border-accent focus:outline-none'
)

export const dialogLabel = 'block text-[9.5px] font-semibold tracking-[.08em] text-fg-subtle uppercase'

export const secondaryButton = cn(
  'rounded-well border border-border-strong px-3.5 py-1.5 text-[12px] text-fg',
  'transition-colors hover:bg-hover'
)

/** Outlined in the accent, never solid-filled; disabled keeps the outline at reduced opacity. */
export function primaryButton(ready: boolean): string {
  return cn(
    'rounded-well border px-3.5 py-1.5 text-[12px] font-medium transition-colors',
    ready
      ? 'border-accent text-accent-text hover:bg-accent-soft'
      : 'cursor-default border-border text-fg-subtle opacity-60'
  )
}

/** A destructive action: the danger outline, a 10% wash under the pointer, never a fill. */
export const dangerButton = cn(
  'rounded-well border border-danger/45 px-3.5 py-1.5 text-[12px] text-danger',
  'transition-colors hover:bg-danger/10'
)

export function DialogHeader({
  icon,
  title,
  onClose
}: {
  icon: ReactNode
  title: string
  onClose: () => void
}): JSX.Element {
  return (
    <header className="flex shrink-0 items-center gap-[9px] px-[22px] pt-[18px]">
      <span className="shrink-0 text-accent">{icon}</span>
      <h2 className="min-w-0 truncate text-[15px] font-medium tracking-tight text-fg">{title}</h2>
      <span className="flex-1" />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        title="Close"
        className="grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
      >
        <CloseIcon width={12} height={12} />
      </button>
    </header>
  )
}

export function DialogFooter({ children }: { children: ReactNode }): JSX.Element {
  return (
    <footer className="mx-[22px] flex shrink-0 items-center justify-end gap-2 border-t border-border py-3.5">
      {children}
    </footer>
  )
}

/** What main refused, or what is wrong with the form, said where the eye is. */
export function DialogProblem({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p
      role="alert"
      data-dialog-problem
      className="mt-3 flex items-start gap-2 rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] leading-[1.55] text-danger"
    >
      <WarnIcon width={12} height={12} className="mt-[3px] shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  )
}
