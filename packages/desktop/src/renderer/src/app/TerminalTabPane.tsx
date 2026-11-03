import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { ShellLostBar } from '@helm/ui'
import { estimateGrid } from './terminals'
import { getShell, mountShell, onShellsChange, reopenShell, shellLost, terminalShellKey } from './pterms'
import { LOCAL_HOST_KEY } from '@helm/core/types'
import { LOCAL_HOST_NAME } from './host/sessions'

export interface TerminalTabPaneProps {
  /** The tab's own id - `PaneRef`'s, and the shell's registry key. */
  id: number
  /** The folder the shell opens in. */
  path: string
  /** Whether this is the tab the user is looking at. */
  active: boolean
  windowsBuild: number | null
  /** The host the folder is on, by id; this PC's when absent. */
  host?: string | undefined
  /** That host's name, for the bar a lost shell shows; this PC's host's when absent. */
  hostName?: string | undefined
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
 * Which executable runs is the `terminalShell` setting. A shell that went with
 * the host it ran in keeps its screen, dimmed, under a bar offering a new one.
 */
export function TerminalTabPane({
  id,
  path,
  active,
  windowsBuild,
  host = LOCAL_HOST_KEY,
  hostName = LOCAL_HOST_NAME
}: TerminalTabPaneProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const key = terminalShellKey(id)
  const lost = useSyncExternalStore(onShellsChange, () => shellLost(key, host))

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const grid = estimateGrid(box)
    void mountShell(path, box, {
      windowsBuild,
      cols: grid.cols,
      rows: grid.rows,
      key: terminalShellKey(id),
      host
    })
  }, [id, path, windowsBuild, host])

  // Hidden, its box was 0x0 and every resize in the meantime was skipped.
  useEffect(() => {
    if (!active) return
    const shell = getShell(terminalShellKey(id), host)
    if (!shell) return
    shell.refit()
    shell.term.focus()
  }, [active, id, host])

  const newShell = useCallback(() => {
    const box = boxRef.current
    if (!box) return
    const grid = estimateGrid(box)
    void reopenShell(path, box, { windowsBuild, cols: grid.cols, rows: grid.rows, key, host }).then((opened) => {
      if (opened !== null && active) opened.host.term.focus()
    })
  }, [path, windowsBuild, key, active, host])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-terminal" data-terminal-tab={id}>
      {lost && <ShellLostBar hostName={hostName} onNewShell={newShell} />}
      {/* A wrapper rather than padding on the terminal's container, for the
          reason `TerminalPane` gives: xterm measures that container's box. */}
      <div
        data-terminal-lost={lost ? true : undefined}
        className={lost ? 'min-h-0 flex-1 p-2.5 opacity-60' : 'min-h-0 flex-1 p-2.5'}
      >
        <div ref={boxRef} className="h-full w-full" />
      </div>
    </div>
  )
}
