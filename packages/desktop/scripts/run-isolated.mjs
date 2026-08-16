// Runs `electron . <args>` against a check's own data directory.
//
// For the modes launched straight from package.json, which have no driver of
// their own to put the isolation in. Everything else goes through run-*.mjs.
//
//   node scripts/run-isolated.mjs <name> <electron args...>
//
// `--fresh` starts from an empty database instead of a copy of the real one.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolate } from './isolate.mjs'
import { auditReport, reportAudit } from './report-audit.mjs'

/**
 * The modes launched through this runner that write a report of checks.
 *
 * `design-shot` is deliberately absent: it asserts nothing and writes PNGs, so
 * there is no report to be short.
 */
const AUDITED = {
  'affordance-check': { report: 'affordance-report.json', driver: 'affordancecheck.ts' },
  'highlight-check': { report: 'highlight-report.json', driver: 'highlightcheck.ts' }
}

const [name, ...rest] = process.argv.slice(2)
if (!name) {
  console.error('usage: node scripts/run-isolated.mjs <name> <electron args...>')
  process.exit(2)
}

const fresh = rest.includes('--fresh')
const args = rest.filter((arg) => arg !== '--fresh')
// `concurrent`, because this is what launches a window somebody sits in front
// of and leaves open. A second launch is a second window, not a mistake.
const { dataDir, env, root } = isolate(name, { seed: !fresh, concurrent: true })
console.log(`${name} is running against ${root}`)

const { default: electron } = await import('electron')
const { status } = spawnSync(electron, ['.', ...args], { stdio: 'inherit', env })

// The driver already decided pass or fail; this asks the other question, which
// is whether it got to the end. A walk that stopped after a failing view leaves
// a report whose remaining checks are absent rather than red.
const audited = AUDITED[name]
if (audited !== undefined && status === 0) {
  const file = join(dataDir, audited.report)
  const checks = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).checks ?? []) : []
  const only = args.find((a) => a.startsWith('--only='))
  const complete = reportAudit(
    name,
    auditReport({ driver: audited.driver, checks, only: only?.slice('--only='.length) })
  )
  if (!complete) process.exit(1)
}

process.exit(status ?? 1)
