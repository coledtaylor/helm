// Runs the profile checks' three phases and decides the verdict from the report.
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

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isolate } from './isolate.mjs'

// Its own data directory, seeded from a consistent copy of the real one, so a
// run cannot disturb the Helm the user is using. See scripts/isolate.mjs.
const { dataDir, env, root } = isolate('profiles')
console.log(`profiles-check is running against ${root}`)
const reportPath = join(dataDir, 'profiles-report.json')
const sweepPath = join(dataDir, 'shim-sweep.json')
// The `electron` package's main export is the path to the executable itself,
// which is both hoist-proof - it resolves wherever pnpm actually put it - and
// spawnable without a shell. The `.bin` shim would need `shell: true`, and
// passing an argument array through a shell is unescaped concatenation.
const { default: electron } = await import('electron')

// Stale artefacts would otherwise be read as this run's results.
for (const file of [reportPath, sweepPath]) rmSync(file, { force: true })

const only = process.argv.slice(2).filter((a) => a.startsWith('--only='))

function phase(label, args) {
  console.log(`\n--- ${label} ---`)
  const { status } = spawnSync(electron, args, { stdio: 'inherit', env })
  if (status !== 0) {
    console.log(`(${label} exited with ${String(status)}; the report decides, not this)`)
  }
  return status
}

phase('profiles-check', ['.', '--profiles-check', ...only])
phase('shim-sweep', ['.', '--shim-sweep'])

const verify = spawnSync(process.execPath, [join('scripts', 'verify-shims.mjs'), dataDir], {
  stdio: 'inherit',
  env
})

if (!existsSync(reportPath)) {
  console.error(`FAIL  the driver wrote no report to ${reportPath}`)
  process.exit(1)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const failed = (report.checks ?? []).filter((c) => !c.ok)

console.log('')
for (const c of report.checks ?? []) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

// verify-shims folds PROF-9's real verdict into the report, so its own status is
// only interesting when it could not do that at all.
if (failed.length > 0 || verify.status !== 0) {
  console.error(`\nFAIL  ${String(failed.length)} of ${String((report.checks ?? []).length)} checks`)
  process.exit(1)
}

console.log(`\nPASS  all ${String((report.checks ?? []).length)} checks — ${reportPath}`)
