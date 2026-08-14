// Runs the config-console driver and decides the verdict from the report.
//
// Same reason run-profiles.mjs and run-history.mjs exist: the driver writes its
// report and then, during teardown, node-pty's conpty helper can die with
// "AttachConsole failed" and take the exit code with it (0xC0000409). The
// checks have already run at that point, so the report is the source of truth
// and the process status is not.
//
// A driver that dies before writing fails the run, because there is then no
// report to read rather than a passing one.
//
// This driver has one extra duty. It is the only check that writes into the
// user's real ~/.claude, and it restores what it borrowed from a plain copy in
// a `finally`. If the process is killed before that runs, the copy is still on
// disk - so this script says where, rather than leaving it to be found.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isolate } from './isolate.mjs'
import { auditReport, reportAudit } from './report-audit.mjs'

// Its own data directory, seeded from a consistent copy of the real one, so a
// run cannot disturb the Helm the user is using. See scripts/isolate.mjs.
const { dataDir, env, root } = isolate('config')
console.log(`config-check is running against ${root}`)
const reportPath = join(dataDir, 'config-report.json')
const userSettings = join(homedir(), '.claude', 'settings.json')
const backup = join(dataDir, 'config-user-settings.backup.json')
const { default: electron } = await import('electron')

const sha256 = (file) =>
  existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null

rmSync(reportPath, { force: true })
const settingsBefore = sha256(userSettings)

const { status } = spawnSync(electron, ['.', '--config-check', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env
})
if (status !== 0) {
  console.log(`(config-check exited with ${String(status)}; the report decides, not this)`)
}

// Before anything else is reported: the user's file is theirs, and a driver
// that died halfway must not leave it changed without saying so.
const settingsAfter = sha256(userSettings)
if (settingsBefore !== null && settingsAfter !== settingsBefore) {
  if (existsSync(backup) && sha256(backup) === settingsBefore) {
    copyFileSync(backup, userSettings)
    console.log(`restored ${userSettings} from ${backup}`)
  } else {
    console.error(`WARNING  ${userSettings} was changed and could not be restored from ${backup}`)
  }
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
    'config-check',
    auditReport({ driver: 'configcheck.ts', checks, only: auditOnly?.slice('--only='.length) })
  )
) {
  process.exit(1)
}

console.log(`\nPASS  all ${String(checks.length)} checks — ${reportPath}`)
