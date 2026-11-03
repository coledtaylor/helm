import { useState, type JSX } from 'react'
import type { DeviceRoleName } from '@helm/core/types'
import { cn } from '../lib/cn'
import { Chip } from './Chip'
import { ROLE_LABEL, Segmented } from './HostsSettings'
import { Action, Divider, Group, Select } from './SettingsKit'

/**
 * Settings > Devices: each host this window is connected to, This PC first,
 * under its name, with the devices attached to it now. Where this device is
 * the host's admin, also the devices paired with it, the ones waiting to
 * pair, and its audit log. A device is approved by the code it shows, with a
 * role (Operator unless another is picked), revoked after a question naming
 * it and the host, and given another role from its row. This device's own
 * row is marked and has no Revoke; a revoked device's row offers no role.
 *
 * What a host says is drawn as it says it: a refused code, role or a
 * presence check that did not pass is the sentence `onApprove`, `onRevoke`
 * or `onRole` answers, shown in the row it is about.
 */

export interface SettingsPairedDevice {
  name: string
  role: DeviceRoleName
  /** RFC 3339 text. */
  pairedAt: string
  /** RFC 3339 text; null while it is not revoked. */
  revokedAt: string | null
  fingerprint: string
}

export interface SettingsWaitingDevice {
  name: string
  fingerprint: string
  secondsLeft: number
}

/** A device attached to a host now. */
export interface SettingsAttachedDevice {
  fingerprint: string
  name: string
  role: DeviceRoleName
  /** Whether it is connected from another computer than the host's. */
  away: boolean
  /** When it attached, as RFC 3339 text. */
  since: string
}

/** One entry of a host's audit log, in words. */
export interface SettingsAuditEntry {
  number: number
  /** RFC 3339 text. */
  at: string
  /** What happened, as one sentence. */
  what: string
  /** The device it is about, or who asked, by name; null where none is known. */
  device: string | null
  fingerprint: string | null
  /** Whether that was from another computer; null where the entry does not say. */
  away: boolean | null
}

/** A host's audit log as far as it has been read, newest first. */
export interface SettingsAuditLog {
  entries: readonly SettingsAuditEntry[]
  /** Whether older entries remain to be read. */
  more: boolean
  /** Whether a page is being read now. */
  loading: boolean
  /** Why the last page could not be read. */
  error: string | null
}

/** One host as Settings > Devices draws it. */
export interface SettingsDevicesHost {
  id: string
  name: string
  /** Whether the host runs on this computer: This PC's. */
  thisComputer: boolean
  /** This device's fingerprint there; its rows are marked. */
  thisDevice: string | null
  /** Whether this device is the host's admin: only then are its paired devices and audit log shown. */
  admin: boolean
  /** Who is attached now; null until the host has said. */
  attached: readonly SettingsAttachedDevice[] | null
  /** Why who is attached cannot be shown. */
  attachedError: string | null
  paired: readonly SettingsPairedDevice[]
  waiting: readonly SettingsWaitingDevice[]
  /** Why its paired devices could not be listed. */
  error: string | null
  /** Its audit log; null where it is not shown. */
  audit: SettingsAuditLog | null
}

export interface DevicesSettingsProps {
  /** Each connected host, This PC first; null until the first listing lands. */
  hosts: readonly SettingsDevicesHost[] | null
  /** Approves the device waiting with `code`; answers the sentence to show when it did not. */
  onApprove: (host: string, code: string, role: DeviceRoleName) => Promise<string | null>
  /** Revokes a paired device; answers the sentence to show when it did not. */
  onRevoke: (host: string, device: SettingsPairedDevice) => Promise<string | null>
  /** Gives a paired device another role; answers the sentence to show when it did not. */
  onRole: (host: string, device: SettingsPairedDevice, role: DeviceRoleName) => Promise<string | null>
  /** Reads the next older page of a host's audit log. */
  onMoreAudit: (host: string) => void
}

/** The role a device approved here gets unless another is picked. */
export const DEFAULT_APPROVE_ROLE: DeviceRoleName = 'operator'

const ROLES: readonly DeviceRoleName[] = ['viewer', 'operator', 'admin']

const FIELD = cn(
  'h-[30px] w-[140px] rounded-well border border-border bg-surface-sunken px-2.5',
  'font-mono text-[12px] text-fg placeholder:text-fg-subtle select-text',
  'focus:border-accent focus:outline-none'
)

/** A moment as this computer writes dates: to the minute, or to the second where order matters. */
function when(text: string, seconds = false): string {
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return text
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: seconds ? 'medium' : 'short'
  }).format(date)
}

/** Where a device is, from the host's side. */
function whereFrom(away: boolean, host: SettingsDevicesHost): string {
  if (away) return 'From another computer'
  return host.thisComputer ? 'On this computer' : 'On the host’s computer'
}

/** A part of a host's devices: the caps label every section of the app is named with. */
function PartLabel({ children }: { children: string }): JSX.Element {
  return (
    <h4 className="mt-3 mb-1 text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase">{children}</h4>
  )
}

/** The second line of a list row: machine data, mono where it is a fingerprint. */
function Detail({ parts, fingerprint }: { parts: readonly string[]; fingerprint: string | null }): JSX.Element {
  return (
    <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-fg-subtle">
      {parts.map((part) => (
        <span key={part}>{part}</span>
      ))}
      {fingerprint !== null && <span className="font-mono">{fingerprint}</span>}
    </p>
  )
}

export function DevicesSettings({ hosts, ...actions }: DevicesSettingsProps): JSX.Element {
  return (
    <Group
      name="devices"
      title="Devices"
      hint="Who is attached to each host now. Where you are an admin, also the devices paired with it, the ones asking to pair and its audit log. Approve a device by the code it shows."
    >
      {hosts === null && <p className="py-1.5 text-[12px] text-fg-muted">Looking…</p>}
      {hosts?.map((host, index) => (
        <div key={host.id}>
          {index > 0 && <Divider />}
          <HostDevices host={host} {...actions} />
        </div>
      ))}
    </Group>
  )
}

type Actions = Omit<DevicesSettingsProps, 'hosts'>

function HostDevices({ host, ...actions }: { host: SettingsDevicesHost } & Actions): JSX.Element {
  return (
    <section data-settings-devices-host={host.id} aria-label={host.name} className="py-2">
      <h3 className="font-mono text-[12.5px] text-fg">{host.name}</h3>
      <AttachedDevices host={host} />
      {host.admin ? (
        <>
          <PartLabel>Paired</PartLabel>
          {host.error !== null ? (
            <p data-settings-devices-error className="text-[12px] text-danger">
              {host.error}
            </p>
          ) : (
            <>
              <ul className="flex flex-col">
                {host.paired.map((device) => (
                  <PairedRow
                    key={device.fingerprint}
                    host={host}
                    device={device}
                    mine={device.fingerprint === host.thisDevice}
                    onRevoke={actions.onRevoke}
                    onRole={actions.onRole}
                  />
                ))}
              </ul>
              {host.waiting.length > 0 && <WaitingDevices host={host} />}
              <ApproveForm host={host} onApprove={actions.onApprove} />
            </>
          )}
          {host.audit !== null && <AuditLog host={host} log={host.audit} onMore={actions.onMoreAudit} />}
        </>
      ) : (
        <>
          {host.error !== null && (
            <p data-settings-devices-error className="mt-1 text-[12px] text-danger">
              {host.error}
            </p>
          )}
          <p data-settings-devices-not-admin className="mt-2 text-[11.5px] text-fg-muted">
            Paired devices, requests to pair and the audit log show only where this device is an admin.
          </p>
        </>
      )}
    </section>
  )
}

function AttachedDevices({ host }: { host: SettingsDevicesHost }): JSX.Element {
  return (
    <>
      <PartLabel>Attached now</PartLabel>
      {host.attachedError !== null ? (
        <p data-settings-attached-error className="text-[12px] text-fg-muted">
          {host.attachedError}
        </p>
      ) : host.attached === null ? (
        <p className="text-[12px] text-fg-muted">Looking…</p>
      ) : (
        <ul data-settings-attached-list={host.id} className="flex flex-col">
          {host.attached.map((device) => {
            const mine = device.fingerprint === host.thisDevice
            return (
              <li
                key={device.fingerprint}
                data-settings-attached={device.fingerprint}
                data-settings-attached-mine={mine ? 'true' : undefined}
                className="py-1"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="min-w-0 truncate text-[12.5px] text-fg">{device.name}</span>
                  {mine && <Chip tone="accent">This device</Chip>}
                  <span className="flex-1" />
                  <span data-settings-attached-since className="text-[11.5px] text-fg-subtle">
                    Since {when(device.since)}
                  </span>
                </div>
                <Detail
                  parts={[ROLE_LABEL[device.role], whereFrom(device.away, host)]}
                  fingerprint={device.fingerprint}
                />
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

function WaitingDevices({ host }: { host: SettingsDevicesHost }): JSX.Element {
  return (
    <>
      <p className="mt-2 text-[11.5px] text-fg-muted">Waiting to pair</p>
      <ul className="mt-1 flex flex-col">
        {host.waiting.map((device) => (
          <li
            key={device.fingerprint}
            data-settings-device-waiting={device.fingerprint}
            className="flex min-w-0 items-center gap-2.5 py-1"
          >
            <span className="min-w-0 truncate text-[12.5px] text-fg">{device.name}</span>
            <span className="font-mono text-[11px] text-fg-subtle">{device.fingerprint}</span>
            <span className="text-[11px] text-fg-subtle">
              {Math.max(1, Math.ceil(device.secondsLeft / 60))} min left
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

function PairedRow({
  host,
  device,
  mine,
  onRevoke,
  onRole
}: {
  host: SettingsDevicesHost
  device: SettingsPairedDevice
  mine: boolean
} & Pick<Actions, 'onRevoke' | 'onRole'>): JSX.Element {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revoke = async (): Promise<void> => {
    setBusy(true)
    const failed = await onRevoke(host.id, device)
    setBusy(false)
    setAsking(false)
    setError(failed)
  }
  const changeRole = async (role: DeviceRoleName): Promise<void> => {
    if (role === device.role) return
    setBusy(true)
    setError(null)
    const failed = await onRole(host.id, device, role)
    setBusy(false)
    setError(failed)
  }
  const revoked = device.revokedAt !== null
  return (
    <li
      data-settings-device={device.fingerprint}
      data-settings-device-revoked={String(revoked)}
      data-settings-device-mine={mine ? 'true' : undefined}
      className="py-1"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className={cn('min-w-0 truncate text-[12.5px]', revoked ? 'text-fg-subtle' : 'text-fg')}>
          {device.name}
        </span>
        {mine && <Chip tone="accent">This device</Chip>}
        {revoked ? (
          <span data-settings-device-role-name className="text-[11.5px] text-fg-muted">
            {ROLE_LABEL[device.role]}
          </span>
        ) : (
          <Select
            narrow
            label={`Role of ${device.name}`}
            value={device.role}
            disabled={busy}
            onChange={(role) => void changeRole(role as DeviceRoleName)}
            data-settings-device-role={device.fingerprint}
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABEL[role]}
              </option>
            ))}
          </Select>
        )}
        <span className="font-mono text-[11px] text-fg-subtle">{device.fingerprint}</span>
        <span className="flex-1" />
        <span data-settings-device-paired-at className="text-[11.5px] text-fg-subtle">
          Paired {when(device.pairedAt)}
        </span>
        {revoked ? (
          <span data-settings-device-revoked-at className="text-[11.5px] text-fg-subtle">
            Revoked {when(device.revokedAt ?? '')}
          </span>
        ) : (
          !mine &&
          !asking && (
            <Action data-settings-device-revoke={device.fingerprint} disabled={busy} onClick={() => setAsking(true)}>
              Revoke
            </Action>
          )
        )}
      </div>
      {asking && (
        <div
          role="alertdialog"
          aria-label={`Revoke ${device.name}`}
          data-settings-device-confirm
          className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-fg-muted"
        >
          <span>
            Revoke {device.name} on {host.name}? Its connections close now, and it has to pair again to come back.
          </span>
          <Action primary data-settings-device-confirm-revoke disabled={busy} onClick={() => void revoke()}>
            Revoke
          </Action>
          <Action onClick={() => setAsking(false)} disabled={busy}>
            Cancel
          </Action>
        </div>
      )}
      {error !== null && (
        <p role="alert" data-settings-device-error className="mt-1 text-[12px] text-danger">
          {error}
        </p>
      )}
    </li>
  )
}

function AuditLog({
  host,
  log,
  onMore
}: {
  host: SettingsDevicesHost
  log: SettingsAuditLog
  onMore: Actions['onMoreAudit']
}): JSX.Element {
  return (
    <>
      <PartLabel>Audit log</PartLabel>
      {log.entries.length === 0 && !log.loading && log.error === null && (
        <p className="text-[12px] text-fg-muted">Nothing recorded yet.</p>
      )}
      <ol data-settings-audit={host.id} aria-label={`Audit log of ${host.name}`} className="flex flex-col">
        {log.entries.map((entry) => (
          <li key={entry.number} data-settings-audit-entry={entry.number} className="py-1">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="min-w-0 truncate text-[12px] text-fg">{entry.what}</span>
              <span className="flex-1" />
              <span data-settings-audit-at className="shrink-0 text-[11.5px] text-fg-subtle">
                {when(entry.at, true)}
              </span>
            </div>
            <Detail
              parts={[
                ...(entry.device !== null ? [entry.device] : []),
                ...(entry.away !== null ? [whereFrom(entry.away, host)] : [])
              ]}
              fingerprint={entry.fingerprint}
            />
          </li>
        ))}
      </ol>
      {log.error !== null && (
        <p role="alert" data-settings-audit-error className="mt-1 text-[12px] text-danger">
          {log.error}
        </p>
      )}
      {log.loading && <p className="py-1 text-[12px] text-fg-muted">Reading…</p>}
      {log.more && !log.loading && (
        <div className="mt-1.5">
          <Action data-settings-audit-more={host.id} onClick={() => onMore(host.id)}>
            Show more
          </Action>
        </div>
      )}
    </>
  )
}

function ApproveForm({ host, onApprove }: { host: SettingsDevicesHost; onApprove: Actions['onApprove'] }): JSX.Element {
  const [code, setCode] = useState('')
  const [role, setRole] = useState<DeviceRoleName>(DEFAULT_APPROVE_ROLE)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    if (code.trim() === '') {
      setError('Type the code the device shows.')
      return
    }
    setBusy(true)
    const failed = await onApprove(host.id, code.trim(), role)
    setBusy(false)
    setError(failed)
    if (failed === null) setCode('')
  }
  return (
    <form
      data-settings-device-approve={host.id}
      aria-label={`Approve a device on ${host.name}`}
      className="mt-2.5 flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <input
          type="text"
          data-settings-device-code
          aria-label={`Code to approve on ${host.name}`}
          placeholder="Code it shows"
          spellCheck={false}
          value={code}
          onChange={(event) => {
            setCode(event.target.value)
            setError(null)
          }}
          className={FIELD}
        />
        <Segmented
          label={`Role on ${host.name}`}
          name="settings-device-role"
          options={ROLES.map((value) => ({
            value,
            label: ROLE_LABEL[value]
          }))}
          value={role}
          onChange={setRole}
        />
        <button
          type="submit"
          data-settings-device-approve-submit
          disabled={busy}
          className="rounded-well border border-accent px-3 py-1.5 text-[12px] text-accent-text transition-colors hover:bg-accent-soft disabled:opacity-50"
        >
          Approve
        </button>
      </div>
      {error !== null && (
        <p role="alert" data-settings-device-approve-error className="text-[12px] text-danger">
          {error}
        </p>
      )}
    </form>
  )
}
