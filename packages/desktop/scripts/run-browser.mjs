// Runs the browser-pane driver in two phases and decides the verdict from the
// reports.
//
// Two phases, for the reason run-transcript.mjs and run-settings.mjs have two:
// "a cookie the fixture set is still there after a restart" is not a claim the
// process that stored it can make. Phase one drives the pane and stores the
// cookie; this script starts the app again with `--browser-restart`, against
// the same isolated data directory - and therefore the same
// `persist:helm-browser` partition - and phase two has to find it.
//
// The report is the verdict rather than the exit code, like every other
// multi-phase check here: node-pty's teardown can lose the status, and a driver
// that dies before writing fails the run because there is then no report at all
// rather than a passing one.
//
// The fixture servers are the driver's own, on 127.0.0.1 and 127.0.0.2, so this
// run touches no network. Phase one writes the port it bound into the data
// directory and phase two binds the same one, because a cookie belongs to an
// origin and an origin includes the port.
//
// Since M17 phase one also spawns **one** real `claude` on haiku - the `live`
// group, which asks a session to drive the browser through Helm's own MCP
// endpoint. Nothing else here spawns anything, so `--only=` without `live` is
// still a run that costs no tokens.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isolate } from './isolate.mjs'
import { auditReport, reportAudit } from './report-audit.mjs'

const { dataDir, env, root } = isolate('browser')
console.log(`browser-check is running against ${root}`)

const mainReport = join(dataDir, 'browser-report.json')
const restartReport = join(dataDir, 'browser-restart-report.json')
const { default: electron } = await import('electron')

const passthrough = process.argv.slice(2)
const onlyArg = passthrough.find((a) => a.startsWith('--only='))
const only = onlyArg?.slice('--only='.length)

rmSync(mainReport, { force: true })
rmSync(restartReport, { force: true })

const phase = (flag, label) => {
  const { status } = spawnSync(electron, ['.', flag, ...passthrough], { stdio: 'inherit', env })
  if (status !== 0) {
    console.log(`(${label} exited with ${String(status)}; the report decides, not this)`)
  }
}

phase('--browser-check', 'browser-check')

// The second start only has something to read when the persistence group ran.
const wantsPersist = only === undefined || only.split(',').includes('persist')
if (wantsPersist) {
  console.log('\n--- second app start, for the cookie ---\n')
  phase('--browser-restart', 'browser-restart')
} else {
  console.log(`(--only=${only ?? ''} does not include persist, so the second start is skipped)`)
}

if (!existsSync(mainReport)) {
  console.error(`FAIL  the driver wrote no report to ${mainReport}`)
  process.exit(1)
}

const read = (file) => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).checks ?? []) : [])
const checks = [...read(mainReport), ...read(restartReport)]
const failed = checks.filter((c) => !c.ok)

console.log('')
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

if (checks.length === 0 || failed.length > 0) {
  console.error(`\nFAIL  ${String(failed.length)} of ${String(checks.length)} checks`)
  process.exit(1)
}

// Nothing that ran failed. Whether *everything* ran is the other question, and
// the union of both phases' reports is what it is asked against - an id only
// the second phase can produce is not missing from the first phase's report.
if (
  !reportAudit(
    'browser-check',
    auditReport({ driver: 'browsercheck.ts', checks, only: wantsPersist ? only : (only ?? 'all-but-persist') })
  )
) {
  process.exit(1)
}

console.log(`\nPASS  all ${String(checks.length)} checks — ${mainReport}`)
