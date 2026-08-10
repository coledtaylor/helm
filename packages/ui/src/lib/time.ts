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
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
