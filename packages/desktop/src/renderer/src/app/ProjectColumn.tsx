import type { JSX, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { useCallback, useRef } from 'react'
import type { DetectedShell } from '@helm/core'
import { DEFAULT_SETTINGS, PROJECT_SHELL_HEIGHT_PCT } from '@helm/core/types'
import { cn } from '@helm/ui'
import { getShell } from './pterms'
import { PROJECT_SHELL_MIN_PX, ProjectShellPane } from './ProjectShellPane'

export interface ProjectColumnProps {
  /** The project directory - the shell's working directory and registry key. */
  path: string
  windowsBuild: number | null
  shells: DetectedShell[]
  /** `projectShellHeightPct`, as last written. */
  heightPct: number
  /** One write at the end of a drag, or a reset. */
  onHeightChange: (pct: number) => void
  /** The project's page, above the shell. */
  children: ReactNode
}

/**
 * The shell's height as a percentage of `column`, for a drag that has put the
 * shell's top edge at `top`.
 *
 * Clamped in pixels first and in percent second, and that order is the whole
 * of it. The pixel floor is the bound with a measurement behind it
 * (`PROJECT_SHELL_MIN_PX`), and converting an already-clamped pixel height
 * into a percentage is what keeps the stored number a description of the
 * height on screen. Clamping the percentage alone would let the setting read
 * 10 while CSS drew 180px - a handle that has stopped moving under a number
 * that has not.
 */
function shellHeightFor(column: DOMRect, top: number): number {
  const ceiling = (column.height * PROJECT_SHELL_HEIGHT_PCT.max) / 100
  const px = Math.min(ceiling, Math.max(PROJECT_SHELL_MIN_PX, column.bottom - top))
  const pct = Math.round((px / column.height) * 100)
  return Math.min(PROJECT_SHELL_HEIGHT_PCT.max, Math.max(PROJECT_SHELL_HEIGHT_PCT.min, pct))
}

/**
 * A project's page with its own shell under it, and the handle between them.
 *
 * Its own component so that each pane showing a project owns its own column,
 * drag and refs: with two panes, two projects' pages can be on screen at once,
 * and a drag that measured "the" project column would measure whichever one
 * rendered last.
 *
 * The setting is the state, and while a drag is in flight the DOM is ahead of
 * it: a `pointermove` sets the shell's height itself and `pointerup` writes it
 * once. A settings write per frame would be a database write per frame, and
 * re-rendering the page sixty times a second to move one edge would re-render
 * the project pane and the terminal with it. The shell still renders its height
 * from `heightPct`, so once the write lands React and the DOM agree on a value
 * they already both hold and nothing moves.
 */
export function ProjectColumn({
  path,
  windowsBuild,
  shells,
  heightPct,
  onHeightChange,
  children
}: ProjectColumnProps): JSX.Element {
  const columnRef = useRef<HTMLDivElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  /**
   * Where inside the handle it was grabbed, and what the drag has reached. The
   * grab offset is why the shell does not jump on the first move: the pointer
   * lands anywhere in the handle's 8px, and without it the first `pointermove`
   * would snap the top edge onto the pointer.
   */
  const grab = useRef(0)
  const dragged = useRef<number | null>(null)

  /**
   * Pointer capture rather than window listeners: let go outside the window and
   * no `mouseup` ever arrives, so a drag held together by window listeners is
   * still running when the pointer comes back.
   */
  const start = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    grab.current = event.clientY - event.currentTarget.getBoundingClientRect().bottom
    dragged.current = null
    document.body.style.userSelect = 'none'
  }, [])

  const move = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const column = columnRef.current
      const shell = shellRef.current
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
      if (column === null || shell === null) return
      const box = column.getBoundingClientRect()
      if (box.height < 1) return
      const next = shellHeightFor(box, event.clientY - grab.current)
      if (next === dragged.current) return
      dragged.current = next
      shell.style.height = `${String(next)}%`
      // The pane moved its own box, so the code that moved it is the code that
      // knows the grid is stale - the same contract `park` keeps in pterms.ts.
      // `refit` tells the pty only when the answer actually changed.
      getShell(path)?.refit()
    },
    [path]
  )

  const end = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      document.body.style.userSelect = ''
      const landed = dragged.current
      dragged.current = null
      // One write for the whole gesture, and none for a press that never
      // moved: a click on the handle is not a decision about anything.
      if (landed !== null && landed !== heightPct) onHeightChange(landed)
    },
    [heightPct, onHeightChange]
  )

  return (
    // No gap: the handle below is the gutter between the page and the shell.
    <div ref={columnRef} className="absolute inset-0 flex flex-col">
      <div className="min-h-0 flex-1">{children}</div>
      {/* The handle, living in the gutter it replaces. Dragging up grows the
          shell, down shrinks it, double-click puts it back to the default.

          `cursor: ns-resize`, and a `separator` rather than a button. Every
          *control* computes `cursor: pointer`, and a separator is not one: it
          computes the resize cursor its own orientation calls for. */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the shell"
        title="Drag to resize the shell, double-click to reset"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => onHeightChange(DEFAULT_SETTINGS.projectShellHeightPct)}
        // The row is as tall as the gap setting; the ::before keeps the target
        // 8px whatever that is.
        className={cn(
          'group relative flex h-gutter shrink-0 cursor-ns-resize items-center justify-center',
          "before:absolute before:inset-x-0 before:top-1/2 before:h-2 before:-translate-y-1/2 before:content-['']"
        )}
      >
        {/* A 3px grip that goes accent on hover (DESIGN.md "Split view"). A
            full-width hairline down the middle of the gutter read as a doubled
            border rather than as something to hold. */}
        <span className="h-[min(3px,var(--helm-gap))] w-10 rounded-full bg-border-strong transition-colors group-hover:bg-accent" />
      </div>
      {/* Keyed by path: this is one project's shell, and handing the same
          component a different project re-mounted someone else's terminal
          into a box that still held the last one. */}
      <ProjectShellPane
        key={path}
        ref={shellRef}
        path={path}
        windowsBuild={windowsBuild}
        visible
        shells={shells}
        heightPct={heightPct}
      />
    </div>
  )
}
