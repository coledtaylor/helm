// A test step that leaves something behind, for scripts/test-leftovers.mjs's
// own test: a `helm world-` folder in the temp folder and a detached Node
// process that outlives this one. It prints both as one JSON line, so the
// test can check the report against them and then remove them itself. The
// child inherits this step's environment, with the step's mark, and its
// working folder, the checkout the test runs it in: either tells the check on
// macOS and Linux that the orphan init adopted is the step's.

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const folder = mkdtempSync(join(tmpdir(), 'helm world-'))
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)', 'leaky-step-child'], {
  detached: true,
  stdio: 'ignore',
  windowsHide: true
})
child.unref()
process.stdout.write(`${JSON.stringify({ pid: child.pid, folder })}\n`)
