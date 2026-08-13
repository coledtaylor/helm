import type { JSX, Ref } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { DetectedShell } from '@helm/core'
import { CaretIcon, cn, WarnIcon } from '@helm/ui'
import { estimateGrid } from './terminals'
import { getShell, mountShell, reopenShell, type MountedShell } from './pterms'

/**
 * The shortest this pane is ever drawn, whatever percentage it is asked for.
 *
 * The PSReadLine number, kept as a pixel floor rather than folded into the
 * percentage: 180px is about 15 rows at the default point size, which is the
 * threshold below which PSReadLine's ListView stops being usable, and 15 rows
 * is 15 rows on every window. A percentage cannot say that - the same 12% is a
 * usable shell on one monitor and four lines on another.
 *
 * Exported because the drag has to clamp to it as well (`App.tsx`): a handle
 * that goes on moving after the pane has stopped is a handle that has come off
 * what it is holding.
 */
export const PROJECT_SHELL_MIN_PX = 180

export interface ProjectShellPaneProps {
  /** The project directory the shell runs in - also the registry key. */
  path: string
  windowsBuild: number | null
  /** Panes hide rather than unmount; a newly shown one has to re-measure. */
  visible: boolean
  /** Shells this machine has, for the header's override picker. */
  shells: DetectedShell[]
  /**
   * Height as a percentage of the page's column - `projectShellHeightPct`,
   * already bounded by `PROJECT_SHELL_HEIGHT_PCT` on the way in.
   */
  heightPct: number
  /**
   * The island, for the drag handle above it.
   *
   * A drag happens between two renders, so it moves this element's height
   * itself and writes the setting once at the end (`App.tsx`). Every other
   * change to the height arrives as `heightPct` and is rendered normally.
   */
  ref?: Ref<HTMLDivElement>
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
  shells,
  heightPct,
  ref
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
   * A height that arrived as a render re-measures the terminal.
   *
   * A grid still describing the old box is the whole failure a resizable pane
   * can ship: the shell paints into rows the pty does not know it has, and
   * whatever is running in it wraps against a width that is not there. So the
   * pane re-measures whenever its own height changes - the same claim the
   * `visible` effect above makes, for the same reason.
   *
   * `terminal.ts` keeps a `ResizeObserver` on the container as well, and a
   * height change was measured to reach the grid through it with this taken
   * out. It stays for the reason the `visible` effect and `park` do: a pane
   * that moved its own box is the thing that knows the grid is stale, and
   * `refit` reports to the pty only when the answer changed.
   *
   * This covers every route except one. The drag does not come through here:
   * it sets the height on this element itself between renders and calls
   * `refit` as it goes (`App.tsx`), because a settings write per frame is a
   * database write per frame. What is left for this effect is the settings
   * row, the handle's double-click, and the height a restart comes back with.
   */
  useEffect(() => {
    getShell(path)?.refit()
  }, [heightPct, path])

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
    // Proportional rather than fixed, and now the user's rather than only ours.
    //
    // A third of the pane is where it starts, and for the reason it always
    // was: it gives a tall display 15+ rows (PSReadLine's ListView threshold)
    // while a small window keeps most of its height for the project pane. That
    // is the default and, as `PROJECT_SHELL_MIN_PX`, the floor. What it never
    // justified was being the only value - somebody reading a `pnpm dev` on a
    // tall monitor wants the terminal, and resizing the whole window was the
    // only lever they had. The handle above this pane is the lever now; the
    // ceiling is half the column (`PROJECT_SHELL_HEIGHT_PCT`).
    //
    // The old `max-h-[420px]` is gone with it. A fixed pixel ceiling is exactly
    // what made a tall monitor useless: past about 1400px of column the shell
    // stopped growing and the extra height all went to a project pane that had
    // nothing more to say. Half the column replaces it and scales.
    //
    // Where the two bounds disagree - a column short enough that 180px is more
    // than half of it - the floor wins, because a terminal too short to use is
    // worse than a project pane pushed slightly past half.
    <div
      ref={ref}
      data-project-shell={String(heightPct)}
      style={{ height: `${String(heightPct)}%`, minHeight: `${String(PROJECT_SHELL_MIN_PX)}px` }}
      className="flex shrink-0 flex-col overflow-hidden rounded-island border border-border bg-terminal"
    >
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
            program, which is precisely wrong on a foreign-ground island.

            The fill is not decoration and must not go back to `bg-transparent`.
            A `<select>`'s dropped-open list is an OS window rather than part of
            the page, and Chromium paints it from the control's own
            `background-color`: a transparent one leaves the platform's white
            listbox, which is what this pane shipped with - `color-scheme: dark`
            is inherited correctly here and does not override it. The text
            colour *was* being applied, so the options were `#75798c` on white
            and near unreadable.

            Hard-coded to the dark ramp's sunken value rather than
            `bg-surface-sunken`, for the same reason the executable beside it is
            `#9397ab`: this island's ground is fixed in both themes, so a themed
            token here would drop a light control onto a dark pane in light mode
            (DESIGN.md par. 6, the foreign-ground hex exception). */}
        <span className="relative shrink-0">
          <select
            data-shell-picker
            aria-label="Shell for this pane"
            title="Run this pane under a different shell"
            disabled={swapping || shells.length === 0}
            value={override}
            onChange={(e) => swap(e.target.value)}
            className={cn(
              'h-[22px] appearance-none rounded-[5px] border border-border bg-[#0d0e17]',
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
