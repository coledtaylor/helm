// The session-lifecycle criteria, and then the half of SESS-9 that can only
// be checked once the app has exited.
//
// A driver of its own for the reason the others have one: the isolation has to
// wrap both halves. `verify-orphans.mjs` reads the report the app wrote, so it
// has to be told where that is - the same directory the app was pointed at, not
// `%APPDATA%\Helm`.
//
// Unlike run-profiles and friends this does not treat the report as the
// verdict: the driver's own exit code has always decided, and the orphan sweep
// runs afterwards either way, because "the app left processes behind" is most
// worth asking precisely when the run failed.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { isolate } from './isolate.mjs'

const { dataDir, env, root } = isolate('sessions')
console.log(`sessions-check is running against ${root}`)

const { default: electron } = await import('electron')
const { status } = spawnSync(electron, ['.', '--sessions-check', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env
})

const verify = spawnSync(
  process.execPath,
  [join('scripts', 'verify-orphans.mjs'), join(dataDir, 'sessions-report.json')],
  { stdio: 'inherit', env }
)

process.exit(status !== 0 ? status : (verify.status ?? 1))
