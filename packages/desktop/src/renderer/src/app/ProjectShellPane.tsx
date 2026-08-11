import type { JSX } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DetectedShell } from '@helm/core'
import { CaretIcon, cn, WarnIcon } from '@helm/ui'
import { estimateGrid } from './terminals'
import { getShell, mountShell, reopenShell, type MountedShell } from './pterms'

export interface ProjectShellPaneProps {
  /** The project directory the shell runs in - also the registry key. */
  path: string
  windowsBuild: number | null
  /** Panes hide rather than unmount; a newly shown one has to re-measure. */
  visible: boolean
  /** Shells this machine has, for the header's override picker. */
  shells: DetectedShell[]
}

/**
 * A plain shell under the project pane, opened in the project's directory -
 * for the `git status` and `pnpm dev` that belong to the project but not to a
 * Claude session. A terminal island like any other (DESIGN.md
 * "foreign-ground islands"); the shell itself lives in pterms.ts and outlives
 * this component.
 *
 * The header says which executable is running and lets this pane alone run a
 * different one. Two shells is a normal thing to want - a PowerShell for the
 * repo's tooling and a bash for a script that assumes one - and the alternative
 * to a per-pane override is changing a global setting and changing it back.
 */
export function ProjectShellPane({
  path,
  windowsBuild,
  visible,
  shells
}: ProjectShellPaneProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const [running, setRunning] = useState<MountedShell | null>(null)
  /** What this pane was told to run, as opposed to what it is running. */
  const [override, setOverride] = useState('')
  const [swapping, setSwapping] = useState(false)

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    setOverride('')
    const grid = estimateGrid(box)
    void mountShell(path, box, { windowsBuild, cols: grid.cols, rows: grid.rows }).then(setRunning)
  }, [path, windowsBuild])

  useEffect(() => {
    if (!visible) return
    getShell(path)?.refit()
  }, [visible, path])

  /**
   * Switching shells is a kill and a respawn - a running shell cannot become a
   * different program - so the scrollback goes with it. That is the honest
   * behaviour and the reason the control is a picker rather than a toggle: it
   * is a deliberate act, not something to flick past.
   */
  const swap = useCallback(
    (shell: string) => {
      const box = boxRef.current
      if (!box) return
      setSwapping(true)
      setOverride(shell)
      const grid = estimateGrid(box)
      void reopenShell(path, box, {
        windowsBuild,
        cols: grid.cols,
        rows: grid.rows,
        ...(shell === '' ? {} : { shell })
      })
        .then(setRunning)
        .finally(() => setSwapping(false))
    },
    [path, windowsBuild]
  )

  const current = running?.shell ?? null

  return (
    // Proportional rather than fixed: ~a third of the pane gives a tall
    // display 15+ rows (PSReadLine's ListView threshold) while a small window
    // keeps most of its height for the project pane.
    <div className="flex h-[30%] max-h-[420px] min-h-[180px] shrink-0 flex-col overflow-hidden rounded-island border border-border bg-terminal">
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
        <span className="text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
          Shell
        </span>
        <span
          data-shell-running={current ?? ''}
          title={current ?? 'Starting…'}
          // The terminal's own foreground, fixed in both themes for the same
          // reason a session tab's is (DESIGN.md par. 6).
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#9397ab]"
        >
          {current === null ? 'Starting…' : fileName(current)}
        </span>
        {running?.problem != null && (
          <span
            data-shell-problem
            title={`${running.requested ?? ''} could not be started: ${running.problem}`}
            className="shrink-0 text-warn"
          >
            <WarnIcon width={11} height={11} />
          </span>
        )}
        {/* `appearance-none` plus the app's own caret, the same shape every
            other picker in Helm takes (DESIGN.md par. 4): the platform arrow is
            a chunky white chevron that reads as a control from a different
            program, which is precisely wrong on a foreign-ground island. */}
        <span className="relative shrink-0">
          <select
            data-shell-picker
            aria-label="Shell for this pane"
            title="Run this pane under a different shell"
            disabled={swapping || shells.length === 0}
            value={override}
            onChange={(e) => swap(e.target.value)}
            className={cn(
              'h-[22px] appearance-none rounded-[5px] border border-border bg-transparent',
              'pr-5 pl-1.5 text-[11px] text-fg-subtle transition-colors',
              'hover:border-border-strong hover:text-fg focus:border-accent focus:outline-none',
              'disabled:cursor-default disabled:opacity-50'
            )}
          >
            <option value="">Default</option>
            {shells.map((shell) => (
              <option key={shell.path} value={shell.path}>
                {shell.name}
              </option>
            ))}
          </select>
          <CaretIcon
            width={8}
            height={8}
            className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rotate-90 text-fg-subtle"
          />
        </span>
      </div>
      <div className="min-h-0 flex-1 p-2.5">
        <div ref={boxRef} className="h-full w-full" />
      </div>
    </div>
  )
}

const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path
