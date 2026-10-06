import type { JSX, RefObject } from 'react'
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { PANES_MOVED_EVENT } from '../lib/paneGeometry'
import { SEGMENT_ON } from '../lib/segmented'
import { ConsolePanel, type ConsoleEntry } from './ConsolePanel'
import { AgentIcon, BackIcon, ExternalIcon, ForwardIcon, MoreIcon, RefreshIcon, SearchIcon, ShareIcon } from './icons'
import { Menu, type MenuEntry } from './Menu'

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
  /** The session that opened the page, or null when the user did. */
  openedBy: string | null
  /** Whether that session is still running, and so can still drive the page. */
  openerRunning: boolean
  /** The session the user has shared the page with, or null. */
  sharedWith: BrowserShareTarget | null
}

/** A session a page is shared with, or could be. Its id, and what it is called. */
export interface BrowserShareTarget {
  session: number
  name: string
}

/** The width presets, in CSS pixels. `null` is "whatever the pane is". */
export const BROWSER_WIDTHS: Array<[string, number | null]> = [
  ['Full', null],
  ['Tablet', 820],
  ['Phone', 390]
]

/**
 * Chromium zoom levels: a step is half a level (about 10%), and main holds
 * the page between -3 and 3 (58% to 173%).
 */
export const BROWSER_ZOOM = { step: 0.5, min: -3, max: 3 } as const

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
  /**
   * Somewhere the caret should go: the address bar (Ctrl+L, a new page) or
   * the find field (Ctrl+F). A request rather than a counter, answered once
   * with `onFocusRequestDone`, because the pane is rebuilt on every page
   * switch and a counter it read on mounting would pull the caret into the
   * address bar each time a page came to the front.
   */
  focusRequest: 'address' | 'find' | null
  onFocusRequestDone: () => void
  /** The engine a phrase is searched with, for the placeholder, or null when searching is off. */
  searchEngine: string | null
  /**
   * A picture of the page, painted in the hole while the view stands down for
   * something drawn over it (`useBrowsers`), or null.
   */
  still: string | null
  /**
   * Whether a page can be shared with a session at all: the browser tools are
   * on. A page an agent opened, which is its session's already, and an empty
   * one never offer it.
   */
  canShare: boolean
  /** The sessions this page could be shared with, asked for as the Share menu opens. */
  onShareTargets: () => Promise<readonly BrowserShareTarget[]>
  /** Share the page with a session, or (`null`) take it back. */
  onShare: (session: number | null) => void
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
  focusRequest,
  onFocusRequestDone,
  searchEngine,
  still,
  canShare,
  onShareTargets,
  onShare
}: BrowserPaneProps): JSX.Element {
  const holeRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const shareRef = useRef<HTMLButtonElement>(null)
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
  const [menuAt, setMenuAt] = useState<DOMRect | null>(null)
  const [shareMenu, setShareMenu] = useState<{ at: DOMRect; targets: readonly BrowserShareTarget[] } | null>(null)

  // Ctrl+F opens the find field before the effect below can put the caret in
  // it: adjusted while rendering, as React has state follow a prop.
  if (focusRequest === 'find' && !finding) setFinding(true)

  // The caret, wherever it was asked for. The effect touches the DOM and
  // answers the request, which is what an effect is for.
  useEffect(() => {
    if (focusRequest === null) return
    const field = focusRequest === 'find' ? findRef.current : addressRef.current
    field?.focus()
    field?.select()
    onFocusRequestDone()
  }, [focusRequest, onFocusRequestDone])

  /**
   * The dropdown is over the page, so the page stands down while it is up.
   *
   * An effect rather than a call beside each `setSuggesting`, because the thing
   * being synchronised is an **external system** - a native view in another
   * process - with a piece of React state, which is what an effect is for. The
   * cleanup covers the case the call sites cannot: unmounting the pane with the
   * dropdown open, where nothing would otherwise ever say it had closed.
   *
   * **It runs when the list opens or closes, and on nothing else.** The
   * callback is an effect event, so a caller passing a new function on every
   * render does not re-run it - which it did, and every re-run was a "closed"
   * then an "open". Standing down waits for a picture of the page, and the
   * picture arriving re-renders the pane, so the view came back every time it
   * was about to go: it never left, and a click meant for the list landed on
   * the page under it.
   */
  const showingList = suggesting && recent.length > 0
  const cover = useEffectEvent((covering: boolean) => onCovering(covering))
  useEffect(() => {
    cover(showingList)
    return () => cover(false)
  }, [showingList])

  /**
   * The rectangle, measured and reported.
   *
   * `useLayoutEffect` for the first one so the view is placed in the same frame
   * the pane appears in - an effect would put the view one frame behind, which
   * on a tab switch is a visible flash of the page in the wrong place. After
   * that a `ResizeObserver` on the placeholder catches a divider drag, the
   * window resize and the console opening; a scroll or a layout change that
   * moves the pane without resizing it is caught by the window listeners, since
   * `ResizeObserver` fires on size and not on position. `PANES_MOVED_EVENT` is
   * the pane grid saying it has just placed every pane, which is the one way a
   * pane moves without the window or anything in it scrolling.
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
    window.addEventListener(PANES_MOVED_EVENT, report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      window.removeEventListener('scroll', report, true)
      window.removeEventListener(PANES_MOVED_EVENT, report)
    }
  }, [report])

  // A width preset changes the placeholder's box, which the observer above
  // turns into a `setBounds`. Reported here as well so the first frame after a
  // preset is picked is already right.
  useLayoutEffect(() => {
    report()
  }, [width, consoleOpen, report])

  const retrying = state.retryingUntil !== null
  const zoomed = state.zoomLevel !== 0

  /**
   * The overflow menu: what a browser keeps out of its bar. Zoom, the width
   * presets, DevTools and clearing the profile were each a control in the bar
   * once, and the bar read as a dashboard rather than a browser. The keys each
   * row names work from the page too (`shared/browserKeys.ts`).
   */
  const menu: MenuEntry[] = [
    { kind: 'heading', id: 'zoom-heading', label: `Zoom ${zoomPercent(state.zoomLevel)}` },
    { kind: 'item', id: 'zoom-in', label: 'Zoom in', hint: 'Ctrl =', disabled: state.zoomLevel >= BROWSER_ZOOM.max },
    { kind: 'item', id: 'zoom-out', label: 'Zoom out', hint: 'Ctrl -', disabled: state.zoomLevel <= BROWSER_ZOOM.min },
    { kind: 'item', id: 'zoom-reset', label: 'Actual size', hint: 'Ctrl 0', disabled: !zoomed },
    { kind: 'separator', id: 'after-zoom' },
    { kind: 'heading', id: 'width-heading', label: 'Width' },
    ...BROWSER_WIDTHS.map(
      ([label, px]): MenuEntry => ({
        kind: 'item',
        id: `width:${label}`,
        label,
        hint: px === null ? undefined : `${String(px)} px`,
        checked: width === px
      })
    ),
    { kind: 'separator', id: 'after-width' },
    {
      kind: 'item',
      id: 'devtools',
      label: state.devtoolsOpen ? 'Close DevTools' : 'Open DevTools',
      hint: 'F12'
    },
    {
      kind: 'item',
      id: 'clear-storage',
      label: 'Clear cookies and site data',
      title: "Every site's, in Helm's browser: you will be signed out of all of them"
    }
  ]

  /**
   * Sharing: one session at a time may read and drive a page of the user's.
   * The sessions are asked for as the menu opens rather than kept, because
   * which ones can take a page - running, and started with the tools - is main's
   * to know and changes under the window.
   */
  const shared = state.sharedWith
  const sharable = canShare && state.openedBy === null && state.url !== ''
  const openShare = (): void => {
    if (shareMenu !== null) {
      setShareMenu(null)
      return
    }
    const at = shareRef.current?.getBoundingClientRect()
    if (at === undefined) return
    void onShareTargets().then(
      (targets) => setShareMenu({ at, targets }),
      () => setShareMenu({ at, targets: [] })
    )
  }
  const shareEntries: MenuEntry[] =
    shareMenu === null
      ? []
      : [
          { kind: 'heading', id: 'share-heading', label: 'Share with' },
          ...(shareMenu.targets.length === 0
            ? [
                {
                  kind: 'item' as const,
                  id: 'share-none',
                  label: 'No session to share with',
                  disabled: true,
                  title: 'A Claude session Helm started while its browser tools were on can be given this page.'
                }
              ]
            : shareMenu.targets.map(
                (target): MenuEntry => ({
                  kind: 'item',
                  id: `share:${String(target.session)}`,
                  label: target.name,
                  checked: shared?.session === target.session
                })
              )),
          ...(shared === null
            ? []
            : [
                { kind: 'separator' as const, id: 'share-separator' },
                { kind: 'item' as const, id: 'share-stop', label: 'Stop sharing' }
              ])
        ]
  const chooseShare = (id: string): void => {
    if (id === 'share-stop') onShare(null)
    else if (id.startsWith('share:')) {
      const session = Number(id.slice('share:'.length))
      if (session !== shared?.session) onShare(session)
    }
  }

  /** Who besides the user can drive this page, said above it. */
  const driver =
    shared !== null
      ? { text: `Shared with “${shared.name}”: that session can read and drive this page.`, stop: true }
      : state.openedBy !== null && state.openerRunning
        ? { text: `“${state.openedBy}” opened this page and can drive it.`, stop: false }
        : null

  const choose = (id: string): void => {
    if (id === 'zoom-in') onZoom(state.zoomLevel + BROWSER_ZOOM.step)
    else if (id === 'zoom-out') onZoom(state.zoomLevel - BROWSER_ZOOM.step)
    else if (id === 'zoom-reset') onZoom(0)
    else if (id === 'devtools') onDevTools()
    else if (id === 'clear-storage') onClearStorage()
    else if (id.startsWith('width:')) setWidth(BROWSER_WIDTHS.find(([label]) => `width:${label}` === id)?.[1] ?? null)
  }

  return (
    <div data-pane="browser" className="flex h-full min-h-0 flex-col">
      <div
        data-browser-bar
        data-browser-recent-count={recent.length}
        className="flex min-h-strip shrink-0 items-center gap-2 border-b border-border px-2 py-1"
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
            placeholder={
              searchEngine === null ? 'Address, or a port number' : `Search ${searchEngine} or type an address`
            }
            aria-label="Address"
            onChange={(event) => {
              setDraft(event.target.value)
              setSuggesting(true)
            }}
            onFocus={() => setSuggesting(true)}
            // And on the click itself, not only on the focus it causes.
            // Clicking a bar that already has the caret fires no focus event, so
            // focus alone would leave the dropdown shut for exactly the gesture
            // somebody makes when they want it. A probe that drove the click and
            // nothing else is what caught this.
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
              'min-w-0 flex-1 rounded-well border border-border bg-surface-sunken py-1 pl-2',
              zoomed ? 'pr-14' : 'pr-2',
              'font-mono text-[12px] text-fg outline-none transition-colors',
              'placeholder:font-sans placeholder:text-fg-subtle',
              'focus:border-border-strong'
            )}
          />
          {/* The zoom, said where a browser says it - in the address bar, only
              when it is not 100% - and a click away from 100% again. */}
          {zoomed && (
            <button
              type="button"
              data-browser="zoom-reset"
              data-browser-zoom={String(state.zoomLevel)}
              title="Zoomed - back to actual size (Ctrl 0)"
              aria-label={`Zoom ${zoomPercent(state.zoomLevel)}, back to actual size`}
              onClick={() => onZoom(0)}
              className="absolute top-1/2 right-1 -translate-y-1/2 rounded-raised px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-fg-muted transition-colors hover:bg-hover hover:text-fg"
            >
              {zoomPercent(state.zoomLevel)}
            </button>
          )}
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
          {sharable && (
            <button
              type="button"
              ref={shareRef}
              data-browser="share"
              data-browser-shared={shared === null ? undefined : String(shared.session)}
              title={
                shared === null
                  ? 'Let a session read and drive this page'
                  : `Shared with “${shared.name}”`
              }
              aria-label={shared === null ? 'Share with a session' : `Shared with ${shared.name}`}
              aria-haspopup="menu"
              aria-expanded={shareMenu !== null}
              onClick={openShare}
              className={cn(
                'mr-0.5 flex h-7 shrink-0 items-center gap-1.5 rounded-well px-2 text-[12px] transition-colors',
                shareMenu !== null
                  ? cn(SEGMENT_ON, shared === null ? 'text-fg' : 'text-accent-text')
                  : shared === null
                    ? 'text-fg-muted hover:bg-hover hover:text-fg'
                    : 'text-accent-text hover:bg-hover'
              )}
            >
              <ShareIcon width={13} height={13} />
              {/* As wide as its longer word either way, so sharing does not
                  nudge the address bar. */}
              <span className="grid">
                <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                  Shared
                </span>
                <span className="col-start-1 row-start-1">{shared === null ? 'Share' : 'Shared'}</span>
              </span>
            </button>
          )}
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
            label="Open in your own browser"
            disabled={state.url === ''}
            onClick={() => onOpenExternal(state.url)}
            data-browser="external"
          >
            <ExternalIcon width={14} height={14} />
          </BarButton>
          <BarButton
            label="More"
            buttonRef={moreRef}
            on={menuAt !== null}
            onClick={() => setMenuAt((open) => (open === null ? (moreRef.current?.getBoundingClientRect() ?? null) : null))}
            data-browser="more"
            aria-haspopup="menu"
            aria-expanded={menuAt !== null}
          >
            <MoreIcon width={14} height={14} />
          </BarButton>
        </div>
      </div>

      {shareMenu !== null && (
        <Menu
          label="Share"
          entries={shareEntries}
          at={{ below: shareMenu.at }}
          anchorRef={shareRef}
          minWidth={200}
          onSelect={chooseShare}
          onDismiss={() => setShareMenu(null)}
        />
      )}

      {menuAt !== null && (
        <Menu
          label="Browser"
          entries={menu}
          at={{ below: menuAt }}
          anchorRef={moreRef}
          minWidth={220}
          onSelect={choose}
          onDismiss={() => setMenuAt(null)}
        />
      )}

      {finding && (
        <div
          data-browser-find
          className="flex shrink-0 items-center gap-2 border-b border-border px-2 py-1.5"
        >
          <input
            ref={findRef}
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

      {/* A page a session can drive says so, above the page, for as long as
          it can: shared by the user, or opened by a session still running. */}
      {driver !== null && (
        <div
          data-browser-driver
          role="note"
          className="flex shrink-0 items-center gap-2 border-b border-border bg-accent-soft py-1 pr-1.5 pl-3 text-[12px] text-accent-text"
        >
          <AgentIcon width={13} height={13} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate leading-[22px]">{driver.text}</span>
          {driver.stop && (
            <button
              type="button"
              data-browser="share-stop"
              onClick={() => onShare(null)}
              className="h-[22px] shrink-0 rounded-well border border-border-strong px-2 text-[11.5px] text-fg transition-colors hover:bg-hover"
            >
              Stop sharing
            </button>
          )}
        </div>
      )}

      {(state.problem !== null || retrying) && (
        <div
          data-browser-problem
          role="status"
          className={cn(
            'shrink-0 border-b px-3 py-2 text-[12px]',
            retrying
              ? 'border-border text-fg-muted'
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
          className="relative min-h-0 w-full flex-1"
        >
          {/* The page, as a picture, while the view is off the screen for
              something drawn over it - so a menu opens over the page rather
              than over a hole. Exactly the view's rectangle, which is this one. */}
          {still !== null && (
            <img
              data-browser-still
              src={still}
              alt=""
              draggable={false}
              className="pointer-events-none absolute inset-0 size-full select-none"
            />
          )}
        </div>
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
  buttonRef,
  children,
  ...hooks
}: {
  label: string
  disabled?: boolean
  on?: boolean
  onClick: (event: { shiftKey: boolean }) => void
  buttonRef?: RefObject<HTMLButtonElement | null>
  children: JSX.Element
  'aria-haspopup'?: 'menu'
  'aria-expanded'?: boolean
} & Record<`data-${string}`, string>): JSX.Element {
  return (
    <button
      type="button"
      ref={buttonRef}
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
