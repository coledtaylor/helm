import type { JSX } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import type {
  PluginInfo,
  PluginLogLine,
  PluginMetrics,
  SecretInput,
  SecretsState
} from '@helm/core/types'
import { cn } from '../lib/cn'
import { formatBytes } from '../lib/time'
import { Checkbox } from './Checkbox'
import { DialogFooter, DialogHeader, secondaryButton } from './DialogParts'
import { EmptyState } from './EmptyState'
import { PlugIcon, PlusIcon, RefreshIcon, TrashIcon } from './icons'
import { Overlay } from './Overlay'
import { PluginIcon } from './PluginIcon'
import { SecretDialog, type SecretPluginChoice } from './SecretsSettings'
import { Action, Divider, Fact, Group, Row, Select, SettingsPage, Verdict, useDraft } from './SettingsKit'

/**
 * Settings > Plugins, and a page for each plugin.
 *
 * A plugin is a folder on this computer, registered by its path. The list says
 * which are on and which failed to load; a plugin's own page is everything
 * Helm knows about it - its settings, the secrets and hosts and programs its
 * manifest asks for, the tools it offers sessions, what it is costing, and its
 * log - and the controls that switch it off, reload it and remove it.
 */

type SettingSpec = PluginInfo['settings'][number]
type SettingValue = PluginInfo['settingValues'][string]

export interface PluginsPageProps {
  /** Null while main has not answered. */
  plugins: readonly PluginInfo[] | null
  /** Why the last folder picked was not added, as a sentence. */
  addError: string | null
  onAdd: () => void
  onOpen: (path: string) => void
}

export function PluginsPage({ plugins, addError, onAdd, onOpen }: PluginsPageProps): JSX.Element {
  return (
    <SettingsPage
      data-settings-section="plugins"
      title="Plugins"
      sole
      aside={
        <Action primary onClick={onAdd} data-plugin-add>
          <span className="flex items-center gap-1.5">
            <PlusIcon width={11} height={11} />
            Add folder
          </span>
        </Action>
      }
    >
      <Group
        name="plugins"
        title="Plugins"
        hint="Folders that hold a helm-plugin.json. Each runs in a process of its own and reaches only the hosts, programs and secrets its manifest declares."
      >
        {addError !== null && (
          <div className="pb-3">
            <Verdict tone="warn" text={addError} data-plugin-add-error />
          </div>
        )}
        {plugins !== null && plugins.length === 0 ? (
          <EmptyState size="list" name="plugins" icon={<PlugIcon width={18} height={18} />} title="No plugins">
            Add a folder that holds a helm-plugin.json.
          </EmptyState>
        ) : (
          <div className="-mx-2.5 flex flex-col gap-px">
            {(plugins ?? []).map((plugin) => (
              <button
                key={plugin.path}
                type="button"
                data-plugin-row={plugin.id ?? plugin.path}
                onClick={() => onOpen(plugin.path)}
                className="flex w-full items-center gap-3 rounded-well px-2.5 py-row text-left transition-colors hover:bg-hover"
              >
                <span className={cn('shrink-0', plugin.enabled && plugin.error === null ? 'text-fg-muted' : 'text-fg-subtle')}>
                  <PluginIcon url={plugin.icon} size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate text-[12.5px] text-fg">{plugin.name}</span>
                    {plugin.version !== null && (
                      <span className="shrink-0 font-mono text-[11px] text-fg-subtle">{plugin.version}</span>
                    )}
                  </span>
                  <span className="block truncate font-mono text-[11px] text-fg-subtle">{plugin.path}</span>
                </span>
                <PluginState plugin={plugin} />
              </button>
            ))}
          </div>
        )}
      </Group>
    </SettingsPage>
  )
}

/** Off, or failed: the one word that is the plugin's whole state. On says nothing. */
function PluginState({ plugin }: { plugin: PluginInfo }): JSX.Element | null {
  if (plugin.error !== null && plugin.enabled) {
    return (
      <span data-plugin-state="error" className="shrink-0 rounded-full border border-danger/40 px-[7px] text-[11px] leading-[15px] text-danger">
        Not loaded
      </span>
    )
  }
  if (!plugin.enabled) {
    return (
      <span data-plugin-state="off" className="shrink-0 rounded-full border border-border-strong px-[7px] text-[11px] leading-[15px] text-fg-muted">
        Off
      </span>
    )
  }
  return null
}

export interface PluginPageProps {
  plugin: PluginInfo
  /** Every plugin, for the plugins a secret may be shared with. */
  plugins: readonly PluginInfo[]
  /** Null: not measured yet, or the plugin is not running. */
  metrics: PluginMetrics | null
  /** Null while it is being read. */
  log: PluginLogLine[] | null
  secrets: SecretsState | null
  onSetEnabled: (enabled: boolean) => void
  /** Whether the sessions Helm starts are offered the plugin's tools. */
  onSetTools: (enabled: boolean) => void
  onReload: () => void
  /** The secrets only this plugin may use, for the remove dialog to offer. */
  ownSecrets: () => Promise<string[]>
  onRemove: (deleteSecrets: string[]) => void
  /** Resolves null when it was saved, or main's sentence when it was not. */
  onSetSetting: (key: string, value: SettingValue) => Promise<string | null>
  onSaveSecret: (input: SecretInput) => Promise<string | null>
  onRemoveSecret: (key: string) => Promise<string | null>
}

export function PluginPage({
  plugin,
  plugins,
  metrics,
  log,
  secrets,
  onSetEnabled,
  onSetTools,
  onReload,
  ownSecrets,
  onRemove,
  onSetSetting,
  onSaveSecret,
  onRemoveSecret
}: PluginPageProps): JSX.Element {
  const [secretFor, setSecretFor] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string[] | null>(null)
  const [settingProblem, setSettingProblem] = useState<string | null>(null)
  const loaded = plugin.error === null
  const live = loaded && plugin.enabled
  const secretState = new Map(plugin.secrets.map((entry) => [entry.key, entry.state]))
  const coveredBySetting = new Set(
    plugin.settings.flatMap((spec) => (spec.type === 'secret' ? [spec.secret] : []))
  )
  const looseSecrets = plugin.secrets.filter((entry) => !coveredBySetting.has(entry.key))
  const choices: SecretPluginChoice[] = plugins.flatMap((entry) =>
    entry.id === null || entry.error !== null
      ? []
      : [{ id: entry.id, name: entry.name, network: entry.network, secrets: entry.secrets.map((s) => s.key) }]
  )

  const setSetting = (key: string, value: SettingValue): void => {
    void onSetSetting(key, value).then(setSettingProblem)
  }

  const openRemove = (): void => {
    void ownSecrets().then(setRemoving, () => setRemoving([]))
  }

  return (
    <SettingsPage
      data-settings-section={`plugin:${plugin.path}`}
      data-plugin-page={plugin.id ?? plugin.path}
      title={plugin.name}
      hint={plugin.description ?? undefined}
      sole={false}
      aside={
        <>
          <Action onClick={onReload} data-plugin-reload title="Read the folder again and restart its pages">
            <span className="flex items-center gap-1.5">
              <RefreshIcon width={11} height={11} />
              Reload
            </span>
          </Action>
          <Action primary={!plugin.enabled} onClick={() => onSetEnabled(!plugin.enabled)} data-plugin-toggle>
            {plugin.enabled ? 'Turn off' : 'Turn on'}
          </Action>
        </>
      }
    >
      <Group name="plugin-status" title="Status">
        <div className="pb-2">
          {plugin.error !== null ? (
            <Verdict tone="warn" text={`Not loaded: ${plugin.error}`} data-plugin-verdict="error" />
          ) : !plugin.enabled ? (
            <Verdict tone="todo" text="Turned off. Its pages, programs and service are not running." data-plugin-verdict="off" />
          ) : (
            <Verdict tone="ok" text="On" data-plugin-verdict="on" />
          )}
        </div>
        {plugin.warnings.length > 0 && (
          <ul className="mb-2 list-none pl-6 text-[11.5px] leading-[1.55] text-warn" data-plugin-warnings>
            {plugin.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        <dl className="flex flex-col gap-1.5 pt-1 pl-6">
          <Fact label="Folder">{plugin.path}</Fact>
          {plugin.id !== null && <Fact label="Id">{plugin.id}</Fact>}
          {plugin.version !== null && <Fact label="Version">{plugin.version}</Fact>}
          {live && <Fact label="Uses">{usage(metrics)}</Fact>}
        </dl>
        {plugin.background !== null && live && (
          <p
            data-plugin-background={plugin.background.state}
            className={cn(
              'pt-2 pl-6 text-[11.5px] leading-[1.5]',
              plugin.background.state === 'crashed' ? 'text-warn' : 'text-fg-muted'
            )}
          >
            {backgroundSentence(plugin.background)}
          </p>
        )}
      </Group>

      {loaded && plugin.settings.length > 0 && (
        <Group name="plugin-settings" title="Settings">
          {plugin.settings.map((spec, index) => (
            <div key={spec.key}>
              {index > 0 && <Divider />}
              <SettingRow
                spec={spec}
                value={plugin.settingValues[spec.key] ?? null}
                secretState={spec.type === 'secret' ? (secretState.get(spec.secret) ?? 'missing') : null}
                onChange={(value) => setSetting(spec.key, value)}
                onSecret={() => spec.type === 'secret' && setSecretFor(spec.secret)}
              />
            </div>
          ))}
          {settingProblem !== null && (
            <p role="alert" className="pt-2 text-[11.5px] text-danger" data-plugin-setting-problem>
              {settingProblem}
            </p>
          )}
        </Group>
      )}

      {loaded && looseSecrets.length > 0 && (
        <Group name="plugin-secrets" title="Secrets" hint="Values it puts in requests and programs. Its pages never see them.">
          {looseSecrets.map((entry, index) => (
            <div key={entry.key}>
              {index > 0 && <Divider />}
              <SecretRow
                label={entry.key}
                mono
                state={entry.state}
                onEdit={() => setSecretFor(entry.key)}
              />
            </div>
          ))}
        </Group>
      )}

      {loaded && (
        <Group
          name="plugin-network"
          title="Network"
          hint="The only origins it can reach. Redirects are checked against the same list."
        >
          {plugin.network.length === 0 ? (
            <p className="text-[12px] text-fg-muted">None. It makes no requests.</p>
          ) : (
            <ul className="flex flex-col gap-1" data-plugin-network>
              {plugin.network.map((origin) => (
                <li key={origin} className="font-mono text-[11.5px] text-fg select-text">
                  {origin}
                </li>
              ))}
            </ul>
          )}
        </Group>
      )}

      {loaded && plugin.runsPrograms && (
        <Group name="plugin-programs" title="Programs">
          <div className="pb-2.5">
            <Verdict tone="warn" text="Runs programs on this computer, with your rights." data-plugin-runs-programs />
          </div>
          <ul className="flex flex-col gap-1.5 pl-6" data-plugin-exec>
            {plugin.exec.map((program) => (
              <li key={program.name} className="flex min-w-0 items-baseline gap-3 font-mono text-[11px] select-text">
                <span className="shrink-0 text-fg">{program.name}</span>
                <span className="min-w-0 flex-1 truncate text-fg-muted" title={[program.command, ...program.args].join(' ')}>
                  {[program.command, ...program.args].join(' ')}
                </span>
              </li>
            ))}
          </ul>
          {plugin.service !== null && (
            <div className={cn('pl-6', plugin.exec.length > 0 && 'mt-3')} data-plugin-service={plugin.service.state}>
              <p className="text-[12.5px] text-fg">
                Service{' '}
                <span className={cn('text-[11.5px]', serviceTone(plugin.service.state))}>{plugin.service.state}</span>
              </p>
              <dl className="mt-1.5 flex flex-col gap-1.5">
                <Fact label="Runs">{plugin.service.command}</Fact>
                <Fact label="Starts">{plugin.service.start === 'enable' ? 'when the plugin is turned on' : 'on its first request'}</Fact>
                {plugin.service.pid !== null && <Fact label="Pid">{plugin.service.pid}</Fact>}
                {plugin.service.port !== null && <Fact label="Port">{plugin.service.port}</Fact>}
                {plugin.service.restarts > 0 && <Fact label="Crashes">{plugin.service.restarts}</Fact>}
              </dl>
              {plugin.service.error !== null && (
                <p className="mt-1.5 text-[11.5px] text-danger">{plugin.service.error}</p>
              )}
            </div>
          )}
        </Group>
      )}

      {loaded && plugin.startsSessions && (
        <Group name="plugin-sessions" title="Starting sessions">
          <Verdict
            tone="warn"
            text="Can ask to start Claude Code sessions. Helm shows you the folder and first message of each, and starts it only if you do."
            data-plugin-starts-sessions
          />
        </Group>
      )}

      {loaded && plugin.agent !== null && (
        <SessionTools agent={plugin.agent} pluginOn={plugin.enabled} onSetTools={onSetTools} />
      )}

      <Group name="plugin-log" title="Log" hint="What its programs and service printed, and what Helm noted. The last 500 lines.">
        <PluginLog log={log} />
      </Group>

      <Group name="plugin-remove" title="Remove">
        <Row label="Remove this plugin" hint="Helm forgets the folder. Nothing in it is deleted.">
          <button type="button" data-plugin-remove onClick={openRemove} className={cn(secondaryButton, 'border-danger/45 text-danger hover:bg-danger/10')}>
            <span className="flex items-center gap-1.5">
              <TrashIcon width={11} height={11} />
              Remove
            </span>
          </button>
        </Row>
      </Group>

      {secretFor !== null && (
        <SecretDialog
          existing={secrets?.secrets.find((entry) => entry.key === secretFor) ?? null}
          presetKey={secretFor}
          requester={plugin.id === null ? null : { id: plugin.id, name: plugin.name }}
          plugins={choices}
          available={secrets?.available ?? true}
          onSave={onSaveSecret}
          onRemove={onRemoveSecret}
          onClose={() => setSecretFor(null)}
        />
      )}
      {removing !== null && (
        <RemovePluginDialog
          name={plugin.name}
          ownSecrets={removing}
          onCancel={() => setRemoving(null)}
          onConfirm={(deleteSecrets) => {
            setRemoving(null)
            onRemove(deleteSecrets)
          }}
        />
      )}
    </SettingsPage>
  )
}

/**
 * The tools the plugin offers the sessions Helm starts, and the switch for them.
 * Said with what follows from them: what the plugin answers is read by the
 * session, so it reaches the conversation the way anything the session reads
 * does.
 */
function SessionTools({
  agent,
  pluginOn,
  onSetTools
}: {
  agent: NonNullable<PluginInfo['agent']>
  pluginOn: boolean
  onSetTools: (enabled: boolean) => void
}): JSX.Element {
  const state = !pluginOn
    ? 'The plugin is turned off, so no session has them.'
    : agent.enabled
      ? `Sessions Helm starts get them as ${agent.server}. Turning this off takes them from sessions already running.`
      : 'No session gets them.'
  return (
    <Group
      name="plugin-tools"
      title="Tools for sessions"
      hint="Claude Code sessions can call these. Its background page answers, and the answer goes into the session's conversation."
    >
      <label className="flex items-center justify-between gap-4 py-1.5" data-plugin-tools-switch>
        <span className="min-w-[220px] flex-1">
          <span className="block text-[12.5px] text-fg">Offer to sessions</span>
          <span className="mt-0.5 block text-[11px] leading-[1.5] text-fg-subtle" data-plugin-tools-state>
            {state}
          </span>
        </span>
        <Checkbox checked={agent.enabled} onChange={() => onSetTools(!agent.enabled)} label="Offer to sessions" />
      </label>
      <ul className="mt-2 flex flex-col gap-1.5 pl-6" data-plugin-tools>
        {agent.tools.map((tool) => (
          <li key={tool.name} className="flex min-w-0 items-baseline gap-3 text-[11px] select-text">
            <span className="shrink-0 font-mono text-fg">{tool.name}</span>
            <span className="min-w-0 flex-1 truncate text-fg-muted" title={tool.description}>
              {tool.description}
            </span>
          </li>
        ))}
      </ul>
    </Group>
  )
}

function backgroundSentence(background: NonNullable<PluginInfo['background']>): string {
  switch (background.state) {
    case 'running':
      return 'Its background page is running.'
    case 'starting':
      return 'Its background page is starting.'
    case 'stopped':
      return 'Its background page is not running.'
    case 'crashed':
      return background.error === null
        ? 'Its background page stopped. Reload starts it again.'
        : `Its background page stopped: ${clause(background.error)}. Reload starts it again.`
  }
}

/** A sentence made a clause: no capital to open it, no full stop to close it. */
function clause(sentence: string): string {
  const trimmed = sentence.trim().replace(/\.$/, '')
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1)
}

function usage(metrics: PluginMetrics | null): string {
  if (metrics === null || metrics.memoryKb === null || metrics.cpuPercent === null) return 'Unknown'
  if (metrics.processes === 0) return 'Nothing running'
  const processes = `${String(metrics.processes)} ${metrics.processes === 1 ? 'process' : 'processes'}`
  return `${formatBytes(metrics.memoryKb * 1024)} memory · ${metrics.cpuPercent.toFixed(1)}% CPU · ${processes}`
}

function serviceTone(state: NonNullable<PluginInfo['service']>['state']): string {
  switch (state) {
    case 'running':
      return 'text-success'
    case 'starting':
      return 'text-fg-muted'
    case 'crashed':
    case 'failed':
      return 'text-danger'
    case 'stopped':
      return 'text-fg-subtle'
  }
}

/** One setting from the manifest's schema, as a row with its control. */
function SettingRow({
  spec,
  value,
  secretState,
  onChange,
  onSecret
}: {
  spec: SettingSpec
  value: SettingValue
  secretState: 'ready' | 'missing' | 'not-allowed' | null
  onChange: (value: SettingValue) => void
  onSecret: () => void
}): JSX.Element {
  const hint = spec.description
  switch (spec.type) {
    case 'toggle':
      return (
        <label className="flex items-center justify-between gap-4 py-1.5" data-plugin-setting={spec.key}>
          <span className="min-w-[220px] flex-1">
            <span className="block text-[12.5px] text-fg">{spec.label}</span>
            {hint !== undefined && <span className="mt-0.5 block text-[11px] leading-[1.5] text-fg-subtle">{hint}</span>}
          </span>
          <Checkbox checked={value === true} onChange={() => onChange(value !== true)} label={spec.label} />
        </label>
      )
    case 'select':
      return (
        <Row label={spec.label} hint={hint}>
          <Select
            value={typeof value === 'string' ? value : ''}
            onChange={onChange}
            label={spec.label}
            data-plugin-setting={spec.key}
          >
            {value === null && <option value="">Not set</option>}
            {spec.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </Row>
      )
    case 'text':
      return (
        <Row label={spec.label} hint={hint}>
          <TextField
            value={typeof value === 'string' ? value : ''}
            placeholder={spec.placeholder}
            label={spec.label}
            setting={spec.key}
            onCommit={(next) => onChange(next === '' ? null : next)}
          />
        </Row>
      )
    case 'number':
      return (
        <Row label={spec.label} hint={hint}>
          <NumberSetting
            value={typeof value === 'number' ? value : null}
            min={spec.min}
            max={spec.max}
            label={spec.label}
            setting={spec.key}
            onCommit={onChange}
          />
        </Row>
      )
    case 'secret':
      return <SecretRow label={spec.label} hint={hint} state={secretState ?? 'missing'} onEdit={onSecret} />
  }
}

function SecretRow({
  label,
  hint,
  mono = false,
  state,
  onEdit
}: {
  label: string
  hint?: string | undefined
  mono?: boolean
  state: 'ready' | 'missing' | 'not-allowed'
  onEdit: () => void
}): JSX.Element {
  const said =
    state === 'ready' ? 'Stored' : state === 'missing' ? 'Not stored yet' : 'Stored, but this plugin may not use it'
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-1.5" data-plugin-secret={label}>
      <div className="min-w-[220px] flex-1">
        <p className={cn('text-[12.5px] text-fg', mono && 'font-mono text-[12px]')}>{label}</p>
        <p className={cn('mt-0.5 text-[11px] leading-[1.5]', state === 'ready' ? 'text-fg-subtle' : 'text-warn')}>
          {hint === undefined ? said : `${said}. ${hint}`}
        </p>
      </div>
      <Action primary={state !== 'ready'} onClick={onEdit} data-plugin-secret-edit={label}>
        {state === 'missing' ? 'Add value' : 'Change'}
      </Action>
    </div>
  )
}

const fieldClass = cn(
  'h-[30px] rounded-well border border-border bg-surface-sunken px-2.5 text-[12px] text-fg select-text',
  'placeholder:text-fg-subtle transition-colors hover:border-border-strong focus:border-accent focus:outline-none'
)

/** Text committed on blur or Enter: one write per edit, not per keystroke. */
function TextField({
  value,
  placeholder,
  label,
  setting,
  onCommit
}: {
  value: string
  placeholder: string | undefined
  label: string
  setting: string
  onCommit: (value: string) => void
}): JSX.Element {
  const [draft, setDraft, reset] = useDraft(value)
  const commit = (): void => {
    if (draft !== value) onCommit(draft)
  }
  return (
    <input
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      data-plugin-setting={setting}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') reset()
      }}
      className={cn(fieldClass, 'w-[260px]')}
    />
  )
}

/** A number of any size or precision the manifest allows, clamped to its bounds, committed on blur or Enter. */
function NumberSetting({
  value,
  min,
  max,
  label,
  setting,
  onCommit
}: {
  value: number | null
  min: number | undefined
  max: number | undefined
  label: string
  setting: string
  onCommit: (value: number | null) => void
}): JSX.Element {
  const [draft, setDraft, reset] = useDraft(value === null ? '' : String(value))
  const commit = (): void => {
    if (draft.trim() === '') {
      if (value !== null) onCommit(null)
      return
    }
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) {
      reset()
      return
    }
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, parsed))
    setDraft(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      value={draft}
      aria-label={label}
      data-plugin-setting={setting}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
        if (event.key === 'Escape') reset()
      }}
      className={cn(fieldClass, 'w-[120px] text-right font-mono text-[11.5px] tabular-nums')}
    />
  )
}

/** The log, newest at the bottom, kept scrolled there unless somebody has scrolled up to read. */
function PluginLog({ log }: { log: PluginLogLine[] | null }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  useLayoutEffect(() => {
    const element = box.current
    if (element !== null && pinned.current) element.scrollTop = element.scrollHeight
  }, [log])
  if (log === null) return <p className="text-[12px] text-fg-subtle">Reading…</p>
  if (log.length === 0) return <p className="text-[12px] text-fg-muted">Nothing yet.</p>
  return (
    <div
      ref={box}
      data-plugin-log
      onScroll={(event) => {
        const element = event.currentTarget
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 8
      }}
      className="max-h-[280px] overflow-y-auto rounded-raised border border-border bg-surface-sunken px-3 py-2 font-mono text-[11px] leading-[1.6] select-text"
    >
      {log.map((line, index) => (
        <div key={`${line.at}:${String(index)}`} className="flex gap-3 whitespace-pre-wrap break-words">
          <span className="shrink-0 text-fg-subtle tabular-nums">{clock(line.at)}</span>
          <span
            className={cn(
              'min-w-0 flex-1',
              // What Helm noted recedes; what the plugin printed is the log.
              line.stream === 'err' ? 'text-danger' : line.stream === 'helm' ? 'text-fg-subtle' : 'text-fg-muted'
            )}
          >
            {line.text}
          </span>
        </div>
      ))}
    </div>
  )
}

function clock(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour12: false })
}

/** Removing forgets the folder; the secrets only it could use are offered for deletion, unticked. */
function RemovePluginDialog({
  name,
  ownSecrets,
  onCancel,
  onConfirm
}: {
  name: string
  ownSecrets: readonly string[]
  onCancel: () => void
  onConfirm: (deleteSecrets: string[]) => void
}): JSX.Element {
  const [chosen, setChosen] = useState<string[]>([])
  const cancelRef = useRef<HTMLButtonElement>(null)
  // In the commit that draws the dialog, so nothing - a key, a test - can find
  // it on screen with the focus still behind it.
  useLayoutEffect(() => {
    cancelRef.current?.focus()
  }, [])
  return (
    <Overlay role="alertdialog" aria-label={`Remove ${name}`} data-plugin-remove-dialog className="max-w-[440px]" onDismiss={onCancel}>
      <DialogHeader icon={<TrashIcon width={13} height={13} />} title={`Remove ${name}?`} onClose={onCancel} />
      <div className="px-[22px] pt-2 pb-1">
        <p className="text-[12px] leading-[1.55] text-fg-muted">
          Helm forgets the folder and closes the plugin&rsquo;s tabs. Nothing in the folder is deleted, and adding it
          again brings it back.
        </p>
        {ownSecrets.length > 0 && (
          <fieldset className="mt-4">
            <legend className="mb-1.5 text-[11.5px] text-fg">Also delete the secrets only it uses</legend>
            <div className="flex flex-col gap-1">
              {ownSecrets.map((key) => (
                <label key={key} className="flex items-center gap-2.5 py-0.5">
                  <Checkbox
                    checked={chosen.includes(key)}
                    onChange={() =>
                      setChosen((current) => (current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]))
                    }
                    label={key}
                    mark="data-plugin-remove-secret"
                  />
                  <span className="font-mono text-[11.5px] text-fg">{key}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </div>
      <DialogFooter>
        <button
          ref={cancelRef}
          type="button"
          onClick={onCancel}
          className={cn(secondaryButton, 'focus:border-accent focus:outline-none')}
        >
          Cancel
        </button>
        <button
          type="button"
          data-plugin-remove-confirm
          onClick={() => onConfirm(chosen)}
          className="rounded-well border border-danger/50 px-3.5 py-1.5 text-[12px] font-medium text-danger transition-colors hover:bg-danger/10"
        >
          Remove
        </button>
      </DialogFooter>
    </Overlay>
  )
}

