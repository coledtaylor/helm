import type { JSX } from 'react'
import { cn } from '../lib/cn'
import { SEGMENT_ON } from '../lib/segmented'
import type { LauncherHost } from './NewSessionDialog'

/**
 * Which host a surface shows, and the hosts it can show: This PC first, then
 * each host on another computer that is connected. History, Usage, Config,
 * Files and Settings > Plugins each take one, and keep the host they show in
 * the window only.
 */
export interface HostChoice {
  hosts: readonly LauncherHost[]
  /** The id of the host shown, one of `hosts`. */
  host: string
  onHostChange: (host: string) => void
}

export interface HostSwitchProps extends Partial<HostChoice> {
  /** What the surface is, for the control's accessible name: "History" reads as "History host". */
  surface: string
  className?: string | undefined
}

/**
 * The host a surface shows, named, with the others beside it to switch to: a
 * segmented control (DESIGN.md 4), a remote host's name in mono as everywhere
 * a host is named. Drawn only while there is more than one host to choose
 * from, so with only this PC a surface looks as it always has.
 */
export function HostSwitch({ hosts, host, onHostChange, surface, className }: HostSwitchProps): JSX.Element | null {
  if (hosts === undefined || hosts.length < 2 || host === undefined) return null
  const shown = hosts.find((each) => each.id === host)
  return (
    <span
      role="radiogroup"
      aria-label={`${surface} host`}
      title={shown === undefined ? undefined : `Showing ${shown.name}’s ${surface.toLowerCase()}`}
      data-host-switch={surface.toLowerCase()}
      data-host-shown={host}
      className={cn('flex shrink-0 gap-0.5 rounded-well border border-border bg-surface-sunken p-0.5', className)}
    >
      {hosts.map((each) => (
        <button
          key={each.id}
          type="button"
          role="radio"
          aria-checked={each.id === host}
          data-host-choice={each.id}
          onClick={() => {
            if (each.id !== host) onHostChange?.(each.id)
          }}
          className={cn(
            'max-w-40 truncate rounded-raised px-2 py-0.5 text-[11px] transition-colors',
            each.remote && 'font-mono text-[10.5px]',
            each.id === host ? SEGMENT_ON : 'text-fg-muted hover:text-fg'
          )}
        >
          {each.name}
        </button>
      ))}
    </span>
  )
}
