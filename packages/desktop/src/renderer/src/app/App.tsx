import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HistorySession, Profile, ProfileDraft, Project, SessionRecord } from '@helm/core'
import {
  AppShell,
  BookIcon,
  cn,
  ConfigConsole,
  ConfigEditor,
  ConfigNothingSelected,
  ContentDocumentPane,
  ContentNothingSelected,
  ContentViewer,
  EffectiveViewPane,
  FolderIcon,
  HarnessIcon,
  HealthPanel,
  HistoryIcon,
  McpPanel,
  NewHarnessDialog,
  ProfileEditor,
  ProfileList,
  ProjectPane,
  RepoIcon,
  SessionHistory,
  SetupPane,
  Sidebar,
  SlidersIcon,
  StatusBar,
  TabBar,
  ThemeToggle,
  VersionBanner,
  WelcomePane,
  type Tab,
  type TabIndicator
} from '@helm/ui'
import { helm } from './bridge'
import { TerminalPane } from './TerminalPane'
import { useConfig } from './useConfig'
import { useContent } from './useContent'
import { useHistory } from './useHistory'
import { useLauncher } from './useLauncher'
import { useProfiles } from './useProfiles'
import { useSessions } from './useSessions'
import { useSetup } from './useSetup'
import { useUsage } from './useUsage'

const KIND_ICON = {
  harness: HarnessIcon,
  repo: RepoIcon,
  folder: FolderIcon
} as const

/**
 * Three kinds of tab, one strip.
 *
 * A project tab is a view of discovery's data and can be thrown away and
 * rebuilt at will, and so can the history tab - there is only ever one of it,
 * and every piece of state it has lives in `useHistory` rather than in the
 * component, so closing and reopening it does not lose a search. A session tab
 * has a process behind it, so it is closed by asking the main process, and its
 * pane stays mounted even while another tab is on screen - unmounting it would
 * drop the scrollback of a live session.
 */
type PaneRef =
  | { kind: 'project'; path: string }
  | { kind: 'session'; id: number }
  | { kind: 'history' }
  | { kind: 'config' }
  | { kind: 'content' }

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
const CONFIG_TAB = 'config'
const CONTENT_TAB = 'content'

const tabId = (ref: PaneRef): string => {
  if (ref.kind === 'project') return `project:${ref.path}`
  if (ref.kind === 'session') return `session:${String(ref.id)}`
  if (ref.kind === 'config') return CONFIG_TAB
  if (ref.kind === 'content') return CONTENT_TAB
  return HISTORY_TAB
}

export function App(): JSX.Element {
  const launcher = useLauncher()
  const { discovery, settings, info } = launcher

  const [order, setOrder] = useState<PaneRef[]>([])
  /** What the user last asked for. The tab that is actually active is derived
   * from it, because the requested one can stop existing. */
  const [requestedId, setRequestedId] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  /** The pane box, measured to open a pty at roughly the right grid. */
  const paneRef = useRef<HTMLDivElement>(null)

  const activateSession = useCallback((id: number) => {
    setRequestedId(tabId({ kind: 'session', id }))
  }, [])

  const sessionState = useSessions(activateSession)
  const { sessions } = sessionState
  const profileState = useProfiles()
  const historyState = useHistory()
  const configState = useConfig()
  const contentState = useContent()
  const usage = useUsage()
  const setup = useSetup(settings, launcher.rescan)

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
   * The tab strip, derived rather than synced in an effect.
   *
   * A rescan that no longer sees a project should close its tab, and every
   * session main is hosting should have one - including sessions this renderer
   * did not launch, which is the case after a reload (dev HMR, or a crashed
   * render process) where the processes outlive the tab strip that was showing
   * them. Writing either as `useEffect` + `setState` renders once with the
   * wrong tabs and then again with the right ones, for a value that is a pure
   * function of what we already have.
   *
   * `order` therefore holds placement, not membership: a session that has never
   * been moved or closed is simply appended.
   */
  const openPanes = useMemo(() => {
    const placed = order.filter((ref) => {
      if (ref.kind === 'project') return !discovery || projectsByPath.has(ref.path)
      if (ref.kind === 'session') return sessionsById.has(ref.id)
      return true
    })
    const known = new Set(placed.filter((ref) => ref.kind === 'session').map((ref) => ref.id))
    const appended = sessions
      .filter((session) => !known.has(session.id))
      .map((session): PaneRef => ({ kind: 'session', id: session.id }))
    return [...placed, ...appended]
  }, [order, discovery, projectsByPath, sessions, sessionsById])

  const activeId =
    requestedId !== null && openPanes.some((ref) => tabId(ref) === requestedId)
      ? requestedId
      : (openPanes.map(tabId).at(-1) ?? null)
  const activePane = openPanes.find((ref) => tabId(ref) === activeId) ?? null

  // Main decides whether an exiting session is worth a notification, and that
  // turns on which pane is in front - which only this side knows.
  const { reportFocus } = sessionState
  useEffect(() => {
    reportFocus(activePane?.kind === 'session' ? activePane.id : null)
  }, [activePane, reportFocus])

  const openPane = useCallback((ref: PaneRef) => {
    setOrder((current) =>
      current.some((r) => tabId(r) === tabId(ref)) ? current : [...current, ref]
    )
    setRequestedId(tabId(ref))
  }, [])

  const openProject = useCallback(
    (project: Project | null) => {
      if (!project) return
      openPane({ kind: 'project', path: project.path })
    },
    [openPane]
  )

  const openHistory = useCallback(() => openPane({ kind: 'history' }), [openPane])
  const openConfig = useCallback(() => openPane({ kind: 'config' }), [openPane])
  const openContent = useCallback(() => openPane({ kind: 'content' }), [openPane])

  const launch = useCallback(
    async (project: Project) => {
      setLaunching(true)
      try {
        const id = await sessionState.launch(project, paneRef.current)
        if (id === null) return
        // Placed on launch so the strip reads in the order it was built, rather
        // than every terminal collecting at the end behind every project tab.
        // The append in `openPanes` is then only for sessions this renderer did
        // not launch.
        setOrder((current) => [...current, { kind: 'session', id }])
        setRequestedId(tabId({ kind: 'session', id }))
      } finally {
        setLaunching(false)
      }
    },
    [sessionState]
  )

  /**
   * A profile launch lands in a tab exactly the way a project launch does - the
   * strip does not care which produced the session, only that one exists.
   */
  const launchProfile = useCallback(
    async (profile: Profile) => {
      const session = await profileState.launch(profile, paneRef.current)
      if (!session) return
      sessionState.adopt(session)
      setOrder((current) => [...current, { kind: 'session', id: session.id }])
      setRequestedId(tabId({ kind: 'session', id: session.id }))
    },
    [profileState, sessionState]
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
      setOrder((current) => [...current, { kind: 'session', id: record.id }])
      setRequestedId(tabId({ kind: 'session', id: record.id }))
    },
    [historyState, sessionState]
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

      if (ref.kind !== 'session') {
        setOrder(openPanes.filter((candidate) => tabId(candidate) !== id))
        return
      }
      // The process gets a say: main confirms before ending a live session, and
      // the tab stays if the answer is no. A closed session drops out of
      // `sessions`, so the strip loses it whether or not it was ever placed.
      void sessionState.close(ref.id).then((closed) => {
        if (closed) setOrder(openPanes.filter((candidate) => tabId(candidate) !== id))
      })
    },
    [openPanes, sessionState]
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

  // Ctrl+Tab cycles, in capture so it never reaches the focused terminal.
  // Ctrl+Shift+Tab is not bound by Claude Code either; Shift+Tab alone is (it
  // cycles permission modes) and is deliberately left alone.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !event.ctrlKey || event.altKey) return
      const ids = openPanes.map(tabId)
      if (ids.length < 2) return
      event.preventDefault()
      event.stopPropagation()
      const at = activeId === null ? -1 : ids.indexOf(activeId)
      const step = event.shiftKey ? -1 : 1
      setRequestedId(ids[(at + step + ids.length) % ids.length] ?? null)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [openPanes, activeId])

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

    if (ref.kind === 'project') {
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
    }

    const session = sessionsById.get(ref.id)
    if (!session) return []
    const indicator: TabIndicator =
      session.status === 'running' ? 'running' : session.exitCode ? 'failed' : 'ended'
    const project = session.projectPath ? projectsByPath.get(session.projectPath) : undefined
    return [
      {
        id: tabId(ref),
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
  // A session tab still points at a project, so the tree keeps showing where
  // the thing on screen came from rather than clearing its selection.
  const selectedPath =
    activePane?.kind === 'session'
      ? (sessionsById.get(activePane.id)?.projectPath ?? null)
      : (activeProject?.path ?? null)
  const sessionPanes = openPanes.filter((ref) => ref.kind === 'session')
  const runningSessions = sessions.filter((session) => session.status === 'running').length

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
      <div className="h-full w-full bg-bg text-fg">
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
        {harnessDialog}
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
        <Sidebar
          profiles={
            <ProfileList
              profiles={profileState.profiles}
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
          onOpenConfig={openConfig}
          configActive={activePane?.kind === 'config'}
          configScopes={configState.scopes.length}
          onOpenContent={openContent}
          contentActive={activePane?.kind === 'content'}
          contentFiles={contentState.tree?.files.length ?? 0}
          {...(contentState.scope ? { contentScopeLabel: contentState.scope.label } : {})}
          discovery={discovery}
          scanning={launcher.scanning}
          scanError={launcher.scanError}
          selectedPath={selectedPath}
          onSelect={openProject}
          onRescan={launcher.rescan}
          onAddRoot={launcher.addRoot}
          onCreateHarness={() => setup.openDialog('new')}
        />
      }
      tabBar={
        <TabBar
          tabs={tabs}
          activeId={activeId}
          onActivate={setRequestedId}
          onClose={closeTab}
          onReorder={reorderTabs}
          actions={
            <ThemeToggle value={settings?.theme ?? 'system'} onChange={launcher.setTheme} />
          }
        />
      }
      statusBar={
        <StatusBar
          build={info ? `${info.version} · ${info.mode}` : '…'}
          dbFile={info?.dbFile ?? ''}
          migrations={info?.migrations ?? []}
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
          onRevealDb={() => info && launcher.reveal(info.dbFile)}
        />
      }
    >
      <div ref={paneRef} className="relative h-full w-full">
        {/* Every terminal stays mounted and only the active one is shown.
            Unmounting a pane to switch tabs would take the session's scrollback
            with it, and re-attaching a live pty to a fresh terminal cannot
            recover what has already scrolled past. */}
        {sessionPanes.map((ref) => {
          const session = sessionsById.get(ref.id)
          if (!session) return null
          const visible = tabId(ref) === activeId
          return (
            <div
              key={ref.id}
              className={cn('absolute inset-0', visible ? 'block' : 'hidden')}
              aria-hidden={!visible}
            >
              <TerminalPane
                session={session}
                active={visible}
                windowsBuild={info?.windowsBuild ?? null}
                onClose={(id) => closeTab(tabId({ kind: 'session', id }))}
              />
            </div>
          )
        })}

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

        {activeProject && (
          <div className="absolute inset-0">
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

        {harnessDialog}

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
          />
        )}
      </div>
    </AppShell>
  )
}
