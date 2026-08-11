// Runs the settings pane's checks and decides the verdict from the report.
//
// Same reason run-m3.mjs through run-usage.mjs exist: the driver writes its
// report and then, during teardown, Electron can lose the exit code. The checks
// have already run by then, so the report is the source of truth and the
// process status is not. A driver that dies before writing fails the run,
// because there is then no report to read rather than a passing one.
//
// Two phases, and the second is the whole reason this file is not just a `&&`.
// "The setting survived a restart" cannot be asserted by the process that set
// it - it never restarted. So the driver parks four settings on values their
// defaults could not produce, and phase two starts the app again through the
// ordinary startup path and reports what `readSettings` found.
//
// Then the originals go back. This borrows the user's real database, and the
// restore runs whatever phase two decided - a run that fails must not also be a
// run that leaves someone's settings on a driver's fixtures.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const dataDir = join(process.env.APPDATA ?? process.env.HOME ?? '.', 'Helm')
const reportPath = join(dataDir, 'settings-report.json')
const restartPath = join(dataDir, 'settings-restart.json')
const originalPath = join(dataDir, 'settings-original.json')
const { default: electron } = await import('electron')

const args = process.argv.slice(2)
const only = args.find((a) => a.startsWith('--only='))
const groups = only ? only.slice('--only='.length).split(',') : null
// Every group writes settings, so the restart phase is meaningful for any of
// them; it is skipped only when the driver never got as far as parking.
rmSync(reportPath, { force: true })
rmSync(restartPath, { force: true })

const { status } = spawnSync(electron, ['.', '--settings-check', ...args], { stdio: 'inherit' })
if (status !== 0) {
  console.log(`(settings-check exited with ${String(status)}; the report decides, not this)`)
}

if (!existsSync(reportPath)) {
  console.error(`FAIL  the driver wrote no report to ${reportPath}`)
  // Nothing was parked that we can be sure of, but the originals may still have
  // been written before the crash - put them back if they were.
  if (existsSync(originalPath)) {
    spawnSync(electron, ['.', '--settings-restart', `--restore=${originalPath}`], {
      stdio: 'inherit'
    })
  }
  process.exit(1)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const checks = report.checks ?? []
const parked = report.parked ?? {}

// Phase two: a real restart, reading the settings the driver parked, and the
// restore in the same start.
console.log('\n--- phase 2: a fresh app start, reading the persisted settings ---')
spawnSync(
  electron,
  ['.', '--settings-restart', ...(existsSync(originalPath) ? [`--restore=${originalPath}`] : [])],
  { stdio: 'inherit' }
)

const found = existsSync(restartPath) ? JSON.parse(readFileSync(restartPath, 'utf8')).settings : null

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const expected = Object.keys(parked)
const disagreed = found === null ? expected : expected.filter((key) => !same(found[key], parked[key]))

checks.push({
  id: 'S-9',
  criterion: 'Every setting the pane writes survives a restart',
  title: 'A second app start reads back exactly what the first one was left holding',
  ok: found !== null && expected.length > 0 && disagreed.length === 0,
  detail: {
    parkedByPhaseOne: parked,
    readByPhaseTwo: found,
    disagreed,
    report: restartPath,
    restoredFrom: existsSync(originalPath) ? originalPath : null
  },
  notes: [
    'A separate process on purpose. The one that wrote the settings cannot',
    'prove a restart finds them - it never restarted.',
    'None of the parked values is a default, so reading them back is evidence',
    'rather than a coincidence: `system`, `percent` and an absent claudePath are',
    'what a database with no rows at all reports.',
    'The originals are restored in the same start, after the read: this borrowed',
    'the real database.'
  ]
})

const failed = checks.filter((c) => !c.ok)

console.log('')
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

if (groups !== null) {
  console.log(`\n(--only=${groups.join(',')}: some checks above were not run)`)
}

if (checks.length === 0 || failed.length > 0) {
  console.error(`\nFAIL  ${String(failed.length)} of ${String(checks.length)} checks`)
  process.exit(1)
}

console.log(`\nPASS  all ${String(checks.length)} checks - ${reportPath}`)
