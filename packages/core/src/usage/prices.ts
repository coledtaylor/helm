/**
 * What a token costs, per model, on a date.
 *
 * Everything this table produces is an **estimate** and is labelled as one
 * wherever it appears. On a subscription plan Anthropic is not billing per
 * token: `spend.enabled` is false in the server's own answer and every
 * `*_dollars` field it sends is null. These figures are Helm's arithmetic over
 * the transcripts, priced from a list Helm carries and has to keep current.
 *
 * A stale price table is worse than no dollar figure, because it looks
 * authoritative. So the date lives in the table rather than in a comment, is
 * shown in the UI, and the UI marks it when it goes past
 * `PRICE_TABLE_FRESH_FOR_DAYS`. There is exactly one place either number is
 * written down, which is here.
 *
 * Pure by construction - no `node:` imports - so `types.ts` can re-export it
 * for the window.
 */

/** US dollars per million tokens. */
export interface TokenPrice {
  input: number
  output: number
  /**
   * Cache writes and reads are priced off the base input rate: a five-minute
   * write is 1.25x, a one-hour write is 2x, and a read is 0.1x. They are
   * written out rather than derived because a multiplier is a rule that can
   * change without the rate changing, and this file is meant to be checked
   * against a price list by eye.
   */
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
}

export interface ModelPrice extends TokenPrice {
  /**
   * A promotional rate and the last day it applies, when one is running.
   * Modelled rather than ignored because ignoring it is a wrong number: Claude
   * Sonnet 5's introductory rate is a third off, and it is live right now.
   */
  intro?: { until: string; price: TokenPrice }
}

/**
 * The day this list was last checked against Anthropic's published pricing.
 *
 * Shown in the status bar. Change it only when the rates below have actually
 * been re-read - a date bumped without a check is the failure this exists to
 * prevent.
 */
export const PRICE_TABLE_DATE = '2026-08-10'

/** Past this, the UI says the prices are old rather than quietly using them. */
export const PRICE_TABLE_FRESH_FOR_DAYS = 90

const price = (input: number, output: number): TokenPrice => ({
  input,
  output,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
  cacheRead: input * 0.1
})

/**
 * Keyed by the `model` a transcript row records.
 *
 * The four current families plus the ones still in this machine's 26 days of
 * surviving transcripts. A model not on this list is not guessed at - its
 * tokens are counted, left unpriced, and its name is reported.
 */
export const PRICES: Record<string, ModelPrice> = {
  'claude-fable-5': price(10, 50),
  'claude-mythos-5': price(10, 50),
  'claude-opus-5': price(5, 25),
  'claude-opus-4-8': price(5, 25),
  'claude-opus-4-7': price(5, 25),
  'claude-opus-4-6': price(5, 25),
  'claude-opus-4-5': price(5, 25),
  'claude-sonnet-5': {
    ...price(3, 15),
    // Introductory pricing through 2026-08-31, per Anthropic's model list.
    intro: { until: '2026-08-31', price: price(2, 10) }
  },
  'claude-sonnet-4-6': price(3, 15),
  'claude-sonnet-4-5': price(3, 15),
  'claude-haiku-4-5': price(1, 5)
}

/**
 * The rate for a model at a moment, or null if Helm has no rate for it.
 *
 * A dated snapshot id (`claude-haiku-4-5-20251001`) falls back to its family,
 * because a snapshot is the same model at the same price. `<synthetic>` - which
 * Claude Code writes for a locally-generated message - matches nothing and is
 * reported as unpriced, which is correct: it never went to a server.
 */
export function priceFor(model: string, atMs: number): TokenPrice | null {
  const entry = PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, '')]
  if (entry === undefined) return null
  if (entry.intro !== undefined) {
    // End of the stated day, in UTC: the rate applies *through* that date.
    const until = Date.parse(`${entry.intro.until}T23:59:59.999Z`)
    if (Number.isFinite(until) && atMs <= until) return entry.intro.price
  }
  return { ...entry }
}

/** Tokens times rate, in dollars. Both sides are per million. */
export function costOfTokens(
  tokens: { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number },
  rate: TokenPrice
): number {
  return (
    (tokens.input * rate.input +
      tokens.output * rate.output +
      tokens.cacheWrite5m * rate.cacheWrite5m +
      tokens.cacheWrite1h * rate.cacheWrite1h +
      tokens.cacheRead * rate.cacheRead) /
    1_000_000
  )
}

/** How old the table is, in whole days. The UI shows it once it is old. */
export function priceTableAgeDays(nowMs: number): number {
  const at = Date.parse(`${PRICE_TABLE_DATE}T00:00:00Z`)
  if (!Number.isFinite(at)) return 0
  return Math.max(0, Math.floor((nowMs - at) / 86_400_000))
}
