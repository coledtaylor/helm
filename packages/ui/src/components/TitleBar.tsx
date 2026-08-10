import type { JSX, ReactNode } from 'react'

export interface TitleBarProps {
  /** Right-aligned controls. They opt out of the drag region via CSS. */
  children?: ReactNode | undefined
}

/**
 * The brand strip that replaces the native title bar.
 *
 * The app window is created with `titleBarStyle: 'hidden'` plus the Window
 * Controls Overlay (main/chrome.ts), so Windows draws only the min/max/close
 * buttons - coloured to the canvas - and this strip provides the title, the
 * drag region, and a home for window-level controls. `pr-36` keeps children
 * clear of the overlay buttons, which sit on top of the strip's right end.
 */
export function TitleBar({ children }: TitleBarProps): JSX.Element {
  return (
    <div className="app-drag flex h-9 shrink-0 items-center gap-2 pr-36 pl-3.5">
      <span aria-hidden className="size-[13px] shrink-0 rounded-[4px] bg-accent" />
      <span className="text-[13px] font-semibold tracking-tight text-fg">Helm</span>
      <span className="flex-1" />
      {children}
    </div>
  )
}
