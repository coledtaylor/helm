/**
 * Ages, in the width a list row has.
 *
 * A session list is read by recency, not by date: "3d" answers "is this the
 * thing I was doing on Friday" faster than "6 Aug 2026" does, and it fits
 * beside a project name. The exact timestamp is on the detail panel, where
 * there is room for it and a reason to want it.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const YEAR = 365 * DAY

export function formatAge(at: number, now = Date.now()): string {
  const ms = now - at
  // Clock skew, or a machine whose time stepped back between the CLI writing
  // the record and Helm reading it. "in 3 minutes" would be nonsense; "now" is
  // at least not wrong by much.
  if (ms < MINUTE) return 'now'
  if (ms < HOUR) return `${String(Math.floor(ms / MINUTE))}m`
  if (ms < DAY) return `${String(Math.floor(ms / HOUR))}h`
  if (ms < WEEK) return `${String(Math.floor(ms / DAY))}d`
  if (ms < YEAR) return `${String(Math.floor(ms / WEEK))}w`
  return `${String(Math.floor(ms / YEAR))}y`
}

/**
 * When a usage window resets, in the width a status bar has.
 *
 * Relative under a day and absolute over it, because those are the two
 * questions being asked. The 5-hour window resets while you are working, so
 * "in 2h 10m" is what you act on; the 7-day one resets on some evening later in
 * the week, and "Tue, 7:00 PM" is what you plan around. A countdown of "3d 4h"
 * answers neither well.
 *
 * The returned string is the phrase after the word "resets", so it reads
 * "resets in 2h 10m" and "resets Tue, 7:00 PM".
 */
export function formatResetsIn(at: number, now = Date.now()): string {
  const ms = at - now
  if (ms <= 0) return 'now'
  if (ms < MINUTE) return 'in <1m'
  if (ms < HOUR) return `in ${String(Math.floor(ms / MINUTE))}m`
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR)
    const minutes = Math.floor((ms % HOUR) / MINUTE)
    return minutes === 0 ? `in ${String(hours)}h` : `in ${String(hours)}h ${String(minutes)}m`
  }
  return new Date(at).toLocaleString(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit'
  })
}

/** The full moment, for a tooltip or a detail row. */
export function formatMoment(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** `1.2 MB`, for a transcript whose size is the evidence it still exists. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  // GB became reachable with the transcript archive's ceiling, which defaults
  // to one. Nothing else in the app gets near it - the largest transcript on
  // the machine this was written against is 4 MB - so the tier is here for the
  // limit rather than for the things measured against it.
  if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(bytes % 1024 ** 3 === 0 ? 0 : 1)} GB`
}
