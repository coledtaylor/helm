import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { estimateGrid } from './terminals'
import { getShell, mountShell, terminalShellKey } from './pterms'

export interface TerminalTabPaneProps {
  /** The tab's own id - `PaneRef`'s, and the shell's registry key. */
  id: number
  /** The folder the shell opens in. */
  path: string
  /** Whether this is the tab the user is looking at. */
  active: boolean
  windowsBuild: number | null
}

/**
 * A terminal tab: a plain shell in a folder, with no `claude` in it.
 *
 * The shell is a project shell's sibling rather than a session - no row, no
 * history, no notification (see main/pterm.ts) - opened `separate` so a second
 * terminal tab on one folder is a second shell. It lives in pterms.ts and
 * outlives this component; closing the tab is what ends it (`App.tsx`).
 *
 * Drawn the way a session's terminal is (`TerminalPane`): edge to edge in its
 * pane's body, on the terminal's own fixed ground, with no chrome of its own.
 * Which executable runs is the `terminalShell` setting.
 */
export function TerminalTabPane({ id, path, active, windowsBuild }: TerminalTabPaneProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const grid = estimateGrid(box)
    void mountShell(path, box, {
      windowsBuild,
      cols: grid.cols,
      rows: grid.rows,
      key: terminalShellKey(id)
    })
  }, [id, path, windowsBuild])

  // Hidden, its box was 0x0 and every resize in the meantime was skipped.
  useEffect(() => {
    if (!active) return
    const host = getShell(terminalShellKey(id))
    if (!host) return
    host.refit()
    host.term.focus()
  }, [active, id])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-terminal" data-terminal-tab={id}>
      {/* A wrapper rather than padding on the terminal's container, for the
          reason `TerminalPane` gives: xterm measures that container's box. */}
      <div className="min-h-0 flex-1 p-2.5">
        <div ref={boxRef} className="h-full w-full" />
      </div>
    </div>
  )
}
