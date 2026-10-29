import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../../scripts/test-posix.mjs'

/**
 * `scripts/compile-cache.mjs`, which the root typecheck, lint and test
 * scripts run through: tsc, eslint and npm turn Node's compile cache on, and
 * without it Node keeps that cache in the system temp folder, where every
 * check would leave it behind.
 */

const SCRIPT = join(REPO_ROOT, 'scripts', 'compile-cache.mjs')

let probes: string
let temp: string

beforeEach(() => {
  probes = mkdtempSync(join(tmpdir(), 'helm compile cache probe-'))
  temp = mkdtempSync(join(tmpdir(), 'helm compile cache temp-'))
})

afterEach(() => {
  rmSync(probes, { recursive: true, force: true })
  rmSync(temp, { recursive: true, force: true })
})

/** Runs, through the script, a node program that turns the cache on as tsc does and says where it went. */
function enableCacheThrough(mode: string, env: Record<string, string> = {}): { status: number | null; dir: string } {
  const probe = join(probes, 'enable cache.cjs')
  writeFileSync(
    probe,
    "const m = require('node:module'); m.enableCompileCache(); console.log(String(m.getCompileCacheDir()))\n"
  )
  const result = spawnSync(process.execPath, [SCRIPT, mode, process.execPath, probe], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_COMPILE_CACHE: undefined, TEMP: temp, TMP: temp, TMPDIR: temp, ...env }
  })
  return { status: result.status, dir: result.stdout.trim() }
}

describe('the compile cache script', () => {
  it('keeps the cache in node_modules/.cache in local mode, never in the temp folder', () => {
    const run = enableCacheThrough('local')
    expect(run.status).toBe(0)
    expect(run.dir.startsWith(join(REPO_ROOT, 'node_modules', '.cache', 'node-compile-cache'))).toBe(true)
    expect(readdirSync(temp)).toEqual([])
  })

  it('turns the cache off in off mode, even when the caller pointed it somewhere', () => {
    // Somewhere other than the temp folder: the script's own node reads it too.
    const run = enableCacheThrough('off', { NODE_COMPILE_CACHE: join(probes, 'node-compile-cache') })
    expect(run.status).toBe(0)
    expect(run.dir).toBe('undefined')
    expect(readdirSync(temp)).toEqual([])
  })

  it('refuses a mode it does not know and runs nothing', () => {
    const run = enableCacheThrough('elsewhere')
    expect(run.status).toBe(2)
    expect(run.dir).toBe('')
    expect(readdirSync(temp)).toEqual([])
  })
})
