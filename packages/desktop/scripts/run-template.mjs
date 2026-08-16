// Runs the harness-templates check and decides the verdict from the report.
//
// Five app starts, and four of them are here rather than in the driver because
// of what the criteria actually say.
//
//   1. `--template-seed`   into a directory that is not there  -> seeds
//   2. (this script edits the seeded README.md)
//   3. `--template-seed`   again                                -> must not overwrite
//   4. (this script deletes the directory)
//   5. `--template-seed`   again                                -> seeds again
//   6. `--template-check`  the real window: create, minimal, hostile
//
// "A first start seeds it", "a second start overwrites nothing" and "deleting
// it brings it back" are three claims about **startup**, and no process that
// has already started can make one about itself. The three seed phases write
// down what each start found; the driver reads those files and turns them into
// TPL-7/8/9, so every verdict still lives in one report. Same reason
// `run-profiles.mjs` starts a second app for the shim sweep.
//
// The edit between phases one and three is the probe, not preparation. Helm
// keeps no hashes of what it seeded and so cannot tell an edited file from an
// untouched one - which is exactly why it must never overwrite. "The file is
// still what the user made it" is the assertion; "the file is still there"
// would pass over a rewrite.
//
// Like every other driver, the report is the verdict rather than the exit code:
// Electron can lose the status during teardown, and the checks have already run
// by then. A driver that dies before writing fails the run, because there is
// then no report to read rather than a passing one.

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isolate } from './isolate.mjs'
import { auditReport, reportAudit } from './report-audit.mjs'

// Its own data directory, seeded from a consistent copy of the real database,
// so a run cannot disturb the Helm the user is using. See scripts/isolate.mjs -
// and note that `PORTABLE_EXECUTABLE_DIR` is what also gives this run its own
// **templates** directory, with no second mechanism: `paths.ts` puts
// `helm-data/templates` under it exactly as it puts `helm.db` there.
const { dataDir, env, root } = isolate('template')
console.log(`template-check is running against ${root}`)

const reportPath = join(dataDir, 'template-report.json')
const templatesDir = join(dataDir, 'templates')
const { default: electron } = await import('electron')

const passthrough = process.argv.slice(2)
const onlyArg = passthrough.find((arg) => arg.startsWith('--only='))
const only = onlyArg ? onlyArg.slice('--only='.length).split(',') : null
const wants = (group) => only === null || only.includes(group)

rmSync(reportPath, { force: true })

/** One `--template-seed` start: the real startup path, no window. */
function seedPhase(reportName) {
  rmSync(join(dataDir, reportName), { force: true })
  const { status } = spawnSync(
    electron,
    ['.', '--template-seed', `--report=${reportName}`],
    { stdio: 'inherit', env }
  )
  if (status !== 0) {
    console.log(`(${reportName} phase exited with ${String(status)}; the report decides, not this)`)
  }
}

if (wants('seed')) {
  console.log('\n--- seed phase 1: the directory is not there --------------------------')
  rmSync(templatesDir, { recursive: true, force: true })
  seedPhase('template-seed-1.json')

  console.log('\n--- editing the seeded README, then starting again --------------------')
  const readme = join(templatesDir, 'README.md')
  if (existsSync(readme)) {
    appendFileSync(readme, '\n<!-- edited by pnpm template-check -->\n', 'utf8')
  } else {
    console.error(`WARNING  ${readme} was not seeded, so TPL-8 has nothing to be about`)
  }
  seedPhase('template-seed-2.json')

  console.log('\n--- seed phase 3: the directory is deleted ----------------------------')
  rmSync(templatesDir, { recursive: true, force: true })
  seedPhase('template-seed-3.json')
} else {
  console.log('(--only= does not include `seed`, so the three seed phases were skipped)')
}

console.log('\n--- the window -------------------------------------------------------')
const { status } = spawnSync(electron, ['.', '--template-check', ...passthrough], {
  stdio: 'inherit',
  env
})
if (status !== 0) {
  console.log(`(template-check exited with ${String(status)}; the report decides, not this)`)
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
if (
  !reportAudit(
    'template-check',
    auditReport({ driver: 'templatecheck.ts', checks, only: onlyArg?.slice('--only='.length) })
  )
) {
  process.exit(1)
}

console.log(`\nPASS  all ${String(checks.length)} checks — ${reportPath}`)
