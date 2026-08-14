// Runs the session-history driver and decides the verdict from the report.
//
// Same reason run-profiles.mjs exists: the driver writes its report and then,
// during teardown, node-pty's conpty helper can die with "AttachConsole
// failed" and take the exit code with it (0xC0000409). The checks have already
// run at that
// point, so the report is the source of truth and the process status is not.
//
// A driver that dies before writing fails the run, because there is then no
// report to read rather than a passing one.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isolate } from './isolate.mjs'
import { auditReport, reportAudit } from './report-audit.mjs'

// Its own data directory, seeded from a consistent copy of the real one, so a
// run cannot disturb the Helm the user is using. See scripts/isolate.mjs.
const { dataDir, env, root } = isolate('history')
console.log(`history-check is running against ${root}`)
const reportPath = join(dataDir, 'history-report.json')
// The `electron` package's main export is the path to the executable itself,
// which resolves wherever pnpm actually put it and is spawnable without a
// shell.
const { default: electron } = await import('electron')

rmSync(reportPath, { force: true })

const { status } = spawnSync(electron, ['.', '--history-check', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env
})
if (status !== 0) {
  console.log(`(history-check exited with ${String(status)}; the report decides, not this)`)
}

if (!existsSync(reportPath)) {
  console.error(`FAIL  the driver wrote no report to ${reportPath}`)
  process.exit(1)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const checks = report.checks ?? []
const failed = checks.filter((c) => !c.ok)

console.log('')
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

if (checks.length === 0 || failed.length > 0) {
  console.error(`\nFAIL  ${String(failed.length)} of ${String(checks.length)} checks`)
  process.exit(1)
}

// Nothing that ran failed. Whether *everything* ran is a different question,
// and it is the one this asks - a phase that returned early leaves a short
// report that every check above passes.
const auditOnly = process.argv.slice(2).find((a) => a.startsWith('--only='))
if (
  !reportAudit(
    'history-check',
    auditReport({ driver: 'historycheck.ts', checks, only: auditOnly?.slice('--only='.length) })
  )
) {
  process.exit(1)
}

console.log(`\nPASS  all ${String(checks.length)} checks — ${reportPath}`)
