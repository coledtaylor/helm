import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeConfigFileIn, readUsage } from './read'
import { nextUsageMode, parseUsage, usageView, USAGE_STALE_AFTER_MS } from './shape'

/**
 * The unit half of "prefer showing nothing". The driver asserts the same rules
 * against the real window; these assert them against the shapes a CLI release
 * could plausibly hand over, which is quicker to write one of for every case.
 */

const NOW = Date.parse('2026-08-10T09:00:00Z')
const FETCHED = Date.parse('2026-08-10T08:55:00Z')

/** The 2.1.225 shape, with the fields that vary made arguments. */
function claudeJson(
  overrides: {
    fetchedAtMs?: number | null
    limits?: unknown
    omitKey?: boolean
    cached?: unknown
  } = {}
): unknown {
  const limits = overrides.limits ?? [
    {
      kind: 'session',
      group: 'session',
      percent: 51,
      severity: 'normal',
      resets_at: '2026-08-10T13:10:00.721285+00:00',
      scope: null,
      is_active: true
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      percent: 38,
      severity: 'warning',
      resets_at: '2026-08-11T19:00:00.721310+00:00',
      scope: null,
      is_active: false
    },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 21,
      severity: 'normal',
      resets_at: '2026-08-11T18:59:59.721602+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      is_active: false
    }
  ]

  const root: Record<string, unknown> = { numStartups: 42, projects: {} }
  if (overrides.omitKey === true) return root
  if ('cached' in overrides) {
    root['cachedUsageUtilization'] = overrides.cached
    return root
  }
  root['cachedUsageUtilization'] = {
    fetchedAtMs: overrides.fetchedAtMs === undefined ? FETCHED : overrides.fetchedAtMs,
    accountUuid: 'a5438327-5c7d-4ecd-97cd-47307ff36d81',
    utilization: {
      five_hour: { utilization: 51, resets_at: '2026-08-10T13:10:00.721285+00:00' },
      seven_day: { utilization: 38, resets_at: '2026-08-11T19:00:00.721310+00:00' },
      tangelo: null,
      nimbus_quill: { utilization: 0, resets_at: null },
      limits,
      spend: { used: { amount_minor: 0, currency: 'USD' }, enabled: false, percent: 0 },
      extra_usage: { is_enabled: false, daily: null, weekly: null }
    }
  }
  return root
}

describe('parseUsage', () => {
  it('reads the limits a 2.1.225 reading carries', () => {
    const snapshot = parseUsage(claudeJson(), 'claude.json')

    expect(snapshot.problem).toBeNull()
    expect(snapshot.fetchedAtMs).toBe(FETCHED)
    expect(snapshot.limits.map((l) => [l.kind, l.percent])).toEqual([
      ['session', 51],
      ['weekly_all', 38],
      ['weekly_scoped', 21]
    ])
    expect(snapshot.limits[2]?.scope).toBe('Fable')
    expect(snapshot.limits[1]?.severity).toBe('warning')
  })

  it('parses the six-digit offset timestamps the CLI writes', () => {
    const snapshot = parseUsage(claudeJson(), 'claude.json')

    expect(snapshot.limits[0]?.resetsAtMs).toBe(Date.parse('2026-08-10T13:10:00.721Z'))
  })

  it('reports a missing key rather than inventing a zero', () => {
    const snapshot = parseUsage(claudeJson({ omitKey: true }), 'claude.json')

    expect(snapshot.problem?.kind).toBe('missing-key')
    expect(snapshot.limits).toEqual([])
  })

  it('reports an unusable fetchedAtMs, because an age cannot be judged without one', () => {
    for (const value of [null, 'yesterday', 0, Number.NaN]) {
      const snapshot = parseUsage(claudeJson({ fetchedAtMs: value as number }), 'claude.json')
      expect(snapshot.problem?.kind).toBe('unrecognised')
    }
  })

  it('reports a reshaped limits array rather than showing what it recognised', () => {
    const snapshot = parseUsage(
      claudeJson({
        limits: [
          { kind: 'session', group: 'session', utilizationPercent: 51 },
          { kind: 'weekly_all', bucket: 'weekly', percent: 38 }
        ]
      }),
      'claude.json'
    )

    expect(snapshot.problem?.kind).toBe('unrecognised')
    expect(snapshot.limits).toEqual([])
  })

  it('keeps the limits it recognises when a new kind appears beside them', () => {
    const snapshot = parseUsage(
      claudeJson({
        limits: [
          { kind: 'session', group: 'session', percent: 12, resets_at: null },
          { kind: 'weekly_cowork', group: 'weekly', percent: 4, resets_at: null },
          { kind: 'something_new', group: 'monthly', percent: 90 }
        ]
      }),
      'claude.json'
    )

    // The unknown *kind* is kept - it declares a group Helm shows. The unknown
    // *group* is dropped, because there is nowhere honest to put it.
    expect(snapshot.limits.map((l) => l.kind)).toEqual(['session', 'weekly_cowork'])
  })

  it('rejects a percent that is not one', () => {
    const snapshot = parseUsage(
      claudeJson({
        limits: [{ kind: 'session', group: 'session', percent: '51%', resets_at: null }]
      }),
      'claude.json'
    )

    expect(snapshot.problem?.kind).toBe('unrecognised')
  })

  it('reports a null cachedUsageUtilization as missing, not as reshaped', () => {
    expect(parseUsage(claudeJson({ cached: null }), 'f').problem?.kind).toBe('missing-key')
    expect(parseUsage(claudeJson({ cached: 'nope' }), 'f').problem?.kind).toBe('unrecognised')
  })
})

describe('usageView', () => {
  it('shows the session limit and the binding weekly one', () => {
    const view = usageView(parseUsage(claudeJson(), 'claude.json'), NOW)

    expect(view.problem).toBeNull()
    expect(view.buckets.map((b) => [b.label, b.percent, b.scope])).toEqual([
      ['Session', 51, null],
      ['Week', 38, null]
    ])
  })

  it('surfaces the per-model weekly limit when it is the binding one', () => {
    const view = usageView(
      parseUsage(
        claudeJson({
          limits: [
            {
              kind: 'session',
              group: 'session',
              percent: 10,
              resets_at: '2026-08-10T13:10:00Z'
            },
            {
              kind: 'weekly_all',
              group: 'weekly',
              percent: 38,
              resets_at: '2026-08-11T19:00:00Z'
            },
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: 77,
              resets_at: '2026-08-11T19:00:00Z',
              scope: { model: { display_name: 'Fable' } }
            }
          ]
        }),
        'claude.json'
      ),
      NOW
    )

    expect(view.buckets[1]?.percent).toBe(77)
    expect(view.buckets[1]?.scope).toBe('Fable')
    expect(view.buckets[1]?.kind).toBe('weekly_scoped')
  })

  it('does not choose by is_active, which was observed on the lower limit', () => {
    const view = usageView(
      parseUsage(
        claudeJson({
          limits: [
            {
              kind: 'weekly_all',
              group: 'weekly',
              percent: 38,
              resets_at: '2026-08-11T19:00:00Z',
              is_active: false
            },
            {
              kind: 'weekly_scoped',
              group: 'weekly',
              percent: 90,
              resets_at: '2026-08-11T19:00:00Z',
              is_active: true,
              scope: { model: { display_name: 'Fable' } }
            }
          ]
        }),
        'claude.json'
      ),
      NOW
    )

    expect(view.buckets.map((b) => b.percent)).toEqual([90])
  })

  it('shows nothing once the reading is older than the staleness horizon', () => {
    const snapshot = parseUsage(claudeJson(), 'claude.json')
    const justInside = usageView(snapshot, FETCHED + USAGE_STALE_AFTER_MS - 1000)
    const justOutside = usageView(snapshot, FETCHED + USAGE_STALE_AFTER_MS + 1000)

    expect(justInside.buckets).toHaveLength(2)
    expect(justOutside.buckets).toEqual([])
    expect(justOutside.problem?.kind).toBe('stale')
  })

  it('drops a window that has already reset and keeps the one that has not', () => {
    // The five-hour window rolled over four minutes ago; the reading itself is
    // one minute old, so it is not stale - only the session figure is dead.
    const rolled = parseUsage(
      claudeJson({
        fetchedAtMs: NOW - 60_000,
        limits: [
          {
            kind: 'session',
            group: 'session',
            percent: 51,
            resets_at: new Date(NOW - 4 * 60_000).toISOString()
          },
          {
            kind: 'weekly_all',
            group: 'weekly',
            percent: 38,
            resets_at: '2026-08-11T19:00:00Z'
          }
        ]
      }),
      'claude.json'
    )

    const view = usageView(rolled, NOW)

    expect(view.buckets.map((b) => b.label)).toEqual(['Week'])
  })

  it('shows nothing when every window in the reading has reset', () => {
    const rolled = parseUsage(
      claudeJson({
        fetchedAtMs: NOW - 60_000,
        limits: [
          {
            kind: 'session',
            group: 'session',
            percent: 51,
            resets_at: new Date(NOW - 1000).toISOString()
          },
          {
            kind: 'weekly_all',
            group: 'weekly',
            percent: 38,
            resets_at: new Date(NOW - 1000).toISOString()
          }
        ]
      }),
      'claude.json'
    )

    expect(usageView(rolled, NOW).problem?.kind).toBe('rolled-over')
  })

  it('keeps a limit the server sent no reset time for', () => {
    const view = usageView(
      parseUsage(
        claudeJson({
          fetchedAtMs: NOW,
          limits: [{ kind: 'session', group: 'session', percent: 7, resets_at: null }]
        }),
        'claude.json'
      ),
      NOW
    )

    expect(view.buckets.map((b) => [b.percent, b.resetsAtMs])).toEqual([[7, null]])
  })

  it('shows nothing when the reading is dated in the future', () => {
    const snapshot = parseUsage(claudeJson({ fetchedAtMs: NOW + 10 * 60_000 }), 'claude.json')

    expect(usageView(snapshot, NOW).problem?.kind).toBe('unrecognised')
  })

  it('passes a read problem straight through', () => {
    expect(usageView(parseUsage(claudeJson({ omitKey: true }), 'f'), NOW).problem?.kind).toBe(
      'missing-key'
    )
    expect(usageView(null, NOW).buckets).toEqual([])
  })
})

describe('nextUsageMode', () => {
  it('skips cost while there is no estimate to show', () => {
    expect(nextUsageMode('percent', ['percent', 'off'])).toBe('off')
    expect(nextUsageMode('off', ['percent', 'off'])).toBe('percent')
  })

  it('cycles all three once the index has an estimate', () => {
    expect(nextUsageMode('percent', ['percent', 'cost', 'off'])).toBe('cost')
    expect(nextUsageMode('cost', ['percent', 'cost', 'off'])).toBe('off')
    expect(nextUsageMode('off', ['percent', 'cost', 'off'])).toBe('percent')
  })

  it('leaves a mode that is no longer offered rather than jumping', () => {
    expect(nextUsageMode('cost', [])).toBe('cost')
  })
})

describe('readUsage', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'helm-usage-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('finds .claude.json beside the config directory', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude.json'), JSON.stringify(claudeJson()))

    expect(claudeConfigFileIn(join(dir, '.claude'))).toBe(join(dir, '.claude.json'))
  })

  it('prefers one inside the config directory when that is where it is', () => {
    mkdirSync(join(dir, '.claude'), { recursive: true })
    writeFileSync(join(dir, '.claude', '.claude.json'), '{}')

    expect(claudeConfigFileIn(join(dir, '.claude'))).toBe(join(dir, '.claude', '.claude.json'))
  })

  it('reports a file that is not there', () => {
    expect(readUsage(join(dir, 'nothing.json')).problem?.kind).toBe('no-file')
  })

  it('reports a half-written file rather than throwing', () => {
    const file = join(dir, '.claude.json')
    writeFileSync(file, '{"cachedUsageUtilization": {"fetched')

    expect(readUsage(file).problem?.kind).toBe('not-json')
  })

  it('reads a real reading off the disk', () => {
    const file = join(dir, '.claude.json')
    writeFileSync(file, JSON.stringify(claudeJson()))

    const snapshot = readUsage(file)

    expect(snapshot.problem).toBeNull()
    expect(snapshot.limits).toHaveLength(3)
    expect(snapshot.file).toBe(file)
  })
})
