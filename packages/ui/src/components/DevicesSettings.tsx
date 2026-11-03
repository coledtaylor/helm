import { useState, type JSX } from 'react'
import type { DeviceRoleName } from '@helm/core/types'
import { cn } from '../lib/cn'
import { Chip } from './Chip'
import { ROLE_LABEL, Segmented } from './HostsSettings'
import { Action, Divider, Group } from './SettingsKit'

/**
 * Settings > Devices: for each host this device is an admin of, This PC
 * first, the devices paired with it and the ones waiting to pair, under the
 * host's name. A device is approved by the code it shows, with a role
 * (Operator unless another is picked), and revoked after a question naming
 * it and the host. This device's own row is marked and has no Revoke.
 *
 * What a host says is drawn as it says it: a refused code or a presence
 * check that did not pass is the sentence `onApprove` or `onRevoke` answers.
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

/** One host as Settings > Devices draws it. */
export interface SettingsDevicesHost {
  id: string
  name: string
  /** This device's fingerprint there; its row is marked. */
  thisDevice: string | null
  paired: readonly SettingsPairedDevice[]
  waiting: readonly SettingsWaitingDevice[]
  /** Why its devices could not be listed. */
  error: string | null
}

export interface DevicesSettingsProps {
  /** Each admin host, This PC first; null until the first listing lands. */
  hosts: readonly SettingsDevicesHost[] | null
  /** Approves the device waiting with `code`; answers the sentence to show when it did not. */
  onApprove: (host: string, code: string, role: DeviceRoleName) => Promise<string | null>
  /** Revokes a paired device; answers the sentence to show when it did not. */
  onRevoke: (host: string, device: SettingsPairedDevice) => Promise<string | null>
}

/** The role a device approved here gets unless another is picked. */
export const DEFAULT_APPROVE_ROLE: DeviceRoleName = 'operator'

const APPROVE_ROLES: readonly DeviceRoleName[] = ['viewer', 'operator', 'admin']

const FIELD = cn(
  'h-[30px] w-[140px] rounded-well border border-border bg-surface-sunken px-2.5',
  'font-mono text-[12px] text-fg placeholder:text-fg-subtle select-text',
  'focus:border-accent focus:outline-none'
)

/** A moment as this computer writes dates, to the minute. */
function when(text: string): string {
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return text
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date)
}

export function DevicesSettings({ hosts, onApprove, onRevoke }: DevicesSettingsProps): JSX.Element {
  return (
    <Group
      name="devices"
      title="Devices"
      hint="The devices paired with each host you are an admin of, and the ones asking to pair. Approve one by the code it shows."
    >
      {hosts === null && <p className="py-1.5 text-[12px] text-fg-muted">Looking…</p>}
      {hosts?.map((host, index) => (
        <div key={host.id}>
          {index > 0 && <Divider />}
          <HostDevices host={host} onApprove={onApprove} onRevoke={onRevoke} />
        </div>
      ))}
    </Group>
  )
}

function HostDevices({
  host,
  onApprove,
  onRevoke
}: {
  host: SettingsDevicesHost
} & Pick<DevicesSettingsProps, 'onApprove' | 'onRevoke'>): JSX.Element {
  return (
    <section data-settings-devices-host={host.id} aria-label={host.name} className="py-2">
      <h3 className="font-mono text-[12.5px] text-fg">{host.name}</h3>
      {host.error !== null ? (
        <p data-settings-devices-error className="mt-1 text-[12px] text-danger">
          {host.error}
        </p>
      ) : (
        <>
          <ul className="mt-1.5 flex flex-col">
            {host.paired.map((device) => (
              <PairedRow
                key={device.fingerprint}
                host={host}
                device={device}
                mine={device.fingerprint === host.thisDevice}
                onRevoke={onRevoke}
              />
            ))}
          </ul>
          {host.waiting.length > 0 && (
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
          )}
          <ApproveForm host={host} onApprove={onApprove} />
        </>
      )}
    </section>
  )
}

function PairedRow({
  host,
  device,
  mine,
  onRevoke
}: {
  host: SettingsDevicesHost
  device: SettingsPairedDevice
  mine: boolean
  onRevoke: DevicesSettingsProps['onRevoke']
}): JSX.Element {
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
        <span className="text-[11.5px] text-fg-muted">{ROLE_LABEL[device.role]}</span>
        <span className="font-mono text-[11px] text-fg-subtle">{device.fingerprint}</span>
        <span className="flex-1" />
        {revoked ? (
          <span data-settings-device-revoked-at className="text-[11.5px] text-fg-subtle">
            Revoked {when(device.revokedAt ?? '')}
          </span>
        ) : (
          !mine &&
          !asking && (
            <Action data-settings-device-revoke={device.fingerprint} onClick={() => setAsking(true)}>
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

function ApproveForm({
  host,
  onApprove
}: {
  host: SettingsDevicesHost
  onApprove: DevicesSettingsProps['onApprove']
}): JSX.Element {
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
          options={APPROVE_ROLES.map((value) => ({
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
