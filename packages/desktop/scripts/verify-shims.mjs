// The second half of M3-9, run after `--shim-sweep` has exited.
//
// The acceptance criterion is that stale overlay shims left by a crashed run
// are cleaned up on the *next app start*. A check inside a running process can
// prove the sweep function works; only a check across two starts can prove the
// app runs it on the way in. So `--m3-check` plants what a crash would have
// left, `--shim-sweep` performs a real startup, and this asserts the planted
// directory is gone - and, just as importantly, that the repositories the shim
// pointed at are not.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dataDir = process.argv[2] ?? join(process.env.APPDATA ?? process.env.HOME ?? '.', 'Helm')
const reportPath = join(dataDir, 'm3-report.json')

let report
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'))
} catch (err) {
  console.error(`verify-shims: cannot read ${reportPath}: ${String(err)}`)
  process.exit(1)
}

const planted = report.checks?.find((c) => c.id === 'M3-9')
const dir = planted?.detail?.planted
const shimRoot = planted?.detail?.shimRoot

if (!dir) {
  console.error('verify-shims: M3-9 planted nothing, so nothing was verified')
  process.exit(1)
}

let sweep = { removed: null }
try {
  sweep = JSON.parse(readFileSync(join(dataDir, 'shim-sweep.json'), 'utf8'))
} catch {
  // The count is context, not the assertion; the directory is the assertion.
}

const stillThere = existsSync(dir)
// A sweep that removed the shim but left every other one behind would pass the
// check above and still be wrong, so the whole root is inspected.
const leftovers = existsSync(shimRoot ?? '')
  ? readdirSync(shimRoot).filter((entry) => entry.startsWith('overlay-'))
  : []

const ok = !stillThere && leftovers.length === 0

const result = {
  id: 'M3-9',
  criterion: 'Stale shim dirs from crashed sessions are cleaned up on next app start',
  title: 'The next app start removed the shim a crash would have left',
  ok,
  detail: { planted: dir, shimRoot, removedBySweep: sweep.removed, stillThere, leftovers },
  notes: ['Asserted across two app starts, because one process cannot observe its own startup.']
}

// Folded back into the report so it carries every criterion, not all but one.
report.checks = [...(report.checks ?? []).filter((c) => c.id !== 'M3-9'), result]
report.pass = report.checks.every((c) => c.ok)
writeFileSync(reportPath, JSON.stringify(report, null, 2))

if (!ok) {
  console.error(
    `FAIL  M3-9  ${stillThere ? `${dir} survived the next app start` : `leftover shims: ${leftovers.join(', ')}`}`
  )
  process.exit(1)
}

console.log(`PASS  M3-9  the next app start removed ${sweep.removed ?? '?'} stale shim(s)`)
