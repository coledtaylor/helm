import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { estimateGrid } from './terminals'
import { getShell, mountShell } from './pterms'

export interface ProjectShellPaneProps {
  /** The project directory the shell runs in - also the registry key. */
  path: string
  windowsBuild: number | null
  /** Panes hide rather than unmount; a newly shown one has to re-measure. */
  visible: boolean
}

/**
 * A plain shell under the project pane, opened in the project's directory -
 * for the `git status` and `pnpm dev` that belong to the project but not to a
 * Claude session. A terminal island like any other (DESIGN.md
 * "foreign-ground islands"); the shell itself lives in pterms.ts and outlives
 * this component.
 */
export function ProjectShellPane({
  path,
  windowsBuild,
  visible
}: ProjectShellPaneProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const grid = estimateGrid(box)
    void mountShell(path, box, { windowsBuild, cols: grid.cols, rows: grid.rows })
  }, [path, windowsBuild])

  useEffect(() => {
    if (!visible) return
    getShell(path)?.refit()
  }, [visible, path])

  return (
    // Proportional rather than fixed: ~a third of the pane gives a tall
    // display 15+ rows (PSReadLine's ListView threshold) while a small window
    // keeps most of its height for the project pane.
    <div className="flex h-[30%] max-h-[420px] min-h-[180px] shrink-0 flex-col overflow-hidden rounded-island border border-border bg-terminal">
      <div className="min-h-0 flex-1 p-2.5">
        <div ref={boxRef} className="h-full w-full" />
      </div>
    </div>
  )
}
