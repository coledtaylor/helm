import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readArchiveTail, parseArchiveLine, messageText } from '../archive/transcript'
import {
  archiveCursor,
  archiveSearchQuery,
  archiveStateOf,
  archiveTranscriptFile,
  archivedBytes,
  evictToCeiling,
  forgetArchiveFiles,
  indexedArchiveFiles,
  readArchiveStats,
  readArchivedConversation,
  searchArchive
} from './archive'
import { openStore, type Store } from './db'

let dir: string
let store: Store

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'helm-archive-'))
  store = openStore({ file: join(dir, 'helm.db') })
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
  type?: string
  content?: unknown
  at?: number
  session?: string
  extra?: Record<string, unknown>
}

function line({ type = 'user', content = 'hello', at = 0, session = 'sess', extra }: LineOpts = {}): string {
  return JSON.stringify({
    type,
    uuid: uuid(),
    sessionId: session,
    timestamp: new Date(1_760_000_000_000 + at).toISOString(),
    message: { content },
    ...extra
  })
}

/** A transcript on disk, and the tail read of it applied to the archive. */
async function plant(file: string, lines: string[]): Promise<void> {
  await writeFile(file, lines.map((l) => `${l}\n`).join(''), 'utf8')
}

function archive(file: string, sessionId: string): ReturnType<typeof archiveTranscriptFile> {
  const tail = readArchiveTail(file, archiveCursor(store, file), sessionId)
  return archiveTranscriptFile(store, { file, sessionId, tail })
}

describe('parsing a transcript line', () => {
  it('keeps user and assistant messages and nothing else', () => {
    expect(parseArchiveLine(line({ type: 'user' }), 'sess')?.role).toBe('user')
    expect(parseArchiveLine(line({ type: 'assistant', content: [{ type: 'text', text: 'hi' }] }), 'sess')?.role).toBe(
      'assistant'
    )
    for (const type of ['system', 'attachment', 'file-history-snapshot', 'queue-operation', 'mode']) {
      expect(parseArchiveLine(line({ type }), 'sess')).toBeNull()
    }
  })

  it('skips a line that is not usable rather than throwing', () => {
    expect(parseArchiveLine('{not json', 'sess')).toBeNull()
    expect(parseArchiveLine('[]', 'sess')).toBeNull()
    expect(parseArchiveLine(JSON.stringify({ type: 'user' }), 'sess')).toBeNull()
    // No timestamp the parser can read is a row with no place on a time axis.
    expect(
      parseArchiveLine(JSON.stringify({ type: 'user', uuid: 'u', timestamp: 'never', message: { content: 'x' } }), 's')
    ).toBeNull()
  })

  it('skips the caveats the CLI injects around a slash command', () => {
    expect(parseArchiveLine(line({ extra: { isMeta: true } }), 'sess')).toBeNull()
  })

  it('falls back to the file name when a row declares no session', () => {
    const raw = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: new Date().toISOString(),
      message: { content: 'x' }
    })
    expect(parseArchiveLine(raw, 'FROM-THE-FILE')?.sessionId).toBe('from-the-file')
  })
})

describe('what a message is worth keeping', () => {
  it('keeps text and thinking, marks tools, and drops their results', () => {
    expect(
      messageText([
        { type: 'text', text: 'first' },
        { type: 'thinking', thinking: 'second' },
        { type: 'tool_use', name: 'Read', input: { file: 'x'.repeat(10_000) } },
        { type: 'tool_result', content: 'y'.repeat(10_000) },
        { type: 'image', source: {} }
      ])
    ).toBe('first\n\nsecond\n\n[tool: Read]')
  })

  it('takes a plain string content as it is', () => {
    expect(messageText('  just words  ')).toBe('just words')
  })

  it('is empty when there was nothing anybody said', () => {
    expect(messageText([{ type: 'tool_result', content: 'x' }])).toBe('')
    expect(messageText(undefined)).toBe('')
  })
})

describe('the byte cursor', () => {
  it('reads only what was appended', async () => {
    const file = join(dir, 'a.jsonl')
    await plant(file, [line({ at: 1 }), line({ at: 2 })])
    const first = archive(file, 'sess')
    expect(first.messages).toBe(2)
    const after = archiveCursor(store, file)
    expect(after).toBeGreaterThan(0)

    await appendFile(file, `${line({ at: 3 })}\n`, 'utf8')
    const tail = readArchiveTail(file, after, 'sess')
    expect(tail.rows).toHaveLength(1)
    // The whole point: the second pass read the appended bytes and not the file.
    expect(tail.read).toBeLessThan(after)
    expect(tail.read).toBeGreaterThan(0)
  })

  it('re-reads from zero when the file it belonged to was replaced', async () => {
    const file = join(dir, 'b.jsonl')
    await plant(file, [line({ at: 1 }), line({ at: 2 }), line({ at: 3 })])
    archive(file, 'sess')
    await plant(file, [line({ at: 4 })])

    const tail = readArchiveTail(file, archiveCursor(store, file), 'sess')
    expect(tail.reset).toBe(true)
    expect(tail.rows).toHaveLength(1)
  })

  it('does not double-count a message a fork put in a second file', async () => {
    const a = join(dir, 'parent.jsonl')
    const shared = line({ at: 1 })
    await plant(a, [shared, line({ at: 2 })])
    archive(a, 'sess')

    const b = join(dir, 'fork.jsonl')
    await plant(b, [shared, line({ at: 3 })])
    const second = archive(b, 'sess')

    expect(second.messages).toBe(1)
    expect(readArchivedConversation(store, 'sess')?.messageCount).toBe(3)
  })

  it('forgets a cursor for a transcript that has gone, and keeps the conversation', async () => {
    const file = join(dir, 'reaped.jsonl')
    await plant(file, [line({ at: 1 })])
    archive(file, 'sess')

    expect(indexedArchiveFiles(store).has(file)).toBe(true)
    expect(forgetArchiveFiles(store, [file])).toBe(1)
    expect(indexedArchiveFiles(store).has(file)).toBe(false)
    expect(readArchivedConversation(store, 'sess')?.messages).toHaveLength(1)
  })
})

describe('storage', () => {
  it('compresses a body worth compressing and stores a short one as it is', async () => {
    const file = join(dir, 'sizes.jsonl')
    const long = 'the quick brown fox jumps over the lazy dog. '.repeat(40)
    await plant(file, [line({ at: 1, content: 'short' }), line({ at: 2, content: long })])
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

  it('finds a token planted in the middle of a conversation', async () => {
    const file = join(dir, 'search.jsonl')
    await plant(file, [
      line({ at: 1, content: 'opening question' }),
      line({ at: 2, type: 'assistant', content: [{ type: 'text', text: 'the answer is zorblatt' }] }),
      line({ at: 3, content: 'closing remark' })
    ])
    archive(file, 'sess')

    expect([...searchArchive(store, 'zorblatt').keys()]).toEqual(['sess'])
    expect(searchArchive(store, 'zorbl').get('sess')?.text).toContain('zorblatt')
    expect(searchArchive(store, 'nothinglikethis').size).toBe(0)
  })

  it('does not throw on input FTS5 would refuse', async () => {
    const file = join(dir, 'odd.jsonl')
    await plant(file, [line({ at: 1, content: 'ordinary words' })])
    archive(file, 'sess')

    for (const term of ['"', '(', 'NEAR(', 'a AND', '*', '^']) {
      expect(() => searchArchive(store, term)).not.toThrow()
    }
  })

  it('stops finding a conversation the ceiling dropped', async () => {
    const file = join(dir, 'gone.jsonl')
    await plant(file, [line({ at: 1, content: 'the word is zorblatt '.repeat(20) })])
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
  async function fill(): Promise<void> {
    for (const [index, name] of ['oldest', 'older', 'newer', 'newest'].entries()) {
      const file = join(dir, `${name}.jsonl`)
      await plant(file, [
        line({ session: name, at: index * 1000, content: `conversation ${name} `.repeat(60) })
      ])
      archive(file, name)
    }
  }

  it('drops the oldest session whole, and only as far as it has to', async () => {
    await fill()
    const before = archivedBytes(store)
    const each = before / 4

    // Room for three of the four, so exactly one has to go - and which one it
    // is is the claim. A ceiling that forced two would not test the order.
    const ceiling = Math.round(each * 3.5)
    const eviction = evictToCeiling(store, ceiling)

    expect(eviction.sessions).toEqual(['oldest'])
    expect(archivedBytes(store)).toBeLessThanOrEqual(ceiling)
    expect(archiveStateOf(store, 'older')).toBe('archived')
    expect(archiveStateOf(store, 'newest')).toBe('archived')
  })

  it('never leaves half a conversation behind', async () => {
    const file = join(dir, 'many.jsonl')
    await plant(
      file,
      Array.from({ length: 12 }, (_, i) => line({ session: 'wide', at: i, content: `part ${String(i)} `.repeat(40) }))
    )
    archive(file, 'wide')
    const total = archivedBytes(store)

    evictToCeiling(store, Math.round(total / 2))

    // Either the whole session is there or none of it is. A partial one would
    // be a transcript that lies about being complete.
    const kept = store.raw
      .prepare("SELECT COUNT(*) AS n FROM transcript_messages WHERE session_id = 'wide'")
      .get() as { n: number }
    expect(kept.n).toBe(0)
    expect(archiveStateOf(store, 'wide')).toBe('evicted')
  })

  it('tells a session it dropped from one it never had', async () => {
    await fill()
    evictToCeiling(store, Math.round(archivedBytes(store) * 0.6))

    expect(archiveStateOf(store, 'oldest')).toBe('evicted')
    expect(archiveStateOf(store, 'never-seen')).toBeNull()

    const dropped = readArchivedConversation(store, 'oldest')
    expect(dropped?.state).toBe('evicted')
    expect(dropped?.messages).toHaveLength(0)
    // What it had is still on the record; only the text is gone.
    expect(dropped?.messageCount).toBeGreaterThan(0)
    expect(dropped?.evictedAt).not.toBeNull()
    expect(dropped?.storedBytes).toBe(0)
  })

  it('does not re-archive what it just dropped', async () => {
    const file = join(dir, 'again.jsonl')
    await plant(file, [line({ session: 'sess', at: 1, content: 'body '.repeat(80) })])
    archive(file, 'sess')
    evictToCeiling(store, 0)

    // The cursor is at EOF, so nothing is re-offered. Force the issue: pretend
    // the file was replaced, which re-offers every row it has ever had.
    store.raw.prepare('DELETE FROM transcript_index WHERE file = ?').run(file)
    const again = archive(file, 'sess')

    expect(again.messages).toBe(0)
    expect(again.skippedEvicted).toBe(true)
    expect(archiveStateOf(store, 'sess')).toBe('evicted')
  })

  it('stops when there is nothing left to drop rather than looping', async () => {
    await fill()
    const eviction = evictToCeiling(store, 0)
    expect(eviction.sessions).toHaveLength(4)
    expect(eviction.storedBytes).toBe(0)
  })

  it('counts what it has and what it dropped separately', async () => {
    await fill()
    const total = archivedBytes(store)
    evictToCeiling(store, Math.round(total / 2))

    const stats = readArchiveStats(store, 1024 ** 3)
    expect(stats.sessions + stats.evictedSessions).toBe(4)
    expect(stats.evictedSessions).toBeGreaterThan(0)
    expect(stats.storedBytes).toBe(archivedBytes(store))
    expect(stats.rawBytes).toBeGreaterThan(stats.storedBytes)
    expect(stats.maxBytes).toBe(1024 ** 3)
  })
})
