import type { JSX } from 'react'
import { CaretIcon } from './icons'

export interface PaneBackProps {
  /** What it goes back to, e.g. "All sessions". */
  label: string
  onBack: () => void
}

/**
 * The way out of a detail view that has replaced its own list.
 *
 * A list beside a detail needs about 700px before both are readable; docked
 * next to a session split neither gets it, so those panes collapse to one at a
 * time (DESIGN.md "narrow panes"). This is the row that puts the list back -
 * ghost text rather than a button shape, because it is a way back, not an
 * action on what is on screen.
 */
export function PaneBack({ label, onBack }: PaneBackProps): JSX.Element {
  return (
    <div className="shrink-0 px-2.5 pt-2">
      <button
        type="button"
        data-pane-back
        onClick={onBack}
        className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11.5px] text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      >
        <CaretIcon width={9} height={9} className="rotate-180" />
        {label}
      </button>
    </div>
  )
}
