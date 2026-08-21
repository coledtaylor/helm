// The session-lifecycle criteria, then a second app start, then the half of
// SESS-9 that can only be checked once the app has exited.
//
// A driver of its own for the reason the others have one: the isolation has to
// wrap all three. `verify-orphans.mjs` reads the report the app wrote, so it
// has to be told where that is - the same directory the app was pointed at, not
// `%APPDATA%\Helm`.
//
// The second phase is here because "the name someone gave a tab survived a
// restart" is not a claim the process that set it can make: everything it would
// read the answer out of is the state it is holding. Phase one writes
// `sessions-phase1.json`, the app is started again, and SESS-14 reads the row
// back off the disk in a process that never saw the rename happen. Sessions
// themselves do not survive - `before-quit` ends them - so what phase two is
// looking for is the label, not the tab.
//
// Unlike run-profiles and friends this does not treat phase one's report as the
// whole verdict: the driver's own exit code has always decided for that phase,
// and the orphan sweep runs afterwards either way, because "the app left
// processes behind" is most worth asking precisely when the run failed. Phase
// two does go through its report, because a phase that dies before writing one
// must fail rather than pass quietly.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isolate } from './isolate.mjs'
import { auditReport, reportAudit } from './report-audit.mjs'

const { dataDir, env, root } = isolate('sessions')
console.log(`sessions-check is running against ${root}`)

const phaseOnePath = join(dataDir, 'sessions-phase1.json')
const restartPath = join(dataDir, 'sessions-restart-report.json')
rmSync(phaseOnePath, { force: true })
rmSync(restartPath, { force: true })

const { default: electron } = await import('electron')
const { status } = spawnSync(electron, ['.', '--sessions-check', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env
})

// Phase two reads back what phase one's `lifecycle` group wrote down, so a run
// narrowed to another group has nothing for it to find. Skipped rather than run
// and failed: "the rename did not survive" and "no rename happened" are not the
// same red line, and printing the second as the first is how a check stops
// being read.
const only = process.argv.slice(2).find((a) => a.startsWith('--only='))
const wantsLifecycle =
  only === undefined || only.slice('--only='.length).split(',').includes('lifecycle')

if (wantsLifecycle) {
  console.log('\n--- phase 2: a fresh app start, reading the label back ---')
  spawnSync(electron, ['.', '--sessions-restart', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env
  })
} else {
  console.log(`\n(phase 2 skipped: ${only} does not include the lifecycle group that writes its input)`)
}

// The report is the verdict for this phase, not the exit code: node-pty's
// teardown loses that, and a phase that died before writing has to fail rather
// than pass on a missing file.
const restartStatus = (() => {
  if (!wantsLifecycle) return 0
  if (!existsSync(restartPath)) {
    console.error(`FAIL  SESS-14  the second app start wrote no report to ${restartPath}`)
    return 1
  }
  const restart = JSON.parse(readFileSync(restartPath, 'utf8'))
  for (const c of restart.checks ?? []) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)
  return restart.pass ? 0 : 1
})()

// Phase three is the other half of SESS-9, and SESS-9 belongs to `lifecycle`.
// Gated for exactly the reason phase two is: `verify-orphans.mjs` exits 1 when
// the report publishes no pids, which is right in a full run - "nothing was
// verified" reporting green is the failure CLAUDE.md rules out - and is a red
// line about the wrong thing in a run that never asked for that group. The
// guard inside verify-orphans stays; what this script knows and that one cannot
// is whether the group was asked for at all.
//
// Left unfixed this made every `--only=state` and `--only=resources` run exit 1
// with all its probes green, which is the same way a check stops being read.
const verifyStatus = (() => {
  if (!wantsLifecycle) {
    console.log(`(phase 3 skipped: ${only} does not include the lifecycle group that leaves SESS-9 a session)`)
    return 0
  }
  const verify = spawnSync(
    process.execPath,
    [join('scripts', 'verify-orphans.mjs'), join(dataDir, 'sessions-report.json')],
    { stdio: 'inherit', env }
  )
  return verify.status ?? 1
})()

// Nothing that ran failed. Whether *everything* ran is a different question,
// and it is the one this asks - a phase that returned early leaves a short
// report that every check above passes. Both phases' reports together, because
// an id only the second start can produce is not missing from the first's.
const auditOnly = process.argv.slice(2).find((a) => a.startsWith('--only='))
const bothPhases = [join(dataDir, 'sessions-report.json'), restartPath]
  .filter((p) => existsSync(p))
  .flatMap((p) => JSON.parse(readFileSync(p, 'utf8')).checks ?? [])
const complete = reportAudit(
  'sessions-check',
  auditReport({
    driver: 'sessionscheck.ts',
    checks: bothPhases,
    only: auditOnly?.slice('--only='.length)
  })
)

process.exit(
  status !== 0
    ? status
    : restartStatus !== 0
      ? restartStatus
      : !complete
        ? 1
        : verifyStatus
)
