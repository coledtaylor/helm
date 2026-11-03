import type { JSX } from 'react'
import { cn } from '../lib/cn'
import { WarnIcon } from './icons'

export interface HostStoppedBannerProps {
  /** The host, as the window names it: "this PC’s host". */
  hostName: string
  /** Whether Helm starts a new host in place of the one that stopped, rather than waiting for it to answer. */
  restarting: boolean
}

/**
 * Says the host the window's sessions ran in stopped without being asked to,
 * as a strip above the tabs like the version guard, while Helm gets a host
 * back: starting a new one in place of one a desktop started, or connecting
 * again to one it waits for. It goes by itself once the window is connected,
 * so it has no close.
 */
export function HostStoppedBanner({ hostName, restarting }: HostStoppedBannerProps): JSX.Element {
  const host = hostName.charAt(0).toUpperCase() + hostName.slice(1)
  return (
    <div
      role="status"
      data-host-stopped-banner={restarting ? 'restarting' : 'reconnecting'}
      className={cn(
        'flex shrink-0 items-center gap-2.5 rounded-raised border border-warn/30 bg-warn/10 px-3 py-1.5',
        'text-[12px] text-warn'
      )}
    >
      <WarnIcon width={13} height={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {restarting ? `${host} stopped. Starting it again…` : `Reconnecting to ${hostName}…`}
      </span>
    </div>
  )
}
