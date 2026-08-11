import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_SETTINGS,
  type HistorySession,
  type Profile,
  type ProfileDraft,
  type Project,
  type SessionRecord,
  type WorkspaceTab
} from '@helm/core/types'
import {
  AppShell,
  BookIcon,
  cn,
  ConfigConsole,
  ConfigEditor,
  ConfigNothingSelected,
  ConfirmSessionDialog,
  ContentDocumentPane,
  ContentNothingSelected,
  ContentViewer,
  EffectiveViewPane,
  FolderIcon,
  GearIcon,
  HarnessIcon,
  HealthPanel,
  HistoryIcon,
  McpPanel,
  NewHarnessDialog,
  ProfileEditor,
  ProfileList,
  ProjectPane,
  PullRequestIcon,
  PullsPane,
  pullsSummaryLine,
  RepoIcon,
  SessionHistory,
  SettingsPane,
  SetupPane,
  Sidebar,
  SlidersIcon,
  StatusBar,
  TabBar,
  ThemeToggle,
  TitleBar,
  VersionBanner,
  WelcomePane,
  type Tab,
  type TabIndicator
} from '@helm/ui'
import type { SessionConfirmRequest } from '../../../shared/ipc'
import { helm } from './bridge'
import { ProjectShellPane } from './ProjectShellPane'
import { PullRequestTab } from './PullRequestTab'
import { disposeShell } from './pterms'
import { estimateGrid } from './terminals'
import { TerminalPane } from './TerminalPane'
import { terminalFontStack } from '../terminal'
import { useConfig } from './useConfig'
import { useContent } from './useContent'
import { useHistory } from './useHistory'
import { useLauncher } from './useLauncher'
import { useProfiles } from './useProfiles'
import { forgetPullDetail } from './usePullDetail'
import { usePulls } from './usePulls'
import { useSessions } from './useSessions'
import { useSetup } from './useSetup'
import { useShells } from './useShells'
import { useUsage } from './useUsage'

const KIND_ICON = {
  harness: HarnessIcon,
  repo: RepoIcon,
  folder: FolderIcon
} as const

/**
 * Two surfaces, two strips (DESIGN.md, mockup direction 2a).
 *
 * The workspace holds panes that are views of data - projects, history,
 * config, content - and can be thrown away and rebuilt at will; every piece
 * of state they carry lives in a hook rather than in the component. Sessions
 * are different in kind: each has a process behind it, so they dock as a
 * resizable split on the right with their own tab row, are closed by asking
 * the main process, and their panes stay mounted even while another session
 * is in front - unmounting one would drop the scrollback of a live session.
 * The split is what lets a session keep running in view while the workspace
 * is browsed.
 *
 * `WorkspaceTab` is `@helm/core`'s, because the strip is persisted across
 * launches (`AppSettings.workspaceTabs`) and a pane shape that drifted from
 * the shape it is stored in would restore a strip nobody arranged. A `pr` pane
 * is identified by the project it was opened from and not by the repository
 * slug: two checkouts of one repository are two projects, and closing one must
 * not close the other's tabs.
 */
type PaneRef = WorkspaceTab

/**
 * A link in a rendered note, handed to the OS browser.
 *
 * Not a hook, because it holds nothing: `will-navigate` is prevented and the
 * window-open handler denies, so the only thing an `https://` link in a
 * document can do is ask main to open it somewhere else.
 */
const helmOpenExternal = (url: string): Promise<{ opened: boolean }> =>
  helm.invoke('shell:openExternal', { url })

const HISTORY_TAB = 'history'
const PULLS_TAB = 'pulls'
const CONFIG_TAB = 'config'
const CONTENT_TAB = 'content'
const SETTINGS_TAB = 'settings'

const tabId = (ref: PaneRef): string => {
  if (ref.kind === 'project') return `project:${ref.path}`
  if (ref.kind === 'pulls') return PULLS_TAB
  // Compared, never taken apart again: a Windows path can contain a `#` and a
  // `:`, so this string is an identity and not a record. Whatever needs the
  // path or the number reads them off the `PaneRef`.
  if (ref.kind === 'pr') return `pr:${ref.repoPath}#${String(ref.number)}`
  if (ref.kind === 'config') return CONFIG_TAB
  if (ref.kind === 'content') return CONTENT_TAB
  if (ref.kind === 'settings') return SETTINGS_TAB
  return HISTORY_TAB
}

/**
 * A tab label, cut to what a 240px folder tab can hold.
 *
 * Cut here rather than left to `text-overflow`, because the label is a number
 * and a title glued together and the number is the half that identifies it: CSS
 * would ellipsise the whole string and a long title would be indistinguishable
 * from the next long title.
 */
const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`

/** A stable identity for "no strip at all", so the fallback in `placedOrder`
 * does not hand `openPanes` a fresh array to memoise against on every render. */
const EMPTY_STRIP: PaneRef[] = []

/** The session strip's tab ids - `session:12` - kept in the exact shape the
 * single-strip era used, because `m2-check` locates tabs by them. */
const sessionTabId = (id: number): string => `session:${String(id)}`
const sessionIdFromTab = (tab: string): number => Number(tab.slice('session:'.length))

export function App(): JSX.Element {
  const launcher = useLauncher()
  const { discovery, settings, info } = launcher

  /**
   * Placement of the workspace strip, or null while it is still the saved one.
   *
   * Null and not `[]` because the two are different states: nothing has been
   * arranged this run, versus every tab has been closed. Only the first of them
   * should fall back to what the last launch left behind, and an empty strip a
   * user made has to survive being looked at.
   *
   * Restoring is therefore a *derivation* (`placedOrder`) rather than an effect
   * that copies the setting into state once it lands. The settings arrive over
   * IPC a moment after the first paint, so a sync would render the empty strip
   * first and the real one after - and `settings:changed` fires on every write,
   * including this strip's own, so a one-shot latch would be load-bearing.
   * Derived, none of that arises. It is the same rule `openPanes` follows
   * below, and for the same reason.
   */
  const [order, setOrder] = useState<PaneRef[] | null>(null)
  /** What the user last asked for. The tab that is actually active is derived
   * from it, because the requested one can stop existing. */
  const [requestedId, setRequestedId] = useState<string | null>(null)
  /** Placement of the session strip; membership is derived from `sessions`. */
  const [sessionOrder, setSessionOrder] = useState<number[]>([])
  const [requestedSession, setRequestedSession] = useState<number | null>(null)
  /** null = split; one side can take the whole row. */
  const [maximize, setMaximize] = useState<'workspace' | 'sessions' | null>(null)
  /** Fraction of the row the session pane takes, drag-bounded 0.2-0.8. */
  const [split, setSplit] = useState(0.45)
  const splitRowRef = useRef<HTMLDivElement>(null)
  const draggingSplit = useRef(false)
  const [launching, setLaunching] = useState(false)
  /** The pane box, measured to open a pty at roughly the right grid. */
  const paneRef = useRef<HTMLDivElement>(null)

  const activateSession = useCallback((id: number) => {
    setRequestedSession(id)
    // A notification click must actually reveal the session, so a maximized
    // workspace gives the split back.
    setMaximize((current) => (current === 'workspace' ? null : current))
  }, [])

  const sessionState = useSessions(activateSession)
  const { sessions } = sessionState
  const profileState = useProfiles()
  const historyState = useHistory()
  const pullsState = usePulls()
  const configState = useConfig()
  const contentState = useContent()
  const usage = useUsage()
  const setup = useSetup(settings, launcher.rescan)
  const shells = useShells()

  /**
   * The six terminal settings, and one writer for them.
   *
   * Written through `settings:write` like everything else, which is also what
   * pushes them to the terminals: the main process answers with the whole
   * settings object, `useLauncher` adopts it, and the registries that own the
   * live terminals are told from there (termprefs.ts). Nothing here reaches a
   * terminal directly.
   */
  const terminalSettings = useMemo(
    () => ({
      terminalFontFamily: settings?.terminalFontFamily ?? null,
      terminalFontSize: settings?.terminalFontSize ?? DEFAULT_SETTINGS.terminalFontSize,
      terminalCursorStyle: settings?.terminalCursorStyle ?? DEFAULT_SETTINGS.terminalCursorStyle,
      terminalCursorBlink: settings?.terminalCursorBlink ?? DEFAULT_SETTINGS.terminalCursorBlink,
      terminalScrollback: settings?.terminalScrollback ?? DEFAULT_SETTINGS.terminalScrollback,
      terminalShell: settings?.terminalShell ?? null
    }),
    [settings]
  )

  const { writeSettings } = launcher
  const locateShell = useCallback(() => {
    void helm.invoke('path:chooseFile', { title: 'Choose a shell' }).then(({ path }) => {
      if (path !== null) writeSettings({ terminalShell: path })
    })
  }, [writeSettings])

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

  /** The profile being edited, `'new'` for one being created from scratch, or
   * a seeded draft from "save as profile". Null when the dialog is closed. */
  const [editing, setEditing] = useState<Profile | ProfileDraft | null>(null)
  const [saveProblems, setSaveProblems] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const projectsByPath = useMemo(() => {
    const map = new Map<string, Project>()
    for (const project of discovery?.projects ?? []) map.set(project.path, project)
    return map
  }, [discovery])

  const sessionsById = useMemo(() => {
    const map = new Map<number, SessionRecord>()
    for (const session of sessions) map.set(session.id, session)
    return map
  }, [sessions])

  /**
   * Both strips, derived rather than synced in an effect.
   *
   * A rescan that no longer sees a project should close its tab, and every
   * session main is hosting should have one - including sessions this renderer
   * did not launch, which is the case after a reload (dev HMR, or a crashed
   * render process) where the processes outlive the strip that was showing
   * them. Writing either as `useEffect` + `setState` renders once with the
   * wrong tabs and then again with the right ones, for a value that is a pure
   * function of what we already have.
   *
   * The order arrays therefore hold placement, not membership: a session that
   * has never been moved or closed is simply appended.
   */
  /**
   * The strip as arranged: this run's placement, or the saved one until
   * something has been opened, closed or moved.
   *
   * Unfiltered on purpose - a project the scan has not reached yet is dropped
   * by `openPanes` below and stays here, so a slow discovery hides a restored
   * tab for a moment rather than losing it.
   */
  const savedStrip = settings?.workspaceTabs ?? null
  const placedOrder = order ?? savedStrip?.panes ?? EMPTY_STRIP
  const settingsLoaded = settings !== null

  const openPanes = useMemo(() => {
    return placedOrder.filter((ref) => {
      if (ref.kind === 'project') return !discovery || projectsByPath.has(ref.path)
      // A pull request tab follows its project, by the same rule: the project
      // is where it was opened from and where a review would run, so a rescan
      // that no longer sees the directory closes the tab with it.
      if (ref.kind === 'pr') return !discovery || projectsByPath.has(ref.repoPath)
      return true
    })
  }, [placedOrder, discovery, projectsByPath])

  const sessionIds = useMemo(() => {
    const placed = sessionOrder.filter((id) => sessionsById.has(id))
    const known = new Set(placed)
    const appended = sessions.filter((s) => !known.has(s.id)).map((s) => s.id)
    return [...placed, ...appended]
  }, [sessionOrder, sessions, sessionsById])

  // The saved active tab stands in until something is asked for, by the same
  // rule `placedOrder` follows. It is only ever compared against the ids on the
  // strip, so an id whose pane is gone falls through to the last tab exactly as
  // a stale `requestedId` does.
  const requested = requestedId ?? savedStrip?.activeId ?? null
  const activeId =
    requested !== null && openPanes.some((ref) => tabId(ref) === requested)
      ? requested
      : (openPanes.map(tabId).at(-1) ?? null)
  const activePane = openPanes.find((ref) => tabId(ref) === activeId) ?? null

  const activeSessionId =
    requestedSession !== null && sessionIds.includes(requestedSession)
      ? requestedSession
      : (sessionIds.at(-1) ?? null)

  /**
   * The saved strip, written back whenever the arrangement changes.
   *
   * Debounced because a drag moves a tab at a time and every write is a
   * settings round trip that comes back as a `settings:changed` broadcast.
   * `activeId` travels with it, so which tab was in front is restored with the
   * arrangement rather than falling to the last one.
   *
   * Gated on a boolean rather than on `settings` itself, and that is the whole
   * reason `settingsLoaded` exists: `settings` is a new object after every
   * write, so depending on it here would make this effect re-arm its own timer
   * and write forever at 500ms.
   *
   * What is saved is `openPanes` - the strip on screen - even though `order`
   * is what a restore is folded into. A tab whose project the scan no longer
   * finds is gone from the strip the user is looking at, and writing it down
   * again would resurrect it on the next launch.
   */
  useEffect(() => {
    if (!settingsLoaded) return
    const timer = setTimeout(() => {
      writeSettings({ workspaceTabs: { panes: openPanes, activeId } })
    }, 500)
    return () => clearTimeout(timer)
  }, [settingsLoaded, openPanes, activeId, writeSettings])

  const hasSessions = sessionIds.length > 0
  // Derived rather than reset in an effect: with no sessions there is no
  // split, so a held maximize simply stops meaning anything until the next
  // launch gives it a pane to apply to.
  const effectiveMaximize = hasSessions ? maximize : null
  const showSessions = hasSessions && effectiveMaximize !== 'workspace'
  const showWorkspace = !showSessions || effectiveMaximize !== 'sessions'

  // Main decides whether an exiting session is worth a notification, and that
  // turns on which session is actually in view - which only this side knows.
  const { reportFocus } = sessionState
  useEffect(() => {
    reportFocus(showSessions ? activeSessionId : null)
  }, [showSessions, activeSessionId, reportFocus])

  // The split divider: a plain mouse drag, bounded so neither side can be
  // dragged out of usefulness.
  useEffect(() => {
    const onMove = (event: MouseEvent): void => {
      if (!draggingSplit.current || !splitRowRef.current) return
      const box = splitRowRef.current.getBoundingClientRect()
      if (box.width < 1) return
      const fraction = 1 - (event.clientX - box.left) / box.width
      setSplit(Math.min(0.8, Math.max(0.2, fraction)))
    }
    const onUp = (): void => {
      draggingSplit.current = false
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // `placedOrder` and not the raw `order`, so the first tab opened in a window
  // whose strip came from the last launch is appended to that strip rather than
  // replacing it.
  const openPane = useCallback(
    (ref: PaneRef) => {
      setOrder((current) => {
        const strip = current ?? placedOrder
        return strip.some((r) => tabId(r) === tabId(ref)) ? strip : [...strip, ref]
      })
      setRequestedId(tabId(ref))
    },
    [placedOrder]
  )

  const openProject = useCallback(
    (project: Project | null) => {
      if (!project) return
      openPane({ kind: 'project', path: project.path })
    },
    [openPane]
  )

  const openHistory = useCallback(() => openPane({ kind: 'history' }), [openPane])
  const openPulls = useCallback(() => openPane({ kind: 'pulls' }), [openPane])

  /**
   * A row in the Pulls pane opens the pull request in a tab of its own.
   *
   * `openPane` already focuses a tab that is open rather than opening a second
   * one, so clicking the same row twice is a way back to it.
   */
  const openPull = useCallback(
    (repo: { path: string }, pull: { number: number }) =>
      openPane({ kind: 'pr', repoPath: repo.path, number: pull.number }),
    [openPane]
  )

  /**
   * Config and Content open on the scope they already had. They used to be
   * per-harness links that carried a scope in, which meant the only way to
   * reach either pane was through a harness that happened to be expanded.
   * Both panes own a scope switcher, so the entry point does not need to.
   */
  const openConfig = useCallback(() => openPane({ kind: 'config' }), [openPane])
  const openContent = useCallback(() => openPane({ kind: 'content' }), [openPane])

  /**
   * Settings is a workspace pane like any other rather than a modal: it is a
   * place, it is worth leaving open beside a session, and a dialog over the
   * window would be one more thing to dismiss before looking at what a setting
   * changed. Its entry point is in the title bar because what it configures is
   * the app, not whatever project happens to be selected.
   */
  const openSettings = useCallback(() => openPane({ kind: 'settings' }), [openPane])

  /** A launched session lands in the session strip and takes the front. */
  const adoptIntoStrip = useCallback((id: number) => {
    setSessionOrder((current) => (current.includes(id) ? current : [...current, id]))
    setRequestedSession(id)
    setMaximize((current) => (current === 'workspace' ? null : current))
  }, [])

  const launch = useCallback(
    async (project: Project) => {
      setLaunching(true)
      try {
        const id = await sessionState.launch(project, paneRef.current)
        if (id === null) return
        adoptIntoStrip(id)
      } finally {
        setLaunching(false)
      }
    },
    [sessionState, adoptIntoStrip]
  )

  /**
   * A profile launch lands in the strip exactly the way a project launch does
   * - it does not care which produced the session, only that one exists.
   */
  const launchProfile = useCallback(
    async (profile: Profile) => {
      const session = await profileState.launch(profile, paneRef.current)
      if (!session) return
      sessionState.adopt(session)
      adoptIntoStrip(session.id)
    },
    [profileState, sessionState, adoptIntoStrip]
  )

  /**
   * A resumed conversation is a session like any other once it exists - the
   * only difference is upstream, where main decided whether it could be
   * reopened at all and built `--resume` argv for it.
   */
  const resumeSession = useCallback(
    async (session: HistorySession) => {
      const record = await historyState.resume(session, paneRef.current)
      if (!record) return
      sessionState.adopt(record)
      adoptIntoStrip(record.id)
    },
    [historyState, sessionState, adoptIntoStrip]
  )

  /**
   * "Review with Claude", from a pull request tab.
   *
   * Lands in the strip exactly as a resume does, and for the same reason: what
   * comes back is a session like any other, and nothing downstream of this line
   * cares that a pull request is what started it.
   *
   * Note what is *not* here. The prompt is composed in the main process from
   * the cached pull request and the stored template, so this sends a repository
   * path, a number and the grid - the same three-field shape a profile launch
   * has (`LaunchProfileRequest`), and for the same reason: argv assembled in a
   * window is argv that can drift from what was saved. The rejection is
   * re-thrown rather than swallowed because the pull request's own pane is
   * where a dirty tree or a missing `gh` has to be read.
   */
  const reviewPull = useCallback(
    async (repoPath: string, number: number) => {
      const { cols, rows } = estimateGrid(paneRef.current)
      const launched = await helm.invoke('pr:review', { repoPath, number, cols, rows })
      sessionState.adopt(launched.session)
      adoptIntoStrip(launched.session.id)
      return launched
    },
    [sessionState, adoptIntoStrip]
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

  const saveProfile = useCallback(
    async (draft: ProfileDraft) => {
      setSaving(true)
      try {
        const id = editing !== null && 'id' in editing ? editing.id : null
        const { ok, problems } = await profileState.save(draft, id)
        setSaveProblems(problems)
        if (ok) setEditing(null)
      } finally {
        setSaving(false)
      }
    },
    [editing, profileState]
  )

  // Main asks the user first, so this can be fired and forgotten: the list
  // refreshes from `profiles:changed` if the answer was yes and does not if it
  // was no.
  const deleteProfile = useCallback(
    (profile: Profile) => void profileState.remove(profile.id),
    [profileState]
  )

  const closeTab = useCallback(
    (id: string) => {
      const ref = openPanes.find((candidate) => tabId(candidate) === id)
      if (!ref) return
      // The shell dies with its tab, not with a render: hiding the pane keeps
      // it, closing the project ends it.
      if (ref.kind === 'project') void disposeShell(ref.path)
      // Same idea, one layer down: what the pane last painted outlives an
      // unmount so a tab switch does not flash, and a *closed* tab is the point
      // at which nobody is coming back to it.
      if (ref.kind === 'pr') forgetPullDetail(ref.repoPath, ref.number)
      setOrder(openPanes.filter((candidate) => tabId(candidate) !== id))
    },
    [openPanes]
  )

  const closeSession = useCallback(
    (id: number) => {
      // The process gets a say: main confirms before ending a live session, and
      // the tab stays if the answer is no. A closed session drops out of
      // `sessions`, so the strip loses it whether or not it was ever placed.
      void sessionState.close(id).then((closed) => {
        if (closed) setSessionOrder((current) => current.filter((held) => held !== id))
      })
    },
    [sessionState]
  )

  // Written back as the whole strip, so a tab that had only been appended is
  // placed by the same gesture that moved it.
  const reorderTabs = useCallback(
    (id: string, toIndex: number) => {
      const from = openPanes.findIndex((ref) => tabId(ref) === id)
      if (from < 0 || from === toIndex) return
      const next = [...openPanes]
      const [moved] = next.splice(from, 1)
      if (!moved) return
      next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, moved)
      setOrder(next)
    },
    [openPanes]
  )

  const reorderSessions = useCallback(
    (id: string, toIndex: number) => {
      const sessionId = sessionIdFromTab(id)
      const from = sessionIds.indexOf(sessionId)
      if (from < 0 || from === toIndex) return
      const next = [...sessionIds]
      next.splice(from, 1)
      next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, sessionId)
      setSessionOrder(next)
    },
    [sessionIds]
  )

  // Ctrl+Tab cycles both strips as one ring, in capture so it never reaches
  // the focused terminal. Ctrl+Shift+Tab is not bound by Claude Code either;
  // Shift+Tab alone is (it cycles permission modes) and is deliberately left
  // alone.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !event.ctrlKey || event.altKey) return
      const workspaceIds = openPanes.map(tabId)
      const ring = [...workspaceIds, ...sessionIds.map(sessionTabId)]
      if (ring.length < 2) return
      event.preventDefault()
      event.stopPropagation()
      const current =
        showSessions && activeSessionId !== null && document.activeElement?.closest('.xterm')
          ? sessionTabId(activeSessionId)
          : (activeId ?? '')
      const at = ring.indexOf(current)
      const step = event.shiftKey ? -1 : 1
      const next = ring[(at + step + ring.length) % ring.length]
      if (next === undefined) return
      if (next.startsWith('session:')) setRequestedSession(sessionIdFromTab(next))
      else setRequestedId(next)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [openPanes, sessionIds, activeId, activeSessionId, showSessions])

  const tabs: Tab[] = openPanes.flatMap((ref): Tab[] => {
    if (ref.kind === 'history') {
      return [
        {
          id: HISTORY_TAB,
          title: 'Session history',
          hint: historyState.summary?.historyFile ?? 'Every session on this machine',
          icon: <HistoryIcon width={13} height={13} />
        }
      ]
    }

    if (ref.kind === 'pulls') {
      return [
        {
          id: PULLS_TAB,
          title: 'Pull requests',
          hint: pullsSummaryLine(pullsState.snapshot),
          icon: <PullRequestIcon width={13} height={13} />
        }
      ]
    }

    if (ref.kind === 'pr') {
      // The title comes from the list snapshot, which is the same row the tab
      // was opened from. A pull request that has closed since drops out of the
      // snapshot and the tab keeps its number - which is the honest label for a
      // tab whose pane is about to say the same thing.
      const repo = pullsState.snapshot?.repos.find(
        (candidate) => candidate.path.toLowerCase() === ref.repoPath.toLowerCase()
      )
      const pull = repo?.pulls.find((candidate) => candidate.number === ref.number)
      const label = `#${String(ref.number)}`
      return [
        {
          id: tabId(ref),
          title: pull ? `${label} ${truncate(pull.title, 34)}` : label,
          hint: pull ? `${pull.title} - ${ref.repoPath}` : ref.repoPath,
          ...(repo ? { subtitle: repo.name } : {}),
          icon: <PullRequestIcon width={13} height={13} />
        }
      ]
    }

    if (ref.kind === 'config') {
      return [
        {
          id: CONFIG_TAB,
          title: 'Config',
          hint: configState.scope?.path ?? 'Browse and edit .claude configuration',
          ...(configState.scope ? { subtitle: configState.scope.label } : {}),
          icon: <SlidersIcon width={13} height={13} />
        }
      ]
    }

    if (ref.kind === 'content') {
      return [
        {
          id: CONTENT_TAB,
          title: 'Content',
          hint: contentState.selected?.path ?? 'Notes, docs, skills and artifacts',
          ...(contentState.scope ? { subtitle: contentState.scope.label } : {}),
          icon: <BookIcon width={13} height={13} />
        }
      ]
    }

    if (ref.kind === 'settings') {
      return [
        {
          id: SETTINGS_TAB,
          title: 'Settings',
          hint: "Helm's own settings",
          icon: <GearIcon width={13} height={13} />
        }
      ]
    }

    const project = projectsByPath.get(ref.path)
    if (!project) return []
    const Icon = KIND_ICON[project.kind]
    return [
      {
        id: tabId(ref),
        title: project.name,
        hint: project.path,
        icon: <Icon width={13} height={13} />
      }
    ]
  })

  const sessionTabs: Tab[] = sessionIds.flatMap((id): Tab[] => {
    const session = sessionsById.get(id)
    if (!session) return []
    const indicator: TabIndicator =
      session.status === 'running' ? 'running' : session.exitCode ? 'failed' : 'ended'
    const project = session.projectPath ? projectsByPath.get(session.projectPath) : undefined
    return [
      {
        id: sessionTabId(id),
        title: session.name,
        hint: `${session.name} · ${session.cwd}`,
        ...(project && project.name !== session.name ? { subtitle: project.name } : {}),
        indicator,
        // A session tab lifts into the terminal's fixed ground, not the
        // island's - see Tab.ground.
        ground: 'terminal' as const
      }
    ]
  })

  const activeProject =
    activePane?.kind === 'project' ? (projectsByPath.get(activePane.path) ?? null) : null
  const selectedPath = activeProject?.path ?? null
  const runningSessions = sessions.filter((session) => session.status === 'running').length
  // Which sidebar rows get a live dot: the projects with a running session.
  const livePaths = useMemo(() => {
    const paths = new Set<string>()
    for (const session of sessions) {
      if (session.status === 'running' && session.projectPath !== null) {
        paths.add(session.projectPath.toLowerCase())
      }
    }
    return paths
  }, [sessions])

  /**
   * "This session is still running", asked by the main process and answered
   * here. Main owns process lifetime, so it owns the question; the renderer
   * owns everything the user looks at, so it draws it.
   *
   * The answer is sent before the state clears, and only when a request is
   * actually pending: main matches replies by id, and a second reply to an id
   * it has already resolved is a reply for a decision that has been taken.
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
   * Rendered by both branches below, for the same reason `harnessDialog` is -
   * and one more: main holds the window's `close` open on this promise, so a
   * branch that did not draw the dialog would be a branch Helm could not quit
   * from until the fallback timer ran out.
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

  /**
   * Rendered by both branches below. Creating a harness is a first-run action
   * and an every-day one, and having two copies of the dialog is how the two
   * would drift apart.
   */
  const harnessDialog =
    setup.dialog === null ? null : (
      <NewHarnessDialog
        mode={setup.dialog}
        dir={setup.dialogDir}
        onChooseDir={setup.chooseDialogDir}
        problems={setup.dialogProblems}
        busy={setup.creating}
        onCreate={setup.createHarness}
        onCancel={setup.closeDialog}
      />
    )

  /**
   * Setup owns the whole window rather than sitting in a tab.
   *
   * There is nothing else to look at: no roots means no tree, no config scopes
   * and no content. A launcher painted empty behind a dismissible dialog would
   * be four broken surfaces framing the one that works.
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
        {confirmDialog}
      </div>
    )
  }

  // A fact about the machine that qualifies the whole window: the CLI is
  // missing, or it is a version outside what this build was measured against.
  // It warns and does not gate - see `VersionBanner`.
  const versionWarning =
    setup.status !== null &&
    !setup.bannerDismissed &&
    (setup.status.path === null || setup.status.version === null || !setup.status.tested)

  return (
    <AppShell
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
      sidebar={
        !showWorkspace ? null : (
        <Sidebar
          livePaths={livePaths}
          profiles={
            <ProfileList
              profiles={profileState.profiles}
              harnesses={discovery?.harnesses ?? []}
              launchingIds={profileState.launching}
              onLaunch={(profile) => void launchProfile(profile)}
              onCreate={() => {
                setSaveProblems([])
                setEditing(blankProfile(discovery?.roots[0] ?? '', ''))
              }}
              onEdit={(profile) => {
                setSaveProblems([])
                setEditing(profile)
              }}
              onDelete={deleteProfile}
              onExport={(profile) => void profileState.exportProfile(profile.id)}
              onImport={() => void profileState.importProfile()}
              onTogglePin={(profile) => void profileState.togglePin(profile)}
              onReorder={(ids) => void profileState.reorder(ids)}
            />
          }
          onOpenHistory={openHistory}
          {...(historyState.summary
            ? {
                historyCount: historyState.summary.sessions,
                historyResumable: historyState.summary.resumable
              }
            : {})}
          historyActive={activePane?.kind === 'history'}
          onOpenPulls={openPulls}
          pullsDetail={pullsSummaryLine(pullsState.snapshot)}
          pullsActive={activePane?.kind === 'pulls'}
          onOpenConfig={openConfig}
          configActive={activePane?.kind === 'config'}
          onOpenContent={openContent}
          contentActive={activePane?.kind === 'content'}
          discovery={discovery}
          scanning={launcher.scanning}
          scanError={launcher.scanError}
          selectedPath={selectedPath}
          onSelect={openProject}
          onRescan={launcher.rescan}
          onAddRoot={launcher.addRoot}
          onCreateHarness={() => setup.openDialog('new')}
        />
        )
      }
      titleActions={
        <>
          <ThemeToggle value={settings?.theme ?? 'system'} onChange={launcher.setTheme} />
          {/* Beside the toggle, because both are window-level: one is a setting
              with a shortcut in the chrome, the other is where every setting
              lives. A ghost button (DESIGN.md) - the segmented control next to
              it already carries an outline, and two bordered controls in a 36px
              strip read as a toolbar. */}
          <button
            type="button"
            data-open-settings
            onClick={openSettings}
            aria-label="Settings"
            title="Settings"
            className={cn(
              'grid size-7 shrink-0 place-items-center rounded-well transition-colors',
              activePane?.kind === 'settings'
                ? 'bg-hover text-fg'
                : 'text-fg-subtle hover:bg-hover hover:text-fg'
            )}
          >
            <GearIcon width={14} height={14} />
          </button>
        </>
      }
      statusBar={
        <StatusBar
          // The mode is shown only when this copy is not an ordinary install.
          // `dev` and `portable` both change what the binary is and where the
          // data lives, so they are worth a word; an installed build is the
          // case that needs none, and labelling it only adds a segment every
          // user reads once.
          build={
            info === null
              ? '…'
              : info.mode === 'installed'
                ? info.version
                : `${info.version} · ${info.mode}`
          }
          // From the setup status, not from `app:info`. `app:info` is read once
          // at startup, so after the CLI is relocated the strip would keep
          // naming the old version while the banner above it names the new one
          // - two numbers on screen at once, both claiming to be `claude`.
          claudeVersion={setup.status?.version ?? info?.claudeVersion ?? null}
          scanning={launcher.scanning}
          runningSessions={runningSessions}
          usage={usage}
          usageDisplay={settings?.usageDisplay ?? 'percent'}
          onUsageDisplayChange={launcher.setUsageDisplay}
          lastScan={
            discovery && discovery.durationMs > 0
              ? {
                  projects: discovery.projects.length,
                  durationMs: discovery.durationMs,
                  at: discovery.scannedAt
                }
              : null
          }
        />
      }
    >
      <div ref={splitRowRef} className="relative flex h-full w-full">
        {showWorkspace && (
          <div
            className="flex min-w-0 flex-col"
            style={{ flex: showSessions ? `${String(1 - split)} 1 0%` : '1 1 0%' }}
          >
            <TabBar
              tabs={tabs}
              activeId={activeId}
              onActivate={setRequestedId}
              onClose={closeTab}
              onReorder={reorderTabs}
              actions={
                hasSessions ? (
                  <PaneMaxButton
                    maximized={effectiveMaximize === 'workspace'}
                    what="workspace"
                    onToggle={() =>
                      setMaximize((current) => (current === 'workspace' ? null : 'workspace'))
                    }
                  />
                ) : undefined
              }
            />
            <div ref={paneRef} className="relative min-h-0 flex-1 overflow-hidden">
        {activePane?.kind === 'history' && (
          <div className="absolute inset-0">
            <SessionHistory
              summary={historyState.summary}
              page={historyState.page}
              loading={historyState.loading}
              error={historyState.error}
              search={historyState.search}
              onSearchChange={historyState.setSearch}
              grouping={historyState.grouping}
              onGroupingChange={historyState.setGrouping}
              resumableOnly={historyState.resumableOnly}
              onResumableOnlyChange={historyState.setResumableOnly}
              project={historyState.project}
              onProjectChange={historyState.setProject}
              selected={historyState.selected}
              onSelect={historyState.select}
              prompts={historyState.prompts}
              promptsLoading={historyState.promptsLoading}
              onRefresh={historyState.refresh}
              refreshing={historyState.refreshing}
              onResume={(session) => void resumeSession(session)}
              resuming={historyState.resuming}
              resumeError={historyState.resumeError}
              onDismissResumeError={historyState.dismissResumeError}
              onReveal={launcher.reveal}
              compact={showSessions}
            />
          </div>
        )}

        {activePane?.kind === 'pulls' && (
          <div className="absolute inset-0">
            <PullsPane
              snapshot={pullsState.snapshot}
              onRefresh={pullsState.refresh}
              refreshing={pullsState.refreshing}
              error={pullsState.error}
              onOpenPull={openPull}
              compact={showSessions}
            />
          </div>
        )}

        {activePane?.kind === 'pr' && (
          <div className="absolute inset-0">
            <PullRequestTab
              // Keyed on the tab, so switching between two pull request tabs
              // rebuilds the pane rather than leaving one PR's view selected
              // over another's conversation.
              key={tabId(activePane)}
              repoPath={activePane.repoPath}
              number={activePane.number}
              reviewTemplate={settings?.prReviewPrompt ?? DEFAULT_SETTINGS.prReviewPrompt}
              checkout={settings?.prCheckout ?? DEFAULT_SETTINGS.prCheckout}
              reviewModel={settings?.prReviewModel ?? DEFAULT_SETTINGS.prReviewModel}
              reviewEffort={settings?.prReviewEffort ?? DEFAULT_SETTINGS.prReviewEffort}
              onReview={reviewPull}
              onOpenExternal={(url) => void helmOpenExternal(url)}
              compact={showSessions}
            />
          </div>
        )}

        {activePane?.kind === 'config' && (
          <div className="absolute inset-0">
            <ConfigConsole
              scopes={configState.scopes}
              scopePath={configState.scopePath}
              onScopeChange={configState.setScopePath}
              view={configState.view}
              onViewChange={configState.setView}
              tree={configState.tree}
              treeLoading={configState.treeLoading}
              selected={configState.selected}
              onSelect={configState.select}
              dirty={configState.dirty}
              onRefresh={configState.refresh}
              refreshing={configState.refreshing}
              compact={showSessions}
              onBack={() => configState.select(null)}
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
                    snapshots={configState.snapshots}
                    saving={configState.saving}
                    error={configState.editorError}
                    external={configState.external}
                    onSave={configState.save}
                    onReload={configState.reload}
                    onRestore={configState.restore}
                    onReveal={launcher.reveal}
                    onDirtyChange={configState.setDirty}
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
          </div>
        )}

        {activePane?.kind === 'content' && (
          <div className="absolute inset-0">
            <ContentViewer
              scopes={contentState.scopes}
              scopePath={contentState.scopePath}
              onScopeChange={contentState.setScopePath}
              tree={contentState.tree}
              treeLoading={contentState.treeLoading}
              query={contentState.query}
              onQueryChange={contentState.setQuery}
              search={contentState.search}
              searching={contentState.searching}
              selected={contentState.selected}
              onSelect={contentState.select}
              dirty={contentState.dirty}
              onRefresh={contentState.refresh}
              refreshing={contentState.refreshing}
              compact={showSessions}
              onBack={() => contentState.select(null)}
            >
              {contentState.selected === null ? (
                <ContentNothingSelected
                  scope={contentState.scope}
                  fileCount={contentState.tree?.files.length ?? 0}
                />
              ) : (
                <ContentDocumentPane
                  // Keyed on the path so opening another note rebuilds the
                  // pane rather than leaving one document's draft in another's
                  // editor - the same rule the config editor follows.
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
                  onSave={contentState.save}
                  onReload={contentState.reload}
                  onRestore={contentState.restore}
                  onReveal={launcher.reveal}
                  onDirtyChange={contentState.setDirty}
                  onDraftChange={contentState.setDraft}
                  onOpenPath={contentState.openPath}
                  onOpenExternal={(url) => void helmOpenExternal(url)}
                />
              )}
            </ContentViewer>
          </div>
        )}

        {activePane?.kind === 'settings' && (
          <div className="absolute inset-0">
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
              theme={settings?.theme ?? 'system'}
              onThemeChange={launcher.setTheme}
              usageDisplay={settings?.usageDisplay ?? 'percent'}
              onUsageDisplayChange={launcher.setUsageDisplay}
              // The same fact the status bar's cycle turns on, from the same
              // snapshot, so the pane cannot offer a mode the segment skips.
              hasCostEstimate={usage?.spend != null}
              terminal={terminalSettings}
              onTerminalChange={launcher.writeSettings}
              // The stack the terminals are actually running, so the preview
              // well cannot show a font the panes are not using.
              terminalFontStack={terminalFontStack(terminalSettings.terminalFontFamily)}
              shells={shells}
              onLocateShell={locateShell}
              // What `gh` actually resolved to, out of the same snapshot the
              // Pulls pane paints - so the pane cannot report one executable
              // while the fetches use another.
              gh={pullsState.snapshot?.gh ?? null}
              onLocateGh={locateGh}
              onClearGhOverride={() => writeSettings({ ghPath: null })}
              prPollMinutes={settings?.prPollMinutes ?? DEFAULT_SETTINGS.prPollMinutes}
              onPrPollMinutesChange={(prPollMinutes) => writeSettings({ prPollMinutes })}
              // The review launch's two settings live here rather than in the
              // Pulls pane's header: settings for Helm are in one place, and a
              // disclosure strip inside a pane is a second place for one to
              // hide. The pane shows the *result* of these - the exact command
              // and prompt - which is disclosure, not configuration.
              prReviewPrompt={settings?.prReviewPrompt ?? DEFAULT_SETTINGS.prReviewPrompt}
              onPrReviewPromptChange={(prReviewPrompt) => writeSettings({ prReviewPrompt })}
              prCheckout={settings?.prCheckout ?? DEFAULT_SETTINGS.prCheckout}
              onPrCheckoutChange={(prCheckout) => writeSettings({ prCheckout })}
              prReviewModel={settings?.prReviewModel ?? DEFAULT_SETTINGS.prReviewModel}
              onPrReviewModelChange={(prReviewModel) => writeSettings({ prReviewModel })}
              prReviewEffort={settings?.prReviewEffort ?? DEFAULT_SETTINGS.prReviewEffort}
              onPrReviewEffortChange={(prReviewEffort) => writeSettings({ prReviewEffort })}
            />
          </div>
        )}

        {activeProject && (
          <div className="absolute inset-0 flex flex-col gap-2">
            <div className="min-h-0 flex-1">
              <ProjectPane
                key={activeProject.path}
                project={activeProject}
                onReveal={launcher.reveal}
                onLaunch={(project) => void launch(project)}
                launching={launching}
                launchError={sessionState.launchError}
                onSaveAsProfile={(project) => {
                  setSaveProblems([])
                  // Seeded with what is on screen: this project as the root, and
                  // itself composed, which is the launch the button is beside.
                  setEditing({
                    ...blankProfile(project.path, project.name),
                    overlays: [project.path],
                    access: [project.path]
                  })
                }}
              />
            </div>
            {/* The project's own shell, in the project's own directory. Hidden
                while the session split is open - the space belongs to the
                session then - but its process and scrollback live in pterms.ts
                and survive the hiding. */}
            {!showSessions && (
              <ProjectShellPane
                path={activeProject.path}
                windowsBuild={info?.windowsBuild ?? null}
                visible
                shells={shells}
              />
            )}
          </div>
        )}

        {activePane === null && (
          <div className="absolute inset-0">
            <WelcomePane
              roots={settings?.scanRoots ?? []}
              projectCount={discovery?.projects.length ?? 0}
              onAddRoot={launcher.addRoot}
              onCreateHarness={() => setup.openDialog('new')}
            />
          </div>
        )}
            </div>
          </div>
        )}

        {showWorkspace && showSessions && (
          <div
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize"
            onMouseDown={(event) => {
              event.preventDefault()
              draggingSplit.current = true
              document.body.style.userSelect = 'none'
            }}
            className="group flex w-2 shrink-0 cursor-col-resize items-center justify-center"
          >
            <span className="h-10 w-[3px] rounded-full bg-border-strong transition-colors group-hover:bg-accent" />
          </div>
        )}

        {showSessions && (
          <div
            className="flex min-w-0 flex-col"
            style={{ flex: showWorkspace ? `${String(split)} 1 0%` : '1 1 0%' }}
          >
            <TabBar
              tabs={sessionTabs}
              activeId={activeSessionId === null ? null : sessionTabId(activeSessionId)}
              onActivate={(id) => setRequestedSession(sessionIdFromTab(id))}
              onClose={(id) => closeSession(sessionIdFromTab(id))}
              onReorder={reorderSessions}
              actions={
                <PaneMaxButton
                  maximized={effectiveMaximize === 'sessions'}
                  what="session"
                  onToggle={() =>
                    setMaximize((current) => (current === 'sessions' ? null : 'sessions'))
                  }
                />
              }
            />
            <div className="relative min-h-0 flex-1 overflow-hidden">
              {/* Every terminal stays mounted and only the active one is shown.
                  Unmounting a pane to switch tabs would take the session's
                  scrollback with it, and re-attaching a live pty to a fresh
                  terminal cannot recover what has already scrolled past. */}
              {sessionIds.map((id) => {
                const session = sessionsById.get(id)
                if (!session) return null
                const visible = id === activeSessionId
                return (
                  <div
                    key={id}
                    className={cn('absolute inset-0', visible ? 'block' : 'hidden')}
                    aria-hidden={!visible}
                  >
                    <TerminalPane
                      session={session}
                      active={visible}
                      windowsBuild={info?.windowsBuild ?? null}
                      onClose={closeSession}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {harnessDialog}
        {confirmDialog}

        {/* What a launch composed, and anything that went wrong doing it.
            Over the pane rather than in it, because a profile is launched from
            the sidebar and whatever is on screen at the time is unrelated.

            At the top, not the bottom: the pane below is usually a hosted TUI
            whose composer and status line live along its bottom edge, and a
            toast there covers the one part of the terminal the user is about to
            type into. */}
        {(profileState.notice !== null || profileState.error !== null) && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex justify-center p-3">
            <div
              role="status"
              className={cn(
                'pointer-events-auto flex max-w-2xl items-start gap-3 rounded-raised border px-3 py-2',
                'text-[12px] shadow-panel',
                profileState.error !== null
                  ? 'border-danger/30 bg-danger/10 text-danger'
                  : 'border-border bg-surface text-fg-muted'
              )}
            >
              <span className="min-w-0">{profileState.error ?? profileState.notice}</span>
              <button
                type="button"
                onClick={
                  profileState.error !== null
                    ? profileState.dismissError
                    : profileState.dismissNotice
                }
                aria-label="Dismiss"
                className="shrink-0 text-fg-subtle hover:text-fg"
              >
                ×
              </button>
            </div>
          </div>
        )}

        {editing !== null && (
          <ProfileEditor
            initial={editing}
            projects={discovery?.projects ?? []}
            problems={saveProblems}
            saving={saving}
            onSave={(draft) => void saveProfile(draft)}
            onCancel={() => setEditing(null)}
            // Only for a profile that exists. The same call the list's trash
            // icon makes; the editor closes because the row it edits is gone.
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

/** The ⤢ / ⇱ at the end of each strip: give this pane the whole row, or give
 * the split back. */
function PaneMaxButton({
  maximized,
  what,
  onToggle
}: {
  maximized: boolean
  what: 'workspace' | 'session'
  onToggle: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      data-maximize={what}
      title={maximized ? 'Restore the split' : `Maximize the ${what} pane`}
      aria-label={maximized ? 'Restore the split' : `Maximize the ${what} pane`}
      onClick={onToggle}
      className="grid size-6 place-items-center rounded text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
    >
      {maximized ? '⇱' : '⤢'}
    </button>
  )
}
