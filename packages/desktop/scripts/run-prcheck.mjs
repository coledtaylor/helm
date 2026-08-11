// Runs the pull-request checks and decides the verdict from the report.
//
// Same reason run-m3.mjs through run-settings.mjs exist: the driver writes its
// report and then, during teardown, Electron can lose the exit code. The checks
// have already run by then, so the report is the source of truth and the
// process status is not. A driver that dies before writing fails the run,
// because there is then no report to read rather than a passing one.
//
// The other half of this file is the restore. `pr-check` borrows the real
// database - it adds a scan root of fixture repositories and writes the two
// review settings - and puts everything back itself when it finishes. What it
// cannot do is put anything back when it is killed, and a run that leaves a
// fixture root in someone's scan roots is a run that changed their machine. So
// the driver writes the settings down before it touches anything and this file
// restores them through the ordinary write path if the report never appeared.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isolate } from './isolate.mjs'

// Its own data directory, seeded from a consistent copy of the real one, so a
// run cannot disturb the Helm the user is using. See scripts/isolate.mjs.
const { dataDir, env, root } = isolate('prcheck')
console.log(`pr-check is running against ${root}`)
const reportPath = join(dataDir, 'pr-report.json')
const originalPath = join(dataDir, 'pr-original.json')
const { default: electron } = await import('electron')

const args = process.argv.slice(2)
const only = args.find((a) => a.startsWith('--only='))
const groups = only ? only.slice('--only='.length).split(',') : null

rmSync(reportPath, { force: true })

const { status } = spawnSync(electron, ['.', '--pr-check', ...args], { stdio: 'inherit', env })
if (status !== 0) {
  console.log(`(pr-check exited with ${String(status)}; the report decides, not this)`)
}

if (!existsSync(reportPath)) {
  console.error(`FAIL  the driver wrote no report to ${reportPath}`)
  if (existsSync(originalPath)) {
    console.log('restoring the settings the driver wrote down before it started')
    spawnSync(electron, ['.', '--settings-restart', `--restore=${originalPath}`], {
      stdio: 'inherit',
      env
    })
  }
  process.exit(1)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const checks = report.checks ?? []
const failed = checks.filter((c) => !c.ok)
const skipped = checks.filter((c) => c.detail && c.detail.skipped === true)

console.log('')
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

if (groups !== null) {
  console.log(`\n(--only=${groups.join(',')}: some checks above were not run)`)
}
if (skipped.length > 0) {
  console.log(`(${String(skipped.length)} skipped: ${skipped.map((c) => c.id).join(', ')})`)
}

if (checks.length === 0 || failed.length > 0) {
  console.error(`\nFAIL  ${String(failed.length)} of ${String(checks.length)} checks`)
  process.exit(1)
}

console.log(`\nPASS  all ${String(checks.length)} checks - ${reportPath}`)
