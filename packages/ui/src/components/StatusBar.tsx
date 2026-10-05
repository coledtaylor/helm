import type { JSX } from 'react'
import type { UsageDisplayMode, UsageSnapshot } from '@helm/core/types'
import { cn } from '../lib/cn'
import { UsageStatus } from './UsageStatus'

export interface StatusBarProps {
  /**
   * Helm's own live sessions, by what they are doing. `idle` counts every
   * session that is alive and not working or waiting - one that has handed
   * back with a background task still running, and one that has not said
   * anything yet, as well as one that is simply ready.
   */
  sessions: { working: number; waiting: number; idle: number }
  /** Brings the next session that is waiting on you to the front. */
  onShowWaiting: () => void
  /**
   * What kind of build this is when it is not an ordinary install - "dev",
   * "dev · live", "portable" - and null when it is. Each of those changes what
   * the binary is and where the data lives, so it is worth a word; an
   * installed build is the case that needs none.
   */
  mode: string | null
  /** The app's own version, first on the bar. Null until the app has said. */
  version: string | null
  /** The `claude` CLI's version, `x.y.z`, or null while it is not known. */
  claudeVersion: string | null
  /** The `claude` CLI was not found. Said here as well as in the banner,
   * because the banner can be dismissed and the fact cannot. */
  claudeMissing: boolean
  /** Claude Code's cached plan-limit figures, or null before the first read. */
  usage: UsageSnapshot | null
  usageDisplay: UsageDisplayMode
  onUsageDisplayChange: (mode: UsageDisplayMode) => void
  /**
   * What the launch's update check found, or null if it made none. Structural
   * rather than the desktop package's `UpdateCheck`: the bar renders a version
   * and opens a URL, so it takes a version and a URL.
   */
  update: { latest: string; newer: boolean; url: string } | null
  onOpenUpdate: (url: string) => void
  /** Each plugin's item, in the order the plugins were added. Pressing one opens its panel. */
  plugins?: readonly StatusPluginItem[] | undefined
}

export interface StatusPluginItem {
  /** The plugin's id. */
  id: string
  /** The plugin's name, said in the tooltip when the item has none of its own. */
  name: string
  text: string
  tone: 'neutral' | 'accent' | 'success' | 'warn' | 'danger'
  tooltip: string | null
  onSelect: () => void
}

const PLUGIN_TONE: Record<StatusPluginItem['tone'], string> = {
  neutral: 'text-fg-subtle hover:text-fg',
  accent: 'text-accent-text',
  success: 'text-success',
  warn: 'text-warn',
  danger: 'text-danger'
}

/**
 * The bottom strip. On the left, which Helm this is and which `claude` it
 * runs - the version, the build when it is not an ordinary install, a newer
 * release when there is one - and then what your sessions are doing. On the
 * right, what you have left of the plan.
 *
 * The two versions lead because they are what somebody reads the bar for when
 * something is off, and they are fixed-width facts that do not move. How long
 * the last scan took is in Settings; it is a fact about Helm nobody acts on.
 */
export function StatusBar({
  sessions,
  onShowWaiting,
  mode,
  version,
  claudeVersion,
  claudeMissing,
  usage,
  usageDisplay,
  onUsageDisplayChange,
  update,
  onOpenUpdate,
  plugins = []
}: StatusBarProps): JSX.Element {
  const total = sessions.working + sessions.waiting + sessions.idle
  return (
    // No island and no border: the status bar is the one strip that sits
    // directly on the canvas (DESIGN.md), a caption under the islands rather
    // than a panel of its own.
    <footer className="flex h-[26px] shrink-0 items-center gap-3 px-3.5 text-[11px] text-fg-subtle tabular-nums">
      {version !== null && (
        <span data-status-version className="shrink-0">
          Helm {version}
        </span>
      )}

      {mode !== null && (
        <span
          data-status-mode={mode}
          className="shrink-0 rounded-sm border border-border-strong px-1.5 leading-[16px] text-fg-muted"
        >
          {mode}
        </span>
      )}

      {/* Beside the version, because that is the thing it is about. The
          accent as *text*, never as a fill: a newer release is worth noticing
          and is not a warning - colouring it `warn` would put it in the same
          language as a missing CLI, which is a thing you have to fix. This is
          an offer. */}
      {update !== null && update.newer && (
        <button
          type="button"
          data-update-available={update.latest}
          title={`Helm ${update.latest} was released. Opens the releases page - Helm downloads and installs nothing.`}
          onClick={() => onOpenUpdate(update.url)}
          className={cn(
            '-mx-1 shrink-0 rounded px-1 text-accent underline decoration-dotted',
            'underline-offset-[3px] transition-colors hover:bg-hover'
          )}
        >
          {update.latest} available
        </button>
      )}

      {(claudeMissing || claudeVersion !== null) && (
        <>
          {version !== null && <Divider />}
          {claudeMissing ? (
            <span
              data-status-claude="missing"
              className="shrink-0 text-warn"
              title="The claude CLI was not found. Config browsing works; launching a session will not."
            >
              claude CLI not found
            </span>
          ) : (
            <span data-status-claude={claudeVersion} className="shrink-0">
              claude {claudeVersion}
            </span>
          )}
        </>
      )}

      {(version !== null || claudeMissing || claudeVersion !== null) && <Divider />}

      {total === 0 ? (
        <span data-status-sessions="none">No sessions running</span>
      ) : (
        <>
          {sessions.working > 0 && (
            <span data-status-sessions="working" className="flex shrink-0 items-center gap-1.5">
              <span aria-hidden className="size-1.5 rounded-full bg-accent" />
              {sessions.working} working
            </span>
          )}
          {/* The one segment that is a button: "needs you" is a request, and
              the answer to it is to go there. Each press brings the next one
              forward. */}
          {sessions.waiting > 0 && (
            <button
              type="button"
              data-status-sessions="waiting"
              onClick={onShowWaiting}
              title="Show the session that is waiting on you"
              className="-mx-1 flex shrink-0 items-center gap-1.5 rounded px-1 text-warn transition-colors hover:bg-hover"
            >
              <span aria-hidden className="size-1.5 rounded-full bg-warn" />
              {sessions.waiting} needs you
            </button>
          )}
          {sessions.idle > 0 && (
            <span data-status-sessions="idle" className="flex shrink-0 items-center gap-1.5">
              <span aria-hidden className="size-1.5 rounded-full border-[1.5px] border-success" />
              {sessions.idle} idle
            </span>
          )}
        </>
      )}

      <span className="flex-1" />

      {/* A plugin's word, in its own tone, never more than a line of caption:
          the bar is chrome, and a plugin is one voice on it. */}
      {plugins.map((item) => (
        <button
          key={item.id}
          type="button"
          data-status-plugin={item.id}
          title={item.tooltip ?? item.name}
          onClick={item.onSelect}
          className={cn(
            '-mx-1 max-w-[220px] shrink-0 truncate rounded px-1 transition-colors hover:bg-hover',
            PLUGIN_TONE[item.tone]
          )}
        >
          {item.text}
        </button>
      ))}
      {plugins.length > 0 && <Divider />}

      <UsageStatus snapshot={usage} mode={usageDisplay} onModeChange={onUsageDisplayChange} />
    </footer>
  )
}

/** A hairline between the groups on the left, the one the usage figures use between their windows. */
function Divider(): JSX.Element {
  return <span aria-hidden className="h-2.5 w-px shrink-0 bg-border-strong" />
}
