import { useState, type JSX, type ReactNode } from 'react'
import {
  describeTransport,
  type HostTransport,
  type QuitSessions,
  type RemoteHost,
  type RemoteHostConnection,
  remoteHostFromDraft,
  type RemoteHostDraft,
  REMOTE_CONNECT_LINE,
  transportFix
} from '@helm/core/types'
import { cn } from '../lib/cn'
import { SEGMENT_ON } from '../lib/segmented'
import { Chip, type ChipTone } from './Chip'
import { Action, Divider, Group, Select } from './SettingsKit'

/**
 * Settings > Hosts: the hosts on other computers this device reaches, each
 * with how it is reached, where its link stands, what quitting does to the
 * sessions this device started there, and Remove; and a small form that adds
 * one by an ssh target or a command.
 *
 * Everything here is kept on this device (`hosts` and `quitSessions`) and
 * written through `settings:write`. Removing a host forgets it here and ends
 * nothing on it. Where each link stands is the desktop's to say
 * (`connection`); null while it has said nothing.
 */

/** One remote host as Settings > Hosts draws it. */
export interface SettingsHost {
  host: RemoteHost
  /** What quitting Helm does to the sessions it started there (`quitChoice`). */
  quit: QuitSessions
  /** Where this device's link to it stands, or null while nothing has been heard. */
  connection: RemoteHostConnection | null
}

export interface HostsSettingsProps {
  hosts: readonly SettingsHost[]
  /** Adds a host the form checked, with a fresh id. */
  onAdd: (host: RemoteHost) => void
  /** Forgets a host on this device, with its quit choice. Ends nothing there. */
  onRemove: (id: string) => void
  onQuitChange: (id: string, choice: QuitSessions) => void
  /** Whether the add form is open; the page's Add a host… button opens it. */
  adding: boolean
  onAddingChange: (adding: boolean) => void
}

const CONNECTION_CHIP: Record<RemoteHostConnection['state'], { tone: ChipTone; label: string }> = {
  connected: { tone: 'success', label: 'Connected' },
  retrying: { tone: 'warn', label: 'Not connected, retrying' },
  pairing: { tone: 'warn', label: 'Not paired' },
  failed: { tone: 'danger', label: 'Cannot connect' }
}

export function HostsSettings({
  hosts,
  onAdd,
  onRemove,
  onQuitChange,
  adding,
  onAddingChange
}: HostsSettingsProps): JSX.Element {
  return (
    <Group
      name="hosts"
      title="Hosts"
      hint="Hosts on your other computers, reached with your own ssh or a command you choose. Each runs its own sessions."
    >
      {adding && (
        <>
          <AddHostForm
            hosts={hosts.map((entry) => entry.host)}
            onAdd={(host) => {
              onAdd(host)
              onAddingChange(false)
            }}
            onCancel={() => onAddingChange(false)}
          />
          {hosts.length > 0 && <Divider />}
        </>
      )}
      {hosts.length === 0 && !adding && (
        <p data-settings-hosts-empty className="py-1.5 text-[12px] text-fg-muted">
          No other hosts yet. Add one with the target you give ssh, such as build-box or you@build-box.
        </p>
      )}
      {hosts.map((entry, index) => (
        <div key={entry.host.id}>
          {index > 0 && <Divider />}
          <HostRow entry={entry} onRemove={onRemove} onQuitChange={onQuitChange} />
        </div>
      ))}
      {hosts.length > 0 && (
        <p className="mt-3 text-[11px] leading-[1.5] text-fg-subtle">
          Remove forgets a host on this PC. Its sessions keep running there, and your ssh config is not touched.
        </p>
      )}
    </Group>
  )
}

function HostRow({
  entry,
  onRemove,
  onQuitChange
}: {
  entry: SettingsHost
  onRemove: (id: string) => void
  onQuitChange: (id: string, choice: QuitSessions) => void
}): JSX.Element {
  const { host, quit, connection } = entry
  const chip = connection === null ? null : CONNECTION_CHIP[connection.state]
  return (
    <div
      data-settings-host={host.id}
      data-settings-host-connection={connection?.state ?? 'unknown'}
      aria-label={host.name}
      role="group"
      className="py-2"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="min-w-0 truncate font-mono text-[12.5px] text-fg">{host.name}</span>
        {chip !== null && (
          <Chip tone={chip.tone}>{chip.label}</Chip>
        )}
      </div>
      <p
        data-settings-host-reached
        className="mt-0.5 truncate font-mono text-[11px] text-fg-subtle select-text"
        title={describeTransport(host.transport)}
      >
        {describeTransport(host.transport)}
      </p>
      {connection !== null && <ConnectionDetail connection={connection} host={host} />}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[12px] text-fg-muted">When you quit</span>
        <Select
          value={quit}
          label={`When you quit, on ${host.name}`}
          data-settings-host-quit={quit}
          onChange={(value) => onQuitChange(host.id, value === 'end' ? 'end' : 'keep')}
        >
          <option value="end">End my sessions there</option>
          <option value="keep">Keep them running</option>
        </Select>
        <span className="flex-1" />
        <Action data-settings-host-remove={host.id} onClick={() => onRemove(host.id)}>
          Remove
        </Action>
      </div>
    </div>
  )
}

/** What a link that is not simply connected or retrying needs from the user. */
function ConnectionDetail({ connection, host }: { connection: RemoteHostConnection; host: RemoteHost }): ReactNode {
  if (connection.state === 'pairing') {
    return (
      <div data-settings-host-pairing className="mt-2 text-[11.5px] leading-[1.5] text-fg-muted">
        <p>This PC is not paired with {host.name} yet. To approve it, run this in a terminal there:</p>
        <p className="mt-1 font-mono text-[11.5px] text-fg select-text">floti devices approve {connection.code}</p>
      </div>
    )
  }
  if (connection.state === 'failed') {
    return (
      <div data-settings-host-failed className="mt-2 text-[11.5px] leading-[1.5] text-fg-muted">
        <p className="font-mono text-[11px] break-all text-fg select-text">{connection.lastLine}</p>
        <p className="mt-1">{transportFix(host.transport)}</p>
      </div>
    )
  }
  return null
}

const VIA_LABEL: Record<HostTransport['kind'], string> = { ssh: 'ssh', command: 'Command' }

const VIA_HINT: Record<HostTransport['kind'], string> = {
  ssh: `Helm runs your own ssh with this target, exactly as typed, and ${REMOTE_CONNECT_LINE} there. It uses your ssh config, keys and agent, never asks for a password and keeps none.`,
  command: `Run without a shell, with ${REMOTE_CONNECT_LINE} added as its last argument. It must carry input and output unchanged and ask nothing.`
}

const FIELD = cn(
  'h-[30px] w-full rounded-well border border-border bg-surface-sunken px-2.5',
  'text-[12px] text-fg placeholder:text-fg-subtle select-text',
  'focus:border-accent focus:outline-none'
)

/** Name, and an ssh target or a command line. Checked as typed is submitted; nothing is written until it passes. */
function AddHostForm({
  hosts,
  onAdd,
  onCancel
}: {
  hosts: readonly RemoteHost[]
  onAdd: (host: RemoteHost) => void
  onCancel: () => void
}): JSX.Element {
  const [draft, setDraft] = useState<RemoteHostDraft>({ name: '', via: 'ssh', target: '', command: '' })
  const [error, setError] = useState<string | null>(null)
  const edit = (patch: Partial<RemoteHostDraft>): void => {
    setDraft((current) => ({ ...current, ...patch }))
    setError(null)
  }
  const submit = (): void => {
    const result = remoteHostFromDraft(draft, hosts, globalThis.crypto.randomUUID())
    if (result.ok) onAdd(result.host)
    else setError(result.error)
  }

  return (
    <form
      data-settings-host-form
      aria-label="Add a host"
      className="flex flex-col gap-3 py-2"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-fg-muted">Name</span>
        <input
          type="text"
          data-settings-host-name
          aria-label="Host name"
          placeholder={draft.via === 'ssh' ? 'The ssh target, unless you name it' : 'build-box'}
          spellCheck={false}
          autoFocus
          value={draft.name}
          onChange={(event) => edit({ name: event.target.value })}
          className={cn(FIELD, 'max-w-[280px]')}
        />
      </label>
      <div className="flex flex-col gap-1">
        <span className="text-[12px] text-fg-muted">Reached with</span>
        <div
          role="radiogroup"
          aria-label="Reached with"
          className="flex w-fit items-center gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5"
        >
          {(['ssh', 'command'] as const).map((via) => (
            <button
              key={via}
              type="button"
              role="radio"
              aria-checked={draft.via === via}
              data-settings-host-via={via}
              onClick={() => edit({ via })}
              className={cn(
                'rounded-raised px-2.5 py-1 text-[11.5px] transition-colors',
                draft.via === via ? SEGMENT_ON : 'text-fg-subtle hover:text-fg'
              )}
            >
              {VIA_LABEL[via]}
            </button>
          ))}
        </div>
        {draft.via === 'ssh' ? (
          <input
            type="text"
            data-settings-host-target
            aria-label="ssh target"
            placeholder="you@build-box, or a Host from ~/.ssh/config"
            spellCheck={false}
            value={draft.target}
            onChange={(event) => edit({ target: event.target.value })}
            className={cn(FIELD, 'mt-1 font-mono text-[11.5px]')}
          />
        ) : (
          <input
            type="text"
            data-settings-host-command
            aria-label="Command"
            placeholder="wsl.exe -d Ubuntu --"
            spellCheck={false}
            value={draft.command}
            onChange={(event) => edit({ command: event.target.value })}
            className={cn(FIELD, 'mt-1 font-mono text-[11.5px]')}
          />
        )}
        <p className="text-[11px] leading-[1.5] text-fg-subtle">{VIA_HINT[draft.via]}</p>
      </div>
      {error !== null && (
        <p role="alert" data-settings-host-error className="text-[12px] text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          data-settings-host-add
          className="rounded-well border border-accent px-3 py-1.5 text-[12px] text-accent-text transition-colors hover:bg-accent-soft"
        >
          Add host
        </button>
        <Action onClick={onCancel}>Cancel</Action>
      </div>
    </form>
  )
}
