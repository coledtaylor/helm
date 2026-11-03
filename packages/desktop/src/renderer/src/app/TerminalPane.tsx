import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import type { SessionRecord } from '@helm/core'
import { SessionEndedBar, type SessionLost } from '@helm/ui'
import { getTerminal, mountTerminal } from './terminals'
import { terminalPrefs } from './termprefs'

export interface TerminalPaneProps {
  session: SessionRecord
  /** Whether this is the tab the user is looking at. */
  active: boolean
  windowsBuild: number | null
  onClose: (id: number) => void
  /** Set when the session was lost: the bar says so and offers Restore. */
  lost?: SessionLost
  /**
   * The host this session runs in went without a stop and the window has not
   * got one back yet. The session may still be running in its keeper, so the
   * tab keeps its screen, dimmed with input off, until the next host says.
   */
  hostGone?: boolean
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
  onClose,
  lost,
  hostGone = false
}: TerminalPaneProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (boxRef.current) mountTerminal(session.id, boxRef.current, { windowsBuild })
  }, [session.id, windowsBuild])

  const ended = session.status !== 'running'
  const waiting = !ended && hostGone
  const dimmed = waiting || (lost !== undefined && session.status === 'lost')

  // A running session whose host is gone takes no keys until the next host
  // carries it again; then its input and cursor come back.
  useEffect(() => {
    if (ended) return
    const host = getTerminal(session.id)
    if (!host) return
    if (waiting) {
      host.term.options.cursorBlink = false
      host.term.options.disableStdin = true
      host.term.blur()
      return
    }
    if (host.term.options.disableStdin !== true) return
    host.term.options.disableStdin = false
    host.term.options.cursorBlink = terminalPrefs().cursorBlink
  }, [waiting, ended, session.id])

  // Becoming visible is the one moment a pane has to re-measure: while it was
  // hidden its box was 0x0, so every resize the window went through in the
  // meantime was skipped rather than applied to a grid of one column.
  useEffect(() => {
    if (!active) return
    const host = getTerminal(session.id)
    if (!host) return
    host.refit()
    if (!ended && !waiting) host.term.focus()
  }, [active, ended, waiting, session.id])

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
    // The terminal's own fixed ground, edge to edge in its pane's body
    // (DESIGN.md "foreign-ground islands"). The pane is the island - its edge,
    // corners and tab strip - so this draws no chrome of its own.
    <div className="flex h-full w-full flex-col overflow-hidden bg-terminal">
      {ended && (
        <SessionEndedBar
          exitCode={session.exitCode}
          durationMs={session.durationMs}
          onClose={() => onClose(session.id)}
          {...(lost !== undefined && session.status === 'lost' ? { lost } : {})}
        />
      )}
      {/* The gutter is a wrapper rather than padding on the terminal's own
          container: xterm sizes the grid from that container's box, so the
          element it measures has to be exactly the area it is allowed to fill.
          A lost session, and one whose host is gone, keeps its last screen,
          dimmed. */}
      <div
        data-terminal-lost={lost !== undefined && session.status === 'lost' ? true : undefined}
        data-terminal-waiting={waiting ? true : undefined}
        className={dimmed ? 'min-h-0 flex-1 p-2.5 opacity-60' : 'min-h-0 flex-1 p-2.5'}
      >
        <div ref={boxRef} className="h-full w-full" />
      </div>
    </div>
  )
}
