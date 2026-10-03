import type * as NodeFs from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openStore, type Store, type UsageSnapshot } from '@helm/core'
import { createUsageService, type UsageService } from './usage'

/** Set to make `fs.watch` unavailable, as it is documented to be on some systems. */
const fsState = vi.hoisted(() => ({ noWatch: false }))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof NodeFs>()
  const watch = ((...args: Parameters<typeof real.watch>) => {
    if (fsState.noWatch) throw new Error('fs.watch is not available here')
    return real.watch(...args)
  }) as typeof real.watch
  return { ...real, default: { ...real, watch }, watch }
})

/**
 * The usage service keeping the status bar level with `~/.claude.json`, a file
 * every `claude` on the machine rewrites: an `fs.watch` on its directory, a
 * stat poll behind it, and one debounced read for both.
 */

let root: string
let store: Store
let service: UsageService | null = null
let readings: UsageSnapshot[]

/** Claude Code's cache with one session limit at `percent`. */
function writeReading(percent: number): void {
  writeFileSync(
    join(root, '.claude.json'),
    JSON.stringify({
      numStartups: 3,
      cachedUsageUtilization: {
        fetchedAtMs: Date.now(),
        utilization: {
          limits: [
            {
              kind: 'session',
              group: 'session',
              percent,
              severity: 'normal',
              resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString(),
              is_active: true
            }
          ]
        }
      }
    })
  )
}

const percents = (): Array<number | undefined> => readings.map((reading) => reading.limits[0]?.percent)
const latest = (): number | undefined => readings.at(-1)?.limits[0]?.percent

function startService(): UsageService {
  service = createUsageService({
    store,
    home: join(root, '.claude'),
    onChange: (snapshot) => readings.push(snapshot)
  })
  return service
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm usage-'))
  mkdirSync(join(root, '.claude', 'projects'), { recursive: true })
  store = openStore({ file: ':memory:' })
  readings = []
  fsState.noWatch = false
})

afterEach(() => {
  service?.stop()
  service = null
  vi.useRealTimers()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

describe('the usage service', () => {
  it('reads the file Claude Code keeps beside its config directory', () => {
    writeReading(10)
    const usage = startService()

    expect(usage.file()).toBe(join(root, '.claude.json'))
    expect(usage.refresh().limits.map((limit) => limit.percent)).toEqual([10])
  })

  it('hands on a rewritten reading by itself, with no restart, click or request', async () => {
    writeReading(10)
    const usage = startService()
    usage.refresh()
    usage.start()

    writeReading(42)

    await vi.waitFor(() => expect(latest()).toBe(42), { timeout: 5000 })
  })

  it('falls back to its poll when the watch is unavailable, and reads once per burst of writes', async () => {
    fsState.noWatch = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    writeReading(10)
    const usage = startService()
    usage.refresh()
    usage.start()
    // The transcript index catches up on its own (setImmediate) and adds its
    // estimate to the reading; let that land before the file changes.
    await vi.waitFor(() => expect(readings.at(-1)?.spend).not.toBeNull())
    const before = readings.length

    writeReading(42)
    vi.advanceTimersByTime(4000) // the poll sees the file has changed
    writeReading(77) // and Claude Code writes again inside the debounce
    vi.advanceTimersByTime(150)

    expect(percents().slice(before)).toEqual([77])

    // Nothing changed since: the next poll finds nothing to hand on.
    vi.advanceTimersByTime(4150)
    expect(readings).toHaveLength(before + 1)
  })
})
