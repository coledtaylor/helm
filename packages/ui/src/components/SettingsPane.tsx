import type { JSX, ReactNode } from 'react'
import { useState } from 'react'
import {
  offerableUsageModes,
  COST_MODE_UNAVAILABLE,
  DEFAULT_PR_REVIEW_PROMPT,
  EFFORT_LEVELS,
  PR_POLL_MINUTES,
  PR_PROMPT_PLACEHOLDERS,
  PR_REVIEW_PROMPT_MAX_LENGTH,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_FONT_SIZE,
  TERMINAL_SCROLLBACK,
  USAGE_DISPLAY_MODES,
  type AppSettings,
  type DetectedShell,
  withRepoIgnored,
  type EffortLevel,
  type GhStatus,
  type IgnoredRepo,
  type PrCheckoutMode,
  type PullRepo,
  type TerminalCursorStyle,
  type ThemePreference,
  type UsageDisplayMode
} from '@helm/core/types'
import { cn } from '../lib/cn'
import { CaretIcon, CheckIcon, CloseIcon, RefreshIcon, WarnIcon } from './icons'
import type { SetupClaudeStatus } from './SetupPane'
import { ThemeToggle } from './ThemeToggle'

/**
 * Helm's own settings.
 *
 * Deliberately not the config console: that pane edits the `.claude` trees
 * Claude Code reads, which belong to Claude and are shared with every other
 * client on the machine. This one is the app's own configuration, and it is the
 * permanent home for it - every setting a later feature adds lands here as
 * another row in an existing group or another group at the end.
 *
 * One scrolling page of grouped cards rather than sub-views. Five groups and
 * seventeen controls; a segmented navigator over that many rows is furniture
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

  theme: ThemePreference
  onThemeChange: (theme: ThemePreference) => void

  usageDisplay: UsageDisplayMode
  onUsageDisplayChange: (mode: UsageDisplayMode) => void
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
   * What Helm found out about `gh`, out of the pull-request snapshot. Null
   * until the first pass has resolved it.
   */
  gh: GhStatus | null
  /** Native file picker, the same shape the Claude CLI row uses. */
  onLocateGh: () => void
  /** Writes `ghPath: null` - back to whatever discovery finds. */
  onClearGhOverride: () => void
  prPollMinutes: number
  onPrPollMinutesChange: (minutes: number) => void
  /**
   * Every github.com repository Helm knows of and whether each is ignored, out
   * of the same snapshot the Pulls pane paints.
   *
   * Derived from the snapshot rather than from `prIgnoredRepos` alone, because
   * a list of slugs is not a list of choices: the repositories that can be
   * ignored are the ones discovery actually found, and they only exist in the
   * snapshot.
   */
  prRepos: PrRepoChoice[]
  /** Takes the whole list, because that is how the setting is written. */
  onPrIgnoredReposChange: (slugs: string[]) => void
  /** The template a "Review with Claude" launch composes its prompt from. */
  prReviewPrompt: string
  onPrReviewPromptChange: (template: string) => void
  prCheckout: PrCheckoutMode
  onPrCheckoutChange: (mode: PrCheckoutMode) => void
  /** Null for either of these is "pass no flag", not a model called null. */
  prReviewModel: string | null
  onPrReviewModelChange: (model: string | null) => void
  prReviewEffort: EffortLevel | null
  onPrReviewEffortChange: (effort: EffortLevel | null) => void
}

/** One tickable repository in the GitHub group's list. */
export interface PrRepoChoice {
  /** `owner/name`. The identity, and what the setting stores. */
  slug: string
  /** A folder name to read it by, since a slug is not what anybody calls it. */
  name: string
  ignored: boolean
  /** Whether a scanned project maps to it. False ones are still removable. */
  present: boolean
}

/**
 * The snapshot's two repository lists, merged into one set of choices.
 *
 * Deduplicated **by slug**, because that is the granularity of the setting: two
 * checkouts of one repository are two rows in the Pulls pane and one tick here,
 * and offering two ticks for one value would let a user untick a box and watch
 * the other one stay ticked.
 *
 * `snapshot.ignored` carries entries no project maps to - a repository that has
 * been deleted or moved since it was ignored - and they are kept rather than
 * filtered, because an entry that vanished from this list would be a repository
 * ignored for ever with no way left to say otherwise.
 */
export function pullRepoChoices(
  repos: readonly PullRepo[],
  ignored: readonly IgnoredRepo[]
): PrRepoChoice[] {
  const choices = new Map<string, PrRepoChoice>()
  for (const repo of repos) {
    if (repo.slug === null) continue
    const key = repo.slug.toLowerCase()
    if (choices.has(key)) continue
    choices.set(key, { slug: repo.slug, name: repo.name, ignored: false, present: true })
  }
  for (const repo of ignored) {
    choices.set(repo.slug.toLowerCase(), {
      slug: repo.slug,
      name: repo.name,
      ignored: true,
      present: repo.present
    })
  }
  return [...choices.values()].sort((a, b) =>
    a.slug.toLowerCase().localeCompare(b.slug.toLowerCase())
  )
}

/** The six the Terminal group owns, named once so nothing has to list them twice. */
export type TerminalSettings = Pick<
  AppSettings,
  | 'terminalFontFamily'
  | 'terminalFontSize'
  | 'terminalCursorStyle'
  | 'terminalCursorBlink'
  | 'terminalScrollback'
  | 'terminalShell'
>

/** What a fact reads when there is nothing to put in it. */
const NOTHING = '-'

const USAGE_LABEL: Record<UsageDisplayMode, string> = {
  percent: 'Percent',
  cost: 'Cost',
  off: 'Off'
}

export function SettingsPane({
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
  theme,
  onThemeChange,
  usageDisplay,
  onUsageDisplayChange,
  hasCostEstimate,
  terminal,
  onTerminalChange,
  terminalFontStack,
  shells,
  onLocateShell,
  gh,
  onLocateGh,
  onClearGhOverride,
  prPollMinutes,
  onPrPollMinutesChange,
  prRepos,
  onPrIgnoredReposChange,
  prReviewPrompt,
  onPrReviewPromptChange,
  prCheckout,
  onPrCheckoutChange,
  prReviewModel,
  onPrReviewModelChange,
  prReviewEffort,
  onPrReviewEffortChange
}: SettingsPaneProps): JSX.Element {
  const found = status !== null && status.path !== null && status.version !== null
  const overridden = status?.source === 'setting'
  const offerable = offerableUsageModes(hasCostEstimate)

  return (
    <div
      data-settings-pane
      className="h-full overflow-y-auto rounded-island border border-border bg-surface"
    >
      <div className="mx-auto w-full max-w-[720px] px-7 py-7">
        <h1 className="text-[17px] font-medium tracking-tight text-fg">Settings</h1>
        <p className="mt-1 text-[12.5px] leading-[1.55] text-fg-muted">
          Helm&rsquo;s own settings. Claude&rsquo;s <code className="font-mono text-[11px]">.claude</code>{' '}
          trees are the config console&rsquo;s, one tab over.
        </p>

        <Group
          name="claude"
          title="Claude CLI"
          hint="The executable Helm hands a pty to. Found on PATH unless you point it somewhere else."
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
            A folder of repositories works on its own. A <em>harness</em> is any folder with a{' '}
            <code className="font-mono">harness.yaml</code> in it - that is the whole definition,
            and it is what lets one session compose several repos&rsquo; skills at once. Removing a
            folder here only stops Helm scanning it; nothing on disk is touched.
          </p>

          <Actions>
            <Action data-settings-add-root onClick={onAddRoot} primary={roots.length === 0}>
              Add a folder
            </Action>
          </Actions>
        </Group>

        <Group name="appearance" title="Appearance">
          <Row
            label="Theme"
            hint="System follows Windows. The same three-way switch sits in the title bar."
          >
            <span data-settings-theme={theme}>
              <ThemeToggle value={theme} onChange={onThemeChange} />
            </span>
          </Row>

          <Divider />

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
                      'rounded-[5px] px-2.5 py-1 text-[11.5px] transition-colors',
                      usageDisplay === mode
                        ? 'bg-surface-raised text-fg ring-1 ring-border-strong'
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

        <TerminalGroup
          terminal={terminal}
          onChange={onTerminalChange}
          fontStack={terminalFontStack}
          shells={shells}
          onLocateShell={onLocateShell}
        />

        <GitHubGroup
          gh={gh}
          onLocate={onLocateGh}
          onClearOverride={onClearGhOverride}
          pollMinutes={prPollMinutes}
          onPollMinutesChange={onPrPollMinutesChange}
          repos={prRepos}
          onIgnoredChange={onPrIgnoredReposChange}
          reviewPrompt={prReviewPrompt}
          onReviewPromptChange={onPrReviewPromptChange}
          checkout={prCheckout}
          onCheckoutChange={onPrCheckoutChange}
          reviewModel={prReviewModel}
          onReviewModelChange={onPrReviewModelChange}
          reviewEffort={prReviewEffort}
          onReviewEffortChange={onPrReviewEffortChange}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/**
 * The intervals offered, and what each one is for.
 *
 * A select rather than a stepper: the useful values are decades apart, and
 * nobody nudges a polling interval while watching the result. `0` is off and is
 * first, because turning it off is the one choice somebody comes here
 * specifically to make.
 */
const POLL_CHOICES: Array<{ minutes: number; label: string }> = [
  { minutes: 0, label: 'Off - only when I ask' },
  { minutes: 5, label: 'Every 5 minutes' },
  { minutes: 15, label: 'Every 15 minutes' },
  { minutes: 30, label: 'Every 30 minutes' },
  { minutes: 60, label: 'Hourly' },
  { minutes: 240, label: 'Every 4 hours' },
  { minutes: 1440, label: 'Daily' }
]

/**
 * The GitHub CLI, and how often Helm asks it anything.
 *
 * Two rows and a status, and it is the *status* that carries the rule: Helm
 * holds no GitHub credential, so everything on this surface happens through the
 * `gh` on this machine, signed in by the user, in a terminal Helm has nothing to
 * do with. The remedy for "not signed in" is therefore a sentence rather than a
 * button - the same shape the Claude CLI group takes, for the same reason.
 *
 * The interval is here rather than in the Pulls pane's own header on purpose:
 * settings for Helm live in one place, and a disclosure strip inside a pane is
 * a second place for a setting to hide.
 */
function GitHubGroup({
  gh,
  onLocate,
  onClearOverride,
  pollMinutes,
  onPollMinutesChange,
  repos,
  onIgnoredChange,
  reviewPrompt,
  onReviewPromptChange,
  checkout,
  onCheckoutChange,
  reviewModel,
  onReviewModelChange,
  reviewEffort,
  onReviewEffortChange
}: {
  gh: GhStatus | null
  onLocate: () => void
  onClearOverride: () => void
  pollMinutes: number
  onPollMinutesChange: (minutes: number) => void
  repos: PrRepoChoice[]
  onIgnoredChange: (slugs: string[]) => void
  reviewPrompt: string
  onReviewPromptChange: (template: string) => void
  checkout: PrCheckoutMode
  onCheckoutChange: (mode: PrCheckoutMode) => void
  reviewModel: string | null
  onReviewModelChange: (model: string | null) => void
  reviewEffort: EffortLevel | null
  onReviewEffortChange: (effort: EffortLevel | null) => void
}): JSX.Element {
  const found = gh !== null && gh.path !== null
  const overridden = gh?.source === 'setting'
  // A value written by hand or by an older build still has to be selectable, or
  // the picker would silently show something other than what is in force.
  const choices = POLL_CHOICES.some((choice) => choice.minutes === pollMinutes)
    ? POLL_CHOICES
    : [...POLL_CHOICES, { minutes: pollMinutes, label: `Every ${String(pollMinutes)} minutes` }]

  return (
    <Group
      name="github"
      title="GitHub"
      hint="Pull requests are fetched by running your own gh CLI. Helm stores no GitHub credential and never sees your token."
    >
      <div className="pb-1">
        <Verdict
          tone={gh === null ? 'todo' : found && gh.authenticated ? 'ok' : 'warn'}
          text={
            gh === null
              ? 'Looking…'
              : (gh.problem?.message ?? (overridden ? 'Set by you' : 'Found and signed in'))
          }
        />
        <dl className="mt-2.5 space-y-1.5">
          <Fact label="Path">
            <span data-settings-gh-path title={gh?.path ?? ''}>
              {gh?.path ?? NOTHING}
            </span>
          </Fact>
          <Fact label="Version">
            <span data-settings-gh-version>{gh?.version ?? NOTHING}</span>
          </Fact>
        </dl>
      </div>

      <Actions>
        <Action data-settings-gh-locate onClick={onLocate}>
          Locate manually…
        </Action>
        <Action
          data-settings-clear-gh
          onClick={onClearOverride}
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

      <Divider />

      <Row
        label="Check for pull requests"
        hint={
          pollMinutes === PR_POLL_MINUTES.off
            ? 'Off. The pane still refreshes when you ask it to and when Helm comes back to the front.'
            : 'A gh call per repository on this schedule, plus whenever you ask and when Helm comes back to the front.'
        }
      >
        <Select
          value={String(pollMinutes)}
          label="How often to check for pull requests"
          data-settings-pr-poll={String(pollMinutes)}
          onChange={(value) => onPollMinutesChange(Number(value))}
        >
          {choices.map((choice) => (
            <option key={choice.minutes} value={String(choice.minutes)}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Row>

      <Divider />

      <RepositoriesRow repos={repos} onChange={onIgnoredChange} />

      <Divider />

      <ReviewPromptRow value={reviewPrompt} onChange={onReviewPromptChange} />

      <Divider />

      <Row
        label="Check the branch out first"
        hint={
          checkout === 'checkout'
            ? 'Runs gh pr checkout in the repository before the session starts, and refuses when the tree has uncommitted changes - Helm does not stash.'
            : 'Off. Reviews run against the pull request on GitHub, so nothing in your working tree moves.'
        }
      >
        <Select
          value={checkout}
          label="What a review does to the working tree"
          data-settings-pr-checkout={checkout}
          onChange={(value) => onCheckoutChange(value as PrCheckoutMode)}
        >
          <option value="none">Leave my tree alone</option>
          <option value="checkout">Check the pull request out</option>
        </Select>
      </Row>

      <Divider />

      {/* Two rows rather than one, because they are two flags and either can be
          set without the other: an effort with no model named is a perfectly
          ordinary thing to want, and a combined control would have to invent a
          meaning for half of itself. */}
      <Row
        label="Review model"
        hint={
          reviewModel === null
            ? 'Whatever claude starts with. Helm passes no --model at all.'
            : `Adds --model ${reviewModel} to the review launch, and to nothing else.`
        }
      >
        <Select
          value={reviewModel ?? ''}
          label="The model a review session runs on"
          data-settings-pr-model={reviewModel ?? ''}
          onChange={(value) => onReviewModelChange(value === '' ? null : value)}
        >
          <option value="">Claude Code&rsquo;s default</option>
          {/* A value written by hand or by an older build stays selectable, for
              the reason the poll interval's list does the same: a picker that
              silently shows something other than what is in force is worse than
              one with an unfamiliar row in it. */}
          {reviewModels(reviewModel).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
      </Row>

      <Divider />

      <Row
        label="Review effort"
        hint={
          reviewEffort === null
            ? 'Whatever claude starts with. Helm passes no --effort at all.'
            : `Adds --effort ${reviewEffort} to the review launch, and to nothing else.`
        }
      >
        <Select
          value={reviewEffort ?? ''}
          label="The reasoning effort a review session runs at"
          data-settings-pr-effort={reviewEffort ?? ''}
          onChange={(value) => onReviewEffortChange(value === '' ? null : (value as EffortLevel))}
        >
          <option value="">Claude Code&rsquo;s default</option>
          {EFFORT_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </Select>
      </Row>
    </Group>
  )
}

/**
 * The model names offered, plus whatever is already set.
 *
 * The shortlist is the CLI's aliases rather than full model ids, because those
 * are what a person types and they outlive any one release. The setting itself
 * is not validated against this list (see `SETTING_VALIDATORS.prReviewModel`) -
 * so a full id written into the database by hand is honoured, and appears here
 * so the picker can show it.
 */
function reviewModels(current: string | null): string[] {
  const known = ['opus', 'sonnet', 'haiku', 'fable']
  return current === null || known.includes(current) ? known : [...known, current]
}

/**
 * Which repositories the pull-request surface pays attention to.
 *
 * A tick per repository rather than a text field of slugs, because the useful
 * question is "which of the ones I have" and the answer is a set the app
 * already knows. Ticked is fetched: the list reads as what Helm is doing rather
 * than as what it is not, so the default state of everything is on and nobody
 * has to enrol a repository they just cloned.
 *
 * The full-width list rather than a `Row`, for the same reason the scan roots
 * are one: a control with an unbounded number of lines in it cannot sit in the
 * right-hand column of a label-and-control row.
 *
 * Unticking here is the only place a repository can be ignored. The Pulls pane
 * shows what is ignored and can tick one back on, which is disclosure and the
 * undo of it; the setting itself lives with the other settings.
 */
/**
 * The folder a repository is checked out into, when that is worth a word.
 *
 * Which is rarely: a clone is nearly always in a directory named after the
 * repository, so printing it beside every slug would be the same string twice
 * on most rows. Case is not a difference - `WidgetKit` cloned into `widgetkit`
 * is the same name - so only a genuinely different folder gets named.
 */
function folderNote(repo: PrRepoChoice): string | null {
  const name = repo.slug.split('/')[1] ?? ''
  return repo.name.toLowerCase() === name.toLowerCase() ? null : repo.name
}

function RepositoriesRow({
  repos,
  onChange
}: {
  repos: PrRepoChoice[]
  onChange: (slugs: string[]) => void
}): JSX.Element {
  const ignored = repos.filter((repo) => repo.ignored).map((repo) => repo.slug)
  const fetched = repos.length - ignored.length

  return (
    <div data-settings-pr-repos={String(repos.length)} className="py-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[12.5px] text-fg">Repositories</p>
        {repos.length > 0 && (
          <p data-settings-pr-repo-count className="text-[11px] tabular-nums text-fg-subtle">
            {String(fetched)} of {String(repos.length)} fetched
          </p>
        )}
      </div>
      <p className="mt-0.5 text-[11px] leading-[1.5] text-fg-subtle">
        Untick one and Helm stops checking it - no <code className="font-mono">gh</code> call, and
        no rows in the Pulls pane, which names it at the bottom so nothing goes missing quietly.
        Whatever it already fetched is kept for when you tick it back on.
      </p>

      {repos.length === 0 ? (
        <p className="mt-2 text-[12px] text-fg-subtle">
          Nothing with a github.com <code className="font-mono">origin</code> has been found yet.
        </p>
      ) : (
        <ul className="mt-2.5 overflow-hidden rounded-well border border-border bg-surface-sunken">
          {repos.map((repo) => (
            <li
              key={repo.slug}
              data-settings-pr-repo={repo.slug}
              data-settings-pr-repo-ignored={String(repo.ignored)}
              className="flex items-center gap-2.5 border-b border-border px-3 py-1.5 last:border-b-0"
            >
              <Checkbox
                checked={!repo.ignored}
                onChange={() => onChange(withRepoIgnored(ignored, repo.slug, !repo.ignored))}
                label={`Fetch pull requests from ${repo.slug}`}
              />
              {/* The slug leads, so the mono column has one left edge to read
                  down. The folder name would put a ragged word in front of
                  every one of them for a string that is usually the second
                  half of the slug again. */}
              <span
                className={cn(
                  'min-w-0 flex-1 truncate font-mono text-[11px]',
                  repo.ignored ? 'text-fg-subtle' : 'text-fg-muted'
                )}
                title={repo.slug}
              >
                {repo.slug}
              </span>
              {folderNote(repo) !== null && (
                <span
                  className="min-w-0 max-w-[35%] shrink-0 truncate text-[11px] text-fg-subtle"
                  title={`The folder Helm scans is called ${String(folderNote(repo))}`}
                >
                  {folderNote(repo)}
                </span>
              )}
              {!repo.present && (
                <span
                  className="shrink-0 text-[10.5px] text-fg-subtle"
                  title="Ignored, but no folder Helm scans has this origin any more. Tick it to forget the entry."
                >
                  not scanned
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The review prompt template.
 *
 * A free text field rather than a picker, because what "review this" means is
 * the user's and not Helm's: the default runs Claude Code's built-in
 * `/code-review` skill, and a team with a review command of its own should be
 * able to name it without a build.
 *
 * Committed on blur or Enter, like the terminal font field and for the same
 * reason - typing `/code-review {number}` through a live write would save
 * fourteen intermediate templates, three of which are a bare `/`.
 *
 * The placeholder list under it is not a nicety. `{branch}` in particular is a
 * trap worth naming in the surface that offers it: it is GitHub's `headRefName`,
 * and on a pull request opened from a fork that branch does not exist in the
 * local checkout at all unless the checkout row below is on. The shipped default
 * uses `{number}` alone for exactly that reason.
 */
function ReviewPromptRow({
  value,
  onChange
}: {
  value: string
  onChange: (template: string) => void
}): JSX.Element {
  const [draft, setDraft, reset] = useDraft(value)

  const commit = (): void => {
    const next = draft.trim()
    // Empty is not "no prompt" - the validator refuses it, and a blank template
    // would silently make the review button start an ordinary session.
    if (next === '' || next === value) {
      reset()
      return
    }
    onChange(next)
  }

  return (
    <Row
      label="Review prompt"
      hint="The first message a “Review with Claude” session is started with. The pull request pane shows exactly what it will run before you press the button."
    >
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex items-center gap-2">
          <input
            type="text"
            data-settings-pr-prompt={value}
            aria-label="Review prompt template"
            placeholder={DEFAULT_PR_REVIEW_PROMPT}
            spellCheck={false}
            maxLength={PR_REVIEW_PROMPT_MAX_LENGTH}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') reset()
            }}
            className={cn(
              'h-[30px] w-[260px] rounded-well border border-border bg-surface-sunken px-2.5',
              'font-mono text-[11.5px] text-fg placeholder:text-fg-subtle select-text',
              'focus:border-accent focus:outline-none'
            )}
          />
          <Action
            data-settings-pr-prompt-reset
            onClick={() => onChange(DEFAULT_PR_REVIEW_PROMPT)}
            disabled={value === DEFAULT_PR_REVIEW_PROMPT}
            title={
              value === DEFAULT_PR_REVIEW_PROMPT
                ? 'Nothing to reset - this is the built-in prompt'
                : 'Back to the built-in code review'
            }
          >
            Reset
          </Action>
        </div>
        <p className="max-w-[320px] text-right text-[11px] leading-[1.55] text-fg-subtle">
          {PR_PROMPT_PLACEHOLDERS.map((name) => `{${name}}`).join(' ')} are substituted; anything
          else in braces is passed through as you wrote it.{' '}
          <span className="text-fg-muted">
            {'{branch}'} is the head branch on GitHub, which a fork&rsquo;s pull request does not
            have locally unless the checkout below is on.
          </span>
        </p>
      </div>
    </Row>
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
      hint="Applies to every open terminal as you change it - session panes and project shells alike."
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
                'rounded-[5px] px-2.5 py-1 text-[11.5px] transition-colors',
                terminal.terminalCursorStyle === style
                  ? 'bg-surface-raised text-fg ring-1 ring-border-strong'
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
        hint="Claude sessions are unaffected - Helm hands the CLI its own terminal. A project pane can override this for itself."
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
 * A field's own copy of a value it edits, committed on blur rather than on
 * every keystroke.
 *
 * Re-seeded when the value changes underneath it - a restart, a Clear button,
 * another surface writing the same setting - by adjusting state during render,
 * which is what React documents for this. An effect would paint one frame of a
 * stale draft first and would be a cascading render besides.
 */
function useDraft(value: string): [string, (next: string) => void, () => void] {
  const [draft, setDraft] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setDraft(value)
  }
  return [draft, setDraft, () => setDraft(value)]
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
  `${String(n)} ${noun}${n === 1 ? '' : 's'}`

/**
 * One group of settings.
 *
 * A raised card inside the pane's island, titled with the caps label every
 * other section in the app uses. Future groups append; nothing here knows how
 * many there are.
 */
function Group({
  name,
  title,
  hint,
  children
}: {
  name: string
  title: string
  hint?: string | undefined
  children: ReactNode
}): JSX.Element {
  return (
    <section
      data-settings-group={name}
      className="mt-5 overflow-hidden rounded-raised border border-border bg-surface-raised"
    >
      <header className="px-4 pt-3 pb-2.5">
        <h2 className="text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
          {title}
        </h2>
        {hint !== undefined && (
          <p className="mt-1 text-[11.5px] leading-[1.5] text-fg-muted">{hint}</p>
        )}
      </header>
      <div className="border-t border-border px-4 py-3">{children}</div>
    </section>
  )
}

/** Label and hint on the left, control on the right - wrapping when narrow. */
function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string | undefined
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-1.5">
      <div className="min-w-[220px] flex-1">
        <p className="text-[12.5px] text-fg">{label}</p>
        {hint !== undefined && (
          <p className="mt-0.5 text-[11px] leading-[1.5] text-fg-subtle">{hint}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** Between rows in a group. Fades at the ends - DESIGN.md, `.island-rule`. */
function Divider(): JSX.Element {
  return <div aria-hidden className="island-rule my-1.5" />
}

function Actions({ children }: { children: ReactNode }): JSX.Element {
  return <div className="mt-3 flex flex-wrap gap-2">{children}</div>
}

/** The resolved-status line: a tone dot and a sentence, not a paragraph. */
function Verdict({ tone, text }: { tone: 'ok' | 'warn' | 'todo'; text: string }): JSX.Element {
  return (
    <p data-settings-verdict={tone} className="flex items-center gap-2 text-[12.5px] text-fg">
      <span
        className={cn(
          'grid size-4 shrink-0 place-items-center rounded-full',
          tone === 'ok'
            ? 'bg-success/15 text-success'
            : tone === 'warn'
              ? 'bg-warn/15 text-warn'
              : 'bg-surface-sunken text-fg-subtle'
        )}
      >
        {tone === 'ok' ? (
          <CheckIcon width={9} height={9} />
        ) : tone === 'warn' ? (
          <WarnIcon width={9} height={9} />
        ) : null}
      </span>
      {text}
    </p>
  )
}

/** A machine fact: a caps label and a mono value that can be selected. */
function Fact({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-[52px] shrink-0 text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-muted select-text">
        {children}
      </dd>
    </div>
  )
}

/**
 * A bounded integer with two buttons.
 *
 * Buttons rather than a text field because the range is small and every value
 * in it is one the user might want to sit and look at: this is a setting people
 * nudge until the terminal looks right, and every nudge repaints every open
 * pane. It also means the control cannot produce a value the validator would
 * reject, so the two never have to disagree.
 */
function Stepper({
  value,
  min,
  max,
  label,
  onChange,
  ...rest
}: {
  value: number
  min: number
  max: number
  label: string
  onChange: (value: number) => void
} & Record<`data-${string}`, unknown>): JSX.Element {
  return (
    <div
      {...rest}
      className="flex items-center gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
    >
      <StepButton
        label={`Decrease ${label.toLowerCase()}`}
        glyph="−"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
      />
      <span
        aria-live="polite"
        aria-label={label}
        className="w-9 text-center font-mono text-[11.5px] tabular-nums text-fg"
      >
        {value}
      </span>
      <StepButton
        label={`Increase ${label.toLowerCase()}`}
        glyph="+"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
      />
    </div>
  )
}

function StepButton({
  label,
  glyph,
  disabled,
  onClick
}: {
  label: string
  glyph: string
  disabled: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'grid size-6 place-items-center rounded-[5px] text-[13px] leading-none transition-colors',
        'text-fg-subtle hover:bg-hover hover:text-fg',
        'disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent'
      )}
    >
      {glyph}
    </button>
  )
}

/**
 * A number too large for a stepper, committed on blur or Enter rather than per
 * keystroke - typing "25000" through a live write would ask for 2, then 25,
 * then 250, and every one of those is a scrollback truncation.
 */
function NumberField({
  value,
  min,
  max,
  label,
  onCommit,
  ...rest
}: {
  value: number
  min: number
  max: number
  label: string
  onCommit: (value: number) => void
} & Record<`data-${string}`, unknown>): JSX.Element {
  const [draft, setDraft, reset] = useDraft(String(value))

  const commit = (): void => {
    const parsed = Number.parseInt(draft, 10)
    if (!Number.isFinite(parsed)) {
      reset()
      return
    }
    const clamped = Math.min(max, Math.max(min, parsed))
    setDraft(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') reset()
      }}
      {...rest}
      className={cn(
        'h-[30px] w-[92px] rounded-well border border-border bg-surface-sunken px-2.5',
        'text-right font-mono text-[11.5px] tabular-nums text-fg select-text',
        'focus:border-accent focus:outline-none'
      )}
    />
  )
}

/**
 * A native `<select>` in the sunken-well shape, matching the one in
 * `ProfileEditor`. Native and not a listbox of our own for the same reason: a
 * driver sets it through `HTMLSelectElement.prototype.value`, and a div cannot
 * be set that way.
 */
function Select({
  value,
  onChange,
  label,
  children,
  ...rest
}: {
  value: string
  onChange: (value: string) => void
  label: string
  children: ReactNode
} & Record<`data-${string}`, unknown>): JSX.Element {
  return (
    <span className="relative block">
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        {...rest}
        className={cn(
          'h-[30px] w-[220px] appearance-none rounded-well border border-border bg-surface-sunken',
          'pr-7 pl-2.5 text-[12px] text-fg focus:border-accent focus:outline-none'
        )}
      >
        {children}
      </select>
      <CaretIcon
        width={9}
        height={9}
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rotate-90 text-fg-subtle"
      />
    </span>
  )
}

/** The one control the system allows a solid accent fill (DESIGN.md par. 4). */
function Checkbox({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: () => void
  label: string
}): JSX.Element {
  return (
    <span className="relative grid size-4 place-items-center">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        aria-label={label}
        className={cn(
          'peer size-4 cursor-pointer appearance-none rounded-[5px] border-[1.5px] border-fg-subtle',
          'transition-colors checked:border-accent checked:bg-accent hover:border-fg-muted'
        )}
      />
      <CheckIcon
        width={10}
        height={10}
        className="pointer-events-none absolute text-accent-fg opacity-0 peer-checked:opacity-100"
      />
    </span>
  )
}

function Action({
  children,
  onClick,
  disabled = false,
  primary = false,
  ...rest
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  primary?: boolean
  title?: string
} & Record<`data-${string}`, unknown>): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...rest}
      className={cn(
        'rounded-well border px-3 py-1.5 text-[12px] transition-colors',
        'disabled:cursor-default disabled:opacity-50',
        primary
          ? 'border-accent text-accent-text hover:bg-accent-soft'
          : 'border-border-strong text-fg hover:bg-hover'
      )}
    >
      {children}
    </button>
  )
}
