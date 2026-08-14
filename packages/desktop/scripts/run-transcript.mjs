// Runs the transcript-archive driver and decides the verdict from the report.
//
// Same reason run-history.mjs and run-usage.mjs exist: the driver writes its
// report and then, during teardown, Electron can lose the exit code. The checks
// have already run at that point, so the report is the source of truth and the
// process status is not. A driver that dies before writing fails the run,
// because there is then no report to read rather than a passing one.
//
// This one owns three things the driver cannot do for itself.
//
// **The `.claude` tree.** Both phases run against a fixture tree built here and
// pointed at with the real `CLAUDE_CONFIG_DIR` environment variable, not a
// flag. The variable is what `claudeHome()` reads and what the CLI itself
// honours, so "CLAUDE_CONFIG_DIR is respected; nothing assumes os.homedir()"
// becomes something the run actually exercises rather than something a test
// hook simulates. One transcript is planted *before* the app starts, so the
// start-up sweep has a session that ended while Helm was closed to find.
//
// **An empty archive.** The isolated database is seeded from a copy of the real
// one, which is what makes the other checks worth running - but the eviction
// arithmetic has to be exact, so the archive's three tables are emptied here,
// before the app opens the file. Defensively: on a database that predates the
// feature the tables do not exist yet, and the migration has not run.
//
// **The reap.** The whole point of the feature is that the archive outlives the
// transcript, and no process can prove that about itself. So phase one records
// what it archived, this script deletes the transcript, and phase two is a real
// second app start that has to find the conversation still there.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolate } from './isolate.mjs'
import { auditReport, reportAudit } from './report-audit.mjs'

const { dataDir, env, root } = isolate('transcript')
console.log(`transcript-check is running against ${root}`)

const reportPath = join(dataDir, 'transcript-report.json')
const restartPath = join(dataDir, 'transcript-restart-report.json')
const phaseOnePath = join(dataDir, 'transcript-phase1.json')

const { default: electron } = await import('electron')

// ---------------------------------------------------------------------------
// The fixture .claude tree
// ---------------------------------------------------------------------------

const claudeHome = join(root, 'fixture-claude')
const projectsDir = join(claudeHome, 'projects')

// Fresh every run. A tree left over from a previous run would make the archive
// counts depend on how many times this has been run, which is the opposite of
// what a fixture is for.
rmSync(claudeHome, { recursive: true, force: true })
mkdirSync(projectsDir, { recursive: true })

/**
 * A conversation that ended while Helm was closed.
 *
 * Written before the app starts, so nothing could have watched it appear: the
 * only thing that can find it is the sweep at start-up, which is the half of
 * the capture criterion a watch cannot cover.
 */
const CLOSED_SESSION = 'fee5ffff-0000-4000-8000-000000000000'
const closedDir = join(projectsDir, 'C--fixture-closed')
mkdirSync(closedDir, { recursive: true })

const closedAt = Date.parse('2026-07-20T08:00:00.000Z')
const closedLines = [
  {
    type: 'user',
    message: { role: 'user', content: 'This session ended before Helm was even running.' }
  },
  {
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'And the sweep at start-up is what has to find it.' }]
    }
  }
].map((row, index) =>
  JSON.stringify({
    ...row,
    parentUuid: null,
    isSidechain: false,
    uuid: `feedffff-0000-4000-8000-${String(index).padStart(12, '0')}`,
    timestamp: new Date(closedAt + index * 1000).toISOString(),
    userType: 'external',
    cwd: claudeHome,
    sessionId: CLOSED_SESSION,
    version: '2.1.225'
  })
)
writeFileSync(
  join(closedDir, `${CLOSED_SESSION}.jsonl`),
  closedLines.map((line) => `${line}\n`).join(''),
  'utf8'
)

// A history file with that session in it, so the launcher has a row for it.
writeFileSync(
  join(claudeHome, 'history.jsonl'),
  `${JSON.stringify({
    display: 'This session ended before Helm was even running.',
    pastedContents: {},
    timestamp: closedAt,
    project: claudeHome,
    sessionId: CLOSED_SESSION
  })}\n`,
  'utf8'
)

const checkEnv = { ...env, CLAUDE_CONFIG_DIR: claudeHome }
console.log(`CLAUDE_CONFIG_DIR=${claudeHome}`)

// ---------------------------------------------------------------------------
// An empty archive to count against
// ---------------------------------------------------------------------------

const clearScript = [
  "const Database = require('better-sqlite3')",
  "const db = new Database(process.argv[1])",
  "for (const t of ['transcript_messages', 'transcript_sessions', 'transcript_index']) {",
  '  try { db.prepare(`DELETE FROM ${t}`).run() } catch {}',
  '}',
  'db.close()'
].join('\n')
const dbFile = join(dataDir, 'helm.db')
if (existsSync(dbFile)) {
  const cleared = spawnSync(electron, ['-e', clearScript, dbFile], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8'
  })
  if (cleared.status !== 0) {
    console.error(`could not empty the archive tables in ${dbFile}:\n${cleared.stderr ?? ''}`)
    process.exit(1)
  }
  console.log('archive tables emptied in the isolated copy')
}

// ---------------------------------------------------------------------------
// Phase one
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const only = args.find((a) => a.startsWith('--only='))
const groups = only ? only.slice('--only='.length).split(',') : null

rmSync(reportPath, { force: true })
rmSync(restartPath, { force: true })
rmSync(phaseOnePath, { force: true })

const first = spawnSync(electron, ['.', '--transcript-check', ...args], {
  stdio: 'inherit',
  env: checkEnv
})
if (first.status !== 0) {
  console.log(`(transcript-check exited with ${String(first.status)}; the report decides, not this)`)
}

if (!existsSync(reportPath)) {
  console.error(`FAIL  the driver wrote no report to ${reportPath}`)
  process.exit(1)
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const checks = report.checks ?? []

// ---------------------------------------------------------------------------
// The reap, then phase two
// ---------------------------------------------------------------------------

if (!existsSync(phaseOnePath)) {
  checks.push({
    id: 'T-7',
    criterion: 'The archive survives the source transcript being deleted, and survives a restart',
    title: 'Phase one recorded nothing for the second phase to check',
    ok: false,
    detail: { expected: phaseOnePath },
    notes: ['Without that file there is no transcript to delete and nothing to compare against.']
  })
} else {
  const phaseOne = JSON.parse(readFileSync(phaseOnePath, 'utf8'))
  const transcript = phaseOne.survivor.file

  console.log('\n--- the reap: deleting the transcript phase one archived ---')
  console.log(`  rm ${transcript}`)
  rmSync(transcript, { force: true })
  if (existsSync(transcript)) {
    console.error(`FAIL  could not delete ${transcript}`)
    process.exit(1)
  }

  console.log('\n--- phase 2: a fresh app start, reading the conversation back ---')
  spawnSync(electron, ['.', '--transcript-restart', ...args], {
    stdio: 'inherit',
    env: checkEnv
  })

  if (!existsSync(restartPath)) {
    checks.push({
      id: 'T-7',
      criterion: 'The archive survives the source transcript being deleted, and survives a restart',
      title: 'The second app start wrote no report',
      ok: false,
      detail: { expected: restartPath },
      notes: ['A phase that died before writing fails the run rather than passing quietly.']
    })
  } else {
    const restart = JSON.parse(readFileSync(restartPath, 'utf8'))
    checks.push(...(restart.checks ?? []))
  }
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

const failed = checks.filter((c) => !c.ok)

console.log('')
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id}  ${c.title}`)

// The numbers are worth printing whether or not their check passed: the
// compression ratio and the incremental read are measurements, and a run that
// only says PASS has thrown them away.
const bounded = checks.find((c) => c.id === 'T-4')
if (bounded?.detail?.compression) {
  const { rawBytes, storedBytes, ratio } = bounded.detail.compression
  console.log(
    `\narchive after the ceiling: ${String(storedBytes)} bytes stored from ` +
      `${String(rawBytes)} of text (${String(ratio)}x)`
  )
}
const incremental = checks.find((c) => c.id === 'T-2')
if (incremental?.detail) {
  const d = incremental.detail
  console.log(
    `second pass read ${String(d.passReadBytes)} bytes of a ${String(d.fileBytesAfter)} byte transcript`
  )
}
const readOnly = checks.find((c) => c.id === 'T-5')
if (readOnly?.detail) {
  const d = readOnly.detail
  console.log(
    `read-only: ${String(d.files)} files / ${String(d.bytes)} bytes hashed, ` +
      `${String(d.passOverTheWholeTree?.bytesRead)} bytes read by the pass, digest unchanged: ` +
      `${String(d.digestBefore === d.digestAfter)}`
  )
}

if (groups !== null) {
  console.log(`\n(narrowed to ${groups.join(', ')} - a full run is the one that counts)`)
}

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
    'transcript-check',
    auditReport({ driver: 'transcriptcheck.ts', checks, only: auditOnly?.slice('--only='.length) })
  )
) {
  process.exit(1)
}

console.log(`\nPASS  all ${String(checks.length)} checks - ${reportPath}`)
