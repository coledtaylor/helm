import type { DragEvent, JSX, KeyboardEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import {
  SESSION_STATE_DOT,
  SESSION_STATE_LABEL,
  type SessionState
} from '../lib/sessionstate'
import { CloseIcon } from './icons'

/**
 * Whether a tab's session is alive, what it is doing, and how it ended. An
 * alias, because a tab is not the only place this is painted: the sessions
 * pane and the sidebar's session rows carry the same seven, and the tones live
 * in `lib/sessionstate.ts` so they cannot drift apart.
 */
export type TabIndicator = SessionState

export interface Tab {
  id: string
  /** One line, always. What a tab used to say on a second line - a session's
   * branch, a pane's scope - is on the pane's crumb row or in `hint`. */
  title: string
  /** Shown before the title when there is no state dot. */
  icon?: ReactNode | undefined
  /**
   * A short muted word after the title, on the same line. One use: the session
   * that opened a browser tab, because a tab Claude opened and one the user
   * opened are otherwise identical in the strip, and a name only the hover text
   * carries is a name nobody sees.
   */
  badge?: string | undefined
  closable?: boolean | undefined
  indicator?: TabIndicator | undefined
  /** Hover text. A session tab puts its working directory here. */
  hint?: string | undefined
  /** Tabs are only reorderable among tabs that agree they are. */
  draggable?: boolean | undefined
  /**
   * Whether double-clicking the title opens an inline rename. Needs `onRename`
   * on the bar as well.
   */
  renamable?: boolean | undefined
}

export interface TabBarProps {
  tabs: Tab[]
  activeId: string | null
  /**
   * Whether this strip's pane is the focused one. Its front tab takes the
   * stronger fill; the other pane's front tab the hover tone - so with two
   * panes on screen, which one the keyboard means is visible at a glance.
   */
  focused: boolean
  onActivate: (id: string) => void
  onClose: (id: string) => void
  /**
   * A tab should end up at `toIndex` in this strip - moved along it by
   * keyboard or pointer, or dropped onto it from the other pane's strip. The
   * index counts after the tab has left wherever it was. Omit to disable both.
   */
  onMove?: ((id: string, toIndex: number) => void) | undefined
  /**
   * A tab was renamed. Null means the label was cleared and the caller should go
   * back to whatever it calls the thing by default. Omit to disable renaming.
   */
  onRename?: ((id: string, label: string | null) => void) | undefined
  /** The pane's own controls - split, maximize, close - kept out of the
   * strip's scroll so they stay reachable when tabs overflow. */
  actions?: ReactNode | undefined
  /**
   * Whether a tab is being dragged right now.
   *
   * Reported because something outside the DOM needs to know. The browser
   * pane's `WebContentsView` paints above every pixel the renderer draws,
   * including the drop mark and the ghost of the tab being moved - so it gets
   * out of the way for the length of the gesture. A drag is a fraction of a
   * second and the page keeps running behind it, which is why this is the
   * cheap answer and a scrim would not be: a drag is not modal.
   *
   * A **toast** deliberately does not do this. See `App.tsx`.
   */
  onDragging?: ((dragging: boolean) => void) | undefined
}

/**
 * The drag payload's type. Its own, rather than `text/plain` alone, so a strip
 * can tell a tab being dragged from text being dragged over it - and so the
 * other pane's strip, which never saw the drag start, can accept it.
 */
const TAB_MIME = 'application/x-helm-tab'

/**
 * A pane's tabs, as one-line pills.
 *
 * Pills on the island rather than folder tabs lifting into it: with two panes
 * side by side, each an island, the strip is a row *inside* its pane and the
 * front tab is marked by fill rather than by joining the pane below. That is
 * also what lets every tab be one line - a folder tab needed its second line
 * to carry what the pane under it did not show, and the crumb row now does.
 *
 * Reordering is a pointer drag with a keyboard equivalent, Ctrl+Shift+Arrow,
 * because a strip that can only be arranged with a mouse is a strip half the
 * ways into this app cannot reach. A drag can also carry a tab across to the
 * other pane's strip, which is how a tab changes pane by pointer.
 *
 * With nothing to hang off it - no tabs and no actions - the strip is not drawn
 * at all rather than drawn empty.
 */
export function TabBar({
  tabs,
  activeId,
  focused,
  onActivate,
  onClose,
  onMove,
  onRename,
  actions,
  onDragging
}: TabBarProps): JSX.Element | null {
  /** The tab this strip is dragging, if the drag started here. */
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  /** The tab being renamed, or null. One at a time - there is one caret. */
  const [editing, setEditing] = useState<string | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)

  /**
   * An activated tab is scrolled back into view: Ctrl+Tab, a notification and
   * a freshly launched session can all bring a tab to the front while it is
   * past the edge. `nearest`, so a tab already on screen is left where it is.
   */
  useEffect(() => {
    if (activeId === null) return
    const strip = stripRef.current
    const tab = strip?.querySelector(`[data-tab="${CSS.escape(activeId)}"]`)
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  const canMove = onMove !== undefined

  const finishDrag = (): void => {
    setDragging(null)
    setDropIndex(null)
    onDragging?.(false)
  }

  const carriesTab = (event: DragEvent<HTMLElement>): boolean =>
    canMove && event.dataTransfer.types.includes(TAB_MIME)

  const dropAt = (index: number, event: DragEvent<HTMLElement>): void => {
    if (!carriesTab(event)) return
    event.preventDefault()
    event.stopPropagation()
    const id = event.dataTransfer.getData(TAB_MIME)
    setDropIndex(null)
    if (id === '') return
    const from = tabs.findIndex((t) => t.id === id)
    // A tab from this strip is lifted out before it lands, so a drop past
    // where it came from lands one place short. One from the other strip
    // removes nothing here.
    onMove?.(id, from >= 0 && from < index ? index - 1 : index)
  }

  const moveWithKeyboard = (event: KeyboardEvent<HTMLElement>, index: number): void => {
    if (!canMove || !event.ctrlKey || !event.shiftKey) return
    const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (delta === 0) return
    const target = index + delta
    if (target < 0 || target >= tabs.length) return
    event.preventDefault()
    onMove?.(tabs[index]!.id, target)
  }

  if (tabs.length === 0 && !actions) return null

  return (
    <div className="flex h-strip shrink-0 items-center gap-1 border-b border-border px-1.5">
      <div
        role="tablist"
        aria-label="Open tabs"
        ref={stripRef}
        // The empty stretch past the last tab is a drop target too: "put it at
        // the end" is the commonest place to drop a tab from the other pane.
        onDragOver={(event) => {
          if (!carriesTab(event)) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setDropIndex(tabs.length)
        }}
        onDrop={(event) => dropAt(tabs.length, event)}
        // The caret is cleared here and not on each tab. Leaving a tab for its
        // neighbour fires that tab's `dragleave` *after* the neighbour's
        // `dragover` has already set the insertion point, so a per-tab handler
        // spends the drag erasing the mark the next tab just drew. Only leaving
        // the strip altogether means there is no insertion point any more.
        onDragLeave={(event) => {
          const entering = event.relatedTarget
          if (entering instanceof Node && event.currentTarget.contains(entering)) return
          setDropIndex(null)
        }}
        // A wheel over the strip scrolls it sideways. A container with
        // `overflow-x-auto` gives a vertical wheel nothing to do unless Shift
        // is held, which leaves the tabs past the edge unreachable by any
        // gesture a person would try. `deltaX` is left alone: a trackpad's
        // sideways swipe already arrives on the right axis.
        onWheel={(event) => {
          if (event.deltaY === 0) return
          const strip = event.currentTarget
          if (strip.scrollWidth <= strip.clientWidth) return
          strip.scrollLeft += event.deltaY
        }}
        className="tab-scroll flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-hidden"
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeId
          const renaming = editing === tab.id
          // Not while the caret is in the title: a drag that starts on a
          // focused input takes the focus with it and commits the edit halfway.
          const movable = canMove && tab.draggable !== false && !renaming
          const canRename = onRename !== undefined && tab.renamable === true
          const closable = tab.closable !== false
          return (
            <div
              key={tab.id}
              draggable={movable}
              onDragStart={(event) => {
                setDragging(tab.id)
                onDragging?.(true)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData(TAB_MIME, tab.id)
                // Chromium refuses to start a drag with no plain payload.
                event.dataTransfer.setData('text/plain', tab.id)
              }}
              onDragEnd={finishDrag}
              onDragOver={(event) => {
                if (!carriesTab(event)) return
                event.preventDefault()
                event.stopPropagation()
                event.dataTransfer.dropEffect = 'move'
                // Past the midpoint means "after this tab", which is the same
                // insertion point as "before the next one".
                const box = event.currentTarget.getBoundingClientRect()
                setDropIndex(event.clientX < box.left + box.width / 2 ? index : index + 1)
              }}
              onDrop={(event) => dropAt(dropIndex ?? index, event)}
              // Middle-click closes, as it does on every tab strip people
              // already use. `mousedown` is swallowed so the button does not
              // also start Chromium's autoscroll.
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault()
              }}
              onAuxClick={(event) => {
                if (event.button === 1 && closable) onClose(tab.id)
              }}
              className={cn(
                'group relative flex h-[calc(var(--helm-strip)-10px)] min-w-0 shrink-0 items-center rounded-raised transition-colors',
                active ? (focused ? 'bg-active' : 'bg-hover') : 'hover:bg-hover',
                dragging === tab.id && 'opacity-40'
              )}
            >
              {/* One caret per insertion point, and only one: an interior seam
                  is describable twice - after tab k-1, before tab k - and
                  drawing both put two marks 4px apart where the tab would land.
                  The left edge is the general case; the right edge of the last
                  tab carries the one insertion point with no tab to its right. */}
              {dropIndex === index && (
                <span aria-hidden className="absolute inset-y-1 -left-[2px] w-[2px] rounded bg-accent" />
              )}
              {dropIndex === tabs.length && index === tabs.length - 1 && (
                <span aria-hidden className="absolute inset-y-1 -right-[2px] w-[2px] rounded bg-accent" />
              )}

              {renaming ? (
                // Not a `<button role="tab">` for the length of the edit: a text
                // field inside a button is invalid, and every click meant for
                // the caret would activate the tab underneath it.
                <div
                  className={cn(
                    'flex h-full min-w-0 max-w-[200px] items-center gap-[7px] pl-2.5 text-[12.5px]',
                    closable ? 'pr-1' : 'pr-2.5'
                  )}
                >
                  <Mark tab={tab} active={active} />
                  <TabRename
                    tabId={tab.id}
                    initial={tab.title}
                    onDone={(label) => {
                      setEditing(null)
                      if (label !== undefined) onRename?.(tab.id, label)
                    }}
                  />
                </div>
              ) : (
                <button
                  type="button"
                  role="tab"
                  data-tab={tab.id}
                  aria-selected={active}
                  // The state dot is drawn, not written, so the name it would
                  // otherwise be missing is spelled out here rather than in a
                  // visually-hidden span that would glue itself to the title.
                  aria-label={
                    tab.indicator === undefined
                      ? undefined
                      : `${tab.title}, ${SESSION_STATE_LABEL[tab.indicator]}`
                  }
                  title={tab.hint}
                  onClick={() => onActivate(tab.id)}
                  // Double-click, not a menu and not a pencil on hover: the tab
                  // is the thing being named, and it costs the strip no pixels.
                  onDoubleClick={canRename ? () => setEditing(tab.id) : undefined}
                  onKeyDown={(event) => moveWithKeyboard(event, index)}
                  // The front tab keeps its fill under the pointer: that fill
                  // says "front of this pane" and a tone that moved would say
                  // something else. What answers is the close button beside it,
                  // `opacity-60` at rest and full on `group-hover`. That
                  // exemption is for tabs and nothing else.
                  className={cn(
                    'flex h-full min-w-0 max-w-[200px] items-center gap-[7px] pl-2.5 text-[12.5px]',
                    closable ? 'pr-1' : 'pr-2.5',
                    active ? 'text-fg' : 'text-fg-muted group-hover:text-fg'
                  )}
                >
                  <Mark tab={tab} active={active} />
                  <span data-tab-title className="min-w-0 truncate leading-[16px]">
                    {tab.title}
                  </span>
                  {tab.badge !== undefined && (
                    <span
                      data-tab-badge
                      className="max-w-[96px] min-w-0 shrink-0 truncate text-[11px] leading-[16px] text-fg-subtle"
                    >
                      {tab.badge}
                    </span>
                  )}
                </button>
              )}

              {closable && (
                <button
                  type="button"
                  onClick={() => onClose(tab.id)}
                  aria-label={`Close ${tab.title}`}
                  title={`Close ${tab.title}`}
                  className={cn(
                    'mr-1 grid size-[18px] shrink-0 place-items-center rounded-xs',
                    'text-fg-subtle opacity-0 transition hover:bg-border-strong hover:text-fg',
                    'group-hover:opacity-100 focus-visible:opacity-100',
                    active && 'opacity-60'
                  )}
                >
                  <CloseIcon width={11} height={11} />
                </button>
              )}
            </div>
          )
        })}
      </div>

      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  )
}

/** The dot, or the kind icon where there is no dot. */
function Mark({ tab, active }: { tab: Tab; active: boolean }): JSX.Element | null {
  if (tab.indicator !== undefined) {
    return (
      <span
        aria-hidden
        className={cn('size-1.5 shrink-0 rounded-full', SESSION_STATE_DOT[tab.indicator])}
      />
    )
  }
  if (!tab.icon) return null
  return (
    <span className={cn('shrink-0', active ? 'text-accent' : 'text-fg-subtle')}>{tab.icon}</span>
  )
}

/**
 * The rename field, open for as long as it has the caret.
 *
 * Three rules, and each is about a keystroke going where it was not meant to.
 *
 * **It takes the focus, and that is what keeps the terminal out of it.** A
 * session's terminal only receives what is typed while it holds focus, so an
 * open edit is already the answer to "does this swallow what the terminal
 * wants": the two cannot both have the caret. `TerminalPane` focuses its
 * terminal when it *becomes* the visible one, and not on output, so a session
 * printing into the pane behind this does not disturb it.
 *
 * **Escape abandons, Enter and blur commit.** Losing the field by clicking
 * elsewhere is the commonest way out of an inline edit and must not be the one
 * that quietly discards what was typed.
 *
 * **The keys stop here.** `stopPropagation` on the field's own keydown, so the
 * strip's Ctrl+Shift+Arrow never sees the arrows someone is using to move the
 * caret. Ctrl+Tab is bound on `window` in capture and still cycles tabs, which
 * is the right answer: it is a request to leave.
 *
 * An empty field commits null rather than an empty string - clearing the field
 * is the natural way to ask for the CLI's own name back.
 */
function TabRename({
  tabId,
  initial,
  onDone
}: {
  tabId: string
  initial: string
  /** `undefined` means cancelled and nothing should be written. */
  onDone: (label: string | null | undefined) => void
}): JSX.Element {
  const [value, setValue] = useState(initial)

  return (
    <input
      key={tabId}
      data-tab-rename={tabId}
      aria-label="Rename this tab"
      value={value}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          onDone(undefined)
        } else if (event.key === 'Enter') {
          event.preventDefault()
          onDone(value.trim() === '' ? null : value.trim())
        }
      }}
      onBlur={() => onDone(value.trim() === '' ? null : value.trim())}
      className="w-full min-w-0 rounded-well border border-accent bg-surface-sunken px-1 py-0 text-[12.5px] leading-[16px] text-fg outline-none"
    />
  )
}
