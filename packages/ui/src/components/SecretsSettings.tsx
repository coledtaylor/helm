import type { JSX } from 'react'
import { useMemo, useState } from 'react'
import type { SecretInfo, SecretInput, SecretsState } from '@helm/core/types'
import { cn } from '../lib/cn'
import { formatAge } from '../lib/time'
import { Checkbox } from './Checkbox'
import {
  DialogFooter,
  DialogHeader,
  DialogProblem,
  dangerButton,
  dialogInput,
  dialogLabel,
  primaryButton,
  secondaryButton
} from './DialogParts'
import { EmptyState } from './EmptyState'
import { KeyIcon, PlusIcon } from './icons'
import { Overlay } from './Overlay'
import { Action, Group, SettingsPage, Verdict } from './SettingsKit'

/**
 * Settings > Secrets, and the dialog every secret is typed into.
 *
 * A secret is a value a plugin can put in a request as `{{key}}` without its
 * pages ever seeing it. Each is bound twice: to the hosts it may be sent to and
 * to the plugins that may send it, so a plugin that turns hostile cannot carry
 * a token somewhere else, and a token stored for one plugin is not another's.
 * Values go one way - into main, encrypted - and nothing here ever reads one
 * back.
 */

/** A plugin, as the secrets pages offer it. */
export interface SecretPluginChoice {
  id: string
  name: string
  /** The origins its `helm.fetch` may reach: the hosts offered for its secrets. */
  network: readonly string[]
  /** The keys its manifest declares. */
  secrets: readonly string[]
}

export interface SecretDialogProps {
  /** The stored secret being changed, or null for a new one. */
  existing: SecretInfo | null
  /** The key, when something asked for a particular one. Fixed when set. */
  presetKey?: string | null | undefined
  /**
   * The plugin the dialog is open for: ticked, and not untickable, because it
   * is the reason the dialog is open. Its hosts are offered ticked.
   */
  requester?: { id: string; name: string } | null | undefined
  plugins: readonly SecretPluginChoice[]
  /** Whether this computer can encrypt. When it cannot, nothing can be saved. */
  available: boolean
  /** Resolves null when it was saved, or main's sentence when it was not. */
  onSave: (input: SecretInput) => Promise<string | null>
  onRemove?: ((key: string) => Promise<string | null>) | undefined
  /** Saved, removed or dismissed: the dialog is done either way. */
  onClose: () => void
}

export function SecretDialog({
  existing,
  presetKey = null,
  requester = null,
  plugins,
  available,
  onSave,
  onRemove,
  onClose
}: SecretDialogProps): JSX.Element {
  const fixedKey = existing?.key ?? presetKey
  const [key, setKey] = useState(fixedKey ?? '')
  const [value, setValue] = useState('')
  // The plugin asking is ticked, with its hosts, even on a secret stored for
  // somebody else: being let in is what it came to ask for.
  const asking = plugins.find((plugin) => plugin.id === requester?.id)
  const askingIsNew = asking !== undefined && existing?.plugins.includes(asking.id) !== true
  const [chosenPlugins, setChosenPlugins] = useState<string[]>(() =>
    unique([...(existing?.plugins ?? []), ...(askingIsNew ? [asking.id] : [])])
  )
  const [hosts, setHosts] = useState<string[]>(() =>
    unique([...(existing?.hosts ?? []), ...(askingIsNew ? asking.network : [])])
  )
  /** Hosts typed in that no plugin offers. */
  const [typedHosts, setTypedHosts] = useState<string[]>([])
  const [hostDraft, setHostDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  const trimmedKey = key.trim()
  // The plugins that declare this key first: they are the ones it is for.
  const pluginChoices = useMemo(() => {
    const declares = (plugin: SecretPluginChoice): boolean => plugin.secrets.includes(trimmedKey)
    return [...plugins].sort((a, b) => Number(declares(b)) - Number(declares(a)) || a.name.localeCompare(b.name))
  }, [plugins, trimmedKey])
  const hostChoices = useMemo(() => {
    const out: string[] = []
    const add = (host: string): void => {
      if (!out.includes(host)) out.push(host)
    }
    for (const host of existing?.hosts ?? []) add(host)
    for (const plugin of plugins) if (chosenPlugins.includes(plugin.id)) for (const host of plugin.network) add(host)
    for (const host of typedHosts) add(host)
    return out
  }, [existing, plugins, chosenPlugins, typedHosts])

  const needsValue = existing === null
  const ready = available && !busy && trimmedKey !== '' && (!needsValue || value !== '')

  const toggle = (list: string[], item: string): string[] =>
    list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item]

  const addHost = (): void => {
    const host = hostDraft.trim().replace(/\/+$/, '')
    if (host === '') return
    if (!/^https?:\/\/[^\s/]+$/i.test(host)) {
      setProblem(`"${host}" is not an origin. Write it as https://api.example.com or https://*.example.com.`)
      return
    }
    setProblem(null)
    setTypedHosts((current) => (current.includes(host) ? current : [...current, host]))
    setHosts((current) => (current.includes(host) ? current : [...current, host]))
    setHostDraft('')
  }

  const save = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    const refused = await onSave({
      key: trimmedKey,
      value: value === '' ? null : value,
      hosts: hosts.filter((host) => hostChoices.includes(host)),
      plugins: chosenPlugins
    })
    setBusy(false)
    if (refused === null) onClose()
    else setProblem(refused)
  }

  const remove = async (): Promise<void> => {
    if (existing === null || onRemove === undefined) return
    setBusy(true)
    const refused = await onRemove(existing.key)
    setBusy(false)
    if (refused === null) onClose()
    else setProblem(refused)
  }

  const title =
    existing !== null
      ? `Change ${existing.key}`
      : requester !== null && fixedKey !== null
        ? `${requester.name} needs ${fixedKey}`
        : 'Add a secret'

  return (
    <Overlay aria-label={title} data-secret-dialog className="max-w-[520px]" onDismiss={onClose}>
      <DialogHeader icon={<KeyIcon width={13} height={13} />} title={title} onClose={onClose} />

      <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-2 pb-1">
        <p className="text-[11px] leading-[1.55] text-fg-muted">
          Stored encrypted on this computer. A plugin you tick can put it in requests to the hosts you tick, and in
          the programs it runs; its pages never see the value.
        </p>

        {!available && (
          <DialogProblem>Helm cannot encrypt on this computer, so it will not store a secret.</DialogProblem>
        )}

        <label className="mt-4 block">
          <span className={cn(dialogLabel, 'mb-1.5')}>Key</span>
          <input
            value={key}
            onChange={(event) => setKey(event.target.value)}
            readOnly={fixedKey !== null}
            autoFocus={fixedKey === null}
            spellCheck={false}
            aria-label="Key"
            data-secret-key
            placeholder="e.g. github-token"
            className={cn(dialogInput, 'font-mono text-[12px]', fixedKey !== null && 'text-fg-muted')}
          />
          <span className="mt-[5px] block text-[10px] leading-[1.5] text-fg-subtle">
            Written in a plugin's requests as <span className="font-mono">{`{{${trimmedKey === '' ? 'key' : trimmedKey}}}`}</span>.
          </span>
        </label>

        <label className="mt-[14px] block">
          <span className={cn(dialogLabel, 'mb-1.5')}>Value</span>
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save()
            }}
            autoFocus={fixedKey !== null}
            autoComplete="off"
            spellCheck={false}
            aria-label="Value"
            data-secret-value
            placeholder={existing === null ? 'Paste the value' : 'Leave empty to keep the stored value'}
            className={cn(dialogInput, 'font-mono text-[12px]')}
          />
        </label>

        <fieldset className="mt-[14px]">
          <legend className={cn(dialogLabel, 'mb-1.5')}>Plugins that may use it</legend>
          {pluginChoices.length === 0 ? (
            <p className="text-[11px] text-fg-subtle">No plugin is loaded.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {pluginChoices.map((plugin) => {
                const fixed = plugin.id === requester?.id
                return (
                  <label key={plugin.id} className="flex items-center gap-2.5 py-0.5 text-[12px] text-fg">
                    <Checkbox
                      checked={chosenPlugins.includes(plugin.id)}
                      disabled={fixed}
                      onChange={() => setChosenPlugins((current) => toggle(current, plugin.id))}
                      label={plugin.name}
                      mark="data-secret-plugin"
                    />
                    <span className="min-w-0 truncate">{plugin.name}</span>
                    {plugin.secrets.includes(trimmedKey) && (
                      <span className="shrink-0 text-[10.5px] text-fg-subtle">declares it</span>
                    )}
                  </label>
                )
              })}
            </div>
          )}
        </fieldset>

        <fieldset className="mt-[14px]">
          <legend className={cn(dialogLabel, 'mb-1.5')}>Hosts it may be sent to</legend>
          {hostChoices.length === 0 ? (
            <p className="text-[11px] text-fg-subtle">None. Without a host it reaches only the programs a plugin runs.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {hostChoices.map((host) => (
                <label key={host} className="flex items-center gap-2.5 py-0.5">
                  <Checkbox
                    checked={hosts.includes(host)}
                    onChange={() => setHosts((current) => toggle(current, host))}
                    label={host}
                    mark="data-secret-host"
                  />
                  <span className="min-w-0 truncate font-mono text-[11.5px] text-fg">{host}</span>
                </label>
              ))}
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <input
              value={hostDraft}
              onChange={(event) => setHostDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  addHost()
                }
              }}
              spellCheck={false}
              aria-label="Another host"
              placeholder="https://api.example.com"
              className={cn(dialogInput, 'font-mono text-[12px]')}
            />
            <button type="button" onClick={addHost} className={cn(secondaryButton, 'shrink-0')}>
              Add host
            </button>
          </div>
        </fieldset>

        {problem !== null && <DialogProblem>{problem}</DialogProblem>}
      </div>

      <DialogFooter>
        {existing !== null && onRemove !== undefined && (
          <>
            {confirmRemove ? (
              <span className="flex items-center gap-2">
                <span className="text-[11.5px] text-fg-muted">Plugins that use it stop working.</span>
                <button type="button" data-secret-remove-confirm onClick={() => void remove()} className={dangerButton}>
                  Remove
                </button>
              </span>
            ) : (
              <button type="button" data-secret-remove onClick={() => setConfirmRemove(true)} className={dangerButton}>
                Remove
              </button>
            )}
            <span className="flex-1" />
          </>
        )}
        <button type="button" onClick={onClose} className={secondaryButton}>
          Cancel
        </button>
        <button
          type="button"
          data-secret-save
          disabled={!ready}
          onClick={() => void save()}
          className={primaryButton(ready)}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </DialogFooter>
    </Overlay>
  )
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)]
}

export interface SecretsPageProps {
  /** Null while main has not answered. */
  state: SecretsState | null
  plugins: readonly SecretPluginChoice[]
  onSave: (input: SecretInput) => Promise<string | null>
  onRemove: (key: string) => Promise<string | null>
}

/** Settings > Secrets: every stored secret, where it may go and who may send it. */
export function SecretsPage({ state, plugins, onSave, onRemove }: SecretsPageProps): JSX.Element {
  const [editing, setEditing] = useState<SecretInfo | 'new' | null>(null)
  const available = state?.available ?? true
  const names = new Map(plugins.map((plugin) => [plugin.id, plugin.name]))
  const secrets = state?.secrets ?? []

  return (
    <SettingsPage
      data-settings-section="secrets"
      title="Secrets"
      sole
      aside={
        <Action primary disabled={!available} onClick={() => setEditing('new')} data-secret-add>
          <span className="flex items-center gap-1.5">
            <PlusIcon width={11} height={11} />
            Add secret
          </span>
        </Action>
      }
    >
      <Group
        name="secrets"
        title="Secrets"
        hint="Tokens and keys plugins use in requests, stored encrypted on this computer. Each goes only to the hosts and plugins you allow."
      >
        {!available && (
          <div className="pb-3">
            <Verdict
              tone="warn"
              text="This computer cannot encrypt, so Helm stores no secrets."
              data-secrets-unavailable
            />
          </div>
        )}
        {state !== null && secrets.length === 0 ? (
          <EmptyState
            size="list"
            name="secrets"
            icon={<KeyIcon width={18} height={18} />}
            title="No secrets"
          >
            A plugin that needs a token asks for it, or add one here.
          </EmptyState>
        ) : (
          <div className="-mx-2.5 flex flex-col gap-px">
            {secrets.map((secret) => (
              <button
                key={secret.key}
                type="button"
                data-secret-row={secret.key}
                onClick={() => setEditing(secret)}
                className="flex w-full items-center gap-3 rounded-well px-2.5 py-row text-left transition-colors hover:bg-hover"
              >
                <KeyIcon width={13} height={13} className="shrink-0 text-fg-subtle" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12px] text-fg">{secret.key}</span>
                  <span className="block truncate font-mono text-[11px] text-fg-subtle">
                    {secret.hosts.length === 0 ? 'No hosts - programs only' : secret.hosts.join(', ')}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end">
                  <span className="max-w-[200px] truncate text-[11.5px] text-fg-muted">
                    {secret.plugins.length === 0
                      ? 'No plugin'
                      : secret.plugins.map((id) => names.get(id) ?? id).join(', ')}
                  </span>
                  <span className="text-[11px] text-fg-subtle tabular-nums">
                    {formatAge(Date.parse(secret.updatedAt))}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </Group>
      {editing !== null && (
        <SecretDialog
          existing={editing === 'new' ? null : editing}
          plugins={plugins}
          available={available}
          onSave={onSave}
          onRemove={onRemove}
          onClose={() => setEditing(null)}
        />
      )}
    </SettingsPage>
  )
}
