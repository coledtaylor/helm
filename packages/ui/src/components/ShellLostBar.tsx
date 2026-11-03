import type { JSX } from 'react'
import { cn } from '../lib/cn'
import { TerminalIcon } from './icons'

export interface ShellLostBarProps {
  /** The host the shell ran in, as the window names it: "this PC’s host". */
  hostName: string
  /** Opens a new shell in the same folder, in this pane. */
  onNewShell: () => void
}

/**
 * What a plain shell's pane says once the shell went with the host it ran in.
 *
 * A shell has no conversation to resume, so the way back is a new shell in
 * the same folder; the old screen stays readable above until then. Drawn as a
 * lost session's bar is (`SessionEndedBar`), so the two read as one state.
 */
export function ShellLostBar({ hostName, onNewShell }: ShellLostBarProps): JSX.Element {
  return (
    <div
      role="status"
      data-shell-lost
      className="flex shrink-0 items-center gap-2 border-b border-warn/30 bg-warn/10 px-3 py-1.5 text-[11px] text-warn"
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn" />
      <span className="font-medium">{`Shell lost: ${hostName} stopped`}</span>
      <span className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={onNewShell}
          title="Start a new shell in this folder, in this pane"
          className={cn(
            'flex items-center gap-1 rounded px-1.5 py-0.5',
            'text-fg-subtle transition hover:bg-hover hover:text-fg'
          )}
        >
          <TerminalIcon width={11} height={11} />
          New shell
        </button>
      </span>
    </div>
  )
}
