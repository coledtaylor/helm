import type { JSX, ReactNode } from 'react'
import {
  offerableUsageModes,
  COST_MODE_UNAVAILABLE,
  USAGE_DISPLAY_MODES,
  type ThemePreference,
  type UsageDisplayMode
} from '@helm/core/types'
import { cn } from '../lib/cn'
import { CheckIcon, CloseIcon, RefreshIcon, WarnIcon } from './icons'
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
 * One scrolling page of grouped cards rather than sub-views. There are three
 * groups and eight controls; a segmented navigator over that many rows is
 * furniture standing in for content. When a group outgrows the page, it earns
 * its own view then.
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
}

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
  hasCostEstimate
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
      </div>
    </div>
  )
}

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
