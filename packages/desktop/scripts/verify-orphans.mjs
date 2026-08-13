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

const living = () =>
  pids.filter((pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  })

/**
 * How long a tree gets to finish dying before it counts as orphaned.
 *
 * Sampled once, immediately, this raced the operating system and said so: a run
 * reported "1 process(es) outlived the app" and then printed **no name for it**,
 * because between `process.kill(pid, 0)` succeeding and the `Get-Process` that
 * would have named it, the process had gone. It was not an orphan. It was a
 * process the app had already told to die, a few milliseconds from being reaped.
 *
 * The criterion is that quitting the app does not *leave* processes behind, and
 * a tree that is gone a moment later has not been left behind - `before-quit`
 * ended it and Windows took its time. An orphan is one that is still there when
 * nothing is coming to collect it, so the question is asked over an interval
 * rather than at an instant.
 *
 * Ten seconds, and the elapsed time is printed on success: a run that starts
 * needing eight of them is a regression this would otherwise hide, and the
 * number is the only thing that would show it.
 */
const GRACE_MS = 10_000
const startedAt = Date.now()
let alive = living()
while (alive.length > 0 && Date.now() - startedAt < GRACE_MS) {
  await new Promise((resolve) => setTimeout(resolve, 250))
  alive = living()
}
const tookMs = Date.now() - startedAt

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
  console.error(
    `FAIL  SESS-9  ${alive.length} process(es) outlived the app by more than ${String(GRACE_MS)}ms:\n${detail}`
  )
  process.exit(1)
}

console.log(
  `PASS  SESS-9  all ${pids.length} session process(es) died with the app` +
    ` (last one gone ${String(tookMs)}ms after it exited)`
)
