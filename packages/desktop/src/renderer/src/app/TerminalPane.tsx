import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import type { SessionRecord } from '@helm/core'
import { isCommandChild, LOCAL_HOST_KEY } from '@helm/core/types'
import { cn, HostLostBanner, SessionEndedBar, type SessionLost } from '@helm/ui'
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
  /** The host it runs in; its terminal is that host's (`terminals.ts` keeps them by host and id). This PC's when absent. */
  host?: string
  /**
   * The link to the host on another computer this session runs on dropped,
   * or cannot get in. The session keeps running there, so the tab keeps its
   * last screen, dimmed with input off, under a banner saying so with
   * Reconnect now, until the link is back.
   */
  hostLost?: HostLost | undefined
  /**
   * The terminal is a child's card in its parent's tab, not a tab of its own.
   * It never takes the keyboard when it shows (the parent keeps it), takes it
   * when its terminal is pressed, and says nothing in a bar of its own: its
   * header says how it ended, and the parent's tab says where the host went.
   */
  card?: boolean
}

/** What a remote session's tab says while its host's link is down. */
export interface HostLost {
  /** The host, as every surface names it. */
  hostName: string
  /** The last line ssh or the command wrote, unedited, when it could not get in; null while only trying again. */
  lastLine: string | null
  /** The line to try by hand in a terminal. */
  tryLine: string
  onReconnect: () => void
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
  hostGone = false,
  host: on = LOCAL_HOST_KEY,
  hostLost,
  card = false
}: TerminalPaneProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // A card made while its parent has the keyboard leaves it there.
    if (boxRef.current) mountTerminal(session.id, boxRef.current, { windowsBuild, ...(card ? { focus: false } : {}) }, on)
  }, [session.id, windowsBuild, on, card])

  const ended = session.status !== 'running'
  const away = !ended && hostLost !== undefined
  const waiting = !ended && (hostGone || away)
  const dimmed = waiting || (lost !== undefined && session.status === 'lost')

  // A running session whose host is gone, or whose host's link dropped, takes
  // no keys until a host carries it again: what is typed meanwhile reaches
  // nothing and is not kept. Then its input and cursor come back.
  useEffect(() => {
    if (ended) return
    const host = getTerminal(session.id, on)
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
  }, [waiting, ended, session.id, on])

  // Becoming visible is the one moment a pane has to re-measure: while it was
  // hidden its box was 0x0, so every resize the window went through in the
  // meantime was skipped rather than applied to a grid of one column.
  useEffect(() => {
    if (!active) return
    const host = getTerminal(session.id, on)
    if (!host) return
    host.refit()
    if (!ended && !waiting && !card) host.term.focus()
  }, [active, ended, waiting, session.id, on, card])

  // A terminal with no process behind it should not look like one that has.
  // The buffer stays readable and selectable; the blinking cursor and the
  // keystrokes that would go nowhere do not.
  useEffect(() => {
    if (!ended) return
    const host = getTerminal(session.id, on)
    if (!host) return
    host.term.options.cursorBlink = false
    host.term.options.disableStdin = true
    host.term.blur()
  }, [ended, session.id, on])

  return (
    // The terminal's own fixed ground, edge to edge in its pane's body
    // (DESIGN.md "foreign-ground islands"). The pane is the island - its edge,
    // corners and tab strip - so this draws no chrome of its own.
    <div className="flex h-full w-full flex-col overflow-hidden bg-terminal">
      {!card && away && hostLost !== undefined && (
        <HostLostBanner
          hostName={hostLost.hostName}
          sessionName={session.label ?? session.name}
          lastLine={hostLost.lastLine}
          tryLine={hostLost.tryLine}
          onReconnect={hostLost.onReconnect}
        />
      )}
      {!card && ended && (
        <SessionEndedBar
          exitCode={session.exitCode}
          durationMs={session.durationMs}
          onClose={() => onClose(session.id)}
          {...(lost !== undefined && session.status === 'lost' ? { lost } : {})}
          // A command the host ended says so, as its crumb and ended header do:
          // the number the system gave a process it killed is not an exit code.
          stopped={isCommandChild(session) && session.stopped === true}
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
        data-terminal-card={card ? true : undefined}
        className={cn('min-h-0 flex-1', card ? 'px-2.5 py-2' : 'p-2.5', dimmed && 'opacity-60')}
        // Pressing a card's terminal gives it the keyboard. xterm would on its
        // own, but it is the one promise a card makes about keys, so it is said
        // here and not left to the renderer. A press on the gutter, which xterm
        // does not cover, would otherwise move the focus to the page after this
        // has run, leaving the parent without the caret and the card without
        // the keys.
        onMouseDown={
          card && !ended && !waiting
            ? (event) => {
                if (event.button !== 0) return
                if (event.target === event.currentTarget) event.preventDefault()
                getTerminal(session.id, on)?.term.focus()
              }
            : undefined
        }
      >
        <div ref={boxRef} className="h-full w-full" />
      </div>
    </div>
  )
}
