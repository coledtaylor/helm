import { useState, type JSX } from 'react'
import { Chip } from './Chip'
import { Action, Divider, Group } from './SettingsKit'

/**
 * Settings > Devices: each host this window is connected to now, This PC
 * first, under its name, with the devices attached to it now: each one's
 * name, key fingerprint, whether it is on that host's computer or another,
 * and since when. The list is the host's own, live: a device appears when it
 * attaches and goes when its last connection there closes, and a device with
 * several connections is one row.
 *
 * Whatever reaches a host's socket through the user's own login and
 * completes the handshake is served in full: the login is the access.
 * Disconnect beside a device closes every one of its
 * connections to that host at once and ends none of its sessions; keeping a
 * lost device out for good is the user's login's job (its SSH key). This
 * device's own row is marked and has no Disconnect.
 */

/** A device attached to a host now. */
export interface SettingsAttachedDevice {
  fingerprint: string
  name: string
  /** Whether it is connected from another computer than the host's. */
  away: boolean
  /** When its first open connection there was welcomed, as RFC 3339 text. */
  since: string
}

/** One host as Settings > Devices draws it. */
export interface SettingsDevicesHost {
  id: string
  name: string
  /** Whether the host runs on this computer: This PC's. */
  thisComputer: boolean
  /** This device's fingerprint there, from the host's welcome; its row is marked. */
  thisDevice: string | null
  /** Who is attached now; null until the host has said. */
  attached: readonly SettingsAttachedDevice[] | null
  /** Why who is attached cannot be shown. */
  error: string | null
}

export interface DevicesSettingsProps {
  /** Each host connected now, This PC first. */
  hosts: readonly SettingsDevicesHost[]
  /** Closes every connection of `device` to host `host`; answers the sentence to show when it could not. */
  onDisconnect: (host: string, device: SettingsAttachedDevice) => Promise<string | null>
}

/** A moment as this computer writes dates, to the minute. */
function when(text: string): string {
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) return text
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date)
}

/** Where a device is, from the host's side. */
function whereFrom(away: boolean, host: SettingsDevicesHost): string {
  if (away) return 'From another computer'
  return host.thisComputer ? 'On this computer' : 'On the host’s computer'
}

export function DevicesSettings({ hosts, onDisconnect }: DevicesSettingsProps): JSX.Element {
  return (
    <Group
      name="devices"
      title="Devices"
      hint="The devices attached to each host you are connected to, as they come and go. Disconnect closes a device’s connections there; its sessions keep running."
    >
      {hosts.length === 0 && (
        <p data-settings-devices-none className="py-1.5 text-[12px] text-fg-muted">
          No host is connected now.
        </p>
      )}
      {hosts.map((host, index) => (
        <div key={host.id}>
          {index > 0 && <Divider />}
          <HostDevices host={host} onDisconnect={onDisconnect} />
        </div>
      ))}
    </Group>
  )
}

function HostDevices({
  host,
  onDisconnect
}: { host: SettingsDevicesHost } & Pick<DevicesSettingsProps, 'onDisconnect'>): JSX.Element {
  return (
    <section data-settings-devices-host={host.id} aria-label={host.name} className="py-2">
      <h3 className="font-mono text-[12.5px] text-fg">{host.name}</h3>
      {host.error !== null ? (
        <p data-settings-devices-error className="mt-1 text-[12px] text-fg-muted">
          {host.error}
        </p>
      ) : host.attached === null ? (
        <p className="mt-1 text-[12px] text-fg-muted">Looking…</p>
      ) : (
        <ul data-settings-attached-list={host.id} className="mt-1 flex flex-col">
          {host.attached.map((device) => (
            <AttachedRow
              key={device.fingerprint}
              host={host}
              device={device}
              mine={device.fingerprint === host.thisDevice}
              onDisconnect={onDisconnect}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

function AttachedRow({
  host,
  device,
  mine,
  onDisconnect
}: {
  host: SettingsDevicesHost
  device: SettingsAttachedDevice
  mine: boolean
} & Pick<DevicesSettingsProps, 'onDisconnect'>): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const disconnect = (): void => {
    setBusy(true)
    setError(null)
    void onDisconnect(host.id, device).then((problem) => {
      setBusy(false)
      setError(problem)
    })
  }
  return (
    <li
      data-settings-attached={device.fingerprint}
      data-settings-attached-mine={mine ? 'true' : undefined}
      aria-label={device.name}
      className="py-1.5"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="min-w-0 truncate text-[12.5px] text-fg">{device.name}</span>
        {mine && <Chip tone="accent">This device</Chip>}
        <span className="flex-1" />
        <span data-settings-attached-since className="text-[11.5px] text-fg-subtle">
          Since {when(device.since)}
        </span>
        {!mine && (
          <Action data-settings-attached-disconnect={device.fingerprint} disabled={busy} onClick={disconnect}>
            Disconnect
          </Action>
        )}
      </div>
      <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-fg-subtle">
        <span data-settings-attached-where>{whereFrom(device.away, host)}</span>
        <span data-settings-attached-fingerprint className="font-mono select-text">
          {device.fingerprint}
        </span>
      </p>
      {error !== null && (
        <p role="alert" data-settings-attached-error className="mt-1 text-[12px] text-danger">
          {error}
        </p>
      )}
    </li>
  )
}
