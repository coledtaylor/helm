import { describe, expect, it } from 'vitest'
import { costOfTokens, priceFor, PRICES } from './prices'

/** The dollar arithmetic: each model's rates, by date. */

const AT = '2026-08-10T09:00:00.000Z'

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
