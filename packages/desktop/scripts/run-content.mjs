// Runs the content-viewer driver and decides the verdict from the report.
//
// Same reason run-profiles.mjs, run-history.mjs and run-config.mjs exist: the
// driver writes its report and then, during teardown, Electron can lose the
// exit code. The checks have already run at that point, so the report is the
// source of truth and the process status is not. A driver that dies before
// writing fails the run, because there is then no report to read rather than a
// passing one.
//
// This driver has one extra duty, inherited from config-check's. Criterion 5 is
// about preserving frontmatter in a *real* note, so the driver edits one in the
// user's vault and puts it back from the snapshot the save produced. If the
// process is killed between those two things, the plain copy it took first is
// still on disk - so this script restores from it rather than leaving it to be
// found.

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { isolate } from './isolate.mjs'
import { auditReport, reportAudit } from './report-audit.mjs'

// Its own data directory, seeded from a consistent copy of the real one, so a
// run cannot disturb the Helm the user is using. See scripts/isolate.mjs.
const { dataDir, env, root } = isolate('content')
console.log(`content-check is running against ${root}`)
const reportPath = join(dataDir, 'content-report.json')
const backup = join(dataDir, 'content-note.backup.md')
const { default: electron } = await import('electron')

const sha256 = (file) =>
  existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex') : null

rmSync(reportPath, { force: true })

const { status } = spawnSync(electron, ['.', '--content-check', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env
})
if (status !== 0) {
  console.log(`(content-check exited with ${String(status)}; the report decides, not this)`)
}

// Before anything else is reported: the note the driver borrowed is the user's.
if (existsSync(reportPath) && existsSync(backup)) {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const edit = (report.checks ?? []).find((check) => check.id === 'CONT-8')
  const file = edit?.detail?.file
  const expected = edit?.detail?.independentPreEditHash
  if (typeof file === 'string' && typeof expected === 'string' && sha256(file) !== expected) {
    if (sha256(backup) === expected) {
      copyFileSync(backup, file)
      console.log(`restored ${file} from ${backup}`)
    } else {
      console.error(`WARNING  ${file} was changed and could not be restored from ${backup}`)
    }
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
    'content-check',
    auditReport({ driver: 'contentcheck.ts', checks, only: auditOnly?.slice('--only='.length) })
  )
) {
  process.exit(1)
}

console.log(`\nPASS  all ${String(checks.length)} checks — ${reportPath}`)
