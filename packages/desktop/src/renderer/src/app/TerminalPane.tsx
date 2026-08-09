import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import type { SessionRecord } from '@helm/core'
import { SessionEndedBar } from '@helm/ui'
import { getTerminal, mountTerminal } from './terminals'

export interface TerminalPaneProps {
  session: SessionRecord
  /** Whether this is the tab the user is looking at. */
  active: boolean
  windowsBuild: number | null
  onClose: (id: number) => void
}

/**
 * A session's terminal, in a box.
 *
 * Deliberately thin: the terminal it shows is owned by `terminals.ts` and
 * outlives this component, so everything here is about placement - where the
 * pane is, whether it is the visible one, and whether it still has a process
 * behind it.
 */
export function TerminalPane({
  session,
  active,
  windowsBuild,
  onClose
}: TerminalPaneProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (boxRef.current) mountTerminal(session.id, boxRef.current, { windowsBuild })
  }, [session.id, windowsBuild])

  const ended = session.status !== 'running'

  // Becoming visible is the one moment a pane has to re-measure: while it was
  // hidden its box was 0x0, so every resize the window went through in the
  // meantime was skipped rather than applied to a grid of one column.
  useEffect(() => {
    if (!active) return
    const host = getTerminal(session.id)
    if (!host) return
    host.refit()
    if (!ended) host.term.focus()
  }, [active, ended, session.id])

  // A terminal with no process behind it should not look like one that has.
  // The buffer stays readable and selectable; the blinking cursor and the
  // keystrokes that would go nowhere do not.
  useEffect(() => {
    if (!ended) return
    const host = getTerminal(session.id)
    if (!host) return
    host.term.options.cursorBlink = false
    host.term.options.disableStdin = true
    host.term.blur()
  }, [ended, session.id])

  return (
    <div className="flex h-full w-full flex-col bg-terminal">
      {ended && (
        <SessionEndedBar
          exitCode={session.exitCode}
          durationMs={session.durationMs}
          onClose={() => onClose(session.id)}
        />
      )}
      {/* The gutter is a wrapper rather than padding on the terminal's own
          container: xterm sizes the grid from that container's box, so the
          element it measures has to be exactly the area it is allowed to fill. */}
      <div className="min-h-0 flex-1 p-2">
        <div ref={boxRef} className="h-full w-full" />
      </div>
    </div>
  )
}
