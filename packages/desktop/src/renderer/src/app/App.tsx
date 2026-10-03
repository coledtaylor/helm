import type { JSX, ReactNode } from 'react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Harness } from '@helm/core'
import {
  activateTab,
  activeRef,
  closeGroup,
  closeTab,
  cycleTab,
  DEFAULT_SETTINGS,
  findTab,
  focusGroup,
  fromSaved,
  isLoopbackUrl,
  isProjectPinned,
  isScanRoot,
  liveSessionsIn,
  moveTab,
  openFile,
  openTab,
  paneId,
  placeBeside,
  placeRestored,
  reconcile,
  sendToOtherGroup,
  sessionLabel,
  toSaved,
  withProjectPinned,
  withRepoIgnored,
  type EditorHighlight,
  type FileRef,
  type HistorySession,
  type LiveSession,
  type PaneLayout,
  type PaneRef,
  type Profile,
  type ProfileDraft,
  type Project,
  type RestoreOffer,
  type SavedPaneLayout,
  type SessionRecord
} from '@helm/core/types'
import {
  AppShell,
  BookIcon,
  BrowserPane,
  cn,
  CodeIcon,
  ConfigConsole,
  ConfigDeleteDialog,
  ConfigDeletedNotice,
  ConfigEditor,
  ConfigNewDialog,
  ConfigNothingSelected,
  ConfigRenameDialog,
  ConfirmSessionDialog,
  ContentDocumentPane,
  type ConsoleEntry,
  ContentNothingSelected,
  ContentViewer,
  DocIcon,
  EffectiveViewPane,
  FileActions,
  FileCrumb,
  FilesRootPicker,
  FilesStatusNote,
  FilesTree,
  FileView,
  FolderIcon,
  FolderPlusIcon,
  GearIcon,
  GlobeIcon,
  HarnessIcon,
  HealthPanel,
  HistoryIcon,
  ImportIcon,
  LayersIcon,
  McpPanel,
  NewHarnessDialog,
  NewSessionDialog,
  overlayOpen,
  PaneActions,
  PaneCrumb,
  PaneGroup,
  PlusIcon,
  ProfileEditor,
  ProfileList,
  ProjectPane,
  PullRequestIcon,
  PullsPane,
  QuickOpenDialog,
  pullRepoChoices,
  pullsSummaryLine,
  Rail,
  RefreshIcon,
  RepoIcon,
  RestorePane,
  SaveAsTemplateDialog,
  SessionHistory,
  SessionsPane,
  SessionTree,
  SettingsPane,
  SetupPane,
  Sidebar,
  SidebarAction,
  SlidersIcon,
  StatusBar,
  TabBar,
  TemplateManager,
  TerminalIcon,
  TitleBar,
  VersionBanner,
  WelcomePane,
  type LaunchChoice,
  type ProfilePrediction,
  type RailItem,
  type Tab,
  type TabIndicator,
  type TreeSession
} from '@helm/ui'
import type { AppMode, SessionConfirmRequest } from '../../../shared/ipc'
import { helm } from './bridge'
import { usePaneSplit } from './paneSplit'
import { ProjectColumn } from './ProjectColumn'
import { PullRequestTab } from './PullRequestTab'
import { disposeShell } from './pterms'
import { estimateGrid } from './terminals'
import { TerminalPane } from './TerminalPane'
import { terminalFontStack } from '../terminal'
import { crumbStatus, indicatorOf, sessionNote, useNow } from './sessionView'
import { useConfig } from './useConfig'
import { useContent } from './useContent'
import { fileKey, joinRoot, relativeTo, useFiles } from './useFiles'
import { sessionHistoryProps, useHistory } from './useHistory'
import { useLauncher } from './useLauncher'
import { useProfiles } from './useProfiles'
import { forgetPullDetail } from './usePullDetail'
import { usePulls } from './usePulls'
import { useLiveSessions } from './useLiveSessions'
import { useNewSession } from './useNewSession'
import { useRestore } from './useRestore'
import { useSessions } from './useSessions'
import { useSetup } from './useSetup'
import { useTemplates } from './useTemplates'
import { useThemes } from './useThemes'
import { useBrowsers } from './useBrowsers'
import { useShells } from './useShells'
import { useUpdate } from './useUpdate'
import { useUsage } from './useUsage'

const KIND_ICON = {
  harness: HarnessIcon,
  repo: RepoIcon,
  folder: FolderIcon
} as const

/**
 * What the rail's sidebar views are. Pages - history, settings and the rest -
 * open as tabs instead; see `RailItem`.
 */
type SidebarView = 'sessions' | 'files' | 'profiles'

/**
 * A link in a rendered note, handed to the OS browser.
 *
 * Not a hook, because it holds nothing. The renderer's navigation posture is
 * unchanged by the browser pane and is the reason this exists at all:
 * `will-navigate` is still prevented on this window and its window-open handler
 * still denies, so the only thing an `https://` link in a document can do is
 * ask main to open it somewhere else. What the browser pane added is a set of
 * `WebContentsView`s that are exempt **by id**, in `main/index.ts`; this window
 * is not one of them and never will be.
 */
const helmOpenExternal = (url: string): Promise<{ opened: boolean }> =>
  helm.invoke('shell:openExternal', { url })

/** A stable empty list, so a view with no console entries does not hand
 * `BrowserPane` a fresh array to re-render against on every render. */
const EMPTY_CONSOLE: ConsoleEntry[] = []

/** The same, for a project with nothing running in it - which is most of them. */
const EMPTY_LIVE: LiveSession[] = []
const EMPTY_PROJECTS: Project[] = []

/**
 * The editors' tokeniser, on the far side of an IPC boundary.
 *
 * A module-level constant rather than a `useCallback`, and that is load-bearing
 * rather than tidy: the editor debounces on this identity, so a new function
 * per render of `App` would cancel and restart the debounce on every render the
 * app happens to do. Nothing here closes over state.
 */
const helmHighlight = (path: string, source: string): Promise<EditorHighlight> =>
  helm.invoke('editor:highlight', { path, source })

/**
 * What each build mode is called on the status bar, and null for the one that
 * needs no word. `dev-live` is the dev build with **no data directory of its
 * own**, sharing `%APPDATA%\Helm` with the installed app, and the chip that says
 * so is the only thing on screen that distinguishes it from an ordinary
 * `pnpm dev`.
 */
const MODE_LABEL: Record<AppMode, string | null> = {
  installed: null,
  portable: 'portable',
  dev: 'dev',
  'dev-live': 'dev · live'
}

/**
 * A tab label, cut to what a pill can hold.
 *
 * Cut here rather than left to `text-overflow`, because the label is a number
 * and a title glued together and the number is the half that identifies it.
 */
const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`

/** The session id inside a `session:12` tab id. */
const sessionIdOf = (id: string): number => Number(id.slice('session:'.length))

/** The last segment of a path, for a session in no project the scan found. */
const folderName = (path: string): string =>
  path.split(/[\\/]+/).filter((part) => part !== '').at(-1) ?? path

export function App(): JSX.Element {
  const launcher = useLauncher()
  const { discovery, settings, info } = launcher

  /**
   * The panes, or null while they are still the saved ones.
   *
   * Null and not the empty layout because the two are different states:
   * nothing has been arranged this run, versus every tab has been closed. Only
   * the first should fall back to what the last launch left behind.
   *
   * Restoring is therefore a *derivation* (`open`, below) rather than an effect
   * that copies the setting into state once it lands. The settings arrive over
   * IPC a moment after the first paint, so a sync would render the empty window
   * first and the real one after.
   */
  const [layout, setLayout] = useState<PaneLayout | null>(null)
  /** The pane given the whole window, or null for the panes side by side. */
  const [maximized, setMaximized] = useState<number | null>(null)
  /**
   * The file tab standing as a preview - opened by a single click, replaced by
   * the next one (`openFile`). Not written down: a restart reopens it as an
   * ordinary tab, which is what a tab that survived a restart is.
   */
  const [preview, setPreview] = useState<string | null>(null)
  /** Ctrl+P, open on this project, or null. */
  const [quickOpenRoot, setQuickOpenRoot] = useState<string | null>(null)
  /** Where each file tab's caret is, so VS Code opens at the same line. */
  const fileCarets = useRef(new Map<string, number>())
  const [sidebarView, setSidebarView] = useState<SidebarView>('sessions')
  /** The rail's current view, pressed again, puts the sidebar away. */
  const [sidebarHidden, setSidebarHidden] = useState(false)
  /** The project a session is starting in, from its page or its `+`. */
  const [launchingPath, setLaunchingPath] = useState<string | null>(null)
  /**
   * The row the sessions pane has open, by pid - the one key a session Helm
   * does not host also has. Held here rather than in the pane because a pane
   * can be thrown away and rebuilt at will, and a selection that unmounted with
   * it would drop whenever somebody looked at another tab.
   */
  const [selectedLivePid, setSelectedLivePid] = useState<number | null>(null)
  /**
   * The split's boundary is a CSS custom property on the row, not state. The
   * drag and the remembered split write it, through `usePaneSplit`.
   */
  const splitRowRef = useRef<HTMLDivElement>(null)
  /** Each pane's body, measured to open a pty at roughly the right grid. */
  const bodyRefs = useRef<(HTMLDivElement | null)[]>([])

  const profileState = useProfiles()
  const newSession = useNewSession()
  const restoreState = useRestore()
  const { offer: restoreOffer, restore: restoreLost, dismiss: dismissRestore } = restoreState
  const historyState = useHistory()
  const pullsState = usePulls()
  const configState = useConfig()
  const contentState = useContent()
  const usage = useUsage()
  const check = useUpdate()
  const themes = useThemes()
  /*
   * Every live session on the machine, and what Helm's own are holding. Held
   * here rather than inside the sessions pane because the tree and the launch
   * warning need it whether or not that pane has ever been opened.
   */
  const machineSessions = useLiveSessions()
  /**
   * From `answered` and not `attempted`: the bar's line is a standing fact - a
   * newer release exists - and a manual check that could not reach GitHub is
   * not evidence against it. The settings pane takes `attempted` instead.
   */
  const answered = check.answered
  const update =
    answered !== null && answered.newer && answered.latest !== null && answered.url !== null
      ? { latest: answered.latest, newer: true, url: answered.url }
      : null
  /** Late-bound for the reason `focusSessionRef` is: starting a session needs
   * the panes, and setup is read before they exist. */
  const harnessCreatedRef = useRef<(path: string) => void>(() => undefined)
  const onHarnessCreated = useCallback((path: string) => harnessCreatedRef.current(path), [])
  const setup = useSetup(settings, launcher.rescan, onHarnessCreated)
  /**
   * Template authoring, held at app level because both of its entry points are:
   * the New Harness dialog and Settings reach the manager, and a harness's page
   * reaches "Save as template".
   */
  const templates = useTemplates()
  const shells = useShells()
  /**
   * The browser pane's views, which live in the main process. The recent-address
   * list is main's to write - it is the side that knows a navigation succeeded -
   * so it arrives on `settings:changed` like any other setting.
   */
  const browsers = useBrowsers(settings?.browserRecentUrls ?? DEFAULT_SETTINGS.browserRecentUrls)
  const browserViews = browsers.views

  /**
   * What the Terminal group shows, and one writer for them. Six of the eight are
   * terminal preferences and reach the terminals through `settings:write`;
   * `projectShellHeightPct` and `paneSplitPct` are layout, and sit in that group
   * because it is where somebody looks for the shell and the panes.
   */
  const terminalSettings = useMemo(
    () => ({
      terminalFontFamily: settings?.terminalFontFamily ?? null,
      terminalFontSize: settings?.terminalFontSize ?? DEFAULT_SETTINGS.terminalFontSize,
      terminalCursorStyle: settings?.terminalCursorStyle ?? DEFAULT_SETTINGS.terminalCursorStyle,
      terminalCursorBlink: settings?.terminalCursorBlink ?? DEFAULT_SETTINGS.terminalCursorBlink,
      terminalScrollback: settings?.terminalScrollback ?? DEFAULT_SETTINGS.terminalScrollback,
      terminalShell: settings?.terminalShell ?? null,
      projectShellHeightPct:
        settings?.projectShellHeightPct ?? DEFAULT_SETTINGS.projectShellHeightPct,
      paneSplitPct: settings?.paneSplitPct ?? DEFAULT_SETTINGS.paneSplitPct
    }),
    [settings]
  )

  const { writeSettings } = launcher
  const locateShell = useCallback(() => {
    void helm.invoke('path:chooseFile', { title: 'Choose a shell' }).then(({ path }) => {
      if (path !== null) writeSettings({ terminalShell: path })
    })
  }, [writeSettings])

  const savedShellHeight = settings?.projectShellHeightPct ?? DEFAULT_SETTINGS.projectShellHeightPct
  const setShellHeight = useCallback(
    (projectShellHeightPct: number) => writeSettings({ projectShellHeightPct }),
    [writeSettings]
  )
  const savedSplitPct = settings?.paneSplitPct ?? DEFAULT_SETTINGS.paneSplitPct

  /**
   * Point Helm at a `gh` it did not find. Written straight through
   * `settings:write`, whose ladder re-resolves the binary and re-arms the
   * poller - so what the GitHub group reports afterwards is the executable
   * actually in force rather than the file that was picked.
   */
  const locateGh = useCallback(() => {
    void helm
      .invoke('path:chooseFile', { title: 'Locate the gh executable' })
      .then(({ path }) => {
        if (path !== null) writeSettings({ ghPath: path })
      })
  }, [writeSettings])

  /**
   * Puts one repository back on the pull-request surface. The whole list is
   * written, composed from `settings` rather than from the snapshot, so a chip
   * clicked while a fetch is in flight cannot write a list assembled from a
   * half-built view.
   */
  const unignoreRepo = useCallback(
    (slug: string) => {
      const held = settings?.prIgnoredRepos ?? DEFAULT_SETTINGS.prIgnoredRepos
      writeSettings({ prIgnoredRepos: withRepoIgnored(held, slug, false) })
    },
    [settings, writeSettings]
  )

  /**
   * The tree's star, both directions. Composed from `settings` rather than from
   * what the tree is holding, the rule `unignoreRepo` follows, so two stars
   * pressed in quick succession cannot each write the other away.
   */
  const togglePin = useCallback(
    (path: string) => {
      const held = settings?.pinnedProjects ?? DEFAULT_SETTINGS.pinnedProjects
      writeSettings({
        pinnedProjects: withProjectPinned(held, path, !isProjectPinned(held, path))
      })
    },
    [settings, writeSettings]
  )

  /** The profile being edited, or a seeded draft from "save as profile". Null
   * when the dialog is closed. */
  const [editing, setEditing] = useState<Profile | ProfileDraft | null>(null)
  const [saveProblems, setSaveProblems] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const projectsByPath = useMemo(() => {
    const map = new Map<string, Project>()
    for (const project of discovery?.projects ?? []) map.set(project.path, project)
    return map
  }, [discovery])

  // ---------------------------------------------------------------------------
  // The panes
  // ---------------------------------------------------------------------------

  /** Late-bound so the sessions hook can bring a session forward on a
   * notification click, before the layout below exists to do it with. */
  const focusSessionRef = useRef<(id: number) => void>(() => undefined)
  const activateSession = useCallback((id: number) => focusSessionRef.current(id), [])
  const sessionState = useSessions(activateSession)
  const { sessions, activity: sessionActivity } = sessionState

  const sessionsById = useMemo(() => {
    const map = new Map<number, SessionRecord>()
    for (const session of sessions) map.set(session.id, session)
    return map
  }, [sessions])

  const savedLayout = settings?.paneLayout ?? null
  const settingsLoaded = settings !== null

  /**
   * Whether a tab's thing still exists. A rescan that no longer sees a project
   * closes its tab and the pull request tabs opened from it; a view main has
   * dropped takes its tab; a session main no longer hosts takes its tab.
   */
  const keep = useCallback(
    (ref: PaneRef): boolean => {
      if (ref.kind === 'project') return !discovery || projectsByPath.has(ref.path)
      if (ref.kind === 'pr') return !discovery || projectsByPath.has(ref.repoPath)
      if (ref.kind === 'browser') return browserViews.has(ref.id)
      if (ref.kind === 'session') return sessionsById.has(ref.id)
      // Answered, it has nothing left to show.
      if (ref.kind === 'restore') return restoreOffer !== null
      return true
    },
    [discovery, projectsByPath, browserViews, sessionsById, restoreOffer]
  )

  /**
   * What must have a tab whether or not anything placed it: every session main
   * is hosting and every view it holds. After a renderer reload the processes
   * outlive the panes that were showing them, and a page's `window.open` makes a
   * view nothing in this window asked for.
   */
  const extra = useMemo<PaneRef[]>(
    () => [
      ...sessions.map((session) => ({ kind: 'session' as const, id: session.id })),
      ...[...browserViews.keys()].map((id) => ({ kind: 'browser' as const, id }))
    ],
    [sessions, browserViews]
  )

  const open = useMemo(
    () => reconcile(layout ?? fromSaved(savedLayout), keep, extra),
    [layout, savedLayout, keep, extra]
  )

  /**
   * One way to change the panes.
   *
   * A functional update, so two changes in one event compose rather than the
   * second overwriting the first, and reconciled against the latest of what
   * exists - read through a ref, because a launch resolves long after the
   * render that started it. The first change of a run is what turns the saved
   * layout into this run's own.
   */
  const latest = useRef({ saved: savedLayout, keep, extra })
  useLayoutEffect(() => {
    latest.current = { saved: savedLayout, keep, extra }
  }, [savedLayout, keep, extra])
  const commit = useCallback((op: (current: PaneLayout) => PaneLayout) => {
    setLayout((current) => {
      const { saved, keep: exists, extra: unplaced } = latest.current
      return op(reconcile(current ?? fromSaved(saved), exists, unplaced))
    })
  }, [])

  const shownMax = maximized !== null && maximized < open.groups.length ? maximized : null
  const shownGroups = useMemo(
    () => (shownMax === null ? open.groups.map((_, index) => index) : [shownMax]),
    [open.groups, shownMax]
  )
  const sidebarShown = !sidebarHidden && shownMax === null
  /** Two panes side by side: every page in one gets the narrower layout. */
  const compact = shownGroups.length > 1
  const focusedGroup = open.groups[open.focused]
  const front = focusedGroup === undefined ? null : activeRef(focusedGroup)
  const frontId = front === null ? null : paneId(front)
  /** The tab in front of each pane on screen. */
  const visible = useMemo(
    () =>
      shownGroups.flatMap((index) => {
        const group = open.groups[index]
        const ref = group === undefined ? null : activeRef(group)
        return ref === null ? [] : [ref]
      }),
    [open.groups, shownGroups]
  )

  /**
   * Brings a tab forward from outside its pane - the tree, a notification, the
   * status bar - and gives the window back if that tab is in a pane the
   * maximized one is hiding.
   */
  const focusTab = useCallback(
    (id: string) => {
      const at = findTab(open, id)
      if (at === null) return
      commit((current) => activateTab(current, id))
      setMaximized((current) => (current === null || current === at.group ? current : null))
    },
    [open, commit]
  )
  useEffect(() => {
    focusSessionRef.current = (id: number) => focusTab(`session:${String(id)}`)
  }, [focusTab])

  /** Opens a tab in the focused pane, or brings it forward where it already is. */
  const openPane = useCallback(
    (ref: PaneRef) => {
      const at = findTab(open, paneId(ref))
      commit((current) => openTab(current, ref))
      if (at !== null) {
        setMaximized((current) => (current === null || current === at.group ? current : null))
      }
    },
    [open, commit]
  )

  /**
   * The saved panes, written back whenever the arrangement changes.
   *
   * Compared as JSON against what is stored, so the write that comes back as a
   * `settings:changed` broadcast finds nothing to do - an effect keyed on the
   * settings object would re-arm on its own write forever. Debounced because a
   * drag moves a tab at a time and every write is a settings round trip.
   */
  const savedJson = useMemo(() => JSON.stringify(toSaved(open)), [open])
  const storedJson = useMemo(() => JSON.stringify(savedLayout), [savedLayout])
  useEffect(() => {
    if (!settingsLoaded || savedJson === storedJson) return undefined
    const timer = setTimeout(() => {
      writeSettings({ paneLayout: JSON.parse(savedJson) as SavedPaneLayout })
    }, 500)
    return () => clearTimeout(timer)
  }, [settingsLoaded, savedJson, storedJson, writeSettings])

  // The divider between the panes (paneSplit.ts).
  const startSplitDrag = usePaneSplit(splitRowRef, savedSplitPct, writeSettings)

  /*
   * The process pass runs only while the sessions pane is on screen. One
   * enumeration costs 400ms of a child process, so "off unless somebody is
   * looking" is the whole budget. Reference-counted in main.
   */
  const sessionsPaneOpen = visible.some((ref) => ref.kind === 'sessions')
  const watchResources = machineSessions.watch
  useEffect(() => {
    if (!sessionsPaneOpen) return undefined
    watchResources(true)
    return () => watchResources(false)
  }, [sessionsPaneOpen, watchResources])

  /**
   * Which browser views are in front of a pane, told to every view. A pane
   * reports its own rectangle while it is mounted; one that goes behind another
   * tab, or into a pane the maximized one hides, has to be stood down by
   * something that is still rendering.
   */
  const { setShowing: setBrowserShowing } = browsers
  useEffect(() => {
    const shown = new Set(visible.flatMap((ref) => (ref.kind === 'browser' ? [ref.id] : [])))
    for (const id of browserViews.keys()) setBrowserShowing(id, shown.has(id))
  }, [browserViews, visible, setBrowserShowing])

  // Main decides whether an exiting session is worth a notification, and that
  // turns on which sessions are actually on screen - which only this side knows.
  const { reportFocus } = sessionState
  const visibleSessionKey = visible
    .flatMap((ref) => (ref.kind === 'session' ? [ref.id] : []))
    .join(',')
  useEffect(() => {
    reportFocus(visibleSessionKey === '' ? [] : visibleSessionKey.split(',').map(Number))
  }, [visibleSessionKey, reportFocus])

  /**
   * The project the focused pane is about, for a browser tab opened beside it.
   *
   * Derived from `open` inside a memo rather than from `front` in the render
   * body: `front` is an object handed on to helpers further down, and the
   * React Compiler treats anything derived from it as possibly mutated, which
   * costs `openBrowser` its memoization.
   */
  const frontProject = useMemo(() => {
    const group = open.groups[open.focused]
    const ref = group === undefined ? null : activeRef(group)
    if (ref?.kind === 'project') return ref.path
    if (ref?.kind === 'file') return ref.root
    if (ref?.kind === 'session') return sessionsById.get(ref.id)?.projectPath ?? null
    return null
  }, [open, sessionsById])

  // ---------------------------------------------------------------------------
  // Opening things
  // ---------------------------------------------------------------------------

  const openProject = useCallback(
    (project: Project | null) => {
      if (project) openPane({ kind: 'project', path: project.path })
    },
    [openPane]
  )
  const openSessions = useCallback(() => openPane({ kind: 'sessions' }), [openPane])
  const openHistory = useCallback(() => openPane({ kind: 'history' }), [openPane])
  const openPulls = useCallback(() => openPane({ kind: 'pulls' }), [openPane])
  const openConfig = useCallback(() => openPane({ kind: 'config' }), [openPane])
  const openContent = useCallback(() => openPane({ kind: 'content' }), [openPane])
  /**
   * Settings is a tab like any other rather than a modal: it is a place, worth
   * leaving open beside a session, and a dialog over the window would be one
   * more thing to dismiss before looking at what a setting changed.
   */
  const openSettings = useCallback(() => openPane({ kind: 'settings' }), [openPane])

  /** A row in the Pulls pane opens the pull request in a tab of its own. */
  const openPull = useCallback(
    (repo: { path: string }, pull: { number: number }) =>
      openPane({ kind: 'pr', repoPath: repo.path, number: pull.number }),
    [openPane]
  )

  /**
   * Config and Content opened **on** a project - the project page's links. The
   * pane arrives pointed at the project that was on screen instead of at
   * whatever it last held; re-pointing goes through the hook's own setter,
   * because that is what clears the open file. Skipped when the scope is
   * already the one asked for, so returning to a pane keeps what is open in it.
   */
  const { scopePath: configScopePath, setScopePath: setConfigScope } = configState
  const openConfigAt = useCallback(
    (project: Project) => {
      if (configScopePath.toLowerCase() !== project.path.toLowerCase()) {
        setConfigScope(project.path)
      }
      openPane({ kind: 'config' })
    },
    [configScopePath, setConfigScope, openPane]
  )
  const { scopePath: contentScopePath, setScopePath: setContentScope } = contentState
  const openContentAt = useCallback(
    (project: Project) => {
      if (contentScopePath.toLowerCase() !== project.path.toLowerCase()) {
        setContentScope(project.path)
      }
      openPane({ kind: 'content' })
    },
    [contentScopePath, setContentScope, openPane]
  )

  /**
   * A new browser tab, on whichever project the focused pane is about, so it
   * arrives on that project's last address rather than empty. Main decides
   * that from `browserProjectUrls`; nothing here reads it.
   */
  const openBrowser = useCallback(
    (request: { url?: string; project?: string | null } = {}) => {
      void browsers
        .open({ ...request, project: request.project ?? frontProject })
        .then((state) => {
          if (state !== null) {
            commit((current) => openTab(current, { kind: 'browser', id: state.id }))
          }
        })
    },
    [browsers, commit, frontProject]
  )

  /**
   * The rail's Browser: go to the browser, opening one only if there is none.
   * A destination that made a new tab on every press would pile tabs up to the
   * cap; Ctrl+T in a browser tab is how a second one is asked for.
   */
  const showBrowser = useCallback(() => {
    const inFocused = focusedGroup?.tabs.filter((ref) => ref.kind === 'browser') ?? []
    const anywhere = open.groups.flatMap((group) =>
      group.tabs.filter((ref) => ref.kind === 'browser')
    )
    const target = inFocused.at(-1) ?? anywhere.at(-1)
    if (target === undefined) openBrowser()
    else focusTab(paneId(target))
  }, [focusedGroup, open, openBrowser, focusTab])

  /**
   * Ctrl+L focuses the address bar. A counter rather than a boolean, because
   * "focus it" is an event: pressing it twice has to re-select.
   */
  const [focusAddressAt, setFocusAddressAt] = useState(0)

  /**
   * A link in rendered content. A loopback URL is by definition a thing running
   * on this machine, which is what the browser pane exists to look at; anything
   * else goes to the browser the user actually uses. `isLoopbackUrl` is the
   * function the certificate exception and the reach rule are made of, so
   * "what counts as this machine" has one answer.
   */
  const openLink = useCallback(
    (url: string) => {
      if (isLoopbackUrl(url)) openBrowser({ url })
      else void helmOpenExternal(url)
    },
    [openBrowser]
  )

  /**
   * A launched session lands in the focused pane and takes its front - or, from
   * the launcher's "Start beside", in the other pane, opening it if there is
   * only one.
   */
  const placeSession = useCallback(
    (id: number, beside = false) => {
      const ref = { kind: 'session', id } as const
      commit((current) => (beside ? placeBeside(current, ref) : openTab(current, ref)))
      setMaximized((current) =>
        beside || (current !== null && current !== open.focused) ? null : current
      )
    },
    [commit, open.focused]
  )

  const launch = useCallback(
    async (project: Project) => {
      setLaunchingPath(project.path)
      try {
        const id = await sessionState.launch(project, bodyRefs.current[open.focused] ?? null)
        if (id !== null) placeSession(id)
      } finally {
        setLaunchingPath(null)
      }
    },
    [sessionState, placeSession, open.focused]
  )

  /** A profile launch lands exactly the way a project launch does. */
  const launchProfile = useCallback(
    async (profile: Profile) => {
      const session = await profileState.launch(profile, bodyRefs.current[open.focused] ?? null)
      if (!session) return
      sessionState.adopt(session)
      placeSession(session.id)
    },
    [profileState, sessionState, placeSession, open.focused]
  )

  /**
   * A resumed conversation is a session like any other once it exists; main
   * decided upstream whether it could be reopened and built `--resume` argv.
   */
  const resumeSession = useCallback(
    async (session: HistorySession) => {
      const record = await historyState.resume(session, bodyRefs.current[open.focused] ?? null)
      if (!record) return
      sessionState.adopt(record)
      placeSession(record.id)
    },
    [historyState, sessionState, placeSession, open.focused]
  )

  /**
   * What the launcher was showing when Enter was pressed. The grid is measured
   * off the pane the session is going to, where that pane exists; a new one
   * beside is measured off the focused pane and refits when it lands.
   */
  const startChosen = useCallback(
    async (choice: LaunchChoice) => {
      const other = open.focused === 0 ? 1 : 0
      const target = choice.beside && open.groups.length > 1 ? other : open.focused
      const launched = await newSession.launch(
        {
          cwd: choice.project.path,
          projectPath: choice.project.path,
          name: choice.project.name,
          profileId: choice.profileId,
          permissionMode: choice.permissionMode,
          resume: choice.resume?.sessionId ?? null
        },
        bodyRefs.current[target] ?? null
      )
      if (launched === null) return
      sessionState.adopt(launched.session)
      placeSession(launched.session.id, choice.beside)
      newSession.hide()
    },
    [newSession, sessionState, placeSession, open.focused, open.groups.length]
  )

  /*
   * A harness created whole ends in a session in it, not on a page: creating
   * one is a step on the way to working there. Not during first run, which
   * owns the window until it is finished.
   */
  const setupNeeded = setup.needed
  useEffect(() => {
    harnessCreatedRef.current = (path: string) => {
      if (setupNeeded) return
      void newSession
        .launch(
          { cwd: path, projectPath: path, profileId: null, permissionMode: null, resume: null },
          bodyRefs.current[open.focused] ?? null
        )
        .then((launched) => {
          if (launched === null) return
          sessionState.adopt(launched.session)
          placeSession(launched.session.id)
        })
    }
  }, [setupNeeded, newSession, sessionState, placeSession, open.focused])

  /**
   * Reopens sessions a crash took and puts each back in the pane and place it
   * had, sized for that pane. Unasked is the `restoreWithoutAsking` path, which
   * also says afterwards that it happened.
   */
  const resumeLost = useCallback(
    async (ids: readonly number[], unasked = false) => {
      if (restoreOffer === null) return
      const { layout } = restoreOffer
      const paneOf = (id: number): number =>
        layout?.groups.findIndex((group) =>
          group.panes.some((pane) => pane.kind === 'session' && pane.id === id)
        ) ?? -1
      const picks = ids.map((id) => {
        const pane = paneOf(id)
        const body = (pane >= 0 ? bodyRefs.current[pane] : undefined) ?? bodyRefs.current[open.focused]
        return { id, ...estimateGrid(body ?? null) }
      })
      const result = await restoreLost(picks, { unasked })
      if (result === null) return
      for (const { launched } of result.restored) sessionState.adopt(launched.session)
      const pairs = new Map(result.restored.map(({ from, launched }) => [from, launched.session.id]))
      commit((current) => placeRestored(closeTab(current, 'restore'), layout, pairs))
    },
    [restoreOffer, restoreLost, sessionState, commit, open.focused]
  )

  /*
   * The offer, acted on once settings say how: a tab in front of the focused
   * pane, or - with `restoreWithoutAsking` - every session reopened straight
   * away and the offer never drawn. Those that cannot come back are asked for
   * too, so main says why in the same answer.
   */
  const restoreUnasked = settings === null ? null : settings.restoreWithoutAsking
  const actedOn = useRef<RestoreOffer | null>(null)
  useEffect(() => {
    if (restoreOffer === null || restoreUnasked === null || actedOn.current === restoreOffer) return
    actedOn.current = restoreOffer
    if (restoreUnasked) void resumeLost(restoreOffer.sessions.map((session) => session.id), true)
    else commit((current) => openTab(current, { kind: 'restore' }))
  }, [restoreOffer, restoreUnasked, resumeLost, commit])

  /**
   * "Review with Claude", from a pull request tab. The prompt is composed in
   * main from the cached pull request and the stored template, so this sends a
   * repository path, a number and the grid - argv assembled in a window is argv
   * that can drift from what was saved. Re-thrown, because the pull request's
   * own pane is where a dirty tree or a missing `gh` has to be read.
   */
  const reviewPull = useCallback(
    async (repoPath: string, number: number) => {
      const { cols, rows } = estimateGrid(bodyRefs.current[open.focused] ?? null)
      const launched = await helm.invoke('pr:review', { repoPath, number, cols, rows })
      sessionState.adopt(launched.session)
      placeSession(launched.session.id)
      return launched
    },
    [sessionState, placeSession, open.focused]
  )

  const blankProfile = useCallback(
    (root: string, name: string): ProfileDraft => ({
      name,
      root,
      overlays: [],
      access: [],
      model: null,
      effort: null,
      permissionMode: null,
      agent: null,
      mcp: [],
      openingPrompt: null,
      pinnedOrder: null
    }),
    []
  )

  /**
   * What the profile editor's agent and MCP pickers offer: the same
   * `config:effective` the config console calls, asked about the composition
   * being *typed* rather than a saved one.
   */
  const predictProfile = useCallback(
    async (root: string, overlays: string[]): Promise<ProfilePrediction> => {
      const view = await helm.invoke('config:effective', { cwd: root, overlays })
      return { agents: view.agents, mcpServers: view.mcpServers }
    },
    []
  )

  const saveProfile = useCallback(
    async (draft: ProfileDraft) => {
      setSaving(true)
      try {
        const id = editing !== null && 'id' in editing ? editing.id : null
        const { profile, problems } = await profileState.save(draft, id)
        setSaveProblems(problems)
        if (profile === null) return
        setEditing(null)
        // A new profile is made to be used: it ends in a session, not on the
        // list it was added to. An edit is only an edit.
        if (id === null) void launchProfile(profile)
      } finally {
        setSaving(false)
      }
    },
    [editing, profileState, launchProfile]
  )

  // Main asks the user first, so this can be fired and forgotten.
  const deleteProfile = useCallback(
    (profile: Profile) => void profileState.remove(profile.id),
    [profileState]
  )

  // ---------------------------------------------------------------------------
  // Closing and moving
  // ---------------------------------------------------------------------------

  /**
   * A session's tab. The process gets a say: main confirms before ending a live
   * session, and the tab stays if the answer is no.
   */
  const closeSession = useCallback(
    (id: number) => {
      void sessionState.close(id).then((closed) => {
        if (closed) commit((current) => closeTab(current, `session:${String(id)}`))
      })
    },
    [sessionState, commit]
  )

  const closeAny = useCallback(
    (id: string) => {
      const at = findTab(open, id)
      const ref = at === null ? undefined : open.groups[at.group]?.tabs[at.index]
      if (ref === undefined) return
      if (ref.kind === 'session') {
        closeSession(ref.id)
        return
      }
      // The shell dies with its tab, not with a render: hiding the page keeps
      // it, closing the project ends it.
      if (ref.kind === 'project') void disposeShell(ref.path)
      // What the pane last painted outlives an unmount so a tab switch does not
      // flash, and a *closed* tab is the point nobody is coming back to it.
      if (ref.kind === 'pr') forgetPullDetail(ref.repoPath, ref.number)
      // Hiding the pane keeps the page; closing the tab destroys the view.
      if (ref.kind === 'browser') browsers.close(ref.id)
      // Closing the offer is "not now", the same as its button.
      if (ref.kind === 'restore') dismissRestore()
      commit((current) => closeTab(current, id))
    },
    [open, closeSession, browsers, commit, dismissRestore]
  )

  const splitFocused = useCallback(() => {
    commit(sendToOtherGroup)
    setMaximized(null)
  }, [commit])

  // ---------------------------------------------------------------------------
  // The keyboard
  // ---------------------------------------------------------------------------

  /**
   * Ctrl+L and Ctrl+T, only while a browser tab is in front of the focused
   * pane. In capture so a focused terminal does not eat them - but gated,
   * because Ctrl+L is *clear the screen* in every shell Helm hosts and stealing
   * it from a session would be a worse bug than not having the shortcut.
   */
  const browserInFront = front?.kind === 'browser'
  useEffect(() => {
    if (!browserInFront) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || event.shiftKey) return
      if (event.key !== 'l' && event.key !== 't') return
      if (document.activeElement?.closest('.xterm')) return
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'l') setFocusAddressAt((at) => at + 1)
      else openBrowser()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [browserInFront, openBrowser])

  /**
   * The folder the focused pane is about, for the launcher to open on: a
   * project tab's, or a session's project - or its folder, for a session no
   * project was recorded against, such as a profile's at a harness root.
   */
  const frontFolder = useMemo(() => {
    const group = open.groups[open.focused]
    const ref = group === undefined ? null : activeRef(group)
    if (ref?.kind === 'project') return ref.path
    if (ref?.kind === 'file') return ref.root
    if (ref?.kind !== 'session') return null
    const session = sessionsById.get(ref.id)
    return session === undefined ? null : (session.projectPath ?? session.cwd)
  }, [open, sessionsById])
  const { show: showLauncher } = newSession
  const openLauncher = useCallback(() => showLauncher(frontFolder), [showLauncher, frontFolder])

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------

  /** The file tabs on screen: the ones read, re-read and watched. */
  const shownFiles = useMemo(
    () => visible.flatMap((ref) => (ref.kind === 'file' ? [{ root: ref.root, path: ref.path }] : [])),
    [visible]
  )
  const files = useFiles({
    active: sidebarShown && sidebarView === 'files',
    follow: frontFolder,
    shown: shownFiles,
    revision: discovery
  })
  const { noteOpened, loadListing } = files

  /**
   * A file, opened to be read beside the session changing it (`openFile`): a
   * single click previews it, a double click or Ctrl+P keeps it.
   *
   * The preview that comes back is worked out here, from the layout on screen,
   * rather than inside the update - an updater has to be pure, and React runs
   * it twice in development to check.
   */
  const openFileAt = useCallback(
    (root: string, path: string, keep: boolean) => {
      const ref: FileRef = { kind: 'file', root, path }
      const id = paneId(ref)
      const still = preview !== null && findTab(open, preview) !== null ? preview : null
      const placed = openFile(open, ref, still, keep)
      const landed = findTab(placed.layout, id)
      commit((current) => openFile(current, ref, still, keep).layout)
      setPreview(placed.preview)
      // A file sent to the pane a maximized one is hiding gives the window back.
      setMaximized((current) => (current === null || current === landed?.group ? current : null))
      noteOpened(root, relativeTo(root, path))
    },
    [open, preview, commit, noteOpened]
  )

  /** A preview tab double-clicked: it stays. */
  const keepTab = useCallback((id: string) => {
    setPreview((current) => (current === id ? null : current))
  }, [])

  const openInEditor = useCallback((path: string, line: number | null) => {
    void helm.invoke('files:openInEditor', { path, line })
  }, [])
  const copyPath = useCallback((path: string) => {
    void helm.invoke('clipboard:write', path)
  }, [])

  /**
   * Ctrl+P: a file in the project the Files view is on, which follows the
   * pane in front. With nothing to search yet, the Files view opens instead,
   * and picks a project.
   */
  const filesRoot = files.root
  const openQuickOpen = useCallback(() => {
    if (filesRoot === null) {
      setSidebarView('files')
      setSidebarHidden(false)
      return
    }
    loadListing(filesRoot)
    setQuickOpenRoot(filesRoot)
  }, [filesRoot, loadListing])

  /**
   * Ctrl+N opens the launcher from anywhere in the window, a focused terminal
   * included - in capture, as Ctrl+Tab is, so xterm never sees it. Claude Code
   * binds nothing to it; a shell would read it as "next history line", and the
   * arrow keys say the same thing there. Not over another dialog, and not
   * during first run.
   *
   * A browser tab's page is the exception: keys typed into it go to that page's
   * own process, not this window, so Ctrl+N there is the page's.
   */
  useEffect(() => {
    if (setupNeeded) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return
      if (event.key.toLowerCase() !== 'n') return
      event.preventDefault()
      event.stopPropagation()
      if (!overlayOpen()) openLauncher()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [setupNeeded, openLauncher])

  /**
   * Ctrl+P, from anywhere in the window, a focused terminal included - in
   * capture, as Ctrl+N is. Claude Code binds it to the same things it binds
   * Ctrl+N to - the previous line, the previous choice - and the arrow keys
   * do each of those, which is the argument Ctrl+N's handler makes too.
   */
  useEffect(() => {
    if (setupNeeded) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return
      if (event.key.toLowerCase() !== 'p') return
      event.preventDefault()
      event.stopPropagation()
      if (!overlayOpen()) openQuickOpen()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [setupNeeded, openQuickOpen])

  /**
   * Ctrl+Tab cycles every tab in every pane on screen as one ring, and Ctrl+\
   * sends the front tab to the other pane. In capture so neither reaches a
   * focused terminal. Ctrl+Shift+Tab is not bound by Claude Code; Shift+Tab
   * alone is (it cycles permission modes) and is deliberately left alone.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.altKey) return
      if (event.key === '\\' && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        splitFocused()
        return
      }
      if (event.key !== 'Tab') return
      event.preventDefault()
      event.stopPropagation()
      const step = event.shiftKey ? -1 : 1
      if (shownMax === null) {
        commit((current) => cycleTab(current, step))
        return
      }
      // A maximized pane is the whole window, so the ring is its tabs.
      const group = open.groups[shownMax]
      const ids = group?.tabs.map(paneId) ?? []
      if (group === undefined || ids.length < 2) return
      const current = activeRef(group)
      const at = current === null ? -1 : ids.indexOf(paneId(current))
      const next = ids[(at + step + ids.length) % ids.length]
      if (next !== undefined) commit((layoutNow) => activateTab(layoutNow, next))
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [commit, open.groups, shownMax, splitFocused])

  // ---------------------------------------------------------------------------
  // What the tree, the tabs, the crumbs and the status bar say
  // ---------------------------------------------------------------------------

  const now = useNow(30_000)

  /** Each of Helm's sessions' registry record, for how long it has been in its state. */
  const liveByHelmId = useMemo(() => {
    const map = new Map<number, LiveSession>()
    for (const live of machineSessions.sessions) {
      if (live.helmSessionId !== null) map.set(live.helmSessionId, live)
    }
    return map
  }, [machineSessions.sessions])

  const profileNames = useMemo(() => {
    const map = new Map<number, string>()
    for (const profile of profileState.profiles) map.set(profile.id, profile.name)
    return map
  }, [profileState.profiles])

  const stateOf = (session: SessionRecord): TabIndicator =>
    indicatorOf(
      session,
      session.status === 'running' ? sessionActivity.get(session.id) : undefined
    )

  /**
   * The tree's sessions, under the project each is running in.
   *
   * Helm's own are matched on the project they were launched against, falling
   * back to their working directory; ended ones stay, because their tab does -
   * the scrollback is the record of what happened. Sessions Helm did not start
   * are matched with core's `liveSessionsIn`, the comparison the launch warning
   * uses, so the tree and the warning cannot disagree about whether two paths
   * are one folder.
   */
  const visibleIds = new Set(visible.map(paneId))
  const tree = ((): { byPath: Map<string, TreeSession[]>; elsewhere: TreeSession[] } => {
    const byPath = new Map<string, TreeSession[]>()
    const elsewhere: TreeSession[] = []
    const known = new Set([...projectsByPath.keys()].map((path) => path.toLowerCase()))
    const add = (key: string, row: TreeSession): void => {
      const rows = byPath.get(key)
      if (rows) rows.push(row)
      else byPath.set(key, [row])
    }

    for (const session of sessions) {
      const activity = session.status === 'running' ? sessionActivity.get(session.id) : undefined
      const state = indicatorOf(session, activity)
      const live = liveByHelmId.get(session.id)
      const waitingFor = activity?.waitingFor ?? null
      const id = `session:${String(session.id)}`
      const label = sessionLabel(session)
      const row: TreeSession = {
        id,
        label,
        state,
        note: sessionNote(state, live?.statusSinceMs ?? null, now),
        hint: waitingFor === null ? session.cwd : `${session.cwd}\nWaiting: ${waitingFor}`,
        outside: false,
        shown: id === frontId ? 'focused' : visibleIds.has(id) ? 'visible' : null
      }
      const key = (session.projectPath ?? session.cwd).toLowerCase()
      if (known.has(key)) add(key, row)
      else elsewhere.push({ ...row, label: `${label} · ${folderName(session.cwd)}` })
    }

    for (const project of projectsByPath.values()) {
      for (const live of liveSessionsIn(machineSessions.sessions, project.path)) {
        if (live.helmSessionId !== null) continue
        add(project.path.toLowerCase(), {
          id: `pid:${String(live.pid)}`,
          label: live.name ?? 'claude',
          state: live.activity,
          note: 'outside Helm',
          hint:
            `Started outside Helm, in ${live.cwd ?? project.path}` +
            (live.waitingFor === null ? '' : `\nWaiting: ${live.waitingFor}`),
          outside: true,
          shown: null
        })
      }
    }
    return { byPath, elsewhere }
  })()

  const openTreeSession = useCallback(
    (id: string) => {
      if (id.startsWith('session:')) {
        focusTab(id)
        return
      }
      // Somebody else's session has no tab; its row in the sessions pane is
      // where what Helm can know about it is.
      setSelectedLivePid(Number(id.slice('pid:'.length)))
      openSessions()
    },
    [focusTab, openSessions]
  )

  /** Helm's live sessions by what they are doing, for the status bar. */
  const running = sessions.filter((session) => session.status === 'running')
  const waiting = running.filter((session) => stateOf(session) === 'waiting')
  const working = running.filter((session) => stateOf(session) === 'busy').length
  const statusCounts = {
    working,
    waiting: waiting.length,
    idle: running.length - waiting.length - working
  }

  /** "Needs you", pressed: the next waiting session after the one in front. */
  const showWaiting = (): void => {
    const ids = waiting.map((session) => `session:${String(session.id)}`)
    if (ids.length === 0) return
    const at = frontId === null ? -1 : ids.indexOf(frontId)
    const next = ids[(at + 1) % ids.length]
    if (next !== undefined) focusTab(next)
  }

  /**
   * The machine-wide line under the tree: how many sessions are running on
   * this machine and how many of them are not Helm's - the half that changes
   * what somebody does next, and the reason the listing behind it exists.
   */
  const sessionsSummaryLine = ((): string => {
    const all = machineSessions.sessions
    if (machineSessions.readAtMs === null) return 'Reading…'
    if (all.length === 0) return 'Nothing running on this machine'
    const outside = all.filter((session) => session.helmSessionId === null).length
    const count = `${String(all.length)} on this machine`
    return outside === 0 ? `${count} · all in Helm` : `${count} · ${String(outside)} outside Helm`
  })()

  /** One tab, as its pane's strip draws it. */
  const tabFor = (ref: PaneRef): Tab[] => {
    switch (ref.kind) {
      case 'session': {
        const session = sessionsById.get(ref.id)
        if (!session) return []
        const label = sessionLabel(session)
        const waitingFor =
          session.status === 'running'
            ? (sessionActivity.get(session.id)?.waitingFor ?? null)
            : null
        return [
          {
            id: paneId(ref),
            title: label,
            // The CLI's own sentence for why it is blocked, verbatim and never
            // matched against: it comes from whichever dialog is on top, and
            // anything that interpreted it would be a second parser of a string
            // the CLI can change freely.
            hint:
              waitingFor === null
                ? `${label} · ${session.cwd}`
                : `${label} · ${session.cwd}\nWaiting: ${waitingFor}`,
            indicator: stateOf(session),
            renamable: true
          }
        ]
      }
      case 'sessions':
        return [
          {
            id: paneId(ref),
            title: 'Sessions',
            hint: sessionsSummaryLine,
            icon: <TerminalIcon width={13} height={13} />
          }
        ]
      case 'history':
        return [
          {
            id: paneId(ref),
            title: 'Session history',
            hint: historyState.summary?.historyFile ?? 'Every session on this machine',
            icon: <HistoryIcon width={13} height={13} />
          }
        ]
      case 'pulls':
        return [
          {
            id: paneId(ref),
            title: 'Pull requests',
            hint: pullsSummaryLine(pullsState.snapshot),
            icon: <PullRequestIcon width={13} height={13} />
          }
        ]
      case 'pr': {
        // The title comes from the list snapshot - the row the tab was opened
        // from. A pull request that has closed since keeps its number, which
        // is the honest label for a tab whose pane is about to say the same.
        const repo = pullsState.snapshot?.repos.find(
          (candidate) => candidate.path.toLowerCase() === ref.repoPath.toLowerCase()
        )
        const pull = repo?.pulls.find((candidate) => candidate.number === ref.number)
        const label = `#${String(ref.number)}`
        return [
          {
            id: paneId(ref),
            title: pull ? `${label} ${truncate(pull.title, 30)}` : label,
            hint: pull ? `${pull.title}\n${repo?.name ?? ''} - ${ref.repoPath}` : ref.repoPath,
            icon: <PullRequestIcon width={13} height={13} />
          }
        ]
      }
      case 'config':
        return [
          {
            id: paneId(ref),
            title: 'Config',
            hint: configState.scope?.path ?? 'Browse and edit .claude configuration',
            icon: <SlidersIcon width={13} height={13} />
          }
        ]
      case 'content':
        return [
          {
            id: paneId(ref),
            title: 'Content',
            hint:
              contentState.selected?.path ??
              contentState.scope?.path ??
              'Notes, docs, skills and artifacts',
            icon: <BookIcon width={13} height={13} />
          }
        ]
      case 'settings':
        return [
          {
            id: paneId(ref),
            title: 'Settings',
            hint: "Helm's own settings",
            icon: <GearIcon width={13} height={13} />
          }
        ]
      case 'browser': {
        const view = browserViews.get(ref.id)
        if (!view) return []
        // The page's own title, and the session that opened it beside that
        // where one did - the one tab whose provenance somebody will want. The
        // address, which tells three tabs on one dev server apart, is in the
        // hint. An empty page is "New tab": a tab with no label is a tab you
        // cannot aim at.
        const where = view.url === '' ? 'A browser tab with no address yet' : view.url
        return [
          {
            id: paneId(ref),
            title: view.title === '' ? 'New tab' : truncate(view.title, 30),
            ...(view.openedBy === null ? {} : { badge: view.openedBy }),
            hint:
              view.openedBy === null ? where : `${where}\nOpened by the session “${view.openedBy}”`,
            icon: <GlobeIcon width={13} height={13} />
          }
        ]
      }
      case 'restore':
        return restoreOffer === null
          ? []
          : [
              {
                id: paneId(ref),
                title: 'Restore sessions',
                hint: 'What Helm was running when it closed',
                icon: <HistoryIcon width={13} height={13} />
              }
            ]
      case 'project': {
        const project = projectsByPath.get(ref.path)
        if (!project) return []
        const Icon = KIND_ICON[project.kind]
        return [
          {
            id: paneId(ref),
            title: project.name,
            hint: project.path,
            icon: <Icon width={13} height={13} />
          }
        ]
      }
      case 'file':
        return [
          {
            id: paneId(ref),
            title: folderName(ref.path),
            hint: paneId(ref) === preview ? `${ref.path}\nPreview - double-click to keep it open` : ref.path,
            icon: <DocIcon width={13} height={13} />,
            mono: true,
            preview: paneId(ref) === preview
          }
        ]
    }
  }

  /** The crumb under a session's tab. */
  const crumbFor = (ref: PaneRef | null): ReactNode => {
    if (ref?.kind === 'file') {
      const view = files.tabs.get(fileKey(ref.path))?.view ?? null
      return <FileCrumb relPath={view?.relPath ?? relativeTo(ref.root, ref.path)} changes={view?.changes ?? null} />
    }
    if (ref?.kind !== 'session') return null
    const session = sessionsById.get(ref.id)
    if (!session) return null
    const project =
      session.projectPath === null ? undefined : projectsByPath.get(session.projectPath)
    return (
      <PaneCrumb
        place={project?.name ?? folderName(session.cwd)}
        hint={session.cwd}
        branch={session.branch}
        profile={session.profileId === null ? null : (profileNames.get(session.profileId) ?? null)}
        status={crumbStatus(
          session,
          stateOf(session),
          liveByHelmId.get(session.id)?.statusSinceMs ?? null,
          now
        )}
      />
    )
  }

  // ---------------------------------------------------------------------------
  // Dialogs
  // ---------------------------------------------------------------------------

  /**
   * "This session is still running", asked by the main process and answered
   * here. Main owns process lifetime, so it owns the question; the renderer
   * owns everything the user looks at, so it draws it. The answer is sent only
   * while a request is pending: a second reply to an id main has resolved is a
   * reply for a decision that has been taken.
   */
  const [confirmRequest, setConfirmRequest] = useState<SessionConfirmRequest | null>(null)
  useEffect(() => helm.on('session:confirm', setConfirmRequest), [])
  const answerConfirm = useCallback(
    (agreed: boolean) => {
      if (confirmRequest === null) return
      helm.send('session:confirmed', { id: confirmRequest.id, agreed })
      setConfirmRequest(null)
    },
    [confirmRequest]
  )

  /**
   * Rendered by both branches below: main holds the window's `close` open on
   * this promise, so a branch that did not draw the dialog would be a branch
   * Helm could not quit from until the fallback timer ran out.
   */
  const confirmDialog =
    confirmRequest === null ? null : (
      <ConfirmSessionDialog
        kind={confirmRequest.kind}
        message={confirmRequest.message}
        detail={confirmRequest.detail}
        confirmLabel={confirmRequest.confirmLabel}
        sessionNames={confirmRequest.sessionNames}
        onConfirm={() => answerConfirm(true)}
        onCancel={() => answerConfirm(false)}
      />
    )

  /** Rendered by both branches: creating a harness is a first-run action and
   * an every-day one, and two copies of the dialog would drift apart. */
  const harnessDialog =
    setup.dialog === null || templates.managerOpen ? null : (
      <NewHarnessDialog
        mode={setup.dialog}
        dir={setup.dialogDir}
        onChooseDir={setup.chooseDialogDir}
        onModeChange={setup.setDialogMode}
        problems={setup.dialogProblems}
        busy={setup.creating}
        templates={setup.templates}
        template={setup.template}
        onTemplateChange={setup.chooseTemplate}
        templatesDir={setup.templatesDir}
        onManageTemplates={templates.openManager}
        templateProblems={setup.templateProblems}
        preview={setup.templatePreview}
        onCreate={setup.createHarness}
        onCancel={setup.closeDialog}
      />
    )

  /**
   * The template manager, and the dialog that freezes a folder into one. The
   * harness dialog is **withheld while this is up** - two `Overlay`s is two
   * scrims - and withholding rather than closing keeps what was typed into it.
   */
  const templateDialogs =
    templates.saveDialog !== null ? (
      <SaveAsTemplateDialog
        kind={templates.saveDialog.kind}
        dir={templates.saveDialog.dir}
        {...(templates.saveDialog.kind === 'folder'
          ? { onChooseDir: templates.chooseSaveDir }
          : {})}
        preview={templates.savePreview}
        busy={templates.saveBusy}
        problems={templates.saveProblems}
        onSave={templates.save}
        onCancel={templates.closeSaveDialog}
      />
    ) : templates.managerOpen ? (
      <TemplateManager
        templates={templates.templates}
        templatesDir={templates.templatesDir}
        listProblems={templates.listProblems}
        selected={templates.selected}
        onSelect={templates.select}
        detail={templates.detail}
        scopes={templates.scopes}
        importScope={templates.importScope}
        onImportScopeChange={templates.setImportScope}
        importTree={templates.importTree}
        busy={templates.busy}
        problems={templates.problems}
        notice={templates.notice}
        onCreate={templates.create}
        onSaveMetadata={templates.saveMetadata}
        onDelete={templates.remove}
        onReveal={launcher.reveal}
        onMakeSubstitutable={templates.makeSubstitutable}
        onImport={templates.importFiles}
        onImportFolder={templates.openImportFolder}
        onClose={() => {
          templates.closeManager()
          // The harness dialog behind this may be showing a picker built before
          // a template was created, renamed or deleted.
          setup.refreshTemplates()
        }}
      />
    ) : null

  /**
   * New, Rename and Delete for one entry in a `.claude` tree. Rendered beside
   * the other modals rather than inside the console: a dialog nested in a pane
   * that a split can narrow is a dialog that gets clipped.
   */
  const configEntryDialog =
    configState.scope === null || configState.entryDialog === null ? null : configState
      .entryDialog === 'new' ? (
      <ConfigNewDialog
        scope={configState.scope}
        files={configState.tree?.files ?? []}
        busy={configState.entryBusy}
        error={configState.entryError}
        onCreate={configState.createFile}
        onCancel={() => configState.openEntryDialog(null)}
      />
    ) : configState.selected === null ? null : configState.entryDialog === 'rename' ? (
      <ConfigRenameDialog
        scope={configState.scope}
        file={configState.selected}
        files={configState.tree?.files ?? []}
        busy={configState.entryBusy}
        error={configState.entryError}
        onRename={configState.renameFile}
        onCancel={() => configState.openEntryDialog(null)}
      />
    ) : (
      <ConfigDeleteDialog
        file={configState.selected}
        files={configState.tree?.files ?? []}
        busy={configState.entryBusy}
        error={configState.entryError}
        onDelete={configState.deleteFile}
        onCancel={() => configState.openEntryDialog(null)}
      />
    )

  /**
   * Setup owns the whole window rather than sitting in a tab: with no roots
   * there is no tree, no config scope and no content, and a launcher painted
   * empty behind a dialog would be four broken surfaces framing one that works.
   */
  if (setup.needed) {
    return (
      <div className="flex h-full w-full flex-col bg-bg text-fg">
        <TitleBar />
        <div className="min-h-0 flex-1">
          <SetupPane
            status={setup.status}
            roots={settings?.scanRoots ?? []}
            suggestions={setup.suggestions}
            projectCount={discovery?.projects.length ?? 0}
            scanning={launcher.scanning}
            checking={setup.checking}
            onRecheck={setup.recheck}
            onLocateClaude={setup.locateClaude}
            onAddFolder={launcher.addRoot}
            onAcceptSuggestion={setup.acceptSuggestion}
            onCreateHarness={() => setup.openDialog('new')}
            onConvertFolder={() => setup.openDialog('convert')}
            onFinish={setup.finish}
          />
        </div>
        {harnessDialog}
        {templateDialogs}
        {confirmDialog}
      </div>
    )
  }

  // ---------------------------------------------------------------------------
  // The pages
  // ---------------------------------------------------------------------------

  /** Whether `path` is one of the scanned folders - what removal can act on. */
  const isRoot = (path: string): boolean => isScanRoot(settings?.scanRoots ?? [], path)

  /** The harness a project *is*, when it is one - for its `template:`. */
  const harnessAt = (path: string): Harness | null =>
    discovery?.harnesses.find((harness) => harness.path.toLowerCase() === path.toLowerCase()) ??
    null

  const renderProject = (project: Project): JSX.Element => {
    const harness = harnessAt(project.path)
    const here = liveSessionsIn(machineSessions.sessions, project.path)
    return (
      <ProjectColumn
        path={project.path}
        windowsBuild={info?.windowsBuild ?? null}
        shells={shells}
        heightPct={savedShellHeight}
        onHeightChange={setShellHeight}
      >
        <ProjectPane
          key={project.path}
          project={project}
          harness={harness}
          onReveal={launcher.reveal}
          onLaunch={(p) => void launch(p)}
          launching={launchingPath === project.path}
          launchError={sessionState.launchError}
          liveHere={here.length === 0 ? EMPTY_LIVE : here}
          onSaveAsProfile={(p) => {
            setSaveProblems([])
            // Seeded with what is on screen: this project as the root, and
            // itself composed, which is the launch the button is beside.
            setEditing({ ...blankProfile(p.path, p.name), overlays: [p.path], access: [p.path] })
          }}
          onOpenConfig={openConfigAt}
          onOpenContent={openContentAt}
          // A harness only: it is the one kind of project with a layout to
          // freeze. Decided here because whether a project is a harness root is
          // discovery's answer, not the page's.
          {...(harness !== null
            ? { onSaveAsTemplate: (p: Project) => templates.openSaveAs(p.path) }
            : {})}
          // Only where this project *is* a scan root, which is the whole of what
          // removal can act on.
          {...(isRoot(project.path)
            ? {
                onRemoveRoot: (p: Project) => {
                  // The shell goes with the page, exactly as it does on close:
                  // removing a folder takes it out of discovery, which drops its
                  // tab without going through the close button, and nothing
                  // else would end the pty.
                  void disposeShell(p.path)
                  launcher.removeRoot(p.path)
                }
              }
            : {})}
          // The whole snapshot: the page reduces it itself (`projectPulls`), so
          // the project page and the Pulls pane read one answer rather than two.
          pulls={pullsState.snapshot}
          onOpenPull={openPull}
          onRefreshPulls={pullsState.refresh}
          onUnignoreRepo={unignoreRepo}
        />
      </ProjectColumn>
    )
  }

  const renderSettings = (): JSX.Element => (
    <SettingsPane
      status={setup.status}
      checking={setup.checking}
      onRecheck={setup.recheck}
      onLocateClaude={setup.locateClaude}
      onClearClaudeOverride={launcher.clearClaudePath}
      roots={settings?.scanRoots ?? []}
      projectCount={discovery?.projects.length ?? 0}
      scanning={launcher.scanning}
      onAddRoot={launcher.addRoot}
      onRemoveRoot={launcher.removeRoot}
      pinnedProjects={settings?.pinnedProjects ?? DEFAULT_SETTINGS.pinnedProjects}
      // The same writer the tree's star goes through, so the two surfaces
      // cannot hold different ideas of what is pinned.
      onUnpinProject={togglePin}
      appearance={{
        theme: settings?.theme ?? DEFAULT_SETTINGS.theme,
        themeDark: settings?.themeDark ?? DEFAULT_SETTINGS.themeDark,
        themeLight: settings?.themeLight ?? DEFAULT_SETTINGS.themeLight,
        paneGap: settings?.paneGap ?? DEFAULT_SETTINGS.paneGap,
        cornerRadius: settings?.cornerRadius ?? DEFAULT_SETTINGS.cornerRadius,
        density: settings?.density ?? DEFAULT_SETTINGS.density,
        accentColor: settings?.accentColor ?? DEFAULT_SETTINGS.accentColor
      }}
      onAppearanceChange={writeSettings}
      themes={themes.listing}
      themeState={themes.state}
      onOpenThemesFolder={themes.openFolder}
      onDuplicateTheme={themes.duplicate}
      usageDisplay={settings?.usageDisplay ?? 'percent'}
      updateCheck={settings?.updateCheck ?? DEFAULT_SETTINGS.updateCheck}
      onUpdateCheckChange={(updateCheck) => writeSettings({ updateCheck })}
      onUsageDisplayChange={launcher.setUsageDisplay}
      appVersion={info?.version ?? null}
      // From `app:info` rather than from a check's result: the states that
      // produce no result are exactly the ones where somebody wants this link.
      releasesUrl={info?.releasesUrl ?? null}
      // `attempted`, not `answered` - see the narrowing above `update`.
      update={check.attempted}
      updateChecking={check.checking}
      onCheckForUpdate={check.check}
      onOpenReleases={() => {
        if (info?.releasesUrl !== undefined) void helmOpenExternal(info.releasesUrl)
      }}
      // The same fact the status bar's cycle turns on, from the same snapshot.
      hasCostEstimate={usage?.spend != null}
      terminal={terminalSettings}
      onTerminalChange={launcher.writeSettings}
      // The stack the terminals are actually running, so the preview well
      // cannot show a font the panes are not using.
      terminalFontStack={terminalFontStack(terminalSettings.terminalFontFamily)}
      shells={shells}
      onLocateShell={locateShell}
      // The archive's own figures, from the one subscription the history pane
      // reads them from, so the two cannot disagree about how much is stored.
      archiveStats={historyState.archiveStats}
      transcriptArchiveMaxBytes={
        settings?.transcriptArchiveMaxBytes ?? DEFAULT_SETTINGS.transcriptArchiveMaxBytes
      }
      // The authored templates, so the built-in Minimal row does not make an
      // empty templates folder read as one that has something in it.
      templateCount={templates.templates.filter((choice) => !choice.builtIn).length}
      templatesDir={templates.templatesDir}
      onManageTemplates={templates.openManager}
      onRevealTemplates={() => launcher.reveal(templates.templatesDir)}
      browserReach={settings?.browserReach ?? DEFAULT_SETTINGS.browserReach}
      onBrowserReachChange={(browserReach) => writeSettings({ browserReach })}
      browserMcp={settings?.browserMcp ?? DEFAULT_SETTINGS.browserMcp}
      onBrowserMcpChange={(browserMcp) => writeSettings({ browserMcp })}
      browserMcpLocalOnly={settings?.browserMcpLocalOnly ?? DEFAULT_SETTINGS.browserMcpLocalOnly}
      onBrowserMcpLocalOnlyChange={(browserMcpLocalOnly) =>
        writeSettings({ browserMcpLocalOnly })
      }
      sessionMcp={settings?.sessionMcp ?? DEFAULT_SETTINGS.sessionMcp}
      onSessionMcpChange={(sessionMcp) => writeSettings({ sessionMcp })}
      restoreWithoutAsking={settings?.restoreWithoutAsking ?? DEFAULT_SETTINGS.restoreWithoutAsking}
      onRestoreWithoutAskingChange={(restoreWithoutAsking) => writeSettings({ restoreWithoutAsking })}
      contentWrap={settings?.contentWrap ?? DEFAULT_SETTINGS.contentWrap}
      onContentWrapChange={(contentWrap) => writeSettings({ contentWrap })}
      contentWrapIndent={settings?.contentWrapIndent ?? DEFAULT_SETTINGS.contentWrapIndent}
      onContentWrapIndentChange={(contentWrapIndent) => writeSettings({ contentWrapIndent })}
      onTranscriptArchiveMaxBytesChange={(transcriptArchiveMaxBytes) =>
        writeSettings({ transcriptArchiveMaxBytes })
      }
      // What `gh` actually resolved to, from the snapshot the Pulls pane paints,
      // so the pane cannot report one executable while the fetches use another.
      gh={pullsState.snapshot?.gh ?? null}
      onLocateGh={locateGh}
      onClearGhOverride={() => writeSettings({ ghPath: null })}
      prPollMinutes={settings?.prPollMinutes ?? DEFAULT_SETTINGS.prPollMinutes}
      onPrPollMinutesChange={(prPollMinutes) => writeSettings({ prPollMinutes })}
      prStaleDays={settings?.prStaleDays ?? DEFAULT_SETTINGS.prStaleDays}
      onPrStaleDaysChange={(prStaleDays) => writeSettings({ prStaleDays })}
      // Built from the snapshot rather than from the setting, because the
      // choices are the repositories discovery found.
      prRepos={pullRepoChoices(
        pullsState.snapshot?.repos ?? [],
        pullsState.snapshot?.ignored ?? []
      )}
      onPrIgnoredReposChange={(prIgnoredRepos) => writeSettings({ prIgnoredRepos })}
      prReviewPrompt={settings?.prReviewPrompt ?? DEFAULT_SETTINGS.prReviewPrompt}
      onPrReviewPromptChange={(prReviewPrompt) => writeSettings({ prReviewPrompt })}
      prCheckout={settings?.prCheckout ?? DEFAULT_SETTINGS.prCheckout}
      onPrCheckoutChange={(prCheckout) => writeSettings({ prCheckout })}
      prReviewModel={settings?.prReviewModel ?? DEFAULT_SETTINGS.prReviewModel}
      onPrReviewModelChange={(prReviewModel) => writeSettings({ prReviewModel })}
      prReviewEffort={settings?.prReviewEffort ?? DEFAULT_SETTINGS.prReviewEffort}
      onPrReviewEffortChange={(prReviewEffort) => writeSettings({ prReviewEffort })}
    />
  )

  /** Whatever a non-session tab shows. */
  const renderPage = (ref: PaneRef): ReactNode => {
    switch (ref.kind) {
      case 'project': {
        const project = projectsByPath.get(ref.path)
        return project ? renderProject(project) : null
      }
      case 'history':
        return (
          <SessionHistory
            {...sessionHistoryProps(historyState)}
            onResume={(session) => void resumeSession(session)}
            onReveal={launcher.reveal}
            compact={compact}
          />
        )
      case 'sessions':
        return (
          <SessionsPane
            sessions={machineSessions.sessions}
            readAtMs={machineSessions.readAtMs}
            records={sessionsById}
            resources={machineSessions.resources}
            selectedPid={selectedLivePid}
            onSelect={(session) => setSelectedLivePid(session?.pid ?? null)}
            // Bringing the terminal forward is the one thing this pane does
            // *to* a session: the pane is for looking, the tab is for working.
            onOpenSession={(id) => focusTab(`session:${String(id)}`)}
            onReveal={launcher.reveal}
            compact={compact}
          />
        )
      case 'pulls':
        return (
          <PullsPane
            snapshot={pullsState.snapshot}
            onRefresh={pullsState.refresh}
            refreshing={pullsState.refreshing}
            error={pullsState.error}
            onOpenPull={openPull}
            // The reveal direction only. Ignoring is done in Settings, where the
            // setting lives; this is the undo standing beside the thing it undoes.
            onUnignoreRepo={unignoreRepo}
            staleDays={settings?.prStaleDays ?? DEFAULT_SETTINGS.prStaleDays}
            compact={compact}
          />
        )
      case 'pr':
        return (
          <PullRequestTab
            // Keyed on the tab, so switching between two pull request tabs
            // rebuilds the pane rather than leaving one PR's view selected over
            // another's conversation.
            key={paneId(ref)}
            repoPath={ref.repoPath}
            number={ref.number}
            reviewTemplate={settings?.prReviewPrompt ?? DEFAULT_SETTINGS.prReviewPrompt}
            checkout={settings?.prCheckout ?? DEFAULT_SETTINGS.prCheckout}
            reviewModel={settings?.prReviewModel ?? DEFAULT_SETTINGS.prReviewModel}
            reviewEffort={settings?.prReviewEffort ?? DEFAULT_SETTINGS.prReviewEffort}
            onReview={reviewPull}
            onOpenExternal={(url) => void helmOpenExternal(url)}
            compact={compact}
          />
        )
      case 'config':
        return (
          <ConfigConsole
            scopes={configState.scopes}
            scopePath={configState.scopePath}
            onScopeChange={configState.setScopePath}
            view={configState.view}
            onViewChange={configState.setView}
            tree={configState.tree}
            treeLoading={configState.treeLoading}
            live={configState.live}
            selected={configState.selected}
            onSelect={configState.select}
            dirty={configState.dirty}
            onRefresh={configState.refresh}
            refreshing={configState.refreshing}
            compact={compact}
            onBack={() => configState.select(null)}
            onNew={
              configState.scope === null ? undefined : () => configState.openEntryDialog('new')
            }
            notice={
              configState.deleted === null ? null : (
                <ConfigDeletedNotice
                  label={configState.deleted.label}
                  fileCount={configState.deleted.files.length}
                  busy={configState.entryBusy}
                  onUndo={configState.undoDelete}
                  onDismiss={configState.dismissDeleted}
                />
              )
            }
          >
            {configState.view === 'files' ? (
              configState.selected === null ? (
                <ConfigNothingSelected
                  scope={configState.scope}
                  fileCount={configState.tree?.files.length ?? 0}
                />
              ) : (
                <ConfigEditor
                  // Keyed on the path so switching files rebuilds the editor
                  // rather than leaving one file's draft in another's box.
                  key={configState.selected.path}
                  file={configState.selected}
                  loaded={configState.loaded}
                  rendered={configState.rendered}
                  live={configState.live}
                  siblings={configState.tree?.files ?? []}
                  snapshots={configState.snapshots}
                  saving={configState.saving}
                  error={configState.editorError}
                  external={configState.external}
                  onSave={configState.save}
                  onReload={configState.reload}
                  onRestore={configState.restore}
                  onReveal={launcher.reveal}
                  onOpenPath={configState.openPath}
                  onOpenExternal={openLink}
                  onDirtyChange={configState.setDirty}
                  onHighlight={helmHighlight}
                  onRename={() => configState.openEntryDialog('rename')}
                  onDelete={() => configState.openEntryDialog('delete')}
                  justCreated={configState.selected.path === configState.createdPath}
                />
              )
            ) : configState.view === 'effective' ? (
              <EffectiveViewPane
                profiles={profileState.profiles}
                profileId={configState.effectiveProfileId}
                onProfileChange={configState.setEffectiveProfileId}
                cwd={configState.effectiveCwd}
                onCwdChange={configState.setEffectiveCwd}
                view={configState.effective}
                loading={configState.effectiveLoading}
                error={configState.effectiveError}
                onReveal={launcher.reveal}
                onOpenFile={configState.openPath}
              />
            ) : configState.view === 'mcp' ? (
              <McpPanel
                cwd={
                  configState.scope?.kind === 'user'
                    ? (configState.scopes.find((s) => s.kind !== 'user')?.path ?? '')
                    : (configState.scope?.path ?? '')
                }
                servers={configState.mcpServers}
                listing={configState.mcpListing}
                listing_busy={configState.mcpListing_busy}
                onList={configState.runMcpList}
                draft={configState.mcpDraft}
                onDraftChange={configState.setMcpDraft}
                preview={configState.mcpPreview}
                onPreview={configState.requestMcpPreview}
                onApply={configState.applyMcp}
                onCancelPreview={configState.cancelMcpPreview}
                applying={configState.mcpApplying}
                result={configState.mcpResult}
                onDismissResult={configState.dismissMcpResult}
                onRemove={configState.removeMcp}
                onApprove={configState.approveMcp}
                onOpenFile={configState.openPath}
              />
            ) : (
              <HealthPanel
                report={configState.doctor}
                running={configState.doctorRunning}
                onRun={configState.runDoctor}
                claudeVersion={info?.claudeVersion ?? null}
              />
            )}
          </ConfigConsole>
        )
      case 'content':
        return (
          <ContentViewer
            scopes={contentState.scopes}
            scopePath={contentState.scopePath}
            onScopeChange={contentState.setScopePath}
            tree={contentState.tree}
            treeLoading={contentState.treeLoading}
            view={contentState.view}
            onViewChange={contentState.setView}
            viewIsDefault={contentState.viewIsDefault}
            dirs={contentState.dirs}
            expanded={contentState.expanded}
            onToggleDir={contentState.toggleDir}
            loadingDirs={contentState.loadingDirs}
            query={contentState.query}
            onQueryChange={contentState.setQuery}
            search={contentState.search}
            searching={contentState.searching}
            selected={contentState.selected}
            selectedPath={contentState.selectedPath}
            onSelect={contentState.select}
            onOpenPath={contentState.openPath}
            onReveal={launcher.reveal}
            dirty={contentState.dirty}
            onRefresh={contentState.refresh}
            refreshing={contentState.refreshing}
            compact={compact}
            onBack={() => contentState.select(null)}
          >
            {contentState.selected === null ? (
              <ContentNothingSelected
                scope={contentState.scope}
                view={contentState.view}
                fileCount={contentState.tree?.files.length ?? 0}
              />
            ) : (
              <ContentDocumentPane
                // Keyed on the path so opening another note rebuilds the pane
                // rather than leaving one document's draft in another's editor.
                key={contentState.selected.path}
                file={contentState.selected}
                document={contentState.document}
                preview={contentState.preview}
                previewPending={contentState.previewPending}
                mode={contentState.mode}
                onModeChange={contentState.setMode}
                artifactUrl={contentState.artifactUrl}
                artifactConsole={contentState.artifactConsole}
                snapshots={contentState.snapshots}
                saving={contentState.saving}
                error={contentState.error}
                external={contentState.external}
                highlight={contentState.highlight}
                wrapDefault={settings?.contentWrap ?? DEFAULT_SETTINGS.contentWrap}
                wrapIndent={settings?.contentWrapIndent ?? DEFAULT_SETTINGS.contentWrapIndent}
                onHighlight={helmHighlight}
                onSave={contentState.save}
                onReload={contentState.reload}
                onRestore={contentState.restore}
                onReveal={launcher.reveal}
                onDirtyChange={contentState.setDirty}
                onDraftChange={contentState.setDraft}
                onOpenPath={contentState.openPath}
                onOpenWikilink={contentState.openWikilink}
                onOpenExternal={openLink}
              />
            )}
          </ContentViewer>
        )
      case 'browser': {
        const view = browserViews.get(ref.id)
        if (!view) return null
        return (
          <BrowserPane
            // Keyed on the view, so switching between two browser tabs rebuilds
            // the bar rather than leaving one page's address in the other's box.
            key={view.id}
            state={view}
            entries={browsers.entries.get(view.id) ?? EMPTY_CONSOLE}
            recent={browsers.recent}
            focusAddressAt={focusAddressAt}
            onBounds={(rect) => browsers.sendBounds(view.id, rect, true)}
            onNavigate={(input) => browsers.navigate(view.id, input)}
            onBack={() => browsers.back(view.id)}
            onForward={() => browsers.forward(view.id)}
            onReload={(hard) => browsers.reload(view.id, hard)}
            onDevTools={() => browsers.devtools(view.id)}
            onOpenExternal={(url) => void helmOpenExternal(url)}
            onFind={(query, forward) => browsers.find(view.id, query, forward)}
            onStopFind={() => browsers.stopFind(view.id)}
            onZoom={(level) => browsers.zoom(view.id, level)}
            onClearStorage={() => browsers.clearStorage(view.id)}
            onEvaluate={(source) => browsers.evaluate(view.id, source)}
            // The address dropdown hangs over the page; the view stands down
            // for it, the same way it does for a tab drag.
            onCovering={browsers.setSuppressed}
          />
        )
      }
      case 'settings':
        return renderSettings()
      case 'restore':
        return restoreOffer === null ? null : (
          <RestorePane
            offer={restoreOffer}
            withoutAsking={settings?.restoreWithoutAsking ?? DEFAULT_SETTINGS.restoreWithoutAsking}
            onWithoutAskingChange={(restoreWithoutAsking) => writeSettings({ restoreWithoutAsking })}
            busy={restoreState.busy}
            onResume={(ids) => void resumeLost(ids)}
            onNotNow={dismissRestore}
            now={now}
          />
        )
      case 'session':
      case 'file':
        // Neither is a page: a session is its terminal and a file its view,
        // both drawn edge to edge by `renderGroup`.
        return null
    }
  }

  /** A file tab's view: the code on the pane itself, no page gutter around it. */
  const renderFile = (ref: FileRef): JSX.Element => {
    const key = fileKey(ref.path)
    const state = files.tabs.get(key)
    return (
      <FileView
        key={paneId(ref)}
        view={state?.view ?? null}
        error={state?.error ?? null}
        wrap={files.wrap}
        onWrapChange={files.setWrap}
        onHighlight={helmHighlight}
        onCaretChange={(caret) => fileCarets.current.set(key, caret.line)}
        onReveal={launcher.reveal}
        onOpenInEditor={
          files.editor === null ? null : () => openInEditor(ref.path, fileCarets.current.get(key) ?? null)
        }
      />
    )
  }

  // ---------------------------------------------------------------------------
  // The frame
  // ---------------------------------------------------------------------------

  /** One pane: its strip, its crumb, its sessions' terminals and its front page. */
  const renderGroup = (index: number, place: 'whole' | 'start' | 'end'): JSX.Element => {
    const group = open.groups[index]!
    const groupFront = activeRef(group)
    const groupFrontId = groupFront === null ? null : paneId(groupFront)
    const attention = group.tabs.some(
      (ref) =>
        ref.kind === 'session' &&
        sessionsById.get(ref.id)?.status === 'running' &&
        sessionActivity.get(ref.id)?.activity === 'waiting'
    )
    const single = open.groups.length === 1
    return (
      <PaneGroup
        index={index}
        focused={index === open.focused}
        attention={attention}
        className={
          place === 'whole' ? 'split-whole' : place === 'start' ? 'split-start' : 'split-end'
        }
        bodyRef={(element) => {
          bodyRefs.current[index] = element
        }}
        onFocus={() => commit((current) => focusGroup(current, index))}
        strip={
          <TabBar
            tabs={group.tabs.flatMap(tabFor)}
            activeId={groupFrontId}
            focused={index === open.focused}
            onActivate={(id) => commit((current) => activateTab(current, id))}
            onClose={closeAny}
            onMove={(id, toIndex) => commit((current) => moveTab(current, id, index, toIndex))}
            onRename={(id, label) => {
              if (id.startsWith('session:')) void sessionState.rename(sessionIdOf(id), label)
            }}
            onKeep={keepTab}
            // A native view paints over the drop mark and the dragged tab's
            // ghost, so it stands down for the length of the gesture.
            onDragging={browsers.setSuppressed}
            actions={
              <>
                {groupFront?.kind === 'file' && (
                  <FileActions
                    path={groupFront.path}
                    onOpenInEditor={
                      files.editor === null
                        ? null
                        : () =>
                            openInEditor(
                              groupFront.path,
                              fileCarets.current.get(fileKey(groupFront.path)) ?? null
                            )
                    }
                    onReveal={launcher.reveal}
                    onCopyPath={copyPath}
                  />
                )}
                <PaneActions
                split={single ? (group.tabs.length > 1 ? 'new' : null) : 'other'}
                maximized={shownMax === index}
                canMaximize={group.tabs.length > 0}
                canClose={!single && index === 1}
                onSplit={() => {
                  commit((current) => sendToOtherGroup(focusGroup(current, index)))
                  setMaximized(null)
                }}
                onMaximize={() => {
                  commit((current) => focusGroup(current, index))
                  setMaximized((current) => (current === index ? null : index))
                }}
                onClose={() => {
                  commit((current) => closeGroup(current, index))
                  setMaximized(null)
                }}
              />
              </>
            }
          />
        }
        crumb={crumbFor(groupFront)}
      >
        {/* Every terminal in the pane stays mounted and only the front one is
            shown. The terminal itself lives in terminals.ts and outlives any
            render, but a pane that is not mounted has nowhere to put it. */}
        {group.tabs.map((ref) => {
          if (ref.kind !== 'session') return null
          const session = sessionsById.get(ref.id)
          if (!session) return null
          const isFront = groupFrontId === paneId(ref)
          return (
            <div
              key={ref.id}
              className={cn('absolute inset-0', isFront ? 'block' : 'hidden')}
              aria-hidden={!isFront}
            >
              <TerminalPane
                session={session}
                active={isFront}
                windowsBuild={info?.windowsBuild ?? null}
                onClose={closeSession}
              />
            </div>
          )
        })}
        {groupFront?.kind === 'file' && <div className="absolute inset-0">{renderFile(groupFront)}</div>}
        {groupFront !== null && groupFront.kind !== 'session' && groupFront.kind !== 'file' && (
          // On the pane itself: the pane is the island, and a page says what it
          // has in sections with hairlines rather than islands of its own.
          <div className="absolute inset-0">{renderPage(groupFront)}</div>
        )}
      </PaneGroup>
    )
  }

  // A fact about the machine that qualifies the whole window: the CLI is
  // missing, or it is a version outside what this build was measured against.
  const versionWarning =
    setup.status !== null &&
    !setup.bannerDismissed &&
    (setup.status.path === null || setup.status.version === null || !setup.status.tested)

  const toggleView = (view: SidebarView): void => {
    if (sidebarShown && sidebarView === view) {
      setSidebarHidden(true)
      return
    }
    setSidebarView(view)
    setSidebarHidden(false)
    setMaximized(null)
  }

  const inFront = (...kinds: PaneRef['kind'][]): boolean =>
    front !== null && kinds.includes(front.kind)
  const page = (
    id: string,
    label: string,
    icon: JSX.Element,
    onSelect: () => void,
    current: boolean,
    hook: `data-${string}`
  ): RailItem => ({
    id,
    label,
    icon,
    kind: 'page',
    current,
    onSelect,
    hooks: { [hook]: true } as Record<`data-${string}`, boolean>
  })

  // Ordered by how often each is reached for (DESIGN.md "The rail"): the
  // sessions tree, then the occasional pages, then the rare ones under a rule.
  const rail = (
    <Rail
      groups={[
        [
          {
            id: 'sessions',
            label: 'Sessions',
            icon: <TerminalIcon width={17} height={17} />,
            kind: 'view',
            current: sidebarShown && sidebarView === 'sessions',
            attention: statusCounts.waiting > 0,
            onSelect: () => toggleView('sessions')
          },
          {
            id: 'files',
            label: 'Files',
            icon: <DocIcon width={17} height={17} />,
            kind: 'view',
            current: sidebarShown && sidebarView === 'files',
            onSelect: () => toggleView('files'),
            hooks: { 'data-open-files': true }
          },
          page(
            'history',
            'Session history',
            <HistoryIcon width={17} height={17} />,
            openHistory,
            inFront('history'),
            'data-open-history'
          ),
          page(
            'content',
            'Content',
            <BookIcon width={17} height={17} />,
            openContent,
            inFront('content'),
            'data-open-content'
          ),
          page(
            'browser',
            'Browser',
            <GlobeIcon width={17} height={17} />,
            showBrowser,
            inFront('browser'),
            'data-open-browser'
          )
        ],
        [
          {
            id: 'profiles',
            label: 'Profiles',
            icon: <LayersIcon width={17} height={17} />,
            kind: 'view',
            current: sidebarShown && sidebarView === 'profiles',
            onSelect: () => toggleView('profiles'),
            hooks: { 'data-open-profiles': true }
          },
          page(
            'pulls',
            'Pull requests',
            <PullRequestIcon width={17} height={17} />,
            openPulls,
            inFront('pulls', 'pr'),
            'data-open-pulls'
          ),
          page(
            'config',
            'Config',
            <SlidersIcon width={17} height={17} />,
            openConfig,
            inFront('config'),
            'data-open-config'
          )
        ]
      ]}
      footer={[
        page(
          'settings',
          'Settings',
          <GearIcon width={17} height={17} />,
          openSettings,
          inFront('settings'),
          'data-open-settings'
        )
      ]}
    />
  )

  const sidebar = !sidebarShown ? null : (
    <>
      <div className={cn('flex h-full', sidebarView !== 'sessions' && 'hidden')}>
        <Sidebar
          title="Sessions"
          actions={
            <>
              <SidebarAction label="New session (Ctrl+N)" onClick={openLauncher} data-new-session>
                <PlusIcon width={13} height={13} />
              </SidebarAction>
              <SidebarAction
                label="Rescan all folders"
                onClick={launcher.rescan}
                disabled={launcher.scanning}
              >
                <RefreshIcon
                  width={13}
                  height={13}
                  className={cn(launcher.scanning && 'animate-spin')}
                />
              </SidebarAction>
              <SidebarAction
                label="Create a new harness"
                onClick={() => setup.openDialog('new')}
                data-create-harness
              >
                <HarnessIcon width={13} height={13} />
              </SidebarAction>
              <SidebarAction label="Add a folder to scan" onClick={launcher.addRoot} data-add-root>
                <FolderPlusIcon width={13} height={13} />
              </SidebarAction>
            </>
          }
          footer={
            <button
              type="button"
              data-open-sessions
              onClick={openSessions}
              title="Every Claude Code session running on this machine"
              aria-current={inFront('sessions') ? 'true' : undefined}
              className={cn(
                'flex h-7 w-full items-center gap-2 rounded-raised px-2 text-left text-[11.5px] transition-colors',
                inFront('sessions')
                  ? 'bg-hover text-fg hover:bg-active'
                  : 'text-fg-subtle hover:bg-hover hover:text-fg'
              )}
            >
              <TerminalIcon width={12} height={12} className="shrink-0" />
              <span className="min-w-0 truncate">{sessionsSummaryLine}</span>
            </button>
          }
        >
          <SessionTree
            discovery={discovery}
            scanning={launcher.scanning}
            scanError={launcher.scanError}
            selectedPath={front?.kind === 'project' ? front.path : null}
            pinnedPaths={settings?.pinnedProjects ?? DEFAULT_SETTINGS.pinnedProjects}
            onTogglePin={togglePin}
            sessionsByPath={tree.byPath}
            elsewhere={tree.elsewhere}
            onSelect={openProject}
            onLaunch={(project) => void launch(project)}
            launchingPath={launchingPath}
            onOpenSession={openTreeSession}
            onAddRoot={launcher.addRoot}
          />
        </Sidebar>
      </div>
      {/* The tree stays mounted while it is out of sight, so what is folded and
          what the filter holds survive a look at the profiles. The profile list
          is mounted only while it is the view: its rows are titled buttons
          inside the sidebar, and kept hidden in the DOM they would be counted
          by every `aside button[title]` that means "a project row". */}
      {sidebarView === 'files' && (
        <Sidebar
          title="Files"
          scope={<FilesRootPicker roots={files.roots} value={files.root} onChange={files.setRoot} />}
          actions={
            files.root === null ? undefined : (
              <>
                <SidebarAction
                  label="Reveal project in Explorer"
                  onClick={() => {
                    if (files.root !== null) launcher.reveal(files.root)
                  }}
                >
                  <FolderIcon width={13} height={13} />
                </SidebarAction>
                {files.editor !== null && (
                  <SidebarAction
                    label="Open project in VS Code"
                    onClick={() => {
                      if (files.root !== null) openInEditor(files.root, null)
                    }}
                  >
                    <CodeIcon width={13} height={13} />
                  </SidebarAction>
                )}
              </>
            )
          }
          footer={
            files.status !== null && (files.status.repo === null || files.status.files === null) ? (
              <FilesStatusNote status={files.status} />
            ) : undefined
          }
        >
          {files.root === null ? (
            <p className="px-3.5 py-6 text-[12px] text-fg-subtle">Choose a project above to see its files.</p>
          ) : (
            <FilesTree
              rootLabel={folderName(files.root)}
              dirs={files.dirs}
              expanded={files.expanded}
              loading={files.loadingDirs}
              status={files.status}
              selectedPath={front?.kind === 'file' ? front.path : null}
              onToggleDir={files.toggleDir}
              onOpen={(path, keep) => {
                if (files.root !== null) openFileAt(files.root, path, keep)
              }}
              onReveal={launcher.reveal}
              onCopyPath={copyPath}
              onOpenInEditor={files.editor === null ? null : (path) => openInEditor(path, null)}
              onGoToFile={openQuickOpen}
            />
          )}
        </Sidebar>
      )}
      {sidebarView === 'profiles' && (
        <Sidebar
          title="Profiles"
          actions={
            <>
              <SidebarAction
                label="Import a profile"
                onClick={() => void profileState.importProfile()}
              >
                <ImportIcon width={13} height={13} />
              </SidebarAction>
              <SidebarAction
                label="New profile"
                onClick={() => {
                  setSaveProblems([])
                  setEditing(blankProfile(discovery?.roots[0] ?? '', ''))
                }}
              >
                <PlusIcon width={13} height={13} />
              </SidebarAction>
            </>
          }
        >
          <ProfileList
            profiles={profileState.profiles}
            harnesses={discovery?.harnesses ?? []}
            launchingIds={profileState.launching}
            onLaunch={(profile) => void launchProfile(profile)}
            onEdit={(profile) => {
              setSaveProblems([])
              setEditing(profile)
            }}
            onDelete={deleteProfile}
            onExport={(profile) => void profileState.exportProfile(profile.id)}
            onTogglePin={(profile) => void profileState.togglePin(profile)}
            onReorder={(ids) => void profileState.reorder(ids)}
          />
        </Sidebar>
      )}
    </>
  )

  const empty = open.groups.length === 1 && open.groups[0]!.tabs.length === 0

  /**
   * One line over the panes, for what a launch composed and anything that went
   * wrong doing it, first failure first. A launcher error is said in the
   * launcher while it is open; this is for a launch with nowhere else to say it
   * - a new harness's first session, a profile from the sidebar.
   */
  const toast: { text: string; failed: boolean; dismiss: () => void } | null =
    browsers.error !== null
      ? { text: browsers.error, failed: true, dismiss: browsers.dismissError }
      : !newSession.open && newSession.error !== null
        ? { text: newSession.error, failed: true, dismiss: newSession.dismissError }
        : restoreState.report !== null
          ? { ...restoreState.report, dismiss: restoreState.dismissReport }
          : profileState.error !== null
          ? { text: profileState.error, failed: true, dismiss: profileState.dismissError }
          : newSession.warning !== null
            ? { text: newSession.warning, failed: false, dismiss: newSession.dismissWarning }
            : profileState.notice !== null
              ? { text: profileState.notice, failed: false, dismiss: profileState.dismissNotice }
              : null

  return (
    <AppShell
      rail={rail}
      sidebar={sidebar}
      banner={
        versionWarning && setup.status ? (
          <VersionBanner
            version={setup.status.version}
            range={setup.status.testedRange}
            error={setup.status.error}
            onDismiss={setup.dismissBanner}
            onLocate={setup.locateClaude}
          />
        ) : null
      }
      statusBar={
        <StatusBar
          sessions={statusCounts}
          onShowWaiting={showWaiting}
          mode={info === null ? null : MODE_LABEL[info.mode]}
          version={info?.version ?? '…'}
          // From the setup status, not from `app:info`, which is read once at
          // startup: after the CLI is relocated the strip would go on saying it
          // is missing while the banner above it says it was found.
          claudeMissing={setup.status !== null && setup.status.path === null}
          usage={usage}
          usageDisplay={settings?.usageDisplay ?? 'percent'}
          onUsageDisplayChange={launcher.setUsageDisplay}
          update={update}
          onOpenUpdate={(url) => void helmOpenExternal(url)}
        />
      }
    >
      <div ref={splitRowRef} className="split-row relative flex h-full w-full">
        {empty ? (
          <div className="split-whole">
            <WelcomePane
              roots={settings?.scanRoots ?? []}
              projectCount={discovery?.projects.length ?? 0}
              onAddRoot={launcher.addRoot}
              onCreateHarness={() => setup.openDialog('new')}
              onNewSession={openLauncher}
            />
          </div>
        ) : (
          shownGroups.map((index, at) => (
            <Fragment key={index}>
              {at === 1 && (
                // The divider is the gutter between the panes: a 3px grip that
                // goes accent on hover, with an 8px target whatever the gap is.
                <div
                  role="separator"
                  aria-orientation="vertical"
                  title="Drag to resize"
                  onMouseDown={startSplitDrag}
                  className={cn(
                    'group relative flex w-gutter shrink-0 cursor-col-resize items-center justify-center',
                    "before:absolute before:inset-y-0 before:left-1/2 before:w-2 before:-translate-x-1/2 before:content-['']"
                  )}
                >
                  <span className="h-10 w-[min(3px,var(--helm-gap))] rounded-full bg-border-strong transition-colors group-hover:bg-accent" />
                </div>
              )}
              {renderGroup(
                index,
                shownGroups.length === 1 ? 'whole' : at === 0 ? 'start' : 'end'
              )}
            </Fragment>
          ))
        )}

        {harnessDialog}
        {templateDialogs}
        {confirmDialog}
        {configEntryDialog}
        {quickOpenRoot !== null && (
          <QuickOpenDialog
            rootLabel={
              files.roots.find((scope) => scope.path.toLowerCase() === quickOpenRoot.toLowerCase())?.label ??
              folderName(quickOpenRoot)
            }
            listing={files.listing}
            recent={files.recentIn(quickOpenRoot)}
            onOpen={(relPath) => {
              setQuickOpenRoot(null)
              openFileAt(quickOpenRoot, joinRoot(quickOpenRoot, relPath), true)
            }}
            onDismiss={() => setQuickOpenRoot(null)}
          />
        )}
        {newSession.open && (
          <NewSessionDialog
            projects={discovery?.projects ?? EMPTY_PROJECTS}
            recency={newSession.recency}
            live={machineSessions.sessions}
            profiles={profileState.profiles}
            home={info?.home ?? null}
            initialPath={newSession.initialPath}
            resumable={newSession.resumable}
            onShowing={newSession.loadResumable}
            busy={newSession.busy}
            error={newSession.error}
            now={now}
            onStart={(choice) => void startChosen(choice)}
            onDismiss={newSession.hide}
          />
        )}

        {/* What a launch composed, and anything that went wrong doing it. Over
            the panes rather than in one, because a profile is launched from the
            sidebar and whatever is on screen at the time is unrelated - and at
            the top, because a hosted TUI's composer lives along the bottom.

            A browser refusal that produced no tab shares it: there is no pane
            to say it in. Anything that *did* produce a tab says so on that
            tab's own problem line instead. */}
        {toast !== null && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex justify-center p-3">
            {/* Two elements for one island, and the outer one is the fix:
                `bg-danger/10` is a *tint*, and a tint over a transparent
                container is a tint over whatever is behind it - the tab strip,
                here. An opaque ground with the tint composited onto it. */}
            <div className="pointer-events-auto max-w-2xl overflow-hidden rounded-raised bg-surface shadow-panel">
              <div
                role="status"
                className={cn(
                  'flex items-start gap-3 rounded-raised border px-3 py-2 text-[12px]',
                  toast.failed
                    ? 'border-danger/30 bg-danger/10 text-danger'
                    : 'border-border text-fg-muted'
                )}
              >
                <span className="min-w-0">{toast.text}</span>
                <button
                  type="button"
                  onClick={toast.dismiss}
                  aria-label="Dismiss"
                  className="shrink-0 text-fg-subtle hover:text-fg"
                >
                  ×
                </button>
              </div>
            </div>
          </div>
        )}

        {editing !== null && (
          <ProfileEditor
            initial={editing}
            projects={discovery?.projects ?? []}
            predict={predictProfile}
            problems={saveProblems}
            saving={saving}
            onSave={(draft) => void saveProfile(draft)}
            onCancel={() => setEditing(null)}
            // Only for a profile that exists. The editor closes because the row
            // it edits is gone.
            {...('id' in editing
              ? {
                  onDelete: () => {
                    deleteProfile(editing)
                    setEditing(null)
                  }
                }
              : {})}
          />
        )}
      </div>
    </AppShell>
  )
}
