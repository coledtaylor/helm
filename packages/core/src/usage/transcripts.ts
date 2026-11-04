/**
 * The shape of token usage, as an earlier Helm read it out of Claude Code's
 * transcripts into `helm.db` (`store/usage.ts`). The local host reads usage now;
 * `helm.db` keeps what was indexed, which the copy into the host carries
 * (`store/copy.ts`).
 */

/** One assistant message's tokens, priced separately by class. */
export interface UsageRow {
  /**
   * The transcript row's own uuid, and the dedup key. A forked conversation
   * copies its parent's history into a new file, so the same message can appear
   * twice on disk; 0 of 22,180 uuids collided otherwise, so this is safe as a
   * primary key.
   */
  uuid: string
  /** Epoch ms from the row's ISO `timestamp`. */
  at: number
  model: string
  input: number
  output: number
  /**
   * Cache writes, split by TTL, because they are priced differently: a
   * five-minute write is 1.25x base input and a one-hour write is 2x.
   */
  cacheWrite5m: number
  cacheWrite1h: number
  /** The class that dominates the volume - 390M in one day here - at 0.1x. */
  cacheRead: number
}

export interface UsageTail {
  rows: UsageRow[]
  bytes: number
  reset: boolean
  /** Lines that were not usable. Skipped, not fatal. */
  skipped: number
  error?: string
}
