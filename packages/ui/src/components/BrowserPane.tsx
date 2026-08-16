import type { JSX } from 'react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { SEGMENT_ON } from '../lib/segmented'
import { ConsolePanel, type ConsoleEntry } from './ConsolePanel'
import {
  BackIcon,
  ExternalIcon,
  DevToolsIcon,
  ForwardIcon,
  RefreshIcon,
  SearchIcon
} from './icons'

/** Everything the pane knows about the view behind it. Mirrors `BrowserState`. */
export interface BrowserPaneState {
  id: number
  url: string
  title: string
  host: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  problem: string | null
  retryingUntil: number | null
  zoomLevel: number
  errors: number
  devtoolsOpen: boolean
  find: { query: string; matches: number; active: number } | null
  project: string | null
}

/** The width presets, in CSS pixels. `null` is "whatever the pane is". */
export const BROWSER_WIDTHS: Array<[string, number | null]> = [
  ['Phone', 390],
  ['Tablet', 820],
  ['Full', null]
]

export interface BrowserPaneProps {
  state: BrowserPaneState
  entries: readonly ConsoleEntry[]
  /**
   * Where the view should be, in CSS pixels relative to the window, and
   * whether it should paint.
   *
   * The pane measures its own placeholder and hands the rectangle up; the
   * caller adds the reasons to hide that the pane cannot know about - a
   * dialog, the workspace column collapsed, a tab being dragged - and sends it
   * to main. The pane is deliberately not the place those reasons are
   * collected: it is mounted only while it is the active tab, so it cannot see
   * three of the four.
   */
  onBounds: (rect: { x: number; y: number; width: number; height: number }) => void
  onNavigate: (input: string) => void
  onBack: () => void
  onForward: () => void
  onReload: (hard: boolean) => void
  onDevTools: () => void
  onOpenExternal: (url: string) => void
  onFind: (query: string, forward: boolean) => void
  onStopFind: () => void
  onZoom: (level: number) => void
  onClearStorage: () => void
  onEvaluate: (source: string) => Promise<{ ok: boolean; value: string; error: string | null }>
  /**
   * The pane is drawing something over where the view is, and the view has to
   * stand down for it.
   *
   * The recent-address dropdown hangs below the address bar and therefore over
   * the page, and a native view paints above **all** renderer DOM - so without
   * this the dropdown is drawn and then covered, which is what the first capture
   * of this pane showed: a list clipped to the few pixels above the view's top
   * edge. The same answer the tab drag gets, for the same reason: it is
   * transient, the user is looking straight at it, and the page keeps running
   * behind it.
   */
  onCovering: (covering: boolean) => void
  /** The last addresses visited, newest first. The dropdown, and nothing more. */
  recent: readonly string[]
  /** Focus the address bar. Bumped by Ctrl+L, which is a window-level binding. */
  focusAddressAt: number
}

/**
 * The browser pane: an address-bar island, a hole for the native view, and a
 * console under it.
 *
 * **The hole is the design.** A `WebContentsView` paints above all renderer
 * DOM, so the middle of this pane is not a component at all - it is a `div`
 * whose only job is to have a rectangle, measured and sent to the main process
 * so the view can be put exactly there. Everything drawn here is drawn *around*
 * it. That is also why the placeholder carries no border, no radius and no
 * ground of its own: the view's ground is the page's, which is foreign ground
 * (DESIGN.md 6), and a rounded corner Helm drew would be a rounded corner the
 * page paints straight over.
 *
 * **It never reaches the top 36px.** The window hides the native title bar and
 * lets Windows draw the min/max/close buttons there, and a native view is above
 * those too. The layout keeps well clear - a tab strip and this island are
 * between - and main clamps the rectangle anyway, because a layout is not a
 * guarantee.
 */
export function BrowserPane({
  state,
  entries,
  onBounds,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onDevTools,
  onOpenExternal,
  onFind,
  onStopFind,
  onZoom,
  onClearStorage,
  onEvaluate,
  onCovering,
  recent,
  focusAddressAt
}: BrowserPaneProps): JSX.Element {
  const holeRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  /**
   * What is in the address bar, as an override rather than a copy.
   *
   * Null means "whatever the page is", so the bar follows a redirect, a retry
   * that finally connected and a `history.pushState` without anything having to
   * copy the URL into state - and a keystroke is not overwritten mid-word by a
   * page that navigated itself. Typing sets the override; committing, Escape
   * and blurring clear it. Derived, so there is no effect syncing two values
   * that can disagree.
   */
  const [draft, setDraft] = useState<string | null>(null)
  const typed = draft ?? state.url
  const [suggesting, setSuggesting] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [finding, setFinding] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [width, setWidth] = useState<number | null>(null)

  // Ctrl+L. The effect touches the DOM and nothing else - which is what an
  // effect is for, and why the caret being here is not React state.
  useEffect(() => {
    if (focusAddressAt === 0) return
    addressRef.current?.focus()
    addressRef.current?.select()
  }, [focusAddressAt])

  /**
   * The dropdown is over the page, so the page stands down while it is up.
   *
   * An effect rather than a call beside each `setSuggesting`, because the thing
   * being synchronised is an **external system** - a native view in another
   * process - with a piece of React state, which is what an effect is for. The
   * cleanup covers the case the call sites cannot: unmounting the pane with the
   * dropdown open, where nothing would otherwise ever say it had closed.
   */
  const showingList = suggesting && recent.length > 0
  useEffect(() => {
    onCovering(showingList)
    return () => onCovering(false)
  }, [showingList, onCovering])

  /**
   * The rectangle, measured and reported.
   *
   * `useLayoutEffect` for the first one so the view is placed in the same frame
   * the pane appears in - an effect would put the view one frame behind, which
   * on a tab switch is a visible flash of the page in the wrong place. After
   * that a `ResizeObserver` on the placeholder catches the split drag, the
   * window resize and the console opening; a scroll or a layout change that
   * moves the pane without resizing it is caught by the window listeners, since
   * `ResizeObserver` fires on size and not on position.
   */
  const report = useCallback(() => {
    const box = holeRef.current?.getBoundingClientRect()
    if (box === undefined) return
    onBounds({ x: box.x, y: box.y, width: box.width, height: box.height })
  }, [onBounds])

  useLayoutEffect(() => {
    report()
    const hole = holeRef.current
    if (hole === null) return
    const observer = new ResizeObserver(() => report())
    observer.observe(hole)
    window.addEventListener('resize', report)
    window.addEventListener('scroll', report, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      window.removeEventListener('scroll', report, true)
    }
  }, [report])

  // A width preset changes the placeholder's box, which the observer above
  // turns into a `setBounds`. Reported here as well so the first frame after a
  // preset is picked is already right.
  useLayoutEffect(() => {
    report()
  }, [width, consoleOpen, report])

  const retrying = state.retryingUntil !== null

  return (
    <div data-pane="browser" className="flex h-full min-h-0 flex-col gap-2 p-2">
      <div
        data-browser-bar
        data-browser-recent-count={recent.length}
        className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 rounded-island border border-border bg-surface px-2 py-1.5"
      >
        <div className="flex shrink-0 items-center gap-0.5">
          <BarButton label="Back" disabled={!state.canGoBack} onClick={onBack} data-browser="back">
            <BackIcon width={14} height={14} />
          </BarButton>
          <BarButton
            label="Forward"
            disabled={!state.canGoForward}
            onClick={onForward}
            data-browser="forward"
          >
            <ForwardIcon width={14} height={14} />
          </BarButton>
          {/* Shift-click is the hard reload, which is the binding every browser
              already has - and the title says so, because a modifier nobody is
              told about is a feature nobody has. */}
          <BarButton
            label={state.loading ? 'Stop loading' : 'Reload (hold Shift to ignore the cache)'}
            onClick={(event) => onReload(event.shiftKey)}
            data-browser="reload"
          >
            <RefreshIcon width={14} height={14} className={state.loading ? 'animate-pulse' : ''} />
          </BarButton>
        </div>

        <div className="relative flex min-w-0 flex-1 items-center">
          <input
            ref={addressRef}
            data-browser-address
            value={typed}
            spellCheck={false}
            placeholder="Address, or a port number"
            aria-label="Address"
            onChange={(event) => {
              setDraft(event.target.value)
              setSuggesting(true)
            }}
            onFocus={() => setSuggesting(true)}
            // And on the click itself, not only on the focus it causes.
            // Clicking a bar that already has the caret fires no focus event, so
            // focus alone would leave the dropdown shut for exactly the gesture
            // somebody makes when they want it. `browser-check`'s BR-4 drives the
            // click and nothing else, which is what caught this.
            onClick={() => setSuggesting(true)}
            onBlur={() => {
              // After the click on a suggestion has had its chance to land.
              setTimeout(() => setSuggesting(false), 120)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setDraft(null)
                setSuggesting(false)
                addressRef.current?.blur()
                return
              }
              if (event.key !== 'Enter') return
              event.preventDefault()
              setSuggesting(false)
              setDraft(null)
              addressRef.current?.blur()
              onNavigate(typed)
            }}
            className={cn(
              'min-w-0 flex-1 rounded-well border border-border bg-surface-sunken px-2 py-1',
              'font-mono text-[12px] text-fg outline-none transition-colors',
              'placeholder:font-sans placeholder:text-fg-subtle',
              'focus:border-border-strong'
            )}
          />
          {showingList && (
            <ul
              data-browser-recent
              className={cn(
                'absolute left-0 right-0 top-full z-30 mt-1 max-h-64 overflow-auto',
                // No shadow. DESIGN.md allows exactly one, on a modal over a
                // dimmed backdrop, and this is neither - the stronger hairline
                // and the surface against the canvas are the elevation.
                'rounded-raised border border-border-strong bg-surface py-1'
              )}
            >
              {recent.map((url) => (
                <li key={url}>
                  <button
                    type="button"
                    data-browser-recent-url={url}
                    // `onMouseDown` rather than `onClick`: the input's blur
                    // fires first and would unmount this before a click landed.
                    onMouseDown={(event) => {
                      event.preventDefault()
                      setDraft(null)
                      setSuggesting(false)
                      onNavigate(url)
                    }}
                    className="block w-full truncate px-2 py-1 text-left font-mono text-[11px] text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                  >
                    {url}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <BarButton
            label="Find in page"
            onClick={() => {
              setFinding((current) => {
                if (current) onStopFind()
                return !current
              })
            }}
            data-browser="find"
          >
            <SearchIcon width={14} height={14} />
          </BarButton>
          <BarButton
            label={state.devtoolsOpen ? 'Close DevTools' : 'Open DevTools'}
            onClick={onDevTools}
            data-browser="devtools"
            on={state.devtoolsOpen}
          >
            <DevToolsIcon width={14} height={14} />
          </BarButton>
          <BarButton
            label="Open in your own browser"
            disabled={state.url === ''}
            onClick={() => onOpenExternal(state.url)}
            data-browser="external"
          >
            <ExternalIcon width={14} height={14} />
          </BarButton>
        </div>

        <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Viewport width">
          {BROWSER_WIDTHS.map(([label, px]) => (
            <button
              key={label}
              type="button"
              data-browser-width={label.toLowerCase()}
              aria-pressed={width === px}
              onClick={() => setWidth(px)}
              className={cn(
                'rounded-well px-1.5 py-0.5 text-[11px] transition-colors',
                width === px ? SEGMENT_ON : 'text-fg-muted hover:bg-hover hover:text-fg'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label="Zoom">
          <BarButton label="Zoom out" onClick={() => onZoom(state.zoomLevel - 0.5)} data-browser="zoom-out">
            <span aria-hidden className="text-[13px] leading-none">
              −
            </span>
          </BarButton>
          <span
            data-browser-zoom={String(state.zoomLevel)}
            className="w-9 text-center text-[11px] tabular-nums text-fg-subtle"
          >
            {zoomPercent(state.zoomLevel)}
          </span>
          <BarButton label="Zoom in" onClick={() => onZoom(state.zoomLevel + 0.5)} data-browser="zoom-in">
            <span aria-hidden className="text-[13px] leading-none">
              +
            </span>
          </BarButton>
        </div>

        <button
          type="button"
          data-browser="clear-storage"
          onClick={onClearStorage}
          title="Clear cookies and storage for Helm's browser profile"
          className="shrink-0 rounded-well px-1.5 py-0.5 text-[11px] text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          Clear storage
        </button>
      </div>

      {finding && (
        <div
          data-browser-find
          className="flex shrink-0 items-center gap-2 rounded-island border border-border bg-surface px-2 py-1.5"
        >
          <input
            data-browser-find-input
            autoFocus
            value={findQuery}
            aria-label="Find in page"
            placeholder="Find in page"
            spellCheck={false}
            onChange={(event) => {
              setFindQuery(event.target.value)
              onFind(event.target.value, true)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onFind(findQuery, !event.shiftKey)
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setFinding(false)
                onStopFind()
              }
            }}
            className={cn(
              'min-w-0 flex-1 rounded-well border border-border bg-surface-sunken px-2 py-1',
              'text-[12px] text-fg outline-none focus:border-border-strong'
            )}
          />
          <span data-browser-find-count className="shrink-0 text-[11px] tabular-nums text-fg-subtle">
            {state.find === null || state.find.matches === 0
              ? findQuery === ''
                ? ''
                : 'no matches'
              : `${String(state.find.active)} / ${String(state.find.matches)}`}
          </span>
        </div>
      )}

      {(state.problem !== null || retrying) && (
        <div
          data-browser-problem
          role="status"
          className={cn(
            'shrink-0 rounded-island border px-3 py-2 text-[12px]',
            retrying
              ? 'border-border bg-surface text-fg-muted'
              : 'border-danger/30 bg-danger/10 text-danger'
          )}
        >
          {state.problem}
        </div>
      )}

      {/*
        The hole. No ground, no border, no radius: the page paints here and
        Helm has no business tinting foreign ground. `min-h-0` so the console
        below can take its own height rather than pushing this off the pane.
      */}
      <div className="flex min-h-0 flex-1 justify-center">
        <div
          ref={holeRef}
          data-browser-hole={String(state.id)}
          style={width === null ? undefined : { maxWidth: `${String(width)}px` }}
          className="min-h-0 w-full flex-1"
        />
      </div>

      <ConsolePanel
        name="browser"
        entries={entries}
        open={consoleOpen}
        onToggle={() => setConsoleOpen((current) => !current)}
        onEvaluate={onEvaluate}
      />
    </div>
  )
}

/** A ghost icon button in the address-bar island, at the size the strip wants. */
function BarButton({
  label,
  disabled = false,
  on = false,
  onClick,
  children,
  ...hooks
}: {
  label: string
  disabled?: boolean
  on?: boolean
  onClick: (event: { shiftKey: boolean }) => void
  children: JSX.Element
} & Record<`data-${string}`, string>): JSX.Element {
  return (
    <button
      type="button"
      {...hooks}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => onClick(event)}
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-well transition-colors',
        disabled
          ? 'cursor-default text-fg-subtle/40'
          : on
            ? cn(SEGMENT_ON, 'text-fg')
            : 'text-fg-subtle hover:bg-hover hover:text-fg'
      )}
    >
      {children}
    </button>
  )
}

/** Chromium's zoom *level* is logarithmic; what a person reads is a percentage. */
const zoomPercent = (level: number): string => `${String(Math.round(1.2 ** level * 100))}%`
