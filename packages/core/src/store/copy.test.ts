import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ArchiveRow } from '../archive/transcript'
import type { UsageRow } from '../usage/transcripts'
import { archiveTranscriptFile, evictToCeiling, readArchivedConversation } from './archive'
import { insertConfigSnapshot } from './config'
import {
  MAX_COPIED_TEXT_BYTES,
  countCopyableData,
  readConfigSnapshotPage,
  readConversationKeys,
  readConversationPage,
  readSessionNames,
  readUsagePage,
  type ConversationCursor,
  type ConversationPage,
  type ConversationPageOptions,
  type ConversationPart
} from './copy'
import { openStore, type Store } from './db'
import { renameHistorySession } from './history'
import { indexUsageFile } from './usage'

let dir: string
let file: string
let store: Store

beforeEach(async () => {
  // A real file, with a space in its path, because one test is about the file
  // being left exactly as it was.
  dir = await mkdtemp(join(tmpdir(), 'helm copy '))
  file = join(dir, 'helm data', 'helm.db')
  store = openStore({ file })
})

afterEach(async () => {
  store.close()
  await rm(dir, { recursive: true, force: true })
})

let seq = 0
function uuid(): string {
  seq++
  return `00000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`
}

/** Short enough to be stored as it is. */
const SHORT = 'a short message'
/** Long and repetitive, so the archive stores it compressed. */
const LONG = 'the same long line, over and over. '.repeat(40)

function archive(sessionId: string, texts: readonly string[], startAt = 0): void {
  const rows: ArchiveRow[] = texts.map((text, index) => ({
    uuid: uuid(),
    sessionId,
    role: index % 2 === 0 ? 'user' : 'assistant',
    at: 1_760_000_000_000 + startAt + index,
    text
  }))
  archiveTranscriptFile(store, {
    file: join(dir, `${sessionId}.jsonl`),
    sessionId,
    tail: { rows, bytes: 100, reset: false, skipped: 0, read: 100 }
  })
}

/** Drops every conversation older than `keep`, by setting the limit to what it stores. */
function evictAllBut(keep: string): void {
  const row = store.raw
    .prepare('SELECT stored_bytes FROM transcript_sessions WHERE session_id = ?')
    .get(keep) as { stored_bytes: number }
  evictToCeiling(store, row.stored_bytes)
}

function usage(count: number): UsageRow[] {
  const rows: UsageRow[] = Array.from({ length: count }, (_, index) => ({
    uuid: uuid(),
    at: 1_760_000_000_000 + index,
    model: 'claude-opus-4',
    input: 10 + index,
    output: 20,
    cacheWrite5m: 1,
    cacheWrite1h: 2,
    cacheRead: 3
  }))
  indexUsageFile(store, {
    file: join(dir, 'usage.jsonl'),
    tail: { rows, bytes: 100, reset: false, skipped: 0 }
  })
  return rows
}

/** Every page from the start, as a copy reads them. */
function readAll(options: ConversationPageOptions = {}): ConversationPart[][] {
  const pages: ConversationPart[][] = []
  let cursor: ConversationCursor | null = null
  do {
    const page = readConversationPage(store, cursor, options)
    pages.push(page.parts)
    cursor = page.next
    if (pages.length > 1000) throw new Error('the pages never end')
  } while (cursor !== null)
  return pages
}

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

describe('reading conversations to copy', () => {
  it('reads every conversation in session order, messages in the order they happened', () => {
    archive('bbb', [SHORT, LONG, SHORT])
    archive('aaa', [LONG, SHORT])

    const pages = readAll()
    expect(pages).toHaveLength(1)
    const [first, second] = pages[0] ?? []
    expect(first?.conversation.sessionId).toBe('aaa')
    expect(first?.messages.map((m) => m.text)).toEqual([LONG, SHORT])
    expect(first?.last).toBe(true)
    expect(second?.conversation).toMatchObject({
      sessionId: 'bbb',
      state: 'archived',
      messageCount: 3
    })
    expect(second?.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', SHORT],
      ['assistant', LONG],
      ['user', SHORT]
    ])
  })

  it('gives compressed and uncompressed bodies back as the text that was archived', () => {
    archive('mixed', [SHORT, LONG])
    const stored = store.raw
      .prepare('SELECT compressed FROM transcript_messages ORDER BY at')
      .all() as Array<{ compressed: number }>
    expect(stored.map((row) => row.compressed)).toEqual([0, 1])

    const part = readAll()[0]?.[0]
    expect(part?.messages.map((m) => m.text)).toEqual(
      readArchivedConversation(store, 'mixed')?.messages.map((m) => m.text)
    )
  })

  it('splits a conversation larger than the budget into parts, the last one flagged', () => {
    const texts = Array.from({ length: 7 }, (_, index) => `message ${index} ${LONG}`)
    archive('big', texts)
    archive('small', [SHORT])
    const budget = { maxBytes: 3 * Buffer.byteLength(texts[0] ?? '', 'utf8'), maxRows: 100 }

    const parts = readAll({ budget }).flat()
    const big = parts.filter((p) => p.conversation.sessionId === 'big')
    expect(big.length).toBeGreaterThan(1)
    expect(big.map((p) => p.part)).toEqual(big.map((_, index) => index))
    expect(big.map((p) => p.last)).toEqual(big.map((_, index) => index === big.length - 1))
    // Every message once, in order, across the parts.
    expect(big.flatMap((p) => p.messages.map((m) => m.text))).toEqual(texts)
    expect(parts.filter((p) => p.conversation.sessionId === 'small')).toHaveLength(1)
  })

  it('keeps a page within its row count, the conversation row included', () => {
    archive('one', [SHORT, SHORT, SHORT, SHORT, SHORT])
    archive('two', [SHORT, SHORT])

    const pages = readAll({ budget: { maxBytes: 1 << 20, maxRows: 3 } })
    for (const page of pages) {
      const rows = page.reduce((n, p) => n + p.messages.length + (p.last ? 1 : 0), 0)
      expect(rows).toBeLessThanOrEqual(4)
    }
    const all = pages.flat()
    expect(all.flatMap((p) => p.messages).length).toBe(7)
    expect(all.filter((p) => p.last).map((p) => p.conversation.sessionId)).toEqual([
      'one',
      'two'
    ])
  })

  it('sends a message larger than the whole budget on a page of its own', () => {
    archive('huge', [LONG, LONG])
    const pages = readAll({ budget: { maxBytes: 10, maxRows: 100 } })
    expect(pages.map((page) => page.flatMap((p) => p.messages).length)).toEqual([1, 1])
  })

  it('sends a message too long for one frame cut short, saying so, and counts it', () => {
    // Multi-byte characters, so a cut that ended inside one would show.
    const long = 'é'.repeat(5_000)
    archive('long', [SHORT, long, SHORT])
    const maxTextBytes = 4_001
    const pages: ConversationPage[] = []
    let cursor: ConversationCursor | null = null
    do {
      const page = readConversationPage(store, cursor, { budget: { maxBytes: 1 << 20, maxRows: 100, maxTextBytes } })
      pages.push(page)
      cursor = page.next
    } while (cursor !== null)

    const messages = pages.flatMap((page) => page.parts.flatMap((p) => p.messages))
    expect(messages.map((m) => m.text.length > SHORT.length)).toEqual([false, true, false])
    const cut = messages[1]?.text ?? ''
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(maxTextBytes)
    expect(cut).not.toContain('�')
    expect(cut.startsWith('é'.repeat(100))).toBe(true)
    expect(cut).toMatch(/\[Cut short when Helm copied it into the local host: the message held 0\.0 MiB, more than one batch carries\.\]$/)
    expect(pages.reduce((n, page) => n + page.cut, 0)).toBe(1)
    // What Helm keeps is untouched.
    expect(readArchivedConversation(store, 'long')?.messages[1]?.text).toBe(long)
  })

  it('keeps every page inside one protocol frame however long a message is', () => {
    archive('huge', ['x'.repeat(MAX_COPIED_TEXT_BYTES + 1024), SHORT])
    archive('next', [SHORT])
    const pages: ConversationPage[] = []
    let cursor: ConversationCursor | null = null
    do {
      const page = readConversationPage(store, cursor)
      pages.push(page)
      cursor = page.next
    } while (cursor !== null)

    const text = (page: ConversationPage): number =>
      page.parts.flatMap((p) => p.messages).reduce((n, m) => n + Buffer.byteLength(m.text, 'utf8'), 0)
    for (const page of pages) expect(text(page)).toBeLessThanOrEqual(MAX_COPIED_TEXT_BYTES)
    const messages = pages.flatMap((page) => page.parts.flatMap((p) => p.messages))
    expect(messages.map((m) => m.text.length > SHORT.length)).toEqual([true, false, false])
    expect(pages.reduce((n, page) => n + page.cut, 0)).toBe(1)
  })

  it('gives an evicted conversation as its row alone, with every figure it kept', () => {
    archive('old', [LONG, SHORT], 0)
    archive('new', [SHORT], 10_000)
    evictAllBut('new')

    const parts = readAll().flat()
    const old = parts.find((p) => p.conversation.sessionId === 'old')
    expect(old).toMatchObject({ part: 0, last: true, messages: [] })
    expect(old?.conversation).toMatchObject({ state: 'evicted', messageCount: 2, storedBytes: 0 })
    expect(old?.conversation.evictedAt).not.toBeNull()
    expect(readConversationKeys(store)).toEqual([
      { sessionId: 'new', state: 'archived' },
      { sessionId: 'old', state: 'evicted' }
    ])
  })

  it('reads only the conversations asked for', () => {
    archive('aaa', [SHORT])
    archive('bbb', [SHORT])
    archive('ccc', [SHORT])
    const parts = readAll({ only: new Set(['aaa', 'ccc']), budget: { maxBytes: 1 << 20, maxRows: 2 } })
    expect(parts.flat().map((p) => p.conversation.sessionId)).toEqual(['aaa', 'ccc'])
  })

  it('reads nothing from an empty archive', () => {
    expect(readConversationPage(store, null)).toEqual({ parts: [], next: null, cut: 0 })
    expect(readConversationKeys(store)).toEqual([])
  })
})

describe('reading the rest to copy', () => {
  it('pages usage by uuid, every row once', () => {
    const rows = usage(5)
    const seen: UsageRow[] = []
    let after: string | null = null
    let pages = 0
    do {
      const page = readUsagePage(store, after, 2)
      seen.push(...page.rows)
      after = page.next
      pages++
    } while (after !== null)
    expect(pages).toBe(3)
    expect(seen).toEqual([...rows].sort((a, b) => a.uuid.localeCompare(b.uuid)))
  })

  it('reads every session name', () => {
    renameHistorySession(store, 'SESSION-B', 'Second')
    renameHistorySession(store, 'session-a', 'First')
    expect(readSessionNames(store)).toEqual([
      { sessionId: 'session-a', name: 'First', renamedAt: expect.any(String) },
      { sessionId: 'session-b', name: 'Second', renamedAt: expect.any(String) }
    ])
  })

  it('pages config file versions by id with their content', () => {
    for (const content of ['{}', '{"a":1}', '# notes\n']) {
      insertConfigSnapshot(store, {
        scopePath: join(dir, 'project'),
        filePath: '.claude/settings.json',
        content,
        contentHash: sha(Buffer.from(content)),
        reason: 'edit'
      })
    }
    const first = readConfigSnapshotPage(store, null, { maxBytes: 1 << 20, maxRows: 2 })
    expect(first.rows.map((row) => row.content)).toEqual(['{}', '{"a":1}'])
    const second = readConfigSnapshotPage(store, first.next, { maxBytes: 1 << 20, maxRows: 2 })
    expect(second).toMatchObject({ next: null, rows: [{ content: '# notes\n', reason: 'edit' }] })
    expect(second.rows[0]).toMatchObject({
      scopePath: join(dir, 'project'),
      filePath: '.claude/settings.json'
    })
    // The byte budget ends a page too, after at least one row.
    expect(readConfigSnapshotPage(store, null, { maxBytes: 1, maxRows: 10 }).rows).toHaveLength(1)
  })

  it('leaves out a config file version too long for one batch, counts it and reads on past it', () => {
    for (const content of ['{}', 'x'.repeat(64), '# notes\n']) {
      insertConfigSnapshot(store, {
        scopePath: join(dir, 'project'),
        filePath: 'CLAUDE.md',
        content,
        contentHash: sha(Buffer.from(content)),
        reason: 'edit'
      })
    }
    const budget = { maxBytes: 1 << 20, maxRows: 1, maxTextBytes: 32 }
    const pages: Array<{ contents: string[]; skipped: number }> = []
    for (let after: number | null = null, first = true; first || after !== null; first = false) {
      const page = readConfigSnapshotPage(store, after, budget)
      pages.push({ contents: page.rows.map((row) => row.content), skipped: page.skipped })
      after = page.next
    }
    expect(pages).toEqual([
      { contents: ['{}'], skipped: 0 },
      { contents: [], skipped: 1 },
      { contents: ['# notes\n'], skipped: 0 }
    ])
  })

  it('reads empty tables as empty', () => {
    expect(readUsagePage(store, null)).toEqual({ rows: [], next: null })
    expect(readSessionNames(store)).toEqual([])
    expect(readConfigSnapshotPage(store, null)).toEqual({ rows: [], next: null, skipped: 0 })
    expect(countCopyableData(store)).toEqual({
      archivedConversations: 0,
      evictedConversations: 0,
      messages: 0,
      usageMessages: 0,
      sessionNames: 0,
      configSnapshots: 0
    })
  })

  it('counts each table for the log line', () => {
    archive('old', [LONG, SHORT], 0)
    archive('new', [SHORT, SHORT, SHORT], 10_000)
    evictAllBut('new')
    usage(4)
    renameHistorySession(store, 'new', 'Named')
    insertConfigSnapshot(store, {
      scopePath: dir,
      filePath: 'CLAUDE.md',
      content: '',
      contentHash: sha(Buffer.from('')),
      reason: 'create'
    })
    expect(countCopyableData(store)).toEqual({
      archivedConversations: 1,
      evictedConversations: 1,
      messages: 3,
      usageMessages: 4,
      sessionNames: 1,
      configSnapshots: 1
    })
  })
})

describe('a copy reading helm.db', () => {
  it('leaves the file exactly as it was', async () => {
    archive('kept', [SHORT, LONG, SHORT])
    archive('dropped', [LONG], -10_000)
    evictAllBut('kept')
    usage(3)
    renameHistorySession(store, 'kept', 'Kept')
    insertConfigSnapshot(store, {
      scopePath: dir,
      filePath: 'CLAUDE.md',
      content: '# rules\n',
      contentHash: sha(Buffer.from('# rules\n')),
      reason: 'edit'
    })
    // Closing the last connection folds the write-ahead log into the file, so
    // what is on disk is the whole database.
    store.close()
    const before = sha(await readFile(file))

    store = openStore({ file })
    const changes = (): number =>
      (store.raw.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const changedBefore = changes()
    countCopyableData(store)
    readConversationKeys(store)
    readAll({ budget: { maxBytes: 100, maxRows: 2 } })
    readUsagePage(store, null, 1)
    readSessionNames(store)
    readConfigSnapshotPage(store, null)
    expect(changes()).toBe(changedBefore)
    store.close()

    expect(sha(await readFile(file))).toBe(before)
    store = openStore({ file })
  })
})
