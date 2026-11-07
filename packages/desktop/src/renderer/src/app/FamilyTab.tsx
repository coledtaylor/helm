import type { JSX, ReactNode } from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  closeFamilyChild,
  commandState,
  endedHeaderText,
  familyChildren,
  familyEntries,
  familyRoom,
  isCommandChild,
  openFamilyChildAsTab,
  reportNote,
  sessionLabel,
  shrinkFamilyChild,
  showFamilyChild,
  wantsCard,
  type FamilyEntry,
  type FamilyState,
  type PaneLayout,
  type SessionRecord
} from '@helm/core/types'
import {
  ChildHeader,
  cn,
  FAMILY_HEADER_PX,
  FamilyCard,
  FamilyFrame,
  FamilyKids,
  ReportNote,
  type TabIndicator
} from '@helm/ui'
import { forgetFamilyRoom, reportFamilyRoom } from './familyRooms'
import { childStatus } from './sessionView'
import { TerminalPane, type HostLost } from './TerminalPane'
import { terminalCell } from './terminals'
import { useBodySize, useDevicePixelRatio } from './useBodySize'
import { useTerminalPrefs } from './useTerminalPrefs'

/** A child held by a parent's tab, with what the window knows of what it is doing. */
export interface FamilyKid {
  session: SessionRecord
  /** What its dot says. */
  state: TabIndicator
  /** When it entered `state`, in milliseconds, or null where nothing says. */
  since: number | null
  /** It runs a command and not an agent, so its card has no report note. */
  command?: boolean
}

export interface FamilyTabProps {
  /** The parent's tab, by `paneId`. */
  tab: string
  /** The host the parent and its children run on. */
  host: string
  /** Whether the tab is in front in its pane. */
  front: boolean
  /** The parent's own terminal. It is drawn whether or not there is a family view around it. */
  parent: ReactNode
  /**
   * The session this tab is for. When it is itself a child that has reported,
   * its report is a note above its terminal, as it is on its card in its
   * parent's tab.
   */
  own?: SessionRecord
  /** The children this tab holds, ended ones included: none when this device does not show them here. */
  kids: readonly FamilyKid[]
  /** How the user arranged them. */
  family: FamilyState
  /** The time, for how long each has been at what it is doing. */
  now: number
  windowsBuild: number | null
  /** The host the family runs in went without a stop and the window has not got one back yet. */
  hostGone?: boolean
  /** The link to the host on another computer dropped, or cannot get in. */
  hostLost?: HostLost | undefined
  /** Changes the window's panes, which is how a press on a header or a button is kept (`PaneLayout.families`). */
  arrange: (change: (layout: PaneLayout) => PaneLayout) => void
  /**
   * Stop on a card: the window asks whether to end that child and the host
   * ends it once the user agrees. Settles true when the child was ended and
   * false when the user declined.
   */
  onStop: (id: number) => Promise<boolean> | void
}

/** The dot of a header: what a running child is doing, and for an ended one only that it ended, unless it failed by itself. */
function dotOf(child: SessionRecord, state: TabIndicator, command: boolean): TabIndicator {
  if (command) return commandState(child)
  if (child.status === 'running') return state
  return state === 'failed' && child.stopped !== true ? 'failed' : 'ended'
}

/** When a session started, in milliseconds, or null for a time that is not one: how long a command has run. */
function startedMs(child: SessionRecord): number | null {
  const started = Date.parse(child.startedAt)
  return Number.isNaN(started) ? null : started
}

/**
 * A session's tab: its terminal and, around it, its children.
 *
 * The parent's terminal keeps the same place in the tree whether the family
 * view is drawn or not, so it is never remounted by a child starting, ending or
 * being closed, nor by this device's setting being turned off and on. What the
 * tab draws beside it is decided here from the tab's own measured size
 * (`familyRoom`), the children it holds and the user's arrangement
 * (`familyEntries`); what the pane has room for is told to the rest of the
 * window (`familyRooms.ts`), which needs it to know which children are open here.
 *
 * Every press is a change to the window's panes: the arrangement is kept with
 * the layout, per device, and never sent to the host.
 */
export function FamilyTab({
  tab,
  host,
  front,
  parent,
  own,
  kids,
  family,
  now,
  windowsBuild,
  hostGone = false,
  hostLost,
  arrange,
  onStop
}: FamilyTabProps): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const size = useBodySize(bodyRef)
  // The children this window's user stopped with Stop, so their headers say
  // "Stopped by you". The host records only that a child was stopped.
  const [stoppedByYou, setStoppedByYou] = useState<ReadonlySet<number>>(new Set())
  const stop = (id: number): void => {
    void Promise.resolve(onStop(id)).then((ended) => {
      if (ended === true) setStoppedByYou((each) => new Set(each).add(id))
    })
  }
  const prefs = useTerminalPrefs()
  // One cell of the terminal's font, measured again when the font changes or
  // the window moves to a screen with another pixel ratio, which quantises it
  // differently.
  const ratio = useDevicePixelRatio()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the ratio is read by the measurement, not passed to it
  const cell = useMemo(() => terminalCell(prefs), [prefs, ratio])

  const sessions = kids.map((kid) => kid.session)
  const held = familyChildren(sessions, family)

  // Whether the pane has room depends on its size and the font, never on how
  // many children there are: a tab with none is measured as with one, so that
  // the first child to start finds the answer already given.
  const room =
    size === null || cell === null
      ? null
      : familyRoom({
          body: size,
          cell,
          headerHeight: FAMILY_HEADER_PX,
          scrollback: prefs.scrollback,
          children: Math.max(1, held.length),
          wanting: held.filter((child) => wantsCard(child, family)).length
        })
  const fits = room === null ? null : room.fits
  const capacity = room !== null && room.fits ? room.cards : 0
  useLayoutEffect(() => {
    if (fits !== null) reportFamilyRoom(tab, { fits, capacity })
  }, [tab, fits, capacity])
  useEffect(() => () => forgetFamilyRoom(tab), [tab])

  const drawn = room !== null && room.fits && held.length > 0 ? room : null
  const entries = drawn === null ? [] : familyEntries(sessions, family, drawn.cards)
  const cards = entries.filter((entry) => entry.shape === 'card' || entry.shape === 'screen')
  const headers = entries.filter((entry) => entry.shape === 'header' || entry.shape === 'ended')
  const kidOf = new Map(kids.map((kid) => [kid.session.id, kid]))

  // A command child is known by its record's command; a kid the window marked is one too.
  const isCommand = (child: SessionRecord): boolean => isCommandChild(child) || kidOf.get(child.id)?.command === true

  const header = ({ child, shape }: FamilyEntry<SessionRecord>): JSX.Element => {
    const kid = kidOf.get(child.id)
    const name = sessionLabel(child)
    const running = shape === 'card' || shape === 'header'
    const command = isCommand(child)
    const state = dotOf(child, kid?.state ?? 'running', command)
    return (
      <ChildHeader
        key={child.id}
        shape={shape}
        name={name}
        state={state}
        role={child.role}
        command={command}
        status={
          running
            ? childStatus(child, state, kid?.since ?? (command ? startedMs(child) : null), now)
            : endedHeaderText(child, stoppedByYou.has(child.id))
        }
        onPress={() =>
          arrange((layout) =>
            shape === 'card' || shape === 'screen'
              ? shrinkFamilyChild(layout, tab, child)
              : showFamilyChild(layout, tab, held, drawn === null ? null : drawn.cards, child.id)
          )
        }
        onOpenAsTab={
          shape === 'card'
            ? () =>
                arrange((layout) =>
                  openFamilyChildAsTab(layout, tab, { id: child.id, host }, new Set(sessions.map((each) => each.id)))
                )
            : undefined
        }
        onStop={shape === 'card' ? () => stop(child.id) : undefined}
        onClose={
          shape === 'screen' || shape === 'ended'
            ? () => arrange((layout) => closeFamilyChild(layout, tab, child.id))
            : undefined
        }
      />
    )
  }

  // This tab's own session, when it is a child that has reported. A command
  // child never has a report from the host, so the guard `command` gives a card
  // is not needed here.
  const ownNote = own === undefined ? null : reportNote(own)

  return (
    <div ref={bodyRef} className={cn('absolute inset-0', front ? 'block' : 'hidden')} aria-hidden={!front}>
      <FamilyFrame
        axis={drawn === null ? null : drawn.axis}
        parent={parent}
        // A later report is another note, which starts folded.
        note={ownNote === null ? null : <ReportNote key={ownNote.at} label={ownNote.label} text={ownNote.text} />}
      >
        {drawn !== null && (
          <FamilyKids
            axis={drawn.axis}
            cardCount={cards.length}
            cards={cards.map((entry) => {
              const note = reportNote(entry.child, { command: isCommand(entry.child) })
              return (
                <FamilyCard
                  key={entry.child.id}
                  name={sessionLabel(entry.child)}
                  header={header(entry)}
                  // A later report is another note, which starts folded.
                  note={note === null ? null : <ReportNote key={note.at} label={note.label} text={note.text} />}
                >
                  <TerminalPane
                    card
                    session={entry.child}
                    host={host}
                    active={front}
                    windowsBuild={windowsBuild}
                    onClose={(id) => arrange((layout) => closeFamilyChild(layout, tab, id))}
                    hostGone={hostGone}
                    hostLost={hostLost}
                  />
                </FamilyCard>
              )
            })}
            headers={headers.map(header)}
            // The headers the pane has room for; more of them scroll, so the cards keep their rows.
            headersMax={Math.max(headers.length > 0 ? 1 : 0, drawn.headers) * FAMILY_HEADER_PX}
          />
        )}
      </FamilyFrame>
    </div>
  )
}
