// Runs the profile checks' phases and decides the verdict from the report.
//
// Why this exists rather than `a && b && c`: the driver reliably writes its
// report and then, during teardown, node-pty's conpty helper dies with
// "AttachConsole failed" and takes the exit code with it (0xC0000409). The
// checks have already run and passed at that point - but a shell chained on
// exit status stops there, so the second app start that proves the stale-shim
// criterion never happens, and a green run reports as a failure.
//
// So the phases are run unconditionally and the *report* is the source of
// truth. A phase that dies early still fails the run, because its checks are
// then missing from the report rather than passing in it.
//
// Two of the phases are about **two Helms**, and they are opposites:
//
//   PROF-9  a shim from a run that ended must be collected by the next start.
//   PROF-10 a shim a *running* app is serving must survive the next start.
//
// PROF-9 is a sequence and PROF-10 is an overlap, which is why the hold phase
// is spawned rather than waited on: the app has to be alive while the sweeper
// runs. See src/main/shimhold.ts for the handshake.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolate } from './isolate.mjs'
import { auditReport, reportAudit } from './report-audit.mjs'

// Its own data directory, seeded from a consistent copy of the real one, so a
// run cannot disturb the Helm the user is using. See scripts/isolate.mjs.
const { dataDir, env, root } = isolate('profiles')
console.log(`profiles-check is running against ${root}`)
const reportPath = join(dataDir, 'profiles-report.json')
const sweepPath = join(dataDir, 'shim-sweep.json')
const holdReadyPath = join(dataDir, 'shim-hold-ready.json')
const holdReleasePath = join(dataDir, 'shim-hold-release')
const holdReportPath = join(dataDir, 'shim-hold-report.json')
const holdSweepPath = join(dataDir, 'shim-sweep-hold.json')
// The `electron` package's main export is the path to the executable itself,
// which is both hoist-proof - it resolves wherever pnpm actually put it - and
// spawnable without a shell. The `.bin` shim would need `shell: true`, and
// passing an argument array through a shell is unescaped concatenation.
const { default: electron } = await import('electron')

// Stale artefacts would otherwise be read as this run's results.
for (const file of [
  reportPath,
  sweepPath,
  holdReadyPath,
  holdReleasePath,
  holdReportPath,
  holdSweepPath
]) {
  rmSync(file, { force: true })
}

const only = process.argv.slice(2).filter((a) => a.startsWith('--only='))
const groups = only[0]?.slice('--only='.length).split(',') ?? null
const wants = (group) => groups === null || groups.includes(group)

function phase(label, args) {
  console.log(`\n--- ${label} ---`)
  const { status } = spawnSync(electron, args, { stdio: 'inherit', env })
  if (status !== 0) {
    console.log(`(${label} exited with ${String(status)}; the report decides, not this)`)
  }
  return status
}

phase('profiles-check', ['.', '--profiles-check', ...only])

// The three shim phases only when that group was asked for. The driver gates
// `plantStaleShim` the same way, so running the sweep after a `--only=compose`
// would have it verify a trap nothing set - which reads as a failure and is not
// one.
let verify = { status: 0 }
if (wants('shims')) {
  phase('shim-sweep', ['.', '--shim-sweep'])
  verify = spawnSync(process.execPath, [join('scripts', 'verify-shims.mjs'), dataDir], {
    stdio: 'inherit',
    env
  })
  // PROF-10, the overlap. `hold` is spawned rather than waited on, because the
  // point is that it is still up when the sweeper runs.
  await holdPhase()
}

if (!existsSync(reportPath)) {
  console.error(`FAIL  the driver wrote no report to ${reportPath}`)
  process.exit(1)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
// The hold phase writes its own report, for the same reason verify-shims folds
// PROF-9 back in: the run's verdict has to carry every criterion, not all but
// one.
if (existsSync(holdReportPath)) {
  const held = JSON.parse(readFileSync(holdReportPath, 'utf8'))
  report.checks = [
    ...(report.checks ?? []).filter((c) => !(held.checks ?? []).some((h) => h.id === c.id)),
    ...(held.checks ?? [])
  ]
  report.pass = report.checks.every((c) => c.ok)
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
} else if (wants('shims')) {
  report.checks = [
    ...(report.checks ?? []),
    {
      id: 'PROF-10',
      criterion: 'A live session’s overlay shim survives a second Helm starting',
      title: 'The hold phase wrote no report',
      ok: false,
      detail: { expected: holdReportPath }
    }
  ]
  report.pass = false
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
}

const failed = (report.checks ?? []).filter((c) => !c.ok)

console.log('')
for (const c of report.checks ?? []) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

// verify-shims folds PROF-9's real verdict into the report, so its own status is
// only interesting when it could not do that at all.
if (failed.length > 0 || verify.status !== 0) {
  console.error(`\nFAIL  ${String(failed.length)} of ${String((report.checks ?? []).length)} checks`)
  process.exit(1)
}

// Nothing that ran failed. Whether *everything* ran is a different question,
// and it is the one this asks - a phase that returned early leaves a short
// report that every check above passes.
if (
  !reportAudit(
    'profiles-check',
    auditReport({
      driver: 'profilescheck.ts',
      checks: report.checks ?? [],
      only: groups?.join(',')
    })
  )
) {
  process.exit(1)
}

console.log(`\nPASS  all ${String((report.checks ?? []).length)} checks — ${reportPath}`)

/**
 * The two-process phase.
 *
 * `--shim-hold` builds a shim, launches a real session over it and waits;
 * `--shim-sweep` is a genuine second app start against the same data directory.
 * The holder is the one that decides, because it is the process whose session
 * would have lost its skills - so all this does is start it, wait for its
 * READY, run the sweeper, and let it go again.
 */
async function holdPhase() {
  console.log('\n--- shim-hold (two processes) ---')
  const hold = spawn(electron, ['.', '--shim-hold'], { stdio: 'inherit', env })
  const exited = new Promise((resolve) => hold.on('exit', resolve))

  if (!(await waitForFile(holdReadyPath, 180_000))) {
    console.error('FAIL  the hold phase never reported a shim to hold')
    hold.kill()
    await exited
    return
  }
  const held = JSON.parse(readFileSync(holdReadyPath, 'utf8'))
  console.log(`holding ${held.shimDir} in pid ${String(held.pid)}; starting a second Helm`)

  phase('shim-sweep (second Helm)', ['.', '--shim-sweep', '--report=shim-sweep-hold.json'])

  writeFileSync(holdReleasePath, `released at ${new Date().toISOString()}\n`)
  await exited
}

async function waitForFile(file, timeoutMs) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (existsSync(file)) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}
