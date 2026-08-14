/**
 * Did the driver produce every check it can produce, or did it stop early?
 *
 * `pass: true` on a report means "nothing that ran failed". It does not mean
 * "everything ran", and the two are only the same claim when the run reached
 * the end. A driver that throws is already caught - `index.ts` writes no report
 * at all and every runner treats that as a failure - so the shape this exists
 * for is the quieter one: a phase that **returns early** because something it
 * needed was not there, leaving a short list that every runner then printed as
 * `PASS all N`.
 *
 * The expectation is derived from the driver's **own source**: every check id
 * it can push. Not a count written down beside it, which is the second place
 * the `checks` skill warns about - a number in a runner drifts from the driver
 * the first time somebody adds a probe, and then either lies or has to be
 * chased. Reading the ids out of the file that pushes them cannot drift,
 * because the file is the authority.
 *
 * Two things it deliberately does not do:
 *
 * - **A narrowed run is not audited.** `--only=` legitimately produces a short
 *   report, and mapping groups to ids would need exactly the second list this
 *   avoids. The selection is printed instead, so a reader knows why it is
 *   short. Verifying a narrowed run needs a terminal sentinel in the driver -
 *   `configcheck.ts`'s `CFG-Z` is the one that exists - and that is a driver
 *   change rather than a runner one.
 * - **It never turns a red run green.** It can only add a failure.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DRIVERS = join(here, '..', 'src', 'main')

/**
 * Ids a healthy run is not expected to produce, marked at the site that pushes
 * them with `// audit: optional` on the line above the id.
 *
 * A marker rather than a list in this file, because a list here is the drifting
 * second place again. It is also the safe direction to be wrong in: an id that
 * silently stops being pushed fails the audit, and the remedy is to look at why
 * rather than to add an exemption.
 */
const OPTIONAL = /\/\/\s*audit:\s*optional/

/**
 * Every check id the driver can push, and which of them are optional.
 *
 * Single-quoted literals only. The computed ids in `prcheck.ts` and
 * `configcheck.ts` are written with backticks - GraphQL node ids on a fixture
 * in one case, a `<GROUP>-THREW` id in the other - and neither is an id a
 * healthy run produces, so excluding template literals is right rather than
 * merely convenient. A prose mention inside a `notes` array is not `id: '...'`
 * either, so it is excluded by construction rather than by an exception list.
 */
export function driverIds(driverFile) {
  const path = join(DRIVERS, driverFile)
  if (!existsSync(path)) return null
  const src = readFileSync(path, 'utf8')
  const lines = src.split(/\r?\n/)
  const required = new Set()
  const optional = new Set()
  lines.forEach((line, at) => {
    const m = /\bid: '([A-Z][A-Za-z0-9]*-[A-Za-z0-9-]+)'/.exec(line)
    if (m === null) return
    // The marker may be anywhere in the comment block attached to the id, not
    // only on the line above it: an explanation worth writing is usually two
    // lines, and a rule that only reads the last of them would be a rule about
    // how long a sentence is.
    let marked = OPTIONAL.test(line)
    for (let above = at - 1; above >= 0 && !marked; above--) {
      const text = (lines[above] ?? '').trim()
      if (!text.startsWith('//')) break
      marked = OPTIONAL.test(text)
    }
    ;(marked ? optional : required).add(m[1])
  })
  // An id pushed on both a normal and an error path is required: the marker is
  // about ids that a healthy run has no reason to reach.
  for (const id of required) optional.delete(id)
  return { required, optional }
}

/**
 * Compare what a report holds against what its driver can push.
 *
 * `checks` is the union across a family's report files, because an id only the
 * second phase can produce is not missing from the first phase's report.
 */
export function auditReport({ driver, checks, only }) {
  const ids = driverIds(driver)
  if (ids === null) return { audited: false, reason: `no driver source at ${driver}`, missing: [] }
  const present = new Set(checks.map((c) => c.id))
  const missing = [...ids.required].filter((id) => !present.has(id)).sort()
  const unexpected = [...present].filter((id) => !ids.required.has(id) && !ids.optional.has(id)).sort()
  return {
    audited: true,
    narrowed: only !== null && only !== undefined && only !== '',
    only: only ?? null,
    expected: ids.required.size,
    present: present.size,
    missing,
    unexpected
  }
}

/**
 * Print the audit and say whether the run may be believed complete.
 *
 * Returns false only for a full run that is short - the case where a runner
 * would otherwise print `PASS all N` over a driver that stopped early.
 */
export function reportAudit(name, audit) {
  if (!audit.audited) {
    console.log(`(${name}: not audited - ${audit.reason})`)
    return true
  }
  if (audit.narrowed) {
    console.log(
      `(${name}: --only=${audit.only}, so ${String(audit.present)} of ${String(audit.expected)} ids is expected to be short and is not audited)`
    )
    return true
  }
  if (audit.missing.length === 0) {
    console.log(`(${name}: every one of the ${String(audit.expected)} checks its driver can produce is in the report)`)
    return true
  }
  console.error(
    `\nFAIL  the report is short: ${String(audit.present)} of ${String(audit.expected)} checks.` +
      `\n      missing: ${audit.missing.join(', ')}` +
      `\n      A full run that does not produce every check its driver can push stopped early,` +
      `\n      and "nothing that ran failed" is not the same claim as "everything ran".`
  )
  return false
}
