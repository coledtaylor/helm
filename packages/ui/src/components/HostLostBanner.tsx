import type { JSX } from 'react'
import { cn } from '../lib/cn'
import { WarnIcon } from './icons'

export interface HostLostBannerProps {
  /** The host on another computer the session runs on, as every surface names it. */
  hostName: string
  /** The session's name, as its tab says it. */
  sessionName: string
  /**
   * The last line ssh or the command wrote when it could not reach the host,
   * unedited; null while the link is simply trying again.
   */
  lastLine: string | null
  /** The line to try by hand in a terminal: `ssh build-box floti connect`. */
  tryLine: string
  /** Tries the host again at once. */
  onReconnect: () => void
}

/**
 * Over the tab of a session on a host whose link dropped: the session keeps
 * running there, the tab keeps its last screen dimmed under this, and keys
 * reach nothing until the link is back. Reconnect now tries at once rather
 * than after the wait. When ssh or the command could not get in, it shows
 * the last line it wrote, unedited, and the line to try by hand, where ssh
 * can ask for what it needs: Helm never answers it.
 *
 * It goes by itself once the host is connected again, so it has no close.
 */
export function HostLostBanner({
  hostName,
  sessionName,
  lastLine,
  tryLine,
  onReconnect
}: HostLostBannerProps): JSX.Element {
  return (
    <div
      role="status"
      data-host-lost={hostName}
      className="shrink-0 border-b border-border bg-surface-raised px-3 py-1.5 text-[11.5px] leading-[1.45] text-fg-muted"
    >
      <div className="flex items-center gap-2.5">
        <WarnIcon width={13} height={13} className="shrink-0 text-warn" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-fg">{`Lost the connection to ${hostName}.`}</span>
          {` ${sessionName} keeps running there.`}
        </span>
        <button
          type="button"
          data-host-reconnect={hostName}
          onClick={onReconnect}
          title={`Try ${hostName} again now, rather than after the wait`}
          className={cn(
            'shrink-0 rounded-well border border-border-strong px-2 py-0.5 text-[11.5px] text-fg',
            'transition-colors hover:bg-hover'
          )}
        >
          Reconnect now
        </button>
      </div>
      {lastLine !== null && (
        <div data-host-lost-failed className="mt-1 pl-[23px]">
          <p data-host-lost-line className="font-mono text-[11px] break-all text-fg select-text">
            {lastLine}
          </p>
          <p className="mt-0.5">
            Try it by hand in a terminal:{' '}
            <span data-host-lost-try className="font-mono text-[11px] text-fg select-text">
              {tryLine}
            </span>
          </p>
        </div>
      )}
    </div>
  )
}
