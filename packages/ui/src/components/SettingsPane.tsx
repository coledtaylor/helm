import type { JSX } from 'react'
import {
  ACCENT_SWATCHES,
  offerableUsageModes,
  CORNER_RADIUS,
  DEFAULT_THEME_ID,
  DENSITY_MODES,
  deriveAccent,
  PANE_GAP,
  COST_MODE_UNAVAILABLE,
  PROJECT_SHELL_HEIGHT_PCT,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_FONT_SIZE,
  TERMINAL_SCROLLBACK,
  USAGE_DISPLAY_MODES,
  type AppSettings,
  type ArchiveStats,
  browserSearchName,
  BROWSER_SEARCH_ENGINES,
  type BrowserReach,
  type BrowserSearch,
  type DetectedShell,
  type TerminalCursorStyle,
  type Density,
  type ThemeDefinition,
  type ThemeKind,
  type ThemeListing,
  type ThemeState,
  type ThemeTokens,
  type UsageDisplayMode
} from '@helm/core/types'
import { cn } from '../lib/cn'
import { SETTINGS_SECTIONS, type SettingsSectionId } from './SettingsSections'
import { SEGMENT_ON } from '../lib/segmented'
import { formatAge, formatBytes } from '../lib/time'
import { Checkbox } from './Checkbox'
import {
  Action,
  Actions,
  Divider,
  Fact,
  Group,
  NumberField,
  Row,
  Select,
  SettingsPage,
  Stepper,
  Verdict,
  useDraft
} from './SettingsKit'
import { CheckIcon, CloseIcon, RefreshIcon } from './icons'
import type { SetupClaudeStatus } from './SetupPane'

/**
 * Helm's own settings.
 *
 * Deliberately not the config console: that pane edits the `.claude` trees
 * Claude Code reads, which belong to Claude and are shared with every other
 * client on the machine. This one is the app's own configuration, and it is the
 * permanent home for it - every setting a later feature adds lands here as
 * another row in an existing group or another group at the end.
 *
 * One scrolling page of grouped cards rather than sub-views. Six groups and
 * two dozen controls; a segmented navigator over that many rows is furniture
 * standing in for content. When a group outgrows the page, it earns its own
 * view then.
 *
 * The Terminal group is the appearance of the panes, not the terminal's own
 * ground: the xterm palette is fixed in both themes and pixel-asserted by the
 * fidelity checks (DESIGN.md par. 6), so colour is deliberately not a row here.
 *
 * Two things on screen elsewhere write the same settings this pane does - the
 * title bar's theme toggle and the status bar's usage segment - and both stay.
 * A quick accessor beside the thing it changes is worth having; what was
 * missing was somewhere to find the setting when you are not already looking at
 * it. Both write through `settings:write` and this pane renders whatever
 * `settings:changed` carries back, so the two cannot disagree.
 *
 * Internal state is not shown. `windowBounds` and `firstRunCompletedAt` live in
 * the same table but they are things Helm remembers, not things anyone chose.
 */

export interface SettingsPaneProps {
  /** The one section on screen; the sidebar lists the rest (`SettingsSections`). */
  section: SettingsSectionId
  /** What Helm found out about the CLI. Null until the first read lands. */
  status: SetupClaudeStatus | null
  /** A status read the user asked for, so it gets a spinner. */
  checking: boolean
  onRecheck: () => void
  onLocateClaude: () => void
  /** Writes `claudePath: null` - back to whatever discovery finds. */
  onClearClaudeOverride: () => void

  roots: string[]
  /** What the current roots turned up, so "it worked" is visible here. */
  projectCount: number
  scanning: boolean
  onAddRoot: () => void
  onRemoveRoot: (path: string) => void

  /**
   * `pinnedProjects`, as stored: absolute paths, in the order the setting holds
   * them rather than the order the sidebar shows them.
   *
   * Pins are *made* on the sidebar's own rows, where the project is, and this
   * pane is where the whole set is legible at once - including a path whose
   * folder has gone, which is the one a person comes here to clear. Paths and
   * not names, deliberately: the setting is a list of paths and it is a list of
   * paths that a re-clone invalidates, so the pane shows the value rather than
   * a friendlier rendering of it.
   */
  pinnedProjects: string[]
  onUnpinProject: (path: string) => void

  /** Every setting the Appearance group writes. */
  appearance: AppearanceSettings
  onAppearanceChange: (patch: Partial<AppearanceSettings>) => void
  /** Built-in and user themes. Null until the first read lands. */
  themes: ThemeListing | null
  /** The theme on screen, as the main process resolved it. Null until it lands. */
  themeState: ThemeState | null
  /** Opens the user themes folder, creating it if it was deleted. */
  onOpenThemesFolder: () => void
  /** Writes a complete copy of a theme into that folder and shows it. */
  onDuplicateTheme: (id: string) => void

  usageDisplay: UsageDisplayMode
  updateCheck: boolean
  onUpdateCheckChange: (next: boolean) => void
  onUsageDisplayChange: (mode: UsageDisplayMode) => void

  /** This build's version, from `app:info`. Null until that read lands. */
  appVersion: string | null
  /**
   * The releases page, from `app:info` rather than from a check's result.
   *
   * The link has to be reachable in exactly the states no check produces - up
   * to date, offline, the setting off - so it cannot come from `update`.
   */
  releasesUrl: string | null
  /**
   * The last check attempted, complete or not. Null means nobody has asked
   * since launch, which is its own sentence and not an error.
   */
  update: UpdateCheckResult | null
  updateChecking: boolean
  onCheckForUpdate: () => void
  onOpenReleases: () => void
  /**
   * Whether the transcript index has an estimate yet. `cost` is offered only
   * when it has - the same rule the status bar's cycle follows, from the same
   * function, because a mode that would paint nothing is a broken setting.
   */
  hasCostEstimate: boolean

  terminal: TerminalSettings
  onTerminalChange: (patch: Partial<TerminalSettings>) => void
  /**
   * The font stack the terminals are actually running, so the preview is the
   * real thing rather than this pane's re-derivation of the prepend rule.
   */
  terminalFontStack: string
  /** Shells found on this machine. Empty until the probe lands. */
  shells: DetectedShell[]
  /** Native file picker, for a shell installed somewhere `where.exe` misses. */
  onLocateShell: () => void

  /**
   * What the transcript archive holds. Null until the first read lands.
   *
   * Passed in rather than derived from the settings, because the interesting
   * half of this group is not the ceiling - it is how much is actually stored
   * against it, which only the main process knows.
   */
  archiveStats: ArchiveStats | null
  transcriptArchiveMaxBytes: number
  onTranscriptArchiveMaxBytesChange: (bytes: number) => void

  /**
   * Harness templates: how many there are, where they live, and the way in to
   * managing them.
   *
   * A group here as well as a link in the New Harness dialog, because
   * templates are **app-level**: they belong to this Helm rather than to any
   * one harness, and having to start creating a harness in order to rename or
   * delete one would be the same mistake as putting "stop scanning this
   * folder" only in Settings - which is a bug this pane has already been on the
   * wrong end of once.
   */
  templateCount: number
  templatesDir: string
  onManageTemplates: () => void
  /** Opens the templates folder itself, for the editing this app does not do. */
  onRevealTemplates: () => void

  /** Whether long lines wrap in the Files view. */
  filesWrap: boolean
  onFilesWrapChange: (wrap: boolean) => void

  /**
   * How far the browser pane may reach.
   *
   * The one browser key that is a preference. The two beside it in the
   * database - the recent addresses and the per-project ones - are state, so
   * they sit with `workspaceTabs` and are deliberately not on this pane.
   */
  browserReach: BrowserReach
  onBrowserReachChange: (reach: BrowserReach) => void
  /** What the address bar does with a phrase: an engine, or `off`. A preference, so it is here. */
  browserSearch: BrowserSearch
  onBrowserSearchChange: (search: BrowserSearch) => void
  /**
   * The two browser-tool keys: whether Helm serves its browser tools to the
   * sessions it hosts, and whether those tools are held to this machine when
   * the pane is not. Both are preferences rather than state, so both are here.
   */
  browserMcp: boolean
  onBrowserMcpChange: (next: boolean) => void
  browserMcpLocalOnly: boolean
  onBrowserMcpLocalOnlyChange: (next: boolean) => void

  /**
   * Whether a session may ask Helm what the other sessions are doing.
   *
   * Its own row in its own group rather than a third tick under Browser: it is
   * served by the same endpoint but it is not the same capability, and a person
   * deciding about it is deciding about their other work rather than about a
   * browser.
   */
  sessionMcp: boolean
  onSessionMcpChange: (next: boolean) => void
  /** Reopen what a crash took without asking. Also ticked from the offer itself. */
  restoreWithoutAsking: boolean
  onRestoreWithoutAskingChange: (next: boolean) => void
}

/**
 * The outcome of a check, as this package needs it.
 *
 * Structural rather than the desktop package's `UpdateCheck`, for the reason
 * `StatusBarProps.update` gives: the IPC contract belongs to the host. Unlike
 * the bar's version this keeps `error` and `checkedAt`, because the pane's job
 * is to say what happened - including that nothing did.
 */
export interface UpdateCheckResult {
  current: string
  latest: string | null
  newer: boolean
  error: string | null
  checkedAt: string
}

/**
 * The seven the Terminal group owns, named once so nothing has to list them
 * twice.
 *
 * `projectShellHeightPct` is the odd one: it is not a terminal preference and
 * never reaches `applyPrefs`, it is how tall a project page's shell is. It is
 * shown here because this is the group somebody looks in for the shell under a
 * project - the shell picker is already here - and a settings pane organised by
 * where a person would look for a thing beats one organised by which module
 * consumes it.
 */
export type TerminalSettings = Pick<
  AppSettings,
  | 'terminalFontFamily'
  | 'terminalFontSize'
  | 'terminalCursorStyle'
  | 'terminalCursorBlink'
  | 'terminalScrollback'
  | 'terminalShell'
  | 'projectShellHeightPct'
>

/** What a fact reads when there is nothing to put in it. */
const NOTHING = '-'

const USAGE_LABEL: Record<UsageDisplayMode, string> = {
  percent: 'Percent',
  cost: 'Cost',
  off: 'Off'
}

export function SettingsPane({
  section,
  status,
  checking,
  onRecheck,
  onLocateClaude,
  onClearClaudeOverride,
  roots,
  projectCount,
  scanning,
  onAddRoot,
  onRemoveRoot,
  pinnedProjects,
  onUnpinProject,
  appearance,
  onAppearanceChange,
  themes,
  themeState,
  onOpenThemesFolder,
  onDuplicateTheme,
  usageDisplay,
  updateCheck,
  onUpdateCheckChange,
  onUsageDisplayChange,
  hasCostEstimate,
  appVersion,
  releasesUrl,
  update,
  updateChecking,
  onCheckForUpdate,
  onOpenReleases,
  terminal,
  onTerminalChange,
  terminalFontStack,
  shells,
  onLocateShell,
  archiveStats,
  transcriptArchiveMaxBytes,
  onTranscriptArchiveMaxBytesChange,
  templateCount,
  templatesDir,
  onManageTemplates,
  onRevealTemplates,
  filesWrap,
  onFilesWrapChange,
  browserReach,
  onBrowserReachChange,
  browserSearch,
  onBrowserSearchChange,
  browserMcp,
  onBrowserMcpChange,
  browserMcpLocalOnly,
  onBrowserMcpLocalOnlyChange,
  sessionMcp,
  onSessionMcpChange,
  restoreWithoutAsking,
  onRestoreWithoutAskingChange
}: SettingsPaneProps): JSX.Element {
  const found = status !== null && status.path !== null && status.version !== null
  const overridden = status?.source === 'setting'
  const offerable = offerableUsageModes(hasCostEstimate)

  const meta = SETTINGS_SECTIONS.find((entry) => entry.id === section) ?? SETTINGS_SECTIONS[0]!
  // General and Workspace hold two groups each and keep their headings; every
  // other section is one group, whose title is the page's and whose hint is
  // the line under it.
  const sole = section !== 'general' && section !== 'workspace'

  return (
    <SettingsPage data-settings-section={section} title={meta.label} hint={meta.hint} sole={sole}>
          {section === 'general' && (
            <>
                <Group
                  name="claude"
                  title="Claude CLI"
                  hint="The claude executable Helm runs. Found on PATH unless you set one."
                >
                  <div className="pb-1">
                    <Verdict
                      tone={status === null ? 'todo' : found ? (status.tested ? 'ok' : 'warn') : 'warn'}
                      text={
                        status === null
                          ? 'Looking…'
                          : found
                            ? overridden
                              ? 'Set by you'
                              : 'Found on this machine'
                            : (status.error ?? 'Not found.')
                      }
                    />
                    <dl className="mt-2.5 space-y-1.5">
                      <Fact label="Path">
                        <span data-settings-claude-path title={status?.path ?? ''}>
                          {status?.path ?? NOTHING}
                        </span>
                      </Fact>
                      <Fact label="Version">
                        <span data-settings-claude-version>{status?.version ?? NOTHING}</span>
                      </Fact>
                      <Fact label="Config">
                        <span data-settings-claude-config title={status?.configDir ?? ''}>
                          {status?.configDir ?? NOTHING}
                        </span>
                      </Fact>
                    </dl>

                    {found && status !== null && !status.tested && (
                      <p
                        data-settings-version-warning
                        className="mt-3 rounded-well border border-warn/30 bg-warn/10 px-3 py-2 text-[11.5px] leading-[1.55] text-warn"
                      >
                        Helm was tested against {status.testedRange.min} up to (not including){' '}
                        {status.testedRange.max}. {status.semver ?? status.version} is outside that, so a
                        flag may have moved. Nothing is blocked.
                      </p>
                    )}
                  </div>

                  <Actions>
                    <Action data-settings-recheck onClick={onRecheck} disabled={checking}>
                      <RefreshIcon className={cn('mr-1.5 inline', checking && 'animate-spin')} />
                      Check again
                    </Action>
                    <Action data-settings-locate onClick={onLocateClaude}>
                      Locate manually…
                    </Action>
                    <Action
                      data-settings-clear-claude
                      onClick={onClearClaudeOverride}
                      disabled={!overridden}
                      title={
                        overridden
                          ? 'Forget the executable you picked and use whatever Helm finds'
                          : 'Nothing to clear - Helm found this one itself'
                      }
                    >
                      Clear override
                    </Action>
                  </Actions>
                </Group>

                <Group name="statusbar" title="Status bar">
                  <Row
                    label="Usage in the status bar"
                    hint={
                      hasCostEstimate
                        ? 'Percentages of your plan limits, an estimate of what the transcripts would have cost, or nothing.'
                        : 'Percentages of your plan limits, or nothing. Cost joins the list once the transcript index has an estimate.'
                    }
                  >
                    <div
                      role="radiogroup"
                      aria-label="Usage display"
                      className="flex items-center gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
                    >
                      {USAGE_DISPLAY_MODES.map((mode) => {
                        const available = offerable.includes(mode)
                        return (
                          <button
                            key={mode}
                            type="button"
                            role="radio"
                            data-settings-usage={mode}
                            aria-checked={usageDisplay === mode}
                            disabled={!available}
                            title={available ? `Show ${USAGE_LABEL[mode].toLowerCase()}` : COST_MODE_UNAVAILABLE}
                            onClick={() => onUsageDisplayChange(mode)}
                            className={cn(
                              'rounded-raised px-2.5 py-1 text-[11.5px] transition-colors',
                              usageDisplay === mode
                                ? SEGMENT_ON
                                : 'text-fg-subtle hover:text-fg',
                              !available && 'cursor-default opacity-45 hover:text-fg-subtle'
                            )}
                          >
                            {USAGE_LABEL[mode]}
                          </button>
                        )
                      })}
                    </div>
                  </Row>
                </Group>
            </>
          )}

          {section === 'workspace' && (
            <>
                <Group
                  name="workspace"
                  title="Workspace"
                  hint={
                    scanning
                      ? `${count(roots.length, 'folder')} · scanning…`
                      : `${count(roots.length, 'folder')} · ${count(projectCount, 'project')}`
                  }
                >
                  {roots.length === 0 ? (
                    <p className="pb-1 text-[12px] text-fg-subtle">
                      Helm scans nothing until you say what to scan.
                    </p>
                  ) : (
                    <ul className="overflow-hidden rounded-well border border-border bg-surface-sunken">
                      {roots.map((root) => (
                        <li
                          key={root}
                          data-settings-root={root}
                          className="flex items-center gap-2 border-b border-border px-3 py-1.5 last:border-b-0"
                        >
                          <span
                            className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted"
                            title={root}
                          >
                            {root}
                          </span>
                          <button
                            type="button"
                            data-settings-remove-root={root}
                            onClick={() => onRemoveRoot(root)}
                            aria-label={`Stop scanning ${root}`}
                            title={`Stop scanning ${root}`}
                            className={cn(
                              'grid size-5 shrink-0 place-items-center rounded text-fg-subtle',
                              'transition-colors hover:bg-hover hover:text-danger'
                            )}
                          >
                            <CloseIcon width={11} height={11} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <p className="mt-2.5 text-[11px] leading-[1.55] text-fg-subtle">
                    A <em>harness</em> is a folder with a <code className="font-mono">harness.yaml</code>,
                    and lets one session compose several repos&rsquo; skills. Removing a folder only stops
                    Helm scanning it.
                  </p>

                  <Actions>
                    <Action data-settings-add-root onClick={onAddRoot} primary={roots.length === 0}>
                      Add a folder
                    </Action>
                  </Actions>

                  <Divider />

                  {/* Pins are made on the sidebar, on the row of the project being
                      pinned - the star is there because that is where the decision is.
                      This is where the set is legible all at once, which is what the
                      sidebar cannot be: its Pinned section shows a vanished folder as
                      one row saying so, and a list of the paths is what says *which*
                      path, in a form that can be compared with what is on disk. */}
                  <p className="text-[12.5px] text-fg">Pinned projects</p>
                  <p className="mt-0.5 mb-2 text-[11px] leading-[1.55] text-fg-subtle">
                    Shown first in the sidebar. Pin one with the star on its row.
                  </p>

                  {pinnedProjects.length === 0 ? (
                    <p className="text-[12px] text-fg-subtle">Nothing is pinned.</p>
                  ) : (
                    <ul className="overflow-hidden rounded-well border border-border bg-surface-sunken">
                      {pinnedProjects.map((path) => (
                        <li
                          key={path}
                          data-settings-pinned={path}
                          className="flex items-center gap-2 border-b border-border px-3 py-1.5 last:border-b-0"
                        >
                          <span
                            className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted"
                            title={path}
                          >
                            {path}
                          </span>
                          {/* The roots list above wears the same shape with a danger
                              hover on its ×, and this one deliberately does not:
                              un-scanning a folder takes projects out of the tree, and
                              un-pinning one moves a row back into its harness. */}
                          <button
                            type="button"
                            data-settings-unpin={path}
                            onClick={() => onUnpinProject(path)}
                            aria-label={`Unpin ${path}`}
                            title={`Unpin ${path}`}
                            className={cn(
                              'grid size-5 shrink-0 place-items-center rounded text-fg-subtle',
                              'transition-colors hover:bg-hover hover:text-fg'
                            )}
                          >
                            <CloseIcon width={11} height={11} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </Group>

                <TemplatesGroup
                  total={templateCount}
                  dir={templatesDir}
                  onManage={onManageTemplates}
                  onReveal={onRevealTemplates}
                />
            </>
          )}

          {section === 'appearance' && (
            <AppearanceGroup
              settings={appearance}
              onChange={onAppearanceChange}
              themes={themes}
              state={themeState}
              onOpenFolder={onOpenThemesFolder}
              onDuplicate={onDuplicateTheme}
            />
          )}

          {section === 'terminal' && (
            <TerminalGroup
              terminal={terminal}
              onChange={onTerminalChange}
              fontStack={terminalFontStack}
              shells={shells}
              onLocateShell={onLocateShell}
            />
          )}

          {section === 'sessions' && (
            <SessionsGroup
              mcp={sessionMcp}
              onMcpChange={onSessionMcpChange}
              restore={restoreWithoutAsking}
              onRestoreChange={onRestoreWithoutAskingChange}
            />
          )}

          {section === 'files' && (
            <FilesGroup wrap={filesWrap} onWrapChange={onFilesWrapChange} />
          )}

          {section === 'browser' && (
            <BrowserGroup
              reach={browserReach}
              onReachChange={onBrowserReachChange}
              search={browserSearch}
              onSearchChange={onBrowserSearchChange}
              mcp={browserMcp}
              onMcpChange={onBrowserMcpChange}
              mcpLocalOnly={browserMcpLocalOnly}
              onMcpLocalOnlyChange={onBrowserMcpLocalOnlyChange}
            />
          )}

          {section === 'archive' && (
            <ArchiveGroup
              stats={archiveStats}
              maxBytes={transcriptArchiveMaxBytes}
              onMaxBytesChange={onTranscriptArchiveMaxBytesChange}
            />
          )}

          {section === 'updates' && (
            <UpdatesGroup
              appVersion={appVersion}
              releasesUrl={releasesUrl}
              update={update}
              checking={updateChecking}
              onCheckNow={onCheckForUpdate}
              onOpenReleases={onOpenReleases}
              updateCheck={updateCheck}
              onUpdateCheckChange={onUpdateCheckChange}
            />
          )}
    </SettingsPage>
  )
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

export type AppearanceSettings = Pick<
  AppSettings,
  'theme' | 'themeDark' | 'themeLight' | 'paneGap' | 'cornerRadius' | 'density' | 'accentColor'
>

const DENSITY_LABEL: Record<Density, string> = { comfortable: 'Comfortable', compact: 'Compact' }

/**
 * Themes, shape and accent.
 *
 * Under the cards are **two slots and a switch**, not one choice: `themeDark`
 * and `themeLight` each name a theme, and `theme` says which slot is on
 * screen - one of them always, or whichever Windows is in. That is what lets
 * "Follow Windows" mean something once there is more than one theme of a kind,
 * and it is why the title bar's three-way toggle still works unchanged.
 *
 * So a card writes its **own kind's** slot. Following Windows, that is all it
 * does, and a card of the kind Windows is not in today is recorded for later -
 * which is why, while following, the two cards in the slots carry a tag saying
 * when each one shows: a click that changed nothing on screen still visibly
 * moved something. Not following, a card also pins the preference to its
 * kind, so whatever was clicked is what is on screen.
 *
 * The selected ring is on the theme the main process says is showing, never on
 * this pane's guess at it - a slot naming a deleted file resolves to a
 * built-in, and the ring says so.
 */
function AppearanceGroup({
  settings,
  onChange,
  themes,
  state,
  onOpenFolder,
  onDuplicate
}: {
  settings: AppearanceSettings
  onChange: (patch: Partial<AppearanceSettings>) => void
  themes: ThemeListing | null
  state: ThemeState | null
  onOpenFolder: () => void
  onDuplicate: (id: string) => void
}): JSX.Element {
  const all = themes?.themes ?? []
  const follow = settings.theme === 'system'
  const showing = state?.applied ?? null

  // What each slot actually shows: its theme, or the built-in standing in for
  // one that is not there - the same rule `resolveTheme` applies.
  const slotTheme = (kind: ThemeKind): ThemeDefinition | undefined => {
    const wanted = kind === 'dark' ? settings.themeDark : settings.themeLight
    return all.find((t) => t.id === wanted) ?? all.find((t) => t.id === DEFAULT_THEME_ID[kind])
  }
  const dark = slotTheme('dark')
  const light = slotTheme('light')

  const pick = (theme: ThemeDefinition): void => {
    const slot = theme.kind === 'dark' ? { themeDark: theme.id } : { themeLight: theme.id }
    onChange(follow ? slot : { ...slot, theme: theme.kind })
  }

  const problems = [
    ...(themes?.errors ?? []),
    ...all.flatMap((t) => t.problems.map((message) => ({ file: t.file ?? t.id, message })))
  ]

  return (
    <Group
      name="appearance"
      title="Appearance"
      hint="Themes change Helm's chrome. Terminals keep their own colours."
    >
      <div
        role="radiogroup"
        aria-label="Theme"
        data-settings-theme={settings.theme}
        className="grid grid-cols-[repeat(auto-fill,minmax(164px,1fr))] gap-2.5 pt-1"
      >
        {all.map((theme) => (
          <ThemeCard
            key={theme.id}
            theme={theme}
            showing={showing?.id === theme.id}
            slot={
              !follow ? null : theme.id === dark?.id ? 'dark' : theme.id === light?.id ? 'light' : null
            }
            onPick={() => pick(theme)}
          />
        ))}
      </div>

      <label className="mt-3 flex items-center gap-2.5 text-[12.5px] text-fg-muted">
        <Checkbox
          checked={follow}
          // Turning it off pins whatever is showing now, so the click changes
          // nothing on screen - it only stops the next Windows change moving it.
          onChange={() => onChange({ theme: follow ? (state?.resolved ?? 'dark') : 'system' })}
          label="Follow Windows"
          mark="data-settings-theme-follow"
        />
        <span>
          Follow Windows: {light?.name ?? 'the light theme'} when Windows is light,{' '}
          {dark?.name ?? 'the dark theme'} when it is dark
        </span>
      </label>

      {problems.length > 0 && (
        <ul
          data-settings-theme-problems={problems.length}
          className="mt-3 space-y-1 rounded-raised border border-warn/30 bg-warn/10 px-3 py-2 text-[11.5px] leading-[1.5]"
        >
          {problems.map((problem, index) => (
            <li key={`${problem.file}:${String(index)}`} className="flex gap-2">
              <span className="shrink-0 font-mono text-[11px] text-warn">{problem.file}</span>
              <span className="min-w-0 text-fg-muted">{problem.message}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-raised border border-border bg-surface px-3.5 py-3">
        <div className="min-w-[220px] flex-1">
          <p className="text-[12.5px] text-fg">Your own themes</p>
          <p className="mt-0.5 text-[11px] leading-[1.5] text-fg-subtle">
            One JSON file of colours per theme. Saving one repaints Helm.
          </p>
          {/* Its own line, truncated from the left of nothing: a path wrapped
              mid-sentence breaks at whichever backslash the width lands on. */}
          <p
            data-settings-themes-dir
            title={themes?.dir}
            className="mt-1 truncate font-mono text-[10.5px] text-fg-muted select-text"
          >
            {themes?.dir ?? NOTHING}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Action
            data-settings-theme-duplicate={showing?.id ?? ''}
            disabled={showing === null}
            onClick={() => {
              if (showing !== null) onDuplicate(showing.id)
            }}
          >
            Duplicate {showing?.name ?? 'theme'}
          </Action>
          <Action data-settings-themes-open onClick={onOpenFolder}>
            Open folder
          </Action>
        </div>
      </div>

      <div className="mt-2">
        <Row
          label="Space between panes"
          hint={`Pixels of canvas between islands, ${String(PANE_GAP.min)} to ${String(PANE_GAP.max)}.`}
        >
          <Stepper
            value={settings.paneGap}
            min={PANE_GAP.min}
            max={PANE_GAP.max}
            label="Space between panes"
            data-settings-gap={String(settings.paneGap)}
            onChange={(paneGap) => onChange({ paneGap })}
          />
        </Row>

        <Divider />

        <Row label="Corner radius" hint="Panels take it; buttons, fields and popups are one pixel rounder.">
          <Stepper
            value={settings.cornerRadius}
            min={CORNER_RADIUS.min}
            max={CORNER_RADIUS.max}
            label="Corner radius"
            data-settings-radius={String(settings.cornerRadius)}
            onChange={(cornerRadius) => onChange({ cornerRadius })}
          />
        </Row>

        <Divider />

        <Row label="Density" hint="How tightly lists and the tab strip pack. Text keeps its size.">
          <div
            role="radiogroup"
            aria-label="Density"
            className="flex items-center gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
          >
            {DENSITY_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                data-settings-density={mode}
                aria-checked={settings.density === mode}
                onClick={() => onChange({ density: mode })}
                className={cn(
                  'rounded-raised px-2.5 py-1 text-[11.5px] transition-colors',
                  settings.density === mode ? SEGMENT_ON : 'text-fg-subtle hover:text-fg'
                )}
              >
                {DENSITY_LABEL[mode]}
              </button>
            ))}
          </div>
        </Row>

        <Divider />

        <Row
          label="Accent"
          hint="The theme's own, or one of these, fitted to stay readable on it."
        >
          <div role="radiogroup" aria-label="Accent" className="flex items-center gap-2.5 px-1">
            <AccentSwatch
              name={`${showing?.name ?? 'The theme'}'s own`}
              mark="theme"
              color={state === null ? null : themeAccent(all, state)}
              selected={settings.accentColor === null}
              onPick={() => onChange({ accentColor: null })}
            />
            {ACCENT_SWATCHES.map((swatch) => (
              <AccentSwatch
                key={swatch.hex}
                name={swatch.name}
                mark={swatch.hex}
                color={
                  showing === null
                    ? swatch.hex
                    : deriveAccent(showing.tokens, showing.kind, swatch.hex).accent
                }
                selected={settings.accentColor === swatch.hex}
                onPick={() => onChange({ accentColor: swatch.hex })}
              />
            ))}
          </div>
        </Row>
      </div>
    </Group>
  )
}

/**
 * The accent the theme on screen has of its own. Read from the listing rather
 * than from `state`, because with a chosen accent `state` carries the chosen
 * one - and this swatch is the way back to the other.
 */
function themeAccent(all: ThemeDefinition[], state: ThemeState): string {
  return all.find((t) => t.id === state.applied.id)?.tokens.accent ?? state.applied.tokens.accent
}

function AccentSwatch({
  name,
  mark,
  color,
  selected,
  onPick
}: {
  name: string
  mark: string
  color: string | null
  selected: boolean
  onPick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={name}
      title={name}
      data-settings-accent={mark}
      onClick={onPick}
      // A theme colour, so an inline style - the value is data the main
      // process parsed and re-spelled, never a literal in this file.
      style={color === null ? undefined : { backgroundColor: color }}
      className={cn(
        'size-5 shrink-0 rounded-full ring-offset-2 ring-offset-surface-raised transition-shadow',
        selected ? 'ring-[1.5px] ring-fg' : 'ring-1 ring-transparent hover:ring-border-strong'
      )}
    />
  )
}

/**
 * One theme as a card: a miniature of the window in that theme's own colours,
 * its name and kind, and - while following Windows - which slot it fills.
 */
function ThemeCard({
  theme,
  showing,
  slot,
  onPick
}: {
  theme: ThemeDefinition
  showing: boolean
  slot: ThemeKind | null
  onPick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={showing}
      data-settings-theme-card={theme.id}
      title={theme.file === null ? `${theme.name}, built in` : `${theme.name}, from ${theme.file}`}
      onClick={onPick}
      className={cn(
        'min-w-0 rounded-raised border bg-surface p-1.5 text-left transition-colors',
        showing
          ? 'border-accent ring-1 ring-accent'
          : 'border-border hover:border-border-strong hover:bg-hover'
      )}
    >
      <ThemeSwatch tokens={theme.tokens} />
      <span className="flex min-w-0 items-center gap-1.5 px-1 pt-2 pb-0.5">
        <span className="truncate text-[12.5px] font-medium text-fg">{theme.name}</span>
        <span className="shrink-0 text-[11px] text-fg-subtle">
          {theme.kind === 'dark' ? 'Dark' : 'Light'}
        </span>
        <span className="flex-1" />
        {slot !== null && (
          <span
            data-settings-theme-slot={slot}
            className="shrink-0 rounded-raised border border-border px-1 text-[10px] leading-[15px] text-fg-muted"
          >
            when {slot}
          </span>
        )}
        {showing && <CheckIcon width={12} height={12} className="shrink-0 text-accent-text" />}
      </span>
    </button>
  )
}

/**
 * The window, small: canvas, rail, sidebar island and two session panes whose
 * bodies are the terminal's fixed ground - because that is what every theme
 * actually looks like with sessions open. Inline colours, from the theme's own
 * parsed tokens; the terminal is the one token the stylesheet owns.
 */
function ThemeSwatch({ tokens }: { tokens: ThemeTokens }): JSX.Element {
  const island = { backgroundColor: tokens.surface, borderColor: tokens['border-strong'] }
  const bar = (width: string, color: string): JSX.Element => (
    <span className="h-[3px] rounded-full" style={{ width, backgroundColor: color }} />
  )
  return (
    <span
      aria-hidden
      className="flex h-[78px] gap-[3px] overflow-hidden rounded-raised p-[5px]"
      style={{ backgroundColor: tokens.bg }}
    >
      <span className="flex w-[6px] shrink-0 flex-col gap-[3px] pt-px">
        <span className="h-[6px] rounded-xs" style={{ backgroundColor: tokens.accent }} />
        <span className="h-[6px] rounded-xs" style={{ backgroundColor: tokens['border-strong'] }} />
        <span className="h-[6px] rounded-xs" style={{ backgroundColor: tokens['border-strong'] }} />
      </span>
      <span
        className="flex w-[36px] shrink-0 flex-col gap-[4px] rounded-xs border px-[3px] py-[5px]"
        style={island}
      >
        {bar('70%', tokens['fg-subtle'])}
        {bar('90%', tokens.accent)}
        {bar('60%', tokens['fg-subtle'])}
        {bar('80%', tokens['fg-subtle'])}
      </span>
      {[1, 0.8].map((grow) => (
        <span
          key={grow}
          className="flex min-w-0 flex-col overflow-hidden rounded-xs border"
          style={{ ...island, flexGrow: grow, flexBasis: 0 }}
        >
          <span
            className="flex h-[10px] shrink-0 items-center px-[3px]"
            style={{ borderBottom: `1px solid ${tokens.border}` }}
          >
            <span className="h-[4px] w-[18px] rounded-xs" style={{ backgroundColor: tokens.active }} />
          </span>
          <span className="flex-1 bg-terminal" />
        </span>
      ))}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Harness templates
// ---------------------------------------------------------------------------

/**
 * The templates this Helm has, and the two ways to reach them.
 *
 * The path is a button rather than a line of text, and that is the group's
 * whole argument for existing beside the manager: **there is no file editor in
 * Helm for these**. A template is a folder, editing one is a job for the editor
 * somebody already has, and a settings group that named the folder without
 * opening it would be describing a destination it declined to take you to.
 *
 * The count is stated rather than the list drawn. Which template is which is
 * the manager's question and the picker's; what belongs here is the one fact
 * Settings is for - whether this Helm has any, and where they are.
 */
function TemplatesGroup({
  total,
  dir,
  onManage,
  onReveal
}: {
  total: number
  dir: string
  onManage: () => void
  onReveal: () => void
}): JSX.Element {
  return (
    <Group
      name="templates"
      title="Harness templates"
      hint={total === 0 ? 'none yet' : count(total, 'template')}
    >
      <p className="pb-1 text-[12px] leading-[1.55] text-fg-muted">
        A template is a folder here; creating a harness from one copies it in. The New Harness
        dialog picks between them, and the built-in <em>Minimal</em> scaffold is always the first
        row whatever is in this folder.
      </p>

      <button
        type="button"
        data-settings-templates-dir
        onClick={onReveal}
        title={`Show ${dir} in Explorer`}
        className="mt-1.5 block w-full truncate rounded-well border border-border bg-surface-sunken px-3 py-1.5 text-left font-mono text-[11px] text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      >
        {dir === '' ? NOTHING : dir}
      </button>
      <p className="mt-1.5 text-[11px] leading-[1.55] text-fg-subtle">
        Edited in your own editor, not in Helm - these are plain files, and most people keep them
        in git. Deleting the folder puts the shipped README and example back at the next start,
        which is the whole of &ldquo;reset&rdquo;.
      </p>

      <Actions>
        <Action data-settings-manage-templates onClick={onManage} primary={total === 0}>
          Manage templates
        </Action>
      </Actions>
    </Group>
  )
}

// ---------------------------------------------------------------------------
// Transcript archive
// ---------------------------------------------------------------------------

/**
 * The ceilings this pane offers.
 *
 * Not the validator's range, which runs from a kilobyte so that a check can
 * drive eviction. These are the sizes a person would choose, and the smallest
 * of them is still four hundred times the whole archive on the machine this was
 * written against (1.47 MB for 21,952 messages out of 311 MB of transcripts).
 */
const ARCHIVE_CEILINGS = [
  { bytes: 256 * 1024 * 1024, label: '256 MB' },
  { bytes: 512 * 1024 * 1024, label: '512 MB' },
  { bytes: 1024 ** 3, label: '1 GB' },
  { bytes: 2 * 1024 ** 3, label: '2 GB' },
  { bytes: 4 * 1024 ** 3, label: '4 GB' },
  { bytes: 8 * 1024 ** 3, label: '8 GB' }
] as const

/**
 * What Helm has kept, and the one knob over it.
 *
 * The figures are stated rather than drawn. A bar with no number on it would
 * be exactly the wrong answer here: the whole reason this group exists is that
 * `helm.db` is the user's file and a feature that grows it silently is one they
 * find out about from their disk. So the sentence says how many conversations,
 * how many messages, how many bytes, and how many bytes out of how many - and,
 * when the ceiling has actually bitten, how many conversations it dropped.
 *
 * There is no on/off switch and that is deliberate; the field's comment in
 * `types.ts` has the argument. What can be turned down is the ceiling.
 */
function ArchiveGroup({
  stats,
  maxBytes,
  onMaxBytesChange
}: {
  stats: ArchiveStats | null
  maxBytes: number
  onMaxBytesChange: (bytes: number) => void
}): JSX.Element {
  const used = stats?.storedBytes ?? 0
  const percent = maxBytes > 0 ? (used / maxBytes) * 100 : 0
  // Two significant figures below 1%, so a real archive on a default ceiling
  // reads "0.00014%" rather than "0%" - which would say "nothing is stored"
  // about something that is.
  const percentText = percent === 0 ? '0%' : percent < 1 ? `${percent.toPrecision(2)}%` : `${percent.toFixed(1)}%`

  // A ceiling set outside the offered list - by a check, or by a build that
  // offered different sizes - is added to the list rather than silently
  // replaced by the nearest one, which would make the select lie about what is
  // in force the moment it painted.
  const choices = ARCHIVE_CEILINGS.some((choice) => choice.bytes === maxBytes)
    ? ARCHIVE_CEILINGS
    : [{ bytes: maxBytes, label: formatBytes(maxBytes) }, ...ARCHIVE_CEILINGS]

  return (
    <Group
      name="archive"
      title="Transcript archive"
      hint="Claude Code deletes transcripts on its own schedule. Helm keeps a compressed copy of each one first, and never writes to Claude's files."
    >
      <div className="pb-1">
        <Verdict
          data-settings-archive-state={stats === null ? 'reading' : stats.sessions === 0 ? 'empty' : 'holding'}
          tone={stats === null ? 'todo' : 'ok'}
          text={
            stats === null
              ? 'Reading…'
              : stats.sessions === 0
                ? 'Nothing archived yet'
                : `${count(stats.sessions, 'conversation')} kept`
          }
        />
        <dl className="mt-2.5 space-y-1.5">
          <Fact label="Kept">
            <span data-settings-archive-sessions={String(stats?.sessions ?? 0)}>
              {count(stats?.sessions ?? 0, 'session')} · {count(stats?.messages ?? 0, 'message')}
            </span>
          </Fact>
          <Fact label="Stored">
            <span data-settings-archive-stored={String(used)}>
              {formatBytes(used)} of {formatBytes(maxBytes)} ({percentText})
            </span>
          </Fact>
          <Fact label="Dropped">
            <span data-settings-archive-evicted={String(stats?.evictedSessions ?? 0)}>
              {count(stats?.evictedSessions ?? 0, 'session')}
            </span>
          </Fact>
        </dl>
      </div>

      <Divider />

      <Row
        label="Keep at most"
        hint="At the limit the oldest conversation is dropped whole. Lowering it can drop some at once."
      >
        <Select
          value={String(maxBytes)}
          label="How much of the database the archive may use"
          data-settings-archive-max={String(maxBytes)}
          onChange={(value) => onMaxBytesChange(Number(value))}
        >
          {choices.map((choice) => (
            <option key={choice.bytes} value={String(choice.bytes)}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Row>
    </Group>
  )
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/** The five things this group can be saying, named so a driver can read one. */
export type UpdateOutcomeState = 'checking' | 'unasked' | 'newer' | 'current' | 'unreachable'

export interface UpdateOutcome {
  state: UpdateOutcomeState
  tone: 'ok' | 'warn' | 'todo'
  text: string
}

/**
 * The whole of what this group says, as one pure function of what it was given.
 *
 * Separate from the component because the five states are the interesting part
 * and a component cannot be asked what it would say. Exported so a driver could
 * reach it - though a check should write its own expected sentences rather than
 * import these, because one that asked this function what this function says
 * would be asserting that the code agrees with itself.
 *
 * `unreachable` is `todo` and not `warn`, which is the one judgement in here.
 * Offline is an expected answer, not a fault: nothing is broken, nothing is out
 * of date as far as anyone knows, and a machine on a train has done nothing
 * wrong. A warning triangle would be Helm blaming the user's network for a
 * question Helm asked on its own initiative. The sentence names the reason and
 * says what could not be *asked*, never what failed.
 */
export function updateOutcome(update: UpdateCheckResult | null, checking: boolean): UpdateOutcome {
  if (checking) return { state: 'checking', tone: 'todo', text: 'Asking GitHub…' }
  if (update === null) {
    return {
      state: 'unasked',
      tone: 'todo',
      text: 'Helm has not asked GitHub since it started.'
    }
  }
  if (update.error !== null) {
    return { state: 'unreachable', tone: 'todo', text: `Could not ask GitHub - ${update.error}.` }
  }
  if (update.newer && update.latest !== null) {
    return {
      state: 'newer',
      tone: 'todo',
      text: `${update.latest} is available. This build is ${update.current}.`
    }
  }
  return {
    state: 'current',
    tone: 'ok',
    text: `${update.current} is the newest release. Asked ${askedWhen(update.checkedAt)}.`
  }
}

/**
 * "just now" or "5m ago", from the instant the check carries.
 *
 * `formatAge` answers `now` under a minute, which does not take the word "ago",
 * and an unparseable instant answers nothing at all rather than `NaNm` - a row
 * or a payload from another build is a fact about the past, and the sentence
 * around this one is still true without its last clause.
 */
function askedWhen(checkedAt: string): string {
  const at = Date.parse(checkedAt)
  if (!Number.isFinite(at)) return 'this session'
  const age = formatAge(at)
  return age === 'now' ? 'just now' : `${age} ago`
}

/**
 * Releases: what this build is, what the newest one is, and how to ask.
 *
 * This was a single tick in the Appearance group, and the comment there argued
 * for keeping it there - "here rather than in a group of its own, because from
 * the user's side this is a line in the status bar", the same question the
 * usage row above it answered. That argument was right for as long as it was
 * one tick. It stops holding at six controls: two facts, a sentence, the tick
 * and two buttons, every one of them about releases and none of them about how
 * the app looks. The group outgrew the reason rather than contradicting it.
 *
 * What the old hint carried is kept rather than dropped: Helm downloads
 * nothing and installs nothing, and an update Helm told you about is still an
 * update you go and get.
 *
 * The two buttons are the point of the group and they are deliberately
 * independent of everything above them. Check now is live whatever the tick
 * says - the setting governs whether Helm asks by itself, not whether the user
 * may - and Release notes is live whatever the last check returned, because
 * "up to date", "could not ask" and "never asked" are exactly the three states
 * in which somebody wants to go and look for themselves.
 */
/**
 * The Files view. One row: whether a long line wraps, which the toggle in a
 * file's own status line writes too, so the two never disagree.
 */
function FilesGroup({ wrap, onWrapChange }: { wrap: boolean; onWrapChange: (wrap: boolean) => void }): JSX.Element {
  return (
    <Group name="files" title="Files" hint="How a file read from the Files view is shown.">
      <Row label="Wrap long lines" hint="Notes always wrap while you edit them.">
        <span data-settings-files-wrap={String(wrap)}>
          <Checkbox checked={wrap} onChange={() => onWrapChange(!wrap)} label="Wrap long lines in files" />
        </span>
      </Row>
    </Group>
  )
}

/**
 * The browser pane's posture, and what a Claude session may do with it.
 *
 * Four rows, because there are four decisions: where the pane may go at all,
 * what the address bar does with a phrase, whether the sessions Helm hosts can
 * drive it, and whether they are held to this machine when the pane is not.
 * Everything else about the pane - downloads denied, every permission but
 * clipboard writing and fullscreen denied, self-signed certificates accepted
 * for loopback and nowhere else - is not a setting and never will be. Those
 * are the app's postures, and a posture with a switch on it is a posture
 * somebody turns off on the afternoon it gets in their way.
 *
 * The two reach rows are deliberately adjacent and worded as a pair, because
 * the rule between them is an intersection and the failure to avoid is somebody
 * setting the second and believing it widened the first.
 */
function BrowserGroup({
  reach,
  onReachChange,
  search,
  onSearchChange,
  mcp,
  onMcpChange,
  mcpLocalOnly,
  onMcpLocalOnlyChange
}: {
  reach: BrowserReach
  onReachChange: (reach: BrowserReach) => void
  search: BrowserSearch
  onSearchChange: (search: BrowserSearch) => void
  mcp: boolean
  onMcpChange: (next: boolean) => void
  mcpLocalOnly: boolean
  onMcpLocalOnlyChange: (next: boolean) => void
}): JSX.Element {
  const engine = browserSearchName(search)
  return (
    <Group
      name="browser"
      title="Browser"
      hint="Pages in the Browser tab. Sites may copy to your clipboard and go full screen; downloads go to your own browser, and nothing else a site asks for is allowed."
    >
      <Row
        label="Where the pane may go"
        hint={
          reach === 'local'
            ? 'This machine only. Anything that is not localhost, 127.0.0.1 or ::1 is refused with a sentence and nothing is fetched.'
            : 'Anywhere. Helm still opens no page you did not ask for - the pane fetches the address you navigate to and nothing else.'
        }
      >
        <Select
          value={reach}
          label="Where the browser pane may go"
          data-settings-browser-reach={reach}
          onChange={(value) => onReachChange(value as BrowserReach)}
        >
          <option value="web">Anywhere I navigate to</option>
          <option value="local">This machine only</option>
        </Select>
      </Row>

      <Row
        label="Search from the address bar"
        hint={
          engine === null
            ? 'Off. Something that is not an address gets a sentence saying so, and nothing is fetched.'
            : `Something that is not an address goes to ${engine} when you press Enter. Nothing is sent while you type.`
        }
      >
        <Select
          value={search}
          label="Search from the address bar"
          data-settings-browser-search={search}
          onChange={(value) => onSearchChange(value as BrowserSearch)}
        >
          {BROWSER_SEARCH_ENGINES.map((choice) => (
            <option key={choice} value={choice}>
              {browserSearchName(choice) ?? 'Off'}
            </option>
          ))}
        </Select>
      </Row>

      <Row
        label="Let Claude drive the browser"
        hint={
          mcp
            ? 'Sessions Helm hosts can open pages of their own, read them, click and type, and drive a page of yours only once you share it from the browser bar. Helm serves the tools on a loopback port with a token unique to each session.'
            : 'Off. Helm opens no port at all and sessions are started without the tools, exactly as they were before.'
        }
      >
        <span data-settings-browser-mcp={String(mcp)}>
          <Checkbox
            checked={mcp}
            onChange={() => onMcpChange(!mcp)}
            label="Let Claude drive the browser"
          />
        </span>
      </Row>

      <Row
        label="…but only on this machine"
        hint={
          mcpLocalOnly
            ? 'Claude’s tools are held to localhost even where the pane may go further. You can still navigate the pane anywhere yourself.'
            : 'Claude’s tools reach as far as the pane does, and never further - the narrower of these two settings always wins.'
        }
      >
        {/* Not disabled when the tools are off, deliberately. The value is a
            standing preference: somebody who has confined the tools and then
            turns them off for an afternoon should find them still confined when
            they turn them back on, and a control that greys out is a control
            whose state people stop trusting. */}
        <span data-settings-browser-mcp-local={String(mcpLocalOnly)}>
          <Checkbox
            checked={mcpLocalOnly}
            onChange={() => onMcpLocalOnlyChange(!mcpLocalOnly)}
            label="Confine Claude’s browser tools to this machine"
          />
        </span>
      </Row>
    </Group>
  )
}

/**
 * What a session may learn about the other sessions.
 *
 * A group of its own beside Browser rather than a third tick inside it. The two
 * are served by one endpoint on one port, which is an implementation detail; a
 * person reading this pane is deciding two different things - whether an agent
 * may click things in a browser, and whether an agent may be told what their
 * other work is doing - and those have different answers for different people.
 */
function SessionsGroup({
  mcp,
  onMcpChange,
  restore,
  onRestoreChange
}: {
  mcp: boolean
  onMcpChange: (next: boolean) => void
  restore: boolean
  onRestoreChange: (next: boolean) => void
}): JSX.Element {
  return (
    <Group
      name="sessions"
      title="Sessions"
      hint="What a session Helm hosts may know about the others on this machine, so it can stay out of a working tree somebody else is in. Read-only, and never another session’s conversation."
    >
      <Row
        label="Let Claude see the other sessions"
        hint={
          mcp
            ? 'Sessions Helm hosts can list every Claude Code session running here - its name, its directory, whether it is busy or waiting on you - and, for the ones Helm started, what they are holding: child processes and listening ports. Not their conversations, and not the arguments they were launched with.'
            : 'Off. Helm serves the tools to nobody and sessions are started without them, exactly as they were before.'
        }
      >
        <span data-settings-session-mcp={String(mcp)}>
          <Checkbox
            checked={mcp}
            onChange={() => onMcpChange(!mcp)}
            label="Let Claude see the other sessions"
          />
        </span>
      </Row>
      <Row
        label="Resume after a crash without asking"
        hint={
          restore
            ? 'When Helm stops without shutting down, the next start reopens every session it was running, in the tab it had, and says what it could not.'
            : 'When Helm stops without shutting down, the next start lists the sessions it was running and asks which to reopen.'
        }
      >
        <span data-settings-restore-without-asking={String(restore)}>
          <Checkbox
            checked={restore}
            onChange={() => onRestoreChange(!restore)}
            label="Resume after a crash without asking"
          />
        </span>
      </Row>
    </Group>
  )
}

function UpdatesGroup({
  appVersion,
  releasesUrl,
  update,
  checking,
  onCheckNow,
  onOpenReleases,
  updateCheck,
  onUpdateCheckChange
}: {
  appVersion: string | null
  releasesUrl: string | null
  update: UpdateCheckResult | null
  checking: boolean
  onCheckNow: () => void
  onOpenReleases: () => void
  updateCheck: boolean
  onUpdateCheckChange: (next: boolean) => void
}): JSX.Element {
  const outcome = updateOutcome(update, checking)

  return (
    // The posture belongs to the group rather than to the tick, the way the
    // Claude CLI group carries its own: it is true of everything in
    // here, including the button, and it stayed true when the tick stopped
    // being the only thing that could ask.
    <Group
      name="updates"
      title="Updates"
      hint="The only request Helm makes on its own: it reads a version number. Nothing is downloaded."
    >
      <div className="pb-1">
        <Verdict
          data-settings-update-outcome={outcome.state}
          tone={outcome.tone}
          text={outcome.text}
        />
        <dl className="mt-2.5 space-y-1.5">
          <Fact label="Version">
            <span data-settings-app-version>{appVersion ?? NOTHING}</span>
          </Fact>
          {/* Empty after a check that could not complete, and that is the
              intended reading rather than a gap: the last request came back
              with no version in it, so there is no number here anybody has
              been told. Painting the previous one would be the status bar's
              mistake in reverse - a figure on screen that nothing just
              measured. */}
          <Fact label="Latest">
            <span data-settings-latest-version>{update?.latest ?? NOTHING}</span>
          </Fact>
        </dl>

        {outcome.state === 'unreachable' && (
          <p
            data-settings-update-offline
            className="mt-2.5 text-[11px] leading-[1.55] text-fg-subtle"
          >
            Release notes below still opens the releases page - that is a link handed to your
            browser, not a request Helm makes, so it works from here either way.
          </p>
        )}
      </div>

      <Divider />

      <Row
        label="Tell me about new releases"
        hint="Asks at launch, at most once a day, and says so in the status bar. Check now works either way."
      >
        <span data-settings-update-check={String(updateCheck)}>
          <Checkbox
            checked={updateCheck}
            onChange={() => onUpdateCheckChange(!updateCheck)}
            label="Check for new releases on launch"
          />
        </span>
      </Row>

      <Actions>
        {/* Disabled only while a check is in flight - never because the tick
            above is off. A button that greyed itself out when the automatic
            check was turned off would make the setting mean something it does
            not say. */}
        <Action data-settings-update-now onClick={onCheckNow} disabled={checking}>
          <RefreshIcon className={cn('mr-1.5 inline', checking && 'animate-spin')} />
          Check now
        </Action>
        <Action
          data-settings-releases
          onClick={onOpenReleases}
          disabled={releasesUrl === null}
          title={releasesUrl ?? 'Not known until app:info lands'}
        >
          Release notes
        </Action>
      </Actions>
    </Group>
  )
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

const CURSOR_LABEL: Record<TerminalCursorStyle, string> = {
  block: 'Block',
  underline: 'Underline',
  bar: 'Bar'
}

/**
 * What the preview well renders.
 *
 * Box-drawing, block elements and the letters that are told apart only by their
 * shapes, because those are what a font chosen for its letterforms drops or
 * gets wrong - and Claude Code's whole interface is box-drawing.
 *
 * The rules are built from the body's own length rather than typed out: a
 * hand-counted box is exactly the kind of thing that goes one character out and
 * then looks like a rendering bug in the font someone is evaluating.
 */
const PREVIEW_BODY = '  0O1lI  {}[]  <=>  ~-  ░▒▓█  The quick brown fox  '
const PREVIEW_LINES = [
  `╭${'─'.repeat(PREVIEW_BODY.length)}╮`,
  `│${PREVIEW_BODY}│`,
  `╰${'─'.repeat(PREVIEW_BODY.length)}╯`
]

/**
 * Terminal appearance and the shell a project pane opens.
 *
 * Colour is deliberately absent. The xterm palette is fixed in both themes
 * (DESIGN.md par. 6, "foreign-ground islands") and asserted pixel-for-pixel by
 * the fidelity checks; making it settable is a design amendment, not a row.
 */
function TerminalGroup({
  terminal,
  onChange,
  fontStack,
  shells,
  onLocateShell
}: {
  terminal: TerminalSettings
  onChange: (patch: Partial<TerminalSettings>) => void
  fontStack: string
  shells: DetectedShell[]
  onLocateShell: () => void
}): JSX.Element {
  const chosenShell = terminal.terminalShell
  // A shell picked by hand may not be one of the detected ones, and dropping it
  // out of the list would make the picker show "Detect automatically" for a
  // setting that is doing no such thing.
  const shellOptions =
    chosenShell !== null && !shells.some((s) => sameFile(s.path, chosenShell))
      ? [...shells, { path: chosenShell, name: fileName(chosenShell), label: 'Chosen by you', args: [] }]
      : shells

  return (
    <Group
      name="terminal"
      title="Terminal"
      hint="Applies to every open terminal as you change it."
    >
      <FontRow terminal={terminal} onChange={onChange} />

      <Divider />

      <Row label="Size" hint={`Point size, ${String(TERMINAL_FONT_SIZE.min)} to ${String(TERMINAL_FONT_SIZE.max)}.`}>
        <Stepper
          value={terminal.terminalFontSize}
          min={TERMINAL_FONT_SIZE.min}
          max={TERMINAL_FONT_SIZE.max}
          label="Terminal font size"
          data-settings-terminal-size={String(terminal.terminalFontSize)}
          onChange={(terminalFontSize) => onChange({ terminalFontSize })}
        />
      </Row>

      <Divider />

      <Row label="Cursor">
        <div
          role="radiogroup"
          aria-label="Cursor style"
          className="flex items-center gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
        >
          {TERMINAL_CURSOR_STYLES.map((style) => (
            <button
              key={style}
              type="button"
              role="radio"
              data-settings-terminal-cursor={style}
              aria-checked={terminal.terminalCursorStyle === style}
              onClick={() => onChange({ terminalCursorStyle: style })}
              className={cn(
                'rounded-raised px-2.5 py-1 text-[11.5px] transition-colors',
                terminal.terminalCursorStyle === style
                  ? SEGMENT_ON
                  : 'text-fg-subtle hover:text-fg'
              )}
            >
              {CURSOR_LABEL[style]}
            </button>
          ))}
        </div>
      </Row>

      <Divider />

      <Row label="Blink the cursor">
        <span data-settings-terminal-blink={String(terminal.terminalCursorBlink)}>
          <Checkbox
            checked={terminal.terminalCursorBlink}
            onChange={() => onChange({ terminalCursorBlink: !terminal.terminalCursorBlink })}
            label="Blink the terminal cursor"
          />
        </span>
      </Row>

      <Divider />

      <Row
        label="Scrollback"
        hint="Lines of history each terminal keeps. Shrinking it discards what is already past that point."
      >
        <NumberField
          value={terminal.terminalScrollback}
          min={TERMINAL_SCROLLBACK.min}
          max={TERMINAL_SCROLLBACK.max}
          label="Scrollback lines"
          data-settings-terminal-scrollback={String(terminal.terminalScrollback)}
          onCommit={(terminalScrollback) => onChange({ terminalScrollback })}
        />
      </Row>

      <Divider />

      <Row
        label="Shell for project panes"
        hint="Claude sessions are unaffected. A project page can override it."
      >
        <div className="flex items-center gap-2">
          <Select
            value={chosenShell ?? ''}
            label="Default shell"
            data-settings-terminal-shell={chosenShell ?? ''}
            onChange={(value) => onChange({ terminalShell: value === '' ? null : value })}
          >
            <option value="">Detect automatically</option>
            {shellOptions.map((shell) => (
              <option key={shell.path} value={shell.path}>
                {shell.name} - {shell.label}
              </option>
            ))}
          </Select>
          <Action data-settings-terminal-shell-locate onClick={onLocateShell}>
            Choose…
          </Action>
        </div>
      </Row>

      <Divider />

      {/* The drag handle above the shell is the control for this; the row is
          here so the value is findable and so a drag that landed somewhere
          silly can be typed back. Which is also why it is a field rather than a
          stepper: nobody nudges this while watching it, because the thing it
          moves is on a different tab. */}
      <Row
        label="Shell height"
        hint="Share of a project page the shell takes, up to half. Dragging its handle changes it too."
      >
        <NumberField
          value={terminal.projectShellHeightPct}
          min={PROJECT_SHELL_HEIGHT_PCT.min}
          max={PROJECT_SHELL_HEIGHT_PCT.max}
          label="Project shell height"
          data-settings-shell-height={String(terminal.projectShellHeightPct)}
          onCommit={(projectShellHeightPct) => onChange({ projectShellHeightPct })}
        />
      </Row>

      {/* Plain DOM at the chosen font, not an xterm instance: the point is to
          see the choice before any terminal repaints, and a second terminal in
          the settings pane would be a second pty to own. The ground and the
          foreground are the terminal's own fixed pair (DESIGN.md par. 6), which
          is why they are hex here - the same exception the session tab takes. */}
      <div
        data-settings-terminal-preview
        // `lineHeight: normal` rather than a ratio of the point size, because
        // that is what a terminal row actually is: xterm measures a span in the
        // configured font and takes its box, so 14px type sits on 19px rows.
        // Pinning the rows to the point size instead would squash the preview
        // and pull the box-drawing apart at exactly the size it is meant to
        // show off.
        style={{
          fontFamily: fontStack,
          fontSize: `${String(terminal.terminalFontSize)}px`,
          lineHeight: 'normal'
        }}
        className="mt-3 overflow-x-auto rounded-well border border-border bg-terminal px-3 py-2.5 text-[#c9d1d9] select-text"
      >
        {PREVIEW_LINES.map((line) => (
          <div key={line} className="whitespace-pre">
            {line}
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-[11px] leading-[1.5] text-fg-subtle">
        The terminal keeps its own ground in both themes, so this is what a pane will look like.
      </p>
    </Group>
  )
}

/**
 * The font family row, with the "you do not have that font" hint.
 *
 * The hint is a courtesy, not a guard. Whatever is typed here is put *in front
 * of* the built-in stack rather than replacing it, so a font this machine does
 * not have simply never wins a glyph - and a font that has letters but no
 * box-drawing loses only the box-drawing. That is what makes the field safe to
 * leave open rather than restricting it to a list.
 */
function FontRow({
  terminal,
  onChange
}: {
  terminal: TerminalSettings
  onChange: (patch: Partial<TerminalSettings>) => void
}): JSX.Element {
  const saved = terminal.terminalFontFamily ?? ''
  const [draft, setDraft, reset] = useDraft(saved)

  const commit = (): void => {
    const next = draft.trim()
    if (next === saved) return
    onChange({ terminalFontFamily: next === '' ? null : next })
  }

  return (
    <Row
      label="Font"
      hint="One family name. It goes in front of Cascadia Mono and Consolas rather than replacing them, so anything it lacks still draws."
    >
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex items-center gap-2">
          <input
            type="text"
            data-settings-terminal-font={saved}
            aria-label="Terminal font family"
            placeholder="Cascadia Mono (built in)"
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') reset()
            }}
            className={cn(
              'h-[30px] w-[190px] rounded-well border border-border bg-surface-sunken px-2.5',
              'font-mono text-[11.5px] text-fg placeholder:text-fg-subtle select-text',
              'focus:border-accent focus:outline-none'
            )}
          />
          <Action
            data-settings-terminal-font-clear
            onClick={() => onChange({ terminalFontFamily: null })}
            disabled={terminal.terminalFontFamily === null}
            title={
              terminal.terminalFontFamily === null
                ? 'Nothing to clear - this is the built-in stack'
                : 'Back to the built-in stack'
            }
          >
            Clear
          </Action>
        </div>
        {terminal.terminalFontFamily !== null && !fontInstalled(terminal.terminalFontFamily) && (
          <p
            data-settings-terminal-font-missing={terminal.terminalFontFamily}
            className="max-w-[280px] text-right text-[11px] leading-[1.5] text-warn"
          >
            {terminal.terminalFontFamily} is not installed on this machine, so terminals fall back
            to Cascadia Mono and Consolas.
          </p>
        )}
      </div>
    </Row>
  )
}

/**
 * Whether this machine can actually draw that family.
 *
 * Measured, not asked. `document.fonts.check('14px "Whatever"')` is the obvious
 * call and it does not answer this question: the font set it reports on is the
 * document's `@font-face` rules, so a family it has never heard of comes back
 * **true** - verified on Chromium 2026-08-11, where a deliberately nonsense
 * name passed. What does answer it is the oldest trick there is: render a probe
 * string with the family in front of a fallback and again with the fallback
 * alone. A family that resolves changes the width; one that does not cannot.
 *
 * Two fallbacks with very different metrics, because one comparison would call
 * a font missing if it happened to match that fallback's advance exactly. At
 * 72px a real difference is tens of pixels, so this is not a close call.
 *
 * Cached: the answer cannot change while the window is open, and this runs on
 * every render of the row.
 */
const installedFonts = new Map<string, boolean>()

function fontInstalled(family: string): boolean {
  const cached = installedFonts.get(family)
  if (cached !== undefined) return cached

  let answer = true
  const context = document.createElement('canvas').getContext('2d')
  if (context !== null) {
    const width = (font: string): number => {
      context.font = font
      return context.measureText('MWMWiill 0123').width
    }
    answer = ['monospace', 'serif', 'sans-serif'].some(
      (fallback) => width(`72px "${family}", ${fallback}`) !== width(`72px ${fallback}`)
    )
  }
  installedFonts.set(family, answer)
  return answer
}

const sameFile = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? path

// ---------------------------------------------------------------------------

const count = (n: number, noun: string): string =>
  `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`

