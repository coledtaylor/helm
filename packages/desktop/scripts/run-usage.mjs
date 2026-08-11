// Runs the status bar's usage checks and decides the verdict from the report.
//
// Same reason run-m3.mjs through run-m6.mjs exist: the driver writes its report
// and then, during teardown, Electron can lose the exit code. The checks have
// already run at that point, so the report is the source of truth and the
// process status is not. A driver that dies before writing fails the run,
// because there is then no report to read rather than a passing one.
//
// Two phases, and the second is the whole reason this file is not just a `&&`.
// "The mode is persisted and survives a restart" cannot be asserted by the
// process that set it. So the driver parks the setting on `off` - deliberately
// not its default - and phase two starts the app again through the ordinary
// startup path and reports what `readSettings` found. Then it puts the setting
// back to `percent`, because the driver borrowed the user's own database.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isolate } from './isolate.mjs'

// Its own data directory, seeded from a consistent copy of the real one, so a
// run cannot disturb the Helm the user is using. See scripts/isolate.mjs.
const { dataDir, env, root } = isolate('usage')
console.log(`usage-check is running against ${root}`)
const reportPath = join(dataDir, 'usage-report.json')
const settingsPath = join(dataDir, 'usage-settings.json')
const { default: electron } = await import('electron')

const args = process.argv.slice(2)
const only = args.find((a) => a.startsWith('--only='))
const groups = only ? only.slice('--only='.length).split(',') : null
const ranSetting = groups === null || groups.includes('setting')

rmSync(reportPath, { force: true })
rmSync(settingsPath, { force: true })

const { status } = spawnSync(electron, ['.', '--usage-check', ...args], { stdio: 'inherit', env })
if (status !== 0) {
  console.log(`(usage-check exited with ${String(status)}; the report decides, not this)`)
}

if (!existsSync(reportPath)) {
  console.error(`FAIL  the driver wrote no report to ${reportPath}`)
  process.exit(1)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const checks = report.checks ?? []

// Phase two: a real restart, reading the setting the driver parked.
if (ranSetting) {
  console.log('\n--- phase 2: a fresh app start, reading the persisted mode ---')
  spawnSync(electron, ['.', '--usage-settings'], { stdio: 'inherit', env })

  const found = existsSync(settingsPath)
    ? JSON.parse(readFileSync(settingsPath, 'utf8')).usageDisplay
    : null

  checks.push({
    id: 'U-10',
    criterion: 'The mode is persisted in settings and survives a restart',
    title: 'A second app start reads back the mode the first one was left on',
    ok: found === 'off',
    detail: { expected: 'off', found, report: settingsPath },
    notes: [
      'A separate process on purpose. The one that wrote the setting cannot',
      'prove a restart finds it - it never restarted.',
      'Restored to `percent` afterwards: this borrowed the real database.'
    ]
  })

  // The user's setting, put back. `--usage-settings` is a read; this is the
  // one write, and it happens after the assertion has been made.
  spawnSync(electron, ['.', '--usage-settings', '--set=percent'], { stdio: 'inherit', env })
}

const failed = checks.filter((c) => !c.ok)

console.log('')
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

// Criterion 7 is a measurement, so print the numbers whether or not it passed.
const cost = checks.find((c) => c.id === 'U-8')
if (cost) {
  const full = cost.detail.fullParse
  console.log(
    `\nfull parse of ${String(full.transcripts)} transcripts (${String(full.megabytes)} MB, ` +
      `${String(full.rows)} rows): ${String(full.ms)} ms` +
      `\nstatus bar per repaint: ${cost.detail.repaint.perPaintMs.toFixed(4)} ms` +
      `\none read of .claude.json: ${String(cost.detail.oneReadOfClaudeJsonMs)} ms`
  )
}

if (checks.length === 0 || failed.length > 0) {
  console.error(`\nFAIL  ${String(failed.length)} of ${String(checks.length)} checks`)
  process.exit(1)
}

console.log(`\nPASS  all ${String(checks.length)} checks - ${reportPath}`)
