import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ArchiveRole, ArchiveRow } from '../archive/transcript'
import type { ArchiveSessionState } from '../types'
import {
  archiveCursor,
  archiveSearchQuery,
  archiveTranscriptFile,
  evictToCeiling,
  readArchiveStats,
  readArchivedConversation,
  searchArchive
} from './archive'
import { openStore, type Store } from './db'
import { indexHistory, readHistorySessions } from './history'

/**
 * The archive `helm.db` keeps for an install that ran sessions in Helm's own
 * process, which the copy into the host reads (`copy.ts`). The rows are the
 * ones that install's transcript reader produced; each test hands them to the
 * archive as one transcript's tail, with the cursor counted in rows.
 */

let dir: string
let store: Store
/** Each planted transcript's rows, by file. */
let transcripts: Map<string, ArchiveRow[]>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'helm-archive-'))
  // The rows the archive writes are about the store, not its file, so the
  // store is in memory.
  store = openStore({ file: ':memory:' })
  transcripts = new Map()
})

afterEach(async () => {
  store.close()
  await rm(dir, { recursive: true, force: true })
})

let uuidSeq = 0
const uuid = (): string => {
  uuidSeq++
  const hex = uuidSeq.toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${hex}`
}

interface LineOpts {
  role?: ArchiveRole
  text?: string
  at?: number
  session?: string
}

/** One message of a transcript, as the archive is given it. */
function line({ role = 'user', text = 'hello', at = 0, session = 'sess' }: LineOpts = {}): ArchiveRow {
  return { uuid: uuid(), sessionId: session, role, at: 1_760_000_000_000 + at, text: text.trim() }
}

/** A transcript's whole content, replacing what it held. */
function plant(file: string, rows: ArchiveRow[]): void {
  transcripts.set(file, rows)
}

/** What the transcript gained since the archive's cursor, applied to the archive. */
function archive(file: string, sessionId: string): ReturnType<typeof archiveTranscriptFile> {
  const rows = transcripts.get(file) ?? []
  const from = archiveCursor(store, file)
  const tail = { rows: rows.slice(from), bytes: rows.length, reset: false, skipped: 0, read: rows.length - from }
  return archiveTranscriptFile(store, { file, sessionId, tail })
}

/** Stored bytes the archive holds, which is what the ceiling is measured on. */
function storedBytes(): number {
  return readArchiveStats(store, 0).storedBytes
}

/** What a session's archive is, or null when it never had one. */
function stateOf(sessionId: string): ArchiveSessionState | null {
  return readArchivedConversation(store, sessionId)?.state ?? null
}

describe('archiving a transcript', () => {
  it('adds exactly the messages a transcript grew by', () => {
    const file = join(dir, 'grown.jsonl')
    const first = [line({ at: 1 }), line({ at: 2, role: 'assistant', text: 'one' })]
    plant(file, first)
    expect(archive(file, 'sess').messages).toBe(2)

    plant(file, [...first, line({ at: 3, text: 'two' }), line({ at: 4, role: 'assistant', text: 'three' })])
    expect(archive(file, 'sess').messages).toBe(2)
    expect(readArchivedConversation(store, 'sess')?.messages.map((m) => m.text)).toEqual(['hello', 'one', 'two', 'three'])
  })

  it('does not double-count a message a fork put in a second file', () => {
    const a = join(dir, 'parent.jsonl')
    const shared = line({ at: 1 })
    plant(a, [shared, line({ at: 2 })])
    archive(a, 'sess')

    const b = join(dir, 'fork.jsonl')
    plant(b, [shared, line({ at: 3 })])
    const second = archive(b, 'sess')

    expect(second.messages).toBe(1)
    expect(readArchivedConversation(store, 'sess')?.messageCount).toBe(3)
  })
})

describe('storage', () => {
  it('compresses a body worth compressing and stores a short one as it is', () => {
    const file = join(dir, 'sizes.jsonl')
    const long = 'the quick brown fox jumps over the lazy dog. '.repeat(40)
    plant(file, [line({ at: 1, text: 'short' }), line({ at: 2, text: long })])
    archive(file, 'sess')

    const rows = store.raw
      .prepare('SELECT compressed, raw_bytes, stored_bytes FROM transcript_messages ORDER BY at')
      .all() as Array<{ compressed: number; raw_bytes: number; stored_bytes: number }>

    expect(rows[0]?.compressed).toBe(0)
    expect(rows[0]?.stored_bytes).toBe(rows[0]?.raw_bytes)
    expect(rows[1]?.compressed).toBe(1)
    expect(rows[1]?.stored_bytes).toBeLessThan((rows[1]?.raw_bytes ?? 0) / 4)
    // And it comes back out byte for byte.
    const conversation = readArchivedConversation(store, 'sess')
    expect(conversation?.messages[1]?.text).toBe(long.trim())
  })
})

describe('search', () => {
  it('quotes what was typed so FTS syntax cannot leak out of the box', () => {
    expect(archiveSearchQuery('hello world')).toBe('"hello" AND "world"*')
    expect(archiveSearchQuery('-not "a phrase"')).toBe('"not" AND "a" AND "phrase"*')
    expect(archiveSearchQuery('   ')).toBeNull()
  })

  it('finds a token planted in the middle of a conversation', () => {
    const file = join(dir, 'search.jsonl')
    plant(file, [
      line({ at: 1, text: 'opening question' }),
      line({ at: 2, role: 'assistant', text: 'the answer is zorblatt' }),
      line({ at: 3, text: 'closing remark' })
    ])
    archive(file, 'sess')

    expect([...searchArchive(store, 'zorblatt').keys()]).toEqual(['sess'])
    expect(searchArchive(store, 'zorbl').get('sess')?.text).toContain('zorblatt')
    expect(searchArchive(store, 'nothinglikethis').size).toBe(0)
  })

  it('finds it through the conversations scope of the history list and not through the prompts scope', () => {
    indexHistory(store, {
      file: join(dir, 'history.jsonl'),
      tail: {
        lines: ['opening question', 'closing remark'].map((display, i) => ({
          sessionId: 'sess',
          project: dir,
          timestamp: 1_760_000_000_000 + i,
          display
        })),
        bytes: 100,
        reset: false,
        skipped: 0
      },
      transcripts: new Map(),
      directoryExists: () => true
    })
    const file = join(dir, 'scoped.jsonl')
    plant(file, [
      line({ at: 1, text: 'opening question' }),
      line({ at: 2, role: 'assistant', text: 'the answer is zorblatt' }),
      line({ at: 3, text: 'closing remark' })
    ])
    archive(file, 'sess')

    const messages = readHistorySessions(store, { search: 'zorblatt', scope: 'messages' })
    expect(messages.sessions.map((s) => [s.sessionId, s.match])).toEqual([['sess', 'the answer is zorblatt']])
    expect(readHistorySessions(store, { search: 'zorblatt', scope: 'prompts' }).total).toBe(0)
  })

  it('does not throw on input FTS5 would refuse', () => {
    const file = join(dir, 'odd.jsonl')
    plant(file, [line({ at: 1, text: 'ordinary words' })])
    archive(file, 'sess')

    for (const term of ['"', '(', 'NEAR(', 'a AND', '*', '^']) {
      expect(() => searchArchive(store, term)).not.toThrow()
    }
  })

  it('stops finding a conversation the ceiling dropped', () => {
    const file = join(dir, 'gone.jsonl')
    plant(file, [line({ at: 1, text: 'the word is zorblatt '.repeat(20) })])
    archive(file, 'sess')
    expect(searchArchive(store, 'zorblatt').size).toBe(1)

    evictToCeiling(store, 0)
    // The trigger on `transcript_messages` is what un-indexes it. A search that
    // still matched would be one returning rowids nothing can resolve.
    expect(searchArchive(store, 'zorblatt').size).toBe(0)
  })
})

describe('the ceiling', () => {
  /** Four sessions, oldest first, each big enough to be worth evicting. */
  function fill(): void {
    for (const [index, name] of ['oldest', 'older', 'newer', 'newest'].entries()) {
      const file = join(dir, `${name}.jsonl`)
      plant(file, [
        line({ session: name, at: index * 1000, text: `conversation ${name} `.repeat(60) })
      ])
      archive(file, name)
    }
  }

  it('drops the oldest session whole, and only as far as it has to', () => {
    fill()
    const before = storedBytes()
    const each = before / 4

    // Room for three of the four, so exactly one has to go - and which one it
    // is is the claim. A ceiling that forced two would not test the order.
    const ceiling = Math.round(each * 3.5)
    const eviction = evictToCeiling(store, ceiling)

    expect(eviction.sessions).toEqual(['oldest'])
    expect(storedBytes()).toBeLessThanOrEqual(ceiling)
    expect(stateOf('older')).toBe('archived')
    expect(stateOf('newest')).toBe('archived')
  })

  it('never leaves half a conversation behind', () => {
    const file = join(dir, 'many.jsonl')
    plant(
      file,
      Array.from({ length: 12 }, (_, i) => line({ session: 'wide', at: i, text: `part ${String(i)} `.repeat(40) }))
    )
    archive(file, 'wide')
    const total = storedBytes()

    evictToCeiling(store, Math.round(total / 2))

    // Either the whole session is there or none of it is. A partial one would
    // be a transcript that lies about being complete.
    const kept = store.raw
      .prepare("SELECT COUNT(*) AS n FROM transcript_messages WHERE session_id = 'wide'")
      .get() as { n: number }
    expect(kept.n).toBe(0)
    expect(stateOf('wide')).toBe('evicted')
  })

  it('tells a session it dropped from one it never had', () => {
    fill()
    evictToCeiling(store, Math.round(storedBytes() * 0.6))

    expect(stateOf('oldest')).toBe('evicted')
    expect(stateOf('never-seen')).toBeNull()

    const dropped = readArchivedConversation(store, 'oldest')
    expect(dropped?.state).toBe('evicted')
    expect(dropped?.messages).toHaveLength(0)
    // What it had is still on the record; only the text is gone.
    expect(dropped?.messageCount).toBeGreaterThan(0)
    expect(dropped?.evictedAt).not.toBeNull()
    expect(dropped?.storedBytes).toBe(0)
  })

  it('does not re-archive what it just dropped', () => {
    const file = join(dir, 'again.jsonl')
    plant(file, [line({ session: 'sess', at: 1, text: 'body '.repeat(80) })])
    archive(file, 'sess')
    evictToCeiling(store, 0)

    // The cursor is at the end, so nothing is re-offered. Force the issue: pretend
    // the file was replaced, which re-offers every row it has ever had.
    store.raw.prepare('DELETE FROM transcript_index WHERE file = ?').run(file)
    const again = archive(file, 'sess')

    expect(again.messages).toBe(0)
    expect(again.skippedEvicted).toBe(true)
    expect(stateOf('sess')).toBe('evicted')
  })

  it('stops when there is nothing left to drop rather than looping', () => {
    fill()
    const eviction = evictToCeiling(store, 0)
    expect(eviction.sessions).toHaveLength(4)
    expect(eviction.storedBytes).toBe(0)
  })

  it('counts what it has and what it dropped separately', () => {
    fill()
    const total = storedBytes()
    evictToCeiling(store, Math.round(total / 2))

    const stats = readArchiveStats(store, 1024 ** 3)
    expect(stats.sessions + stats.evictedSessions).toBe(4)
    expect(stats.evictedSessions).toBeGreaterThan(0)
    expect(stats.storedBytes).toBe(storedBytes())
    expect(stats.rawBytes).toBeGreaterThan(stats.storedBytes)
    expect(stats.maxBytes).toBe(1024 ** 3)
  })
})
