/**
 * The shape of an archived conversation, as an earlier Helm copied it out of
 * Claude Code's transcripts into `helm.db` (`store/archive.ts`). The local host
 * archives now; `helm.db` keeps what was archived, which the copy into the host
 * carries (`store/copy.ts`).
 */

/** Where a message came from. Two, because a transcript has two speakers. */
export type ArchiveRole = 'user' | 'assistant'

/** One message of an archived conversation. */
export interface ArchiveRow {
  /**
   * The transcript row's own uuid, and the dedup key - the same one
   * `usage_messages` uses, for the same reason.
   */
  uuid: string
  /** The session the row declared, lower-cased. Falls back to the file's name. */
  sessionId: string
  role: ArchiveRole
  /** Epoch ms from the row's ISO `timestamp`. */
  at: number
  /** The message as text. Never empty - an empty one is not archived. */
  text: string
}

export interface ArchiveTail {
  rows: ArchiveRow[]
  bytes: number
  reset: boolean
  /** Lines that were not usable. Skipped, not fatal. */
  skipped: number
  /** Bytes this read actually consumed, which is what makes a pass incremental. */
  read: number
  error?: string
}
