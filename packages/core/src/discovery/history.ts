/**
 * The shapes of Claude Code's prompt history and transcripts, as an earlier
 * Helm indexed them into `helm.db` (`store/history.ts`). The local host reads
 * the files now; `helm.db` keeps what was indexed, which the copy into the host
 * carries (`store/copy.ts`).
 */

/** One line of `history.jsonl`, after the fields Helm uses have been checked. */
export interface HistoryLine {
  sessionId: string
  project: string
  timestamp: number
  display: string
}

export interface HistoryTail {
  lines: HistoryLine[]
  /**
   * Byte offset the next pass should resume from. Always the end of the last
   * complete line, so a read that caught the CLI mid-append does not consume
   * half a record and then parse the other half as a whole one.
   */
  bytes: number
  /**
   * The file is not the one the cursor belonged to - it shrank, or it is gone.
   * The caller has to discard what it had rather than append to it.
   */
  reset: boolean
  /** Lines that were not valid JSON, or lacked a field. Skipped, not fatal. */
  skipped: number
  /** Set when the file could not be read at all. */
  error?: string
}

/** A transcript file that is still on disk. */
export interface TranscriptFile {
  sessionId: string
  file: string
  bytes: number
  modifiedMs: number
}
