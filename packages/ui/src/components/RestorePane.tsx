import { useId, useState, type JSX } from 'react'
import type { RestorableSession, RestoreOffer } from '@helm/core/types'
import { cn } from '../lib/cn'
import { folderName } from '../lib/launcher'
import { formatMoment } from '../lib/time'
import { Checkbox } from './Checkbox'
import { HistoryIcon } from './icons'

export interface RestorePaneProps {
  offer: RestoreOffer
  /** The \`restoreWithoutAsking\` setting, ticked here or in Settings. */
  withoutAsking: boolean
  onWithoutAskingChange: (next: boolean) => void
  /** True while the reopening is under way. */
  busy: boolean
  /** The ticked sessions' row ids, in the order they are listed. */
  onResume: (ids: number[]) => void
  onNotNow: () => void
  /** The clock, for the time column. */
  now: number
}

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`

/**
 * When a session was last spoken to, in the width its column has: the time
 * for today, which is the case after a crash, and the date for anything older.
 */
function lastSaid(at: number, now: number): string {
  const when = new Date(at)
  return when.toDateString() === new Date(now).toDateString()
    ? when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/**
 * What a crash took, offered back: every session the last run was hosting
 * when it stopped, ticked, and the one button that reopens them where they
 * were.
 *
 * A page in a pane rather than a dialog, because it is the first thing a
 * start after a crash has to say and somebody may want to look at the rest of
 * the window before answering. Closing its tab is "not now", the same as the
 * button.
 *
 * A session that cannot come back is listed anyway, unticked and greyed with
 * the reason - one quietly missing from the list would read as Helm having
 * forgotten it.
 */
export function RestorePane({
  offer,
  withoutAsking,
  onWithoutAskingChange,
  busy,
  onResume,
  onNotNow,
  now
}: RestorePaneProps): JSX.Element {
  const headingId = useId()
  const [ticked, setTicked] = useState<ReadonlySet<number>>(
    () => new Set(offer.sessions.filter((session) => session.blocked === null).map((session) => session.id))
  )
  const chosen = offer.sessions.filter((session) => ticked.has(session.id)).map((session) => session.id)

  const toggle = (id: number): void =>
    setTicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const count = offer.sessions.length
  const elsewhere =
    offer.elsewhere === 0
      ? null
      : `${plural(offer.elsewhere, 'more is', 'more are')} still running somewhere else, and left alone.`

  return (
    <div
      data-restore-pane
      aria-labelledby={headingId}
      role="region"
      className="h-full overflow-auto rounded-island border border-border bg-surface px-6"
    >
      <div className="mx-auto w-full max-w-[560px] pt-24 pb-10">
        <div className="mb-1.5 flex items-center gap-2.5">
          <HistoryIcon width={20} height={20} className="shrink-0 text-accent-text" />
          <h1 id={headingId} className="m-0 text-[18px] font-medium tracking-[-0.01em] text-fg">
            {count === 1
              ? '1 session was running when Helm closed'
              : `${String(count)} sessions were running when Helm closed`}
          </h1>
        </div>
        <p className="mt-0 mb-[18px] ml-[30px] leading-normal text-fg-muted">
          Helm didn’t shut down cleanly. Pick up where they left off.
        </p>

        <ul
          aria-label="Sessions to reopen"
          className="m-0 list-none overflow-hidden rounded-raised border border-border bg-surface-raised p-0"
        >
          {offer.sessions.map((session) => (
            <Row
              key={session.id}
              session={session}
              on={ticked.has(session.id)}
              onToggle={() => toggle(session.id)}
              now={now}
            />
          ))}
        </ul>

        <p className="mt-3 mb-[18px] text-[11.5px] leading-normal text-fg-subtle">
          Each one runs <span className="font-mono text-fg-muted">claude --resume</span> in its own
          folder with its own profile, in the tab it had. Not now leaves them in Session history.
          {elsewhere !== null && <> {elsewhere}</>}
        </p>

        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-fg-muted">
            <Checkbox
              checked={withoutAsking}
              onChange={() => onWithoutAskingChange(!withoutAsking)}
              label="Always resume without asking"
              mark="data-restore-always"
            />
            Always resume without asking
          </label>
          <span className="flex-1" />
          <button
            type="button"
            onClick={onNotNow}
            disabled={busy}
            className="rounded-well border border-border-strong px-3.5 py-1.5 text-[12.5px] text-fg transition-colors hover:bg-hover disabled:cursor-default disabled:opacity-50"
          >
            Not now
          </button>
          <button
            type="button"
            data-restore-resume
            onClick={() => onResume(chosen)}
            disabled={busy || chosen.length === 0}
            className={cn(
              'rounded-well border border-accent px-4 py-1.5 text-[12.5px] font-medium text-accent-text',
              'transition-colors hover:bg-accent-soft active:bg-active',
              'disabled:cursor-default disabled:border-border-strong disabled:text-fg-subtle disabled:hover:bg-transparent'
            )}
          >
            {busy ? 'Resuming…' : `Resume ${plural(chosen.length, 'session', 'sessions')}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function Row({
  session,
  on,
  onToggle,
  now
}: {
  session: RestorableSession
  on: boolean
  onToggle: () => void
  now: number
}): JSX.Element {
  const blocked = session.blocked !== null
  const where = [folderName(session.cwd), session.branch].filter((part) => part !== null).join(' · ')
  return (
    <li
      data-restore-row={session.id}
      {...(blocked ? { 'data-restore-blocked': '' } : {})}
      className="border-b border-border last:border-b-0"
    >
      <label
        title={session.cwd}
        className={cn(
          'flex h-[46px] items-center gap-3 px-3.5',
          blocked ? 'cursor-default' : 'cursor-pointer hover:bg-hover'
        )}
      >
        <Checkbox checked={on} onChange={onToggle} label={session.name} disabled={blocked} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn('truncate', on ? 'text-fg' : 'text-fg-muted')}>{session.name}</span>
          {blocked ? (
            <span className="truncate text-[11px] text-fg-subtle">{session.blocked}</span>
          ) : (
            <span className="truncate font-mono text-[11px] text-fg-subtle">{where}</span>
          )}
        </span>
        {session.profileGone ? (
          <span className="shrink-0 text-[11.5px] text-warn">Profile deleted</span>
        ) : (
          session.profile !== null && (
            <span className="shrink-0 text-[11.5px] text-fg-subtle">{session.profile}</span>
          )
        )}
        <span
          className="w-16 shrink-0 text-right text-[11.5px] text-fg-subtle tabular-nums"
          title={session.lastAt === null ? undefined : formatMoment(session.lastAt)}
        >
          {session.lastAt === null ? '' : lastSaid(session.lastAt, now)}
        </span>
      </label>
    </li>
  )
}
