import type { JSX } from 'react'
import { cn } from '../lib/cn'

export interface StatusBarProps {
  /** e.g. "0.0.1 - dev". */
  build: string
  dbFile: string
  migrations: string[]
  claudeVersion: string | null
  scanning: boolean
  lastScan: { projects: number; durationMs: number; at: string } | null
  /** Hosted `claude` processes currently alive. */
  runningSessions: number
  onRevealDb: () => void
}

/**
 * The bottom strip. Everything on it answers a question that otherwise needs a
 * file explorer: where the database is, which migrations it is on, whether the
 * `claude` CLI was found, and how long the last scan took.
 */
export function StatusBar({
  build,
  dbFile,
  migrations,
  claudeVersion,
  scanning,
  lastScan,
  runningSessions,
  onRevealDb
}: StatusBarProps): JSX.Element {
  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-[11px] text-fg-subtle">
      <span className="shrink-0">Helm {build}</span>

      <Divider />

      <button
        type="button"
        onClick={onRevealDb}
        title={`${dbFile}\n${migrations.length} migration(s): ${migrations.join(', ')}`}
        className="shrink-0 transition-colors hover:text-accent"
      >
        SQLite &middot; {migrations.length} migration{migrations.length === 1 ? '' : 's'}
      </button>

      <Divider />

      <span
        className={cn('shrink-0', claudeVersion === null && 'text-warn')}
        title={
          claudeVersion === null
            ? 'The claude CLI was not found. Config browsing works; launching a session will not.'
            : `claude --version reported ${claudeVersion}`
        }
      >
        {claudeVersion === null ? 'claude CLI not found' : `claude ${claudeVersion}`}
      </span>

      <span className="flex-1" />

      {runningSessions > 0 && (
        <>
          <span
            className="flex shrink-0 items-center gap-1.5 tabular-nums"
            title="Hosted claude processes. All of them end when Helm quits."
          >
            <span aria-hidden className="size-1.5 rounded-full bg-success" />
            {runningSessions} session{runningSessions === 1 ? '' : 's'}
          </span>
          <Divider />
        </>
      )}

      <span className="shrink-0 tabular-nums">
        {scanning
          ? 'Scanning…'
          : lastScan
            ? `${lastScan.projects} projects in ${lastScan.durationMs} ms`
            : 'No scan yet'}
      </span>
    </footer>
  )
}

function Divider(): JSX.Element {
  return <span aria-hidden className="h-3 w-px shrink-0 bg-border" />
}
