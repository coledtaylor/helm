import type { JSX, ReactNode } from 'react'
import { useMemo, useState } from 'react'
import type { EffectiveEntry, EffectiveView, Profile } from '@helm/core'
import { cn } from '../lib/cn'
import { SEGMENT_ON } from '../lib/segmented'
import { formatBytes } from '../lib/time'
import { Checkbox } from './Checkbox'
import { AgentIcon, CommandIcon, LayersIcon, SearchIcon, SparkIcon, WarnIcon } from './icons'

export interface EffectiveViewPaneProps {
  profiles: Profile[]
  /** The profile the view is computed for, or null for a plain directory. */
  profileId: number | null
  onProfileChange: (id: number | null) => void
  /** Used when no profile is selected. */
  cwd: string
  onCwdChange: (cwd: string) => void
  view: EffectiveView | null
  loading: boolean
  error: string | null
  onReveal: (path: string) => void
  onOpenFile: (path: string) => void
}

type Kind = 'skills' | 'commands' | 'agents'

/**
 * What a session would actually see.
 *
 * This is the payoff of the composition model and the thing no file explorer
 * can tell you (SPEC 4.2). Two questions, and both of them are unanswerable by
 * looking at the files:
 *
 *   **Under what name does this resolve?** A skill in an overlaid repo is not
 *   `/think` in a session rooted somewhere else - it is `/<overlay>:think`,
 *   because the platform namespaces everything a plugin contributes by the
 *   plugin's manifest name (Spike A) and Helm chooses that name when it
 *   synthesises the shim. So the name is decidable in advance, and two repos
 *   that both define `think` both resolve, each under its own prefix. There is
 *   no shadowing to detect; there are names to predict.
 *
 *   **Which layer's value wins?** Three settings files can each define the same
 *   key, and the one a session reads is the highest-precedence layer that names
 *   it - per leaf, not per top-level key, which was measured rather than
 *   assumed.
 */
export function EffectiveViewPane({
  profiles,
  profileId,
  onProfileChange,
  cwd,
  onCwdChange,
  view,
  loading,
  error,
  onReveal,
  onOpenFile
}: EffectiveViewPaneProps): JSX.Element {
  const [kind, setKind] = useState<Kind>('skills')
  const [filter, setFilter] = useState('')
  const [onlyOverridden, setOnlyOverridden] = useState(true)

  const entries = useMemo(() => {
    const all = view === null ? [] : view[kind]
    const needle = filter.trim().toLowerCase()
    if (needle === '') return all
    return all.filter(
      (entry) =>
        entry.invocation.toLowerCase().includes(needle) ||
        (entry.description ?? '').toLowerCase().includes(needle)
    )
  }, [view, kind, filter])

  const settings = useMemo(() => {
    const all = view?.settings ?? []
    return onlyOverridden ? all.filter((setting) => setting.overridden) : all
  }, [view, onlyOverridden])

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-7">
        {/* --------------------------------------------------------------- */}
        {/* What is being predicted                                          */}
        {/* --------------------------------------------------------------- */}
        <header>
          <h2 className="text-[17px] leading-snug font-medium tracking-tight text-fg">
            What a session would see
          </h2>
          <p className="mt-1.5 max-w-2xl text-[12px] leading-relaxed text-fg-muted">
            Resolved from a working directory and the overlays composed into it. Names under an
            overlay carry that overlay&rsquo;s prefix, which the platform assigns and Helm chooses -
            so two repos defining the same skill both resolve, and neither hides the other.
          </p>
        </header>

        {/* Bounded rather than stretched: a select whose longest option is a
            profile name has no use for eight hundred pixels, and a control that
            wide reads as a text field. */}
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block w-64 shrink-0">
            <span className="mb-1 block text-[10px] font-medium tracking-wide text-fg-subtle uppercase">
              Profile
            </span>
            <select
              data-effective-profile
              aria-label="Profile"
              value={profileId === null ? '' : String(profileId)}
              onChange={(event) =>
                onProfileChange(event.target.value === '' ? null : Number(event.target.value))
              }
              className={fieldClass}
            >
              <option value="">A directory, with no overlays</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          {profileId === null && (
            <label className="block min-w-64 flex-1">
              <span className="mb-1 block text-[10px] font-medium tracking-wide text-fg-subtle uppercase">
                Working directory
              </span>
              <input
                data-effective-cwd
                aria-label="Working directory"
                value={cwd}
                onChange={(event) => onCwdChange(event.target.value)}
                spellCheck={false}
                className={cn(fieldClass, 'font-mono text-[11px]')}
              />
            </label>
          )}
        </div>

        {error !== null && (
          <p className="mt-4 rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            {error}
          </p>
        )}

        {view === null ? (
          <p className="mt-6 text-[12px] text-fg-subtle">
            {loading ? 'Resolving…' : 'Pick a profile or a directory.'}
          </p>
        ) : (
          <>
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
              <Metric label="skills" value={view.skills.length} />
              <Metric label="commands" value={view.commands.length} />
              <Metric label="agents" value={view.agents.length} />
              <Metric label="overlays" value={view.overlays.length} />
            </dl>

            <p className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] text-fg-subtle">
              <span>cwd</span>
              <button
                type="button"
                onClick={() => onReveal(view.cwd)}
                className="max-w-full truncate font-mono text-fg-muted transition-colors hover:text-accent-text"
              >
                {view.cwd}
              </button>
            </p>

            {view.warnings.length > 0 && (
              <ul className="mt-4 space-y-1.5">
                {view.warnings.map((warning) => (
                  <li
                    key={warning}
                    className="flex items-start gap-2 rounded-raised border border-warn/30 bg-warn/10 px-3 py-1.5 text-[11px] text-fg-muted"
                  >
                    <WarnIcon width={12} height={12} className="mt-0.5 shrink-0 text-warn" />
                    <span className="min-w-0">{warning}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* ----------------------------------------------------------- */}
            {/* Overlays                                                     */}
            {/* ----------------------------------------------------------- */}
            {view.overlays.length > 0 && (
              <Section title="Overlays" hint="Each contributes under its own namespace.">
                <ul className="overflow-hidden rounded-raised border border-border bg-surface-raised">
                  {view.overlays.map((overlay) => (
                    <li
                      key={overlay.projectPath}
                      data-overlay={overlay.name}
                      className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
                    >
                      <LayersIcon
                        width={13}
                        height={13}
                        className={cn('shrink-0', overlay.exists ? 'text-accent' : 'text-fg-subtle')}
                      />
                      <span className="shrink-0 rounded-sm bg-accent-soft px-1.5 py-px font-mono text-[11px] text-fg">
                        {overlay.name}:
                      </span>
                      <button
                        type="button"
                        onClick={() => onReveal(overlay.projectPath)}
                        className="min-w-0 flex-1 truncate text-left font-mono text-[10px] text-fg-subtle transition-colors hover:text-accent-text"
                      >
                        {overlay.projectPath}
                      </button>
                      {overlay.exists ? (
                        <span className="shrink-0 text-[10px] tabular-nums text-fg-muted">
                          <Plural n={overlay.skills} one="skill" /> ·{' '}
                          <Plural n={overlay.agents} one="agent" /> ·{' '}
                          <Plural n={overlay.commands} one="command" />
                        </span>
                      ) : (
                        <span className="shrink-0 rounded-sm border border-danger/40 px-1 text-[9px] tracking-wide text-danger uppercase">
                          missing
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {/* ----------------------------------------------------------- */}
            {/* Names that appear twice                                      */}
            {/* ----------------------------------------------------------- */}
            {view.sharedNames.length > 0 && (
              <Section
                title="Defined more than once"
                hint="Not a collision. Every copy resolves, each under its own prefix."
              >
                <ul className="space-y-1">
                  {view.sharedNames.map((shared) => (
                    <li
                      key={shared.name}
                      data-shared-name={shared.name}
                      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-raised border border-border bg-surface-raised px-3 py-1.5"
                    >
                      <span className="text-[12px] font-medium text-fg">{shared.name}</span>
                      <span className="text-[10px] text-fg-subtle">resolves as</span>
                      {shared.invocations.map((invocation) => (
                        <code
                          key={invocation}
                          className="rounded-sm bg-surface-sunken px-1.5 py-px font-mono text-[11px] text-fg-muted"
                        >
                          {invocation}
                        </code>
                      ))}
                    </li>
                  ))}
                </ul>
              </Section>
            )}

            {/* ----------------------------------------------------------- */}
            {/* Everything that resolves                                     */}
            {/* ----------------------------------------------------------- */}
            <Section
              title="Resolved names"
              hint="What you can type at the prompt in this session."
              actions={
                <div className="flex items-center gap-2">
                  <div className="flex gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5">
                    {(['skills', 'commands', 'agents'] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        data-effective-kind={option}
                        aria-pressed={kind === option}
                        onClick={() => setKind(option)}
                        className={cn(
                          'rounded-[5px] px-2 py-0.5 text-[11px] capitalize transition-colors',
                          kind === option
                            ? SEGMENT_ON
                            : 'text-fg-muted hover:text-fg'
                        )}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                  <div className="relative">
                    <SearchIcon
                      width={12}
                      height={12}
                      className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-subtle"
                    />
                    <input
                      value={filter}
                      onChange={(event) => setFilter(event.target.value)}
                      placeholder="Filter"
                      spellCheck={false}
                      aria-label="Filter resolved names"
                      className={cn(fieldClass, 'h-6 w-40 pl-6 text-[11px]')}
                    />
                  </div>
                </div>
              }
            >
              {entries.length === 0 ? (
                <p className="rounded-raised border border-border bg-surface-raised px-3 py-6 text-center text-[12px] text-fg-subtle">
                  {filter === '' ? `No ${kind} would resolve here.` : 'Nothing matches that.'}
                </p>
              ) : (
                <ul className="overflow-hidden rounded-raised border border-border bg-surface-raised">
                  {entries.map((entry) => (
                    <Entry key={`${entry.invocation}:${entry.path}`} entry={entry} kind={kind} onOpen={onOpenFile} />
                  ))}
                </ul>
              )}
            </Section>

            {/* ----------------------------------------------------------- */}
            {/* Settings                                                     */}
            {/* ----------------------------------------------------------- */}
            <Section
              title="Settings"
              hint="Highest layer that names a key wins, per leaf."
              actions={
                <label className="flex items-center gap-1.5 text-[11px] text-fg-muted">
                  <Checkbox
                    mark="data-only-overridden"
                    checked={onlyOverridden}
                    onChange={() => setOnlyOverridden(!onlyOverridden)}
                    label="Only where layers disagree"
                  />
                  Only where layers disagree
                </label>
              }
            >
              <ul className="mb-3 flex flex-wrap gap-2">
                {view.settingsLayers.map((layer) => (
                  <li
                    key={layer.file}
                    data-settings-layer={layer.kind}
                    title={layer.file}
                    className={cn(
                      'flex items-baseline gap-1.5 rounded-well border px-2 py-1 text-[11px]',
                      layer.error !== null
                        ? 'border-danger/40 bg-danger/10 text-danger'
                        : layer.exists
                          ? 'border-border-strong text-fg-muted'
                          : 'border-dashed border-border text-fg-subtle'
                    )}
                  >
                    <span className="font-medium">{layer.kind}</span>
                    <span className="tabular-nums">
                      {layer.error !== null
                        ? 'invalid JSON'
                        : layer.exists
                          ? `${layer.keys} keys`
                          : 'absent'}
                    </span>
                  </li>
                ))}
              </ul>

              {settings.length === 0 ? (
                <p className="rounded-raised border border-border bg-surface-raised px-3 py-6 text-center text-[12px] text-fg-subtle">
                  {onlyOverridden
                    ? 'No key is defined by more than one layer with a different value.'
                    : 'No settings are defined at any layer.'}
                </p>
              ) : (
                <ul className="overflow-hidden rounded-raised border border-border bg-surface-raised">
                  {settings.map((setting) => (
                    <li
                      key={setting.key}
                      data-setting={setting.key}
                      data-setting-winner={setting.winner}
                      className="border-b border-border px-3 py-2 last:border-b-0"
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg">
                          {setting.key}
                        </span>
                        <span className="shrink-0 rounded-sm bg-accent-soft px-1.5 py-px text-[10px] text-fg">
                          {setting.winner}
                        </span>
                      </div>
                      <p
                        className="mt-1 truncate font-mono text-[11px] text-fg-muted"
                        title={setting.value}
                      >
                        {setting.value}
                      </p>
                      {setting.overridden && (
                        <ul className="mt-1 space-y-0.5">
                          {setting.candidates.slice(1).map((candidate) => (
                            <li
                              key={candidate.layer}
                              className="flex items-baseline gap-2 text-[10px] text-fg-subtle"
                              title={candidate.file}
                            >
                              <span className="w-12 shrink-0">{candidate.layer}</span>
                              <span className="min-w-0 flex-1 truncate font-mono line-through">
                                {candidate.value}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {/* ----------------------------------------------------------- */}
            {/* Instructions                                                 */}
            {/* ----------------------------------------------------------- */}
            <Section
              title="Instruction files"
              hint="An overlay's CLAUDE.md arrives via --append-system-prompt-file; nothing else carries it."
            >
              {view.instructions.length === 0 ? (
                <p className="rounded-raised border border-border bg-surface-raised px-3 py-6 text-center text-[12px] text-fg-subtle">
                  No CLAUDE.md would reach this session.
                </p>
              ) : (
                <ul className="overflow-hidden rounded-raised border border-border bg-surface-raised">
                  {view.instructions.map((instruction) => (
                    <li
                      key={instruction.path}
                      data-instruction={instruction.source}
                      className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0"
                    >
                      <span className="w-14 shrink-0 text-[10px] tracking-wide text-fg-subtle uppercase">
                        {instruction.source}
                      </span>
                      <button
                        type="button"
                        onClick={() => onOpenFile(instruction.path)}
                        className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-fg-muted transition-colors hover:text-accent-text"
                      >
                        {instruction.path}
                      </button>
                      <span className="shrink-0 text-[10px] tabular-nums text-fg-subtle">
                        {formatBytes(instruction.bytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}
      </div>
    </div>
  )
}

const KIND_ICON = {
  skills: SparkIcon,
  commands: CommandIcon,
  agents: AgentIcon
} as const

function Entry({
  entry,
  kind,
  onOpen
}: {
  entry: EffectiveEntry
  kind: Kind
  onOpen: (path: string) => void
}): JSX.Element {
  const Icon = KIND_ICON[kind]
  return (
    <li
      data-invocation={entry.invocation}
      data-source={entry.source}
      className="flex items-start gap-3 border-b border-border px-3 py-2 last:border-b-0"
    >
      <Icon
        width={13}
        height={13}
        className={cn('mt-0.5 shrink-0', entry.namespace === null ? 'text-fg-subtle' : 'text-accent')}
      />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => onOpen(entry.path)}
          title={entry.path}
          className="block max-w-full truncate text-left font-mono text-[12px] text-fg transition-colors hover:text-accent-text"
        >
          {/* The prefix is the whole point, so it carries the colour and the
              bare name does not - a list of `api:` in accent and `think`
              in body text reads as "from api" at a glance. */}
          {entry.namespace !== null && <span className="text-accent">{entry.namespace}:</span>}
          {entry.name}
        </button>
        {entry.description !== null && (
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-fg-subtle">
            {entry.description}
          </p>
        )}
      </div>
      <span className="shrink-0 rounded-sm border border-border px-1 text-[9px] tracking-wide text-fg-subtle uppercase">
        {entry.source}
      </span>
    </li>
  )
}

const fieldClass = cn(
  'h-7 w-full rounded-well border border-border bg-surface-sunken px-2 text-[12px]',
  'text-fg placeholder:text-fg-subtle select-text',
  'transition-colors hover:border-border-strong focus:border-accent focus:outline-none'
)

function Plural({ n, one }: { n: number; one: string }): JSX.Element {
  return (
    <>
      {n} {n === 1 ? one : `${one}s`}
    </>
  )
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div>
      <dd
        className={cn(
          'text-[22px] leading-tight font-medium tabular-nums',
          value === 0 ? 'text-fg-subtle' : 'text-fg'
        )}
      >
        {value}
      </dd>
      <dt className="text-[11px] text-fg-subtle">{label}</dt>
    </div>
  )
}

function Section({
  title,
  hint,
  actions,
  children
}: {
  title: string
  hint?: string | undefined
  actions?: ReactNode | undefined
  children: ReactNode
}): JSX.Element {
  return (
    <section className="mt-7">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">{title}</h3>
        {hint !== undefined && (
          <p className="min-w-0 flex-1 text-[11px] text-fg-subtle">{hint}</p>
        )}
        {actions}
      </div>
      {children}
    </section>
  )
}
