import type { HTMLAttributes, JSX, ReactNode } from 'react'
import { useEffect } from 'react'
import { cn } from '../lib/cn'
import { overlayMounted } from '../lib/overlay'

export interface OverlayProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'className'> {
  /**
   * `alertdialog` for a destructive confirmation, `dialog` for everything else.
   * The distinction is DESIGN.md's and is about what a screen reader does with
   * it, not about how it is drawn - both are the same island.
   */
  role?: 'dialog' | 'alertdialog'
  /**
   * The island's width cap, which is the one thing that differs between the
   * dialogs - `max-w-[440px]` for a confirmation, `max-w-[620px]` for the
   * profile editor. Merged over the recipe, so a `max-w` here wins.
   */
  className?: string
  /** Escape and a click on the scrim both mean this. */
  onDismiss: () => void
  children: ReactNode
}

/**
 * The one modal overlay: the scrim, the centring, the z-index, the island and
 * its shadow, and Escape.
 *
 * Four components used to carry a copy of `fixed inset-0 z-50 grid
 * place-items-center bg-black/60 p-6` and a copy of the island beneath it.
 * That is one design-system decision written down four times - DESIGN.md
 * allows a shadow *only* on a modal, and there was no single place that said
 * what a modal was, so "a modal" was whatever the last person had pasted.
 *
 * The cost of that only shows up when something outside these components needs
 * to know a dialog is open. The integrated browser pane is a native
 * `WebContentsView` and paints above all renderer DOM, so it has to hide while
 * a dialog is up; with four backdrops there is nothing to subscribe to, and
 * "remember to tell the browser pane" becomes a rule a person holds. This
 * component holds it instead - see `lib/overlay.ts` - and `no-raw-overlay` in
 * `eslint.config.js` is what stops a fifth dialog going round it.
 *
 * `fixed`, not `absolute`. The profile editor is mounted inside a pane, and an
 * absolute backdrop would dim the pane while leaving the sidebar lit and
 * clickable - which is not what `aria-modal` promises.
 */
export function Overlay({
  role = 'dialog',
  className,
  onDismiss,
  children,
  ...island
}: OverlayProps): JSX.Element {
  // Mount and unmount are the whole protocol; the cleanup React already
  // guarantees is what says the overlay is gone.
  useEffect(() => overlayMounted(), [])

  // Escape closes. On the window, because the focus may be inside any of a
  // dozen fields and each of them would otherwise need the handler.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onDismiss])

  return (
    <div
      className={SCRIM}
      onMouseDown={(event) => {
        // Only the scrim itself. A drag that started inside the island and
        // finished out here is a text selection, not a dismissal.
        if (event.target === event.currentTarget) onDismiss()
      }}
    >
      <div role={role} aria-modal="true" className={cn(MODAL_ISLAND, className)} {...island}>
        {children}
      </div>
    </div>
  )
}

/**
 * The scrim, and the one place in the app allowed to say `fixed inset-0`.
 *
 * `no-raw-overlay` refuses that pair everywhere else under `packages/ui` and
 * the renderer, and exempts this file by name.
 */
const SCRIM = 'fixed inset-0 z-50 grid place-items-center bg-black/60 p-6'

/**
 * The modal island: 12px radius, the stronger hairline, and `shadow-panel` -
 * the one shadow the system allows, and the reason this is a single constant
 * rather than a comment repeated four times (DESIGN.md 3).
 */
const MODAL_ISLAND = cn(
  'flex max-h-full w-full flex-col overflow-hidden rounded-xl',
  'border border-border-strong bg-surface shadow-panel'
)
