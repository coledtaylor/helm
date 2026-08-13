import { readTail } from '../discovery/tail'

/**
 * The conversation out of a transcript Claude Code is going to delete.
 *
 * `history.jsonl` keeps every prompt for ever; the transcripts behind them are
 * reaped on the CLI's own schedule. Measured on 2026-08-08: 744 sessions
 * recorded across 35 projects, 68 transcripts still on disk - 91% of the
 * conversations already gone, and the prompts of all 744 still there. That
 * asymmetry is the whole reason this file exists. Reading a record that is about
 * to be deleted is not hosting a client; nothing here is ever in the path of a
 * live session, and nothing here writes to Claude Code's tree.
 *
 * What is kept, and what is deliberately not:
 *
 *   `text` and `thinking` blocks are the conversation and are kept whole.
 *   `tool_use` becomes a one-line marker naming the tool. The input is machine
 *   data - a 200 KB file write, a base64 image - and it is the bulk of the
 *   bytes. `tool_result` is dropped for the same reason and one more: it is the
 *   world's answer rather than anybody's words, and it is the class that would
 *   put a file's whole contents into Helm's database.
 *
 * That rule is what makes the archive small enough to keep for ever. Measured
 * over this machine's whole `projects/` tree on 2026-08-13: **229 transcripts,
 * 311.8 MB on disk, 21,952 messages, 2.33 MB of conversation text, 1.47 MB once
 * compressed** - 212x smaller than the transcripts it came from, against a
 * default ceiling of a gigabyte.
 *
 * The parse discipline is `usage/transcripts.ts`'s, because it is the same file
 * being read: an unusable line is **skipped, not fatal**, and rows dedup by the
 * transcript row's own `uuid` - a forked conversation copies its parent's
 * history into a new file, so the same message genuinely is on disk twice.
 *
 * Unlike the usage reader there is **no substring gate before the parse**, and
 * that was measured rather than assumed: over the same 311.8 MB, gating on
 * `"user"`/`"assistant"` skipped 28,000 of 75,000 `JSON.parse` calls and made
 * the pass no faster (1,275 ms with the gate, 1,204 ms without). The cost is the
 * read and the split, so the gate bought only a line of code to get wrong.
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One content block, as the conversation reads it.
 *
 * Returns null for a block that is not part of what was said. The marker for a
 * tool call is deliberately short and deliberately *there*: a conversation that
 * silently skipped from a question to an answer twenty tool calls later would
 * be a transcript that lies about what happened.
 */
function blockText(block: unknown): string | null {
  if (typeof block === 'string') return block === '' ? null : block
  if (!isObject(block)) return null
  const type = block['type']
  if (type === 'text' && typeof block['text'] === 'string') {
    return block['text'] === '' ? null : block['text']
  }
  if (type === 'thinking' && typeof block['thinking'] === 'string') {
    return block['thinking'] === '' ? null : block['thinking']
  }
  if (type === 'tool_use') {
    const name = block['name']
    return typeof name === 'string' && name !== '' ? `[tool: ${name}]` : '[tool]'
  }
  // `tool_result`, `image`, `document` and whatever the CLI adds next.
  return null
}

/** The renderable text of one message's content, blocks joined by blank lines. */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const text = blockText(block)
    if (text !== null) parts.push(text)
  }
  return parts.join('\n\n').trim()
}

/**
 * One transcript line, if it is a message somebody said.
 *
 * Everything else in the file - `system`, `attachment`, `file-history-snapshot`,
 * `queue-operation`, `mode`, `bridge-session` and a dozen more - is skipped
 * silently rather than counted as a failure, because it is not a failure: those
 * rows are not conversation. `isMeta` rows are skipped too; they are the
 * caveats the CLI injects around a slash command, addressed to the model rather
 * than written by anybody.
 */
export function parseArchiveLine(raw: string, fallbackSessionId: string): ArchiveRow | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(value)) return null

  const type = value['type']
  if (type !== 'user' && type !== 'assistant') return null
  if (value['isMeta'] === true) return null

  const uuid = value['uuid']
  if (typeof uuid !== 'string' || uuid === '') return null

  const at = Date.parse(String(value['timestamp'] ?? ''))
  if (!Number.isFinite(at)) return null

  const message = value['message']
  if (!isObject(message)) return null
  const text = messageText(message['content'])
  // A message with nothing to read is not archived. The row still existed, but
  // an empty entry in a conversation is noise in the one surface this feeds.
  if (text === '') return null

  const declared = value['sessionId']
  const sessionId =
    typeof declared === 'string' && declared !== ''
      ? declared.toLowerCase()
      : fallbackSessionId.toLowerCase()

  return { uuid, sessionId, role: type, at, text }
}

/**
 * The messages appended to one transcript since `fromBytes`.
 *
 * The same byte-cursor shape the usage index uses, and the same primitive
 * underneath it: a transcript that has grown by 4 KB costs a 4 KB read. `read`
 * is reported so a check can prove that rather than take it on trust.
 */
export function readArchiveTail(
  file: string,
  fromBytes: number,
  fallbackSessionId: string
): ArchiveTail {
  const tail = readTail(file, fromBytes)
  if (tail.error !== undefined) {
    return {
      rows: [],
      bytes: tail.bytes,
      reset: tail.reset,
      skipped: 0,
      read: 0,
      error: tail.error
    }
  }

  const from = tail.reset ? 0 : fromBytes
  const rows: ArchiveRow[] = []
  let skipped = 0
  for (const raw of tail.text.split('\n')) {
    if (raw === '') continue
    const row = parseArchiveLine(raw, fallbackSessionId)
    if (row === null) skipped++
    else rows.push(row)
  }

  return {
    rows,
    bytes: tail.bytes,
    reset: tail.reset,
    skipped,
    read: Math.max(0, tail.bytes - from)
  }
}
