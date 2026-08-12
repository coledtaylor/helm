// The second half of SESS-9, run after the `--sessions-check` process has exited.
//
// The acceptance criterion is that killing the app leaves no orphaned
// claude/conpty processes. A check inside the app can prove the teardown
// function works; only a check outside it can prove the app ran that function
// on the way out. So the driver leaves one session alive, publishes its process
// tree in the report, and this asserts the tree is gone.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const reportPath =
  process.argv[2] ??
  join(process.env.APPDATA ?? process.env.HOME ?? '.', 'Helm', 'sessions-report.json')

let report
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'))
} catch (err) {
  console.error(`verify-orphans: cannot read ${reportPath}: ${String(err)}`)
  process.exit(1)
}

const handoff = report.checks?.find((c) => c.id === 'SESS-9')
const pids = handoff?.detail?.pids ?? []

if (pids.length === 0) {
  console.error('verify-orphans: SESS-9 published no pids, so nothing was verified')
  process.exit(1)
}

const alive = pids.filter((pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
})

if (alive.length > 0) {
  // Name them: "3 pids survived" is not something anyone can act on.
  let detail = alive.join(', ')
  if (process.platform === 'win32') {
    try {
      detail = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-Process -Id ${alive.join(',')} -ErrorAction SilentlyContinue |` +
            ' ForEach-Object { "$($_.Id) $($_.ProcessName)" }'
        ],
        { windowsHide: true, encoding: 'utf8', timeout: 15_000 }
      ).trim()
    } catch {
      // Fall back to the bare pid list.
    }
  }
  console.error(`FAIL  SESS-9  ${alive.length} process(es) outlived the app:\n${detail}`)
  process.exit(1)
}

console.log(`PASS  SESS-9  all ${pids.length} session process(es) died with the app`)
