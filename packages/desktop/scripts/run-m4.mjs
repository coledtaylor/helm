// Runs M4's driver and decides the verdict from the report.
//
// Same reason run-m3.mjs exists: the driver writes its report and then, during
// teardown, node-pty's conpty helper can die with "AttachConsole failed" and
// take the exit code with it (0xC0000409). The checks have already run at that
// point, so the report is the source of truth and the process status is not.
//
// A driver that dies before writing fails the run, because there is then no
// report to read rather than a passing one.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const dataDir = join(process.env.APPDATA ?? process.env.HOME ?? '.', 'Helm')
const reportPath = join(dataDir, 'm4-report.json')
// The `electron` package's main export is the path to the executable itself,
// which resolves wherever pnpm actually put it and is spawnable without a
// shell.
const { default: electron } = await import('electron')

rmSync(reportPath, { force: true })

const { status } = spawnSync(electron, ['.', '--m4-check', ...process.argv.slice(2)], {
  stdio: 'inherit'
})
if (status !== 0) {
  console.log(`(m4-check exited with ${String(status)}; the report decides, not this)`)
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

console.log(`\nPASS  all ${String(checks.length)} checks — ${reportPath}`)
