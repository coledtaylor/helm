import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openStore, type Store } from '../store/db'
import {
  countUsageMessages,
  forgetUsageFiles,
  indexUsageFile,
  indexedUsageFiles,
  readUsageSpend,
  usageCursor
} from '../store/usage'
import { costOfTokens, priceFor, PRICES } from './prices'
import type { UsageRow, UsageTail } from './transcripts'

/**
 * The dollar half, unit-tested where a driver would be slow: the arithmetic,
 * and the index `helm.db` keeps for an install that ran sessions in Helm's own
 * process, which the copy into the host reads (`store/copy.ts`).
 */

const AT = '2026-08-10T09:00:00.000Z'

/** One assistant message's tokens, as that install's transcript reader gave them. */
function assistantRow(overrides: { uuid?: string; model?: string; timestamp?: string } = {}): UsageRow {
  return {
    uuid: overrides.uuid ?? 'a1',
    at: Date.parse(overrides.timestamp ?? AT),
    model: overrides.model ?? 'claude-opus-5',
    input: 100,
    output: 200,
    cacheWrite5m: 600,
    cacheWrite1h: 400,
    cacheRead: 50_000
  }
}

/** A whole transcript's rows as one tail, its cursor counted in rows. */
function tail(...rows: UsageRow[]): UsageTail {
  return { rows, bytes: rows.length, reset: false, skipped: 0 }
}

describe('priceFor', () => {
  it('prices the four classes off the base input rate', () => {
    const rate = priceFor('claude-opus-5', Date.parse(AT))

    expect(rate).toEqual({
      input: 5,
      output: 25,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
      cacheRead: 0.5
    })
  })

  it('falls back to the family for a dated snapshot id', () => {
    expect(priceFor('claude-haiku-4-5-20251001', Date.parse(AT))?.input).toBe(1)
  })

  it('applies an introductory rate inside its window and not after', () => {
    const inside = priceFor('claude-sonnet-5', Date.parse('2026-08-31T23:00:00Z'))
    const after = priceFor('claude-sonnet-5', Date.parse('2026-09-01T00:00:01Z'))

    expect(inside?.input).toBe(2)
    expect(after?.input).toBe(PRICES['claude-sonnet-5']?.input)
    expect(after?.input).toBe(3)
  })

  it('has no price for a model it does not know', () => {
    expect(priceFor('<synthetic>', Date.parse(AT))).toBeNull()
    expect(priceFor('claude-something-9', Date.parse(AT))).toBeNull()
  })

  it('prices cache reads an order of magnitude below input', () => {
    // The whole reason the classes are priced apart: cache reads dominate the
    // volume, so folding them into the input rate would be tenfold wrong.
    const rate = priceFor('claude-opus-5', Date.parse(AT))
    expect(rate!.cacheRead * 10).toBeCloseTo(rate!.input, 10)

    const asInput = costOfTokens(
      { input: 1_000_000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
      rate!
    )
    const asRead = costOfTokens(
      { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 1_000_000 },
      rate!
    )
    expect(asInput).toBe(5)
    expect(asRead).toBe(0.5)
  })
})

describe('the usage index', () => {
  let dir: string
  let store: Store

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'helm-cost-'))
    store = openStore({ file: join(dir, 'helm.db') })
  })

  afterEach(async () => {
    store.close()
    await rm(dir, { recursive: true, force: true })
  })

  /** A transcript's path; the index keys its cursor by it. */
  const file = (name: string): string => join(dir, 'projects', 'alpha', name)

  it('counts a message once even when two transcripts contain it', () => {
    // What a fork does: the new file carries a copy of the parent's history.
    const parent = file('s1.jsonl')
    const fork = file('s2.jsonl')

    indexUsageFile(store, { file: parent, tail: tail(assistantRow({ uuid: 'shared' })) })
    const added = indexUsageFile(store, {
      file: fork,
      tail: tail(assistantRow({ uuid: 'shared' }), assistantRow({ uuid: 'own' }))
    })

    expect(added).toBe(1)
    expect(countUsageMessages(store)).toBe(2)
  })

  it('re-reading a whole file from zero does not double the totals', () => {
    const whole = tail(assistantRow({ uuid: 'a1' }), assistantRow({ uuid: 'a2' }))
    indexUsageFile(store, { file: file('s1.jsonl'), tail: whole })
    indexUsageFile(store, { file: file('s1.jsonl'), tail: whole })

    expect(countUsageMessages(store)).toBe(2)
  })

  it('keeps a cursor per file, and forgets one whose transcript was reaped', () => {
    const reaped = file('s1.jsonl')
    indexUsageFile(store, { file: reaped, tail: tail(assistantRow()) })

    expect(usageCursor(store, reaped)).toBeGreaterThan(0)
    expect(indexedUsageFiles(store).size).toBe(1)

    expect(forgetUsageFiles(store, [reaped])).toBe(1)
    expect(indexedUsageFiles(store).size).toBe(0)
    // The rows stay: the tokens were spent whether or not the record survives.
    expect(countUsageMessages(store)).toBe(1)
  })

  it('sums each window and prices it per model', () => {
    const now = Date.parse('2026-08-10T12:00:00Z')
    const hoursAgo = (n: number): string => new Date(now - n * 3_600_000).toISOString()

    indexUsageFile(store, {
      file: file('s1.jsonl'),
      tail: tail(
        assistantRow({ uuid: 'in-session', timestamp: hoursAgo(1) }),
        assistantRow({ uuid: 'earlier-today', timestamp: hoursAgo(9) }),
        assistantRow({ uuid: 'last-week', timestamp: hoursAgo(24 * 3) }),
        assistantRow({ uuid: 'too-old', timestamp: hoursAgo(24 * 20) })
      )
    })

    const spend = readUsageSpend(store, {
      nowMs: now,
      // The window the plan's own session percentage describes.
      sessionResetsAtMs: now + 2 * 3_600_000,
      todayStartMs: Date.parse('2026-08-10T00:00:00Z'),
      indexMs: 0
    })

    expect(spend.session.messages).toBe(1)
    expect(spend.today.messages).toBe(2)
    expect(spend.week.messages).toBe(3)

    // One message: 100 in, 200 out, 1000 written, 50,000 read, at Opus 5.
    const one = (100 * 5 + 200 * 25 + 600 * 6.25 + 400 * 10 + 50_000 * 0.5) / 1_000_000
    expect(spend.session.dollars).toBeCloseTo(one, 10)
    expect(spend.week.dollars).toBeCloseTo(one * 3, 10)
    expect(spend.week.tokens).toEqual({
      input: 300,
      output: 600,
      cacheWrite: 3000,
      cacheRead: 150_000
    })
    expect(spend.pricedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(spend.unpricedModels).toEqual([])
  })

  it('reports a model it has no rate for rather than pricing it as something else', () => {
    const now = Date.parse('2026-08-10T12:00:00Z')
    indexUsageFile(store, {
      file: file('s1.jsonl'),
      tail: tail(assistantRow({ uuid: 'x', model: 'claude-unreleased-9', timestamp: new Date(now).toISOString() }))
    })

    const spend = readUsageSpend(store, {
      nowMs: now,
      sessionResetsAtMs: null,
      todayStartMs: now - 3_600_000,
      indexMs: 0
    })

    expect(spend.unpricedModels).toEqual(['claude-unreleased-9'])
    expect(spend.week.dollars).toBe(0)
    // Counted, though - the tokens were real even if the price is not known.
    expect(spend.week.tokens.input).toBe(100)
  })
})
