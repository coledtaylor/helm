import type { ChildReport } from '../types'

/**
 * A child's report as its card draws it: a note under the card's header.
 *
 * The host keeps a child's last report on the child's row until its next turn
 * starts, and lists it with the row. What the note says, and when there is
 * none, is decided here so the view only draws.
 */
export interface ReportNote {
  /** "Reported done", "Reported stuck" or "Note". */
  label: string
  /** All of the report, in the child's own words. */
  text: string
  /** When it was made. A later report is another note, which starts folded. */
  at: string
}

/** What a report's state is called in the note. */
const NOTE_LABELS: Readonly<Record<string, string>> = {
  done: 'Reported done',
  stuck: 'Reported stuck'
}

/** What a report of a state this build has no word for is called: the neutral one. */
const NOTE_LABEL_OTHER = 'Note'

/**
 * The note for `child`'s card, or null when the card has none.
 *
 * A card has one while its child runs and its last report stands. An ended
 * child's report is not shown: its header says how it ended, and its last
 * screen is what is left to read. A command child runs a program and not an
 * agent, so it has nothing to report and never has one, whatever its row says.
 */
export function reportNote(
  child: { status: string; lastReport?: ChildReport | undefined },
  options: { command?: boolean } = {}
): ReportNote | null {
  if (options.command === true || child.status !== 'running') return null
  const report = child.lastReport
  if (report === undefined || report.text.trim() === '') return null
  return { label: NOTE_LABELS[report.state] ?? NOTE_LABEL_OTHER, text: report.text, at: report.at }
}

/** Whether two reports (or the lack of both) say the same thing. */
export function sameReport(a: ChildReport | undefined, b: ChildReport | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.state === b.state && a.text === b.text && a.at === b.at
}

/**
 * `known` with the report `fresh` carries: the very same row when they agree,
 * and a copy that takes the report (or goes without one) when they do not.
 * Nothing else of `known` is touched, because a window may hold facts about the
 * row that the host's listing has not caught up with, such as a name it has
 * just changed.
 */
export function withReportOf<T extends { lastReport?: ChildReport }>(known: T, fresh: { lastReport?: ChildReport }): T {
  if (sameReport(known.lastReport, fresh.lastReport)) return known
  const next = { ...known }
  if (fresh.lastReport === undefined) delete next.lastReport
  else next.lastReport = fresh.lastReport
  return next
}

/**
 * The rows `current` holds, each taking the report its row in `listed` carries,
 * or null when no report changed, so the sessions a window keeps are not
 * replaced (and everything drawn from them redrawn) by a listing that said
 * nothing new. A row `current` holds that `listed` does not have is left as it
 * is.
 */
export function withReports<T extends { id: number; lastReport?: ChildReport }>(
  current: readonly T[],
  listed: readonly { id: number; lastReport?: ChildReport }[]
): T[] | null {
  const byId = new Map(listed.map((row) => [row.id, row]))
  let changed = false
  const next = current.map((row) => {
    const fresh = byId.get(row.id)
    const taken = fresh === undefined ? row : withReportOf(row, fresh)
    if (taken !== row) changed = true
    return taken
  })
  return changed ? next : null
}
