import type { JSX, ReactNode } from 'react'
import { HelmMarkIcon } from './icons'

export interface TitleBarProps {
  /** Right-aligned controls. They opt out of the drag region via CSS. */
  children?: ReactNode | undefined
}

/**
 * The brand strip that replaces the native title bar.
 *
 * The app window is created with `titleBarStyle: 'hidden'` plus the Window
 * Controls Overlay (main/chrome.ts), so Windows draws only the min/max/close
 * buttons - coloured to the canvas - and this strip provides the mark, the
 * drag region, and a home for window-level controls. `pr-36` keeps children
 * clear of the overlay buttons, which sit on top of the strip's right end.
 */
export function TitleBar({ children }: TitleBarProps): JSX.Element {
  return (
    <div className="app-drag flex h-9 shrink-0 items-center gap-2 pr-36 pl-3.5">
      {/* The mark alone - the wordmark beside it said "Helm" to someone
          already looking at Helm. The accessible name stays, because the mark
          is now the only thing identifying the window. */}
      <HelmMarkIcon
        width={16}
        height={16}
        role="img"
        aria-label="Helm"
        // The icons default to `aria-hidden`, which is right when a label sits
        // beside them. Nothing does now, so this one has to be announced.
        aria-hidden={false}
        className="shrink-0 text-accent"
      />
      <span className="flex-1" />
      {children}
    </div>
  )
}
