import type { DragEvent, JSX, KeyboardEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { CloseIcon } from './icons'

/** Whether a tab's session is alive, and how it ended if it is not. */
export type TabIndicator = 'running' | 'ended' | 'failed'

export interface Tab {
  id: string
  title: string
  /** Shown before the title; the launcher uses the project's kind icon. */
  icon?: ReactNode | undefined
  /**
   * A second line under the title, with its own truncation budget.
   *
   * Its own *line* is the point rather than a stylistic choice. The strip caps a
   * tab at 240px, and a scheme where what distinguishes two tabs shares a line
   * with what they have in common is a scheme that truncates back to identical
   * tabs at exactly the width where telling them apart starts to matter. Two
   * lines means the branch on a session tab gets the full width whatever the
   * title in front of it is doing.
   */
  subtitle?: string | undefined
  /** Mono for the subtitle - branches and paths, per DESIGN.md's machine data. */
  subtitleMono?: boolean | undefined
  closable?: boolean | undefined
  indicator?: TabIndicator | undefined
  /** Hover text. The launcher puts the working directory here. */
  hint?: string | undefined
  /** Tabs are only reorderable among tabs that agree they are. */
  draggable?: boolean | undefined
  /**
   * What the active tab lifts into. A folder tab reads as part of the pane
   * below it, so its fill must match that pane's ground: `island` for every
   * ordinary view, `terminal` for a session tab - the terminal keeps its own
   * fixed #11121A in both modes (DESIGN.md "foreign-ground islands"), and an
   * island-coloured tab on top of it would show a seam.
   */
  ground?: 'island' | 'terminal' | undefined
  /**
   * Whether double-clicking the title opens an inline rename. Needs `onRename`
   * on the bar as well - a tab that says it is renamable and a strip with
   * nowhere to send the answer is not a state worth having.
   */
  renamable?: boolean | undefined
}

export interface TabBarProps {
  tabs: Tab[]
  activeId: string | null
  onActivate: (id: string) => void
  onClose: (id: string) => void
  /** Called with the tab's new index within `tabs`. Omit to disable dragging. */
  onReorder?: ((id: string, toIndex: number) => void) | undefined
  /**
   * A tab was renamed. Null means the label was cleared and the caller should go
   * back to whatever it calls the thing by default. Omit to disable renaming.
   */
  onRename?: ((id: string, label: string | null) => void) | undefined
  /** Trailing controls - theme switch, about. Kept out of the tab strip's
   * scroll so they stay reachable when tabs overflow. */
  actions?: ReactNode | undefined
}

const INDICATOR_CLASS: Record<TabIndicator, string> = {
  running: 'bg-success',
  // Not border-strong: that token became a 16% alpha hairline, and a dot
  // filled with it disappears into whatever it sits on.
  ended: 'bg-fg-subtle',
  failed: 'bg-danger'
}

const INDICATOR_LABEL: Record<TabIndicator, string> = {
  running: 'running',
  ended: 'ended',
  failed: 'exited with an error'
}

/**
 * The strip the terminals hang off. It holds no session state of its own: a tab
 * is an id, a label and a dot, and what fills the pane is the caller's
 * business.
 *
 * Reordering is a pointer drag with a keyboard equivalent, not a pointer drag
 * alone. Ctrl+Shift+Arrow moves the focused tab, because a tab strip that can
 * only be arranged with a mouse is a tab strip half the ways into this app
 * cannot reach - and it costs one key handler.
 *
 * With nothing to hang off it - no tabs and no actions - the strip is not
 * drawn at all rather than drawn empty. Its 40px are reserved for tabs, and
 * holding them open on the welcome screen would drop the pane island 40px
 * below the sidebar island beside it, two edges that should line up.
 */
export function TabBar({
  tabs,
  activeId,
  onActivate,
  onClose,
  onReorder,
  onRename,
  actions
}: TabBarProps): JSX.Element | null {
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  /** The tab being renamed, or null. One at a time - there is one caret. */
  const [editing, setEditing] = useState<string | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)

  /**
   * An activated tab is scrolled back into view.
   *
   * The other half of a strip that scrolls: Ctrl+Tab, a notification click and
   * a freshly launched session can all make a tab active while it is past the
   * edge, and without this the pane below would change to something whose tab
   * cannot be seen. `nearest` rather than `center` so a tab already on screen
   * is left where it is - scrolling the strip under a person who just clicked
   * something on it would be its own bug.
   */
  useEffect(() => {
    if (activeId === null) return
    const strip = stripRef.current
    const tab = strip?.querySelector(`[data-tab="${CSS.escape(activeId)}"]`)
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  const canReorder = onReorder !== undefined

  const finishDrag = (): void => {
    setDragging(null)
    setDropIndex(null)
  }

  const dropOn = (index: number, event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    if (dragging === null) return
    const from = tabs.findIndex((t) => t.id === dragging)
    // Dropping on the far side of where it came from lands one place short
    // once the tab is lifted out of the list, so the index is taken after the
    // removal it is about to cause.
    onReorder?.(dragging, from >= 0 && from < index ? index - 1 : index)
    finishDrag()
  }

  const moveWithKeyboard = (event: KeyboardEvent<HTMLElement>, index: number): void => {
    if (!canReorder || !event.ctrlKey || !event.shiftKey) return
    const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (delta === 0) return
    const target = index + delta
    if (target < 0 || target >= tabs.length) return
    event.preventDefault()
    onReorder?.(tabs[index]!.id, target)
  }

  if (tabs.length === 0 && !actions) return null

  return (
    <div className="flex h-10 shrink-0 items-end px-1.5">
      <div
        role="tablist"
        aria-label="Open tabs"
        // `overflow-x-auto` promotes the other axis from `visible` to `auto`,
        // so the active tab's 1px overlap into the pane below counted as
        // scrollable overflow and Chromium painted a vertical scrollbar over
        // the strip. The overlap is unchanged - the strip reaches 1px into the
        // pane (`-mb-px`) and spends that pixel as bottom padding (`pb-px`), so
        // the tab's overshoot lands inside the scroll container instead of past
        // it. `overflow-y-hidden` keeps it that way if a tab ever grows.
        // The caret is cleared here and not on each tab. Leaving a tab for its
        // neighbour fires that tab's `dragleave` *after* the neighbour's
        // `dragover` has already set the insertion point, so a per-tab handler
        // spends the drag erasing the mark the next tab just drew. Only leaving
        // the strip altogether means there is no insertion point any more, and
        // `relatedTarget` - the element being entered - is what says so.
        onDragLeave={(event) => {
          const entering = event.relatedTarget
          if (entering instanceof Node && event.currentTarget.contains(entering)) return
          setDropIndex(null)
        }}
        ref={stripRef}
        // A wheel over the strip scrolls it sideways.
        //
        // This is not a nicety, it is the other half of hiding the bar.
        // `tab-scroll` takes the scrollbar away for the reason theme.css gives,
        // and a container with `overflow-x-auto` and no bar is one Chromium
        // gives no way to reach: a vertical wheel does nothing to it unless
        // Shift is held, so hiding the bar on its own left the tabs past the
        // edge unreachable by any gesture a person would try. Every tab strip
        // that hides its bar - the browser's own included - translates the
        // wheel like this, and it is why they can get away with hiding it.
        //
        // `deltaX` is left alone: a trackpad's sideways swipe already arrives
        // on the right axis and doubling it would make the strip skid.
        onWheel={(event) => {
          if (event.deltaY === 0) return
          const strip = event.currentTarget
          if (strip.scrollWidth <= strip.clientWidth) return
          strip.scrollLeft += event.deltaY
        }}
        // `tab-scroll` hides the bar itself; see theme.css for why a strip this
        // short cannot carry one.
        className="tab-scroll -mb-px flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto overflow-y-hidden pb-px"
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeId
          const renaming = editing === tab.id
          // Not while the caret is in the title: a drag that starts on a focused
          // input takes the focus with it and commits the edit halfway through
          // the gesture.
          const reorderable = canReorder && tab.draggable !== false && !renaming
          const terminalGround = tab.ground === 'terminal'
          const canRename = onRename !== undefined && tab.renamable === true
          return (
            <div
              key={tab.id}
              draggable={reorderable}
              onDragStart={(event) => {
                setDragging(tab.id)
                event.dataTransfer.effectAllowed = 'move'
                // Firefox and Chromium both refuse to start a drag with no
                // payload, even when nothing reads it.
                event.dataTransfer.setData('text/plain', tab.id)
              }}
              onDragEnd={finishDrag}
              onDragOver={(event) => {
                if (!reorderable || dragging === null) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                // Past the midpoint means "after this tab", which is the same
                // insertion point as "before the next one".
                const box = event.currentTarget.getBoundingClientRect()
                setDropIndex(event.clientX < box.left + box.width / 2 ? index : index + 1)
              }}
              onDrop={(event) => dropOn(dropIndex ?? index, event)}
              className={cn(
                // A folder tab: the active one lifts into the pane island below
                // it - same fill, hairline edge on three sides, and a 1px
                // overlap that erases the island's top border under it. The
                // z-index is what makes the overlap paint over the pane, which
                // is later in the DOM.
                'group relative flex h-[34px] min-w-0 shrink-0 items-center',
                'rounded-t-[9px] border border-b-0 border-transparent',
                active
                  ? cn('z-10 -mb-px border-border', terminalGround ? 'bg-terminal' : 'bg-surface')
                  : 'hover:bg-hover/60',
                dragging === tab.id && 'opacity-40'
              )}
            >
              {/* One caret per insertion point, and only one. An interior seam
                  is describable twice - after tab k-1, before tab k - and
                  drawing both put two 2px marks 4px apart on screen where the
                  tab was going to land. The left edge is the general case; the
                  right edge of the last tab is the only insertion point that
                  has no tab to its right to carry it. */}
              {dropIndex === index && (
                <span aria-hidden className="absolute inset-y-1 left-0 w-[2px] rounded bg-accent" />
              )}
              {dropIndex === tabs.length && index === tabs.length - 1 && (
                <span aria-hidden className="absolute inset-y-1 right-0 w-[2px] rounded bg-accent" />
              )}

              {renaming ? (
                // Not a `<button role="tab">` for the length of the edit: a text
                // field inside a button is invalid, and every click meant for
                // the caret would activate the tab underneath it. The dot and
                // the subtitle stay put, so the strip does not move.
                <div
                  className={cn(
                    'flex min-w-0 max-w-[240px] items-center gap-1.5 py-0 pl-3 text-[12px]',
                    tab.closable === false ? 'pr-3' : 'pr-1'
                  )}
                >
                  {tab.indicator !== undefined && (
                    <span
                      aria-hidden
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        INDICATOR_CLASS[tab.indicator]
                      )}
                    />
                  )}
                  <span className="flex min-w-0 flex-col items-stretch">
                    <TabRename
                      tabId={tab.id}
                      initial={tab.title}
                      terminalGround={terminalGround}
                      onDone={(label) => {
                        setEditing(null)
                        if (label !== undefined) onRename?.(tab.id, label)
                      }}
                    />
                    <Subtitle tab={tab} active={active} terminalGround={terminalGround} />
                  </span>
                </div>
              ) : (
                <button
                  type="button"
                  role="tab"
                  data-tab={tab.id}
                  aria-selected={active}
                  // The state dot is drawn, not written, so the name it would
                  // otherwise be missing is spelled out here instead of hidden in
                  // a visually-hidden span - which would land inside the tab's
                  // own text and glue itself to the title, reading as
                  // "runningapi-server" for a tab called "api-server".
                  aria-label={
                    tab.indicator === undefined
                      ? undefined
                      : `${tab.title}, ${INDICATOR_LABEL[tab.indicator]}`
                  }
                  title={tab.hint}
                  onClick={() => onActivate(tab.id)}
                  // Double-click, not a menu and not a pencil that appears on
                  // hover: the tab is the thing being named, so the gesture is
                  // the one every other strip of renamable labels uses, and it
                  // costs the strip no pixels at rest.
                  onDoubleClick={canRename ? () => setEditing(tab.id) : undefined}
                  onKeyDown={(event) => moveWithKeyboard(event, index)}
                  className={cn(
                    'flex min-w-0 max-w-[240px] items-center gap-1.5 py-0 pl-3 text-[12px]',
                    tab.closable === false ? 'pr-3' : 'pr-1',
                    active
                      ? // The terminal's ground is fixed in both modes, so the
                        // text on it is too - fg would go near-black in light
                        // mode on a surface that stayed dark.
                        terminalGround
                        ? 'text-[#dde1ea]'
                        : 'text-fg'
                      : 'text-fg-muted group-hover:text-fg'
                  )}
                >
                  {tab.indicator !== undefined ? (
                    <span
                      aria-hidden
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        INDICATOR_CLASS[tab.indicator]
                      )}
                    />
                  ) : (
                    tab.icon && (
                      <span className={cn('shrink-0', active ? 'text-accent' : 'text-fg-subtle')}>
                        {tab.icon}
                      </span>
                    )
                  )}
                  {/* Title over subtitle, each with the tab's whole width to
                      truncate in. See `Tab.subtitle`. */}
                  <span className="flex min-w-0 flex-col items-start">
                    <span className="min-w-0 max-w-full truncate leading-[15px]">{tab.title}</span>
                    <Subtitle tab={tab} active={active} terminalGround={terminalGround} />
                  </span>
                </button>
              )}

              {tab.closable !== false && (
                <button
                  type="button"
                  onClick={() => onClose(tab.id)}
                  aria-label={`Close ${tab.title}`}
                  title={`Close ${tab.title}`}
                  className={cn(
                    'mr-1.5 grid size-5 shrink-0 place-items-center rounded',
                    'text-fg-subtle opacity-0 transition hover:bg-hover hover:text-fg',
                    'group-hover:opacity-100 focus-visible:opacity-100',
                    active && 'opacity-60'
                  )}
                >
                  <CloseIcon width={12} height={12} />
                </button>
              )}
            </div>
          )
        })}
      </div>

      {actions && <div className="mb-1 flex shrink-0 items-center gap-1 self-center px-2">{actions}</div>}
    </div>
  )
}

/**
 * The tab's second line.
 *
 * Its own component only because the edit renders it too: the branch a session
 * is on is the context for what you are about to call it, so it stays on screen
 * while the title is being typed.
 *
 * On an active session tab the colour is pinned rather than a token, for the
 * reason the title beside it is: that tab's ground is the terminal's fixed
 * `#11121A` in both modes, and `#9397ab` is the dim value DESIGN.md par. 6
 * already sanctions on it - the same one the shell pane's header uses for the
 * running executable.
 */
function Subtitle({
  tab,
  active,
  terminalGround
}: {
  tab: Tab
  active: boolean
  terminalGround: boolean
}): JSX.Element | null {
  if (tab.subtitle === undefined) return null
  return (
    <span
      data-tab-subtitle
      className={cn(
        'min-w-0 max-w-full truncate text-[10px] leading-[12px]',
        tab.subtitleMono === true && 'font-mono',
        active
          ? terminalGround
            ? 'text-[#9397ab]'
            : 'text-accent-text'
          : 'text-fg-subtle group-hover:text-fg-muted'
      )}
    >
      {tab.subtitle}
    </span>
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
 * wants": the two cannot both have the caret. What would break that is the pane
 * grabbing focus back underneath the edit - `TerminalPane` focuses its terminal
 * when it *becomes* the visible one, and not on output, so a session printing
 * into the pane behind this does not disturb it.
 *
 * **Escape abandons, Enter and blur commit.** Losing the field by clicking
 * elsewhere is the commonest way out of an inline edit and must not be the one
 * that quietly discards what was typed; the deliberate cancel is the key that
 * means cancel everywhere else in the app.
 *
 * **The keys stop here.** `stopPropagation` on the field's own keydown, so the
 * strip's Ctrl+Shift+Arrow reorder never sees the arrows someone is using to
 * move the caret. Ctrl+Tab is bound on `window` in capture and still cycles
 * tabs, which is the right answer: it is a request to leave.
 *
 * An empty field commits null rather than an empty string - a tab with no title
 * is not a state to allow, and clearing the field is the natural way to ask for
 * the CLI's own name back.
 */
function TabRename({
  tabId,
  initial,
  terminalGround,
  onDone
}: {
  tabId: string
  initial: string
  terminalGround: boolean
  /** `undefined` means cancelled and nothing should be written. */
  onDone: (label: string | null | undefined) => void
}): JSX.Element {
  const [value, setValue] = useState(initial)

  return (
    <input
      // Keyed by the tab so switching which tab is being renamed remounts the
      // field rather than carrying the previous tab's text into it.
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
      className={cn(
        'w-full min-w-0 rounded-[4px] border px-1 py-0 text-[12px] leading-[15px] outline-none',
        // A themed input on a tab whose ground stays `#11121A` in both modes
        // would drop a white field onto a dark tab in light mode. Every value
        // here is pinned for that reason and no other - DESIGN.md par. 6, the
        // foreign-ground hex exception, the same one the shell pane's picker
        // takes. `#0d0e17` is the dark ramp's sunken value.
        terminalGround
          ? 'border-[#9184d9] bg-[#0d0e17] text-[#dde1ea] selection:bg-[#9184d9]/30'
          : 'border-accent bg-surface-sunken text-fg'
      )}
    />
  )
}
