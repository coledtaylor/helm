import type { JSX } from 'react'
import { HelmMarkIcon } from './icons'

/**
 * The strip that replaces the native title bar, and the window's drag region.
 *
 * The app window is created with `titleBarStyle: 'hidden'` plus the Window
 * Controls Overlay (main/chrome.ts), so Windows draws only the min/max/close
 * buttons - coloured to the canvas - and this strip provides the mark and the
 * drag region. The mark sits centred over the rail below it, so the two read as
 * one column down the window's left edge.
 *
 * Nothing else lives here any more. The theme switch went to Settings with the
 * rest of Appearance, and Settings went to the rail.
 */
export function TitleBar(): JSX.Element {
  return (
    <div className="app-drag flex h-9 shrink-0 items-center pr-36">
      <span className="grid w-11 shrink-0 place-items-center">
        {/* The mark alone - a wordmark beside it would say "Helm" to someone
            already looking at Helm. The accessible name stays, because the
            mark is the only thing identifying the window. */}
        <HelmMarkIcon
          width={16}
          height={16}
          role="img"
          aria-label="Helm"
          // The icons default to `aria-hidden`, which is right when a label sits
          // beside them. Nothing does here, so this one has to be announced.
          aria-hidden={false}
          className="text-accent"
        />
      </span>
    </div>
  )
}
