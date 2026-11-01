import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  archiveTranscriptFile,
  indexUsageFile,
  insertConfigSnapshot,
  openStore,
  renameHistorySession,
  type Store
} from '@helm/core'
import { FakeConnection, fakeLink, reconnectingLink } from '../../../test/host-connection'
import type { OwnDataCopyState } from '../../shared/ipc'
import { HostConnectionEnded, HostRequestError } from './client'
import { createOwnDataCopy } from './own-data'
import type * as P from './protocol'

/** Every message's text says this, so a log line carrying any of it is caught. */
const PRIVATE = 'PRIVATE-WORDS'

let store: Store
let seq = 0
const uuid = (): string => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, '0')}`

/** A conversation archived in Helm's database, `count` messages long. */
function archive(sessionId: string, count: number): void {
  archiveTranscriptFile(store, {
    file: `/gone/${sessionId}.jsonl`,
    sessionId,
    tail: {
      rows: Array.from({ length: count }, (_, index) => ({
        uuid: uuid(),
        sessionId,
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        at: 1_760_000_000_000 + index,
        text: `${PRIVATE} ${sessionId} ${index}`
      })),
      bytes: 100,
      reset: false,
      skipped: 0,
      read: 100
    }
  })
}

/** Helm's database as the switch-off path left it: three conversations, names, usage and config versions. */
function fill(): void {
  archive('aaaa', 3)
  archive('bbbb', 5)
  archive('cccc', 2)
  renameHistorySession(store, 'aaaa', 'Release notes')
  renameHistorySession(store, 'bbbb', 'Billing')
  indexUsageFile(store, {
    file: '/gone/usage.jsonl',
    tail: {
      rows: Array.from({ length: 5 }, (_, index) => ({
        uuid: uuid(),
        at: 1_760_000_000_000 + index,
        model: 'claude-opus-4',
        input: 10,
        output: 20,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0
      })),
      bytes: 100,
      reset: false,
      skipped: 0
    }
  })
  for (const content of ['# one', '# two', '# three']) {
    insertConfigSnapshot(store, {
      scopePath: '/work/api',
      filePath: 'CLAUDE.md',
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      reason: 'edit'
    })
  }
}

/** The whole database, byte for byte. */
const image = (): string => createHash('sha256').update(store.raw.serialize()).digest('hex')

interface HostOptions {
  finishedAt?: string | null
  /** Conversations the host already holds, which it says it does not lack. */
  holds?: string[]
  /** Throws instead of answering the nth `carry:conversations` (from 1). */
  failConversations?: { at: number; error: () => Error }
}

/** The host's side of `carry:*`, keeping what it was sent. */
function host(options: HostOptions = {}) {
  const connection = new FakeConnection()
  const held = new Set(options.holds ?? [])
  let finishedAt = options.finishedAt ?? null
  let conversationBatches = 0
  connection.answer('carry:status', () => ({ finishedAt }))
  connection.answer('carry:missing', ({ sessionIds }) => ({ sessionIds: sessionIds.filter((id) => !held.has(id)) }))
  connection.answer('carry:names', ({ names }) => ({ added: names.length, kept: 0 }))
  connection.answer('carry:versions', ({ versions }) => ({ added: versions.length, kept: 0 }))
  connection.answer('carry:usage', ({ rows }) => ({ added: rows.length, kept: 0 }))
  connection.answer('carry:conversations', ({ parts }) => {
    conversationBatches++
    if (options.failConversations?.at === conversationBatches) throw options.failConversations.error()
    for (const part of parts) if (part.last) held.add(part.conversation.sessionId)
    return {
      added: parts.filter((part) => part.last).length,
      kept: 0,
      messages: parts.reduce((sum, part) => sum + part.messages.length, 0),
      evicted: 0
    }
  })
  connection.answer('carry:finish', () => {
    finishedAt ??= '2026-10-31T09:00:00.000Z'
    return { finishedAt }
  })
  return { connection, held }
}

function copier(link: Parameters<typeof createOwnDataCopy>[0]['link'], maxRows = 2) {
  const logged: string[] = []
  const states: OwnDataCopyState[] = []
  // Small batches, so a few rows already take several.
  const copy = createOwnDataCopy({ link, store, budget: { maxBytes: 1024 * 1024, maxRows }, log: (line) => logged.push(line) })
  copy.onChange((state) => states.push(state))
  return { copy, logged, states }
}

const channels = (connection: FakeConnection): string[] => connection.sent.map((request) => request.channel)

beforeEach(() => {
  store = openStore({ file: ':memory:' })
  fill()
})

afterEach(() => {
  store.close()
})

describe('copying Helm’s own data into the local host', () => {
  it('sends names, config versions, usage and the conversations the host lacks in batches, then finishes, logging only counts', async () => {
    const { connection } = host()
    const link = fakeLink(connection)
    const { copy, logged, states } = copier(link)

    await link.connect()
    await copy.settled()

    // Each answer awaited before the next batch is read and sent.
    expect(channels(connection)).toEqual([
      'carry:status',
      'carry:names',
      'carry:versions',
      'carry:versions',
      'carry:usage',
      'carry:usage',
      'carry:usage',
      'carry:missing',
      'carry:missing',
      ...Array<string>(connection.payloads('carry:conversations').length).fill('carry:conversations'),
      'carry:finish'
    ])
    expect(connection.payloads('carry:conversations').length).toBeGreaterThan(2)
    const parts = (connection.payloads('carry:conversations') as P.CarriedConversations[]).flatMap((batch) => batch.parts)
    expect(parts.filter((part) => part.last).map((part) => part.conversation.sessionId)).toEqual(['aaaa', 'bbbb', 'cccc'])
    expect(parts.flatMap((part) => part.messages).length).toBe(10)
    // The snapshot's own id stays Helm's.
    expect((connection.payloads('carry:versions') as P.CarriedConfigVersions[])[0]?.versions[0]).not.toHaveProperty('id')
    expect((connection.payloads('carry:names') as P.CarriedSessionNames[])[0]?.names.map((name) => name.name)).toEqual([
      'Release notes',
      'Billing'
    ])

    expect(states.map((state) => state.state)).toEqual(['copying', 'finished'])
    expect(copy.state()).toEqual({ state: 'finished' })
    expect(logged.at(-1)).toBe(
      "host: copied Helm's own data into the local host: 3 conversations (10 messages), 5 usage rows, 2 session names and 3 config versions"
    )
    expect(logged.join('\n')).not.toContain(PRIVATE)
  })

  it('sends only the conversations the host says it lacks', async () => {
    const { connection } = host({ holds: ['bbbb'] })
    const link = fakeLink(connection)
    const { copy } = copier(link, 100)

    await link.connect()
    await copy.settled()

    const parts = (connection.payloads('carry:conversations') as P.CarriedConversations[]).flatMap((batch) => batch.parts)
    expect([...new Set(parts.map((part) => part.conversation.sessionId))]).toEqual(['aaaa', 'cccc'])
  })

  it('copies nothing into a host that says the copy already finished', async () => {
    const { connection } = host({ finishedAt: '2026-10-30T09:00:00.000Z' })
    const link = fakeLink(connection)
    const { copy, logged } = copier(link)

    await link.connect()
    await copy.settled()

    expect(channels(connection)).toEqual(['carry:status'])
    expect(copy.state()).toEqual({ state: 'finished' })
    expect(logged).toEqual([])
  })

  it('stops when the connection ends part way, says what it copied, and copies again on the next connect without the notice', async () => {
    const first = host({ failConversations: { at: 2, error: () => new HostConnectionEnded('closed') } })
    const link = reconnectingLink(first.connection)
    const { copy, logged, states } = copier(link, 4)

    await link.connection()
    await copy.settled()

    expect(channels(first.connection)).not.toContain('carry:finish')
    expect(copy.state()).toEqual({
      state: 'unfinished',
      copied: { conversations: 1, messages: 3, usageRows: 5, sessionNames: 2, configVersions: 3 },
      reason: 'the connection to the local host ended'
    })
    expect(logged.at(-1)).toBe(
      "host: copying Helm's own data into the local host did not finish after 1 conversations (3 messages), 5 usage rows, " +
        '2 session names and 3 config versions (the connection to the local host ended)'
    )
    expect(logged.join('\n')).not.toContain(PRIVATE)

    // The host kept the whole conversation it was sent, and says so.
    const second = host({ holds: [...first.held] })
    await link.reconnect(second.connection)
    await copy.settled()

    expect(channels(second.connection).at(-1)).toBe('carry:finish')
    const parts = (second.connection.payloads('carry:conversations') as P.CarriedConversations[]).flatMap((batch) => batch.parts)
    expect(parts.some((part) => part.conversation.sessionId === 'aaaa')).toBe(false)
    expect(states.map((state) => state.state)).toEqual(['copying', 'unfinished', 'copying', 'finished'])
  })

  it('stops when the host refuses a batch, naming what it refused and never what the batch said', async () => {
    const { connection } = host({
      failConversations: { at: 1, error: () => new HostRequestError('carry:conversations', 'failed', `bad row ${PRIVATE}`) }
    })
    const link = fakeLink(connection)
    const { copy, logged } = copier(link)

    await link.connect()
    await copy.settled()

    expect(copy.state()).toMatchObject({ state: 'unfinished', reason: 'the local host refused a batch of conversations (failed)' })
    expect(logged.join('\n')).not.toContain(PRIVATE)
  })

  it('runs one copy at a time: a connect while one is running starts no second', async () => {
    const first = host()
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    // The first batch of names waits until the test lets it go.
    first.connection.answer('carry:names', (({ names }: P.CarriedSessionNames) =>
      held.then(() => ({ added: names.length, kept: 0 }))) as unknown as (
      payload: P.CarriedSessionNames
    ) => P.CarryMerged)
    const link = reconnectingLink(first.connection)
    const { copy } = copier(link)

    await link.connection()
    const second = host()
    await link.reconnect(second.connection)
    release()
    await copy.settled()

    expect(channels(second.connection)).toEqual([])
    expect(channels(first.connection).at(-1)).toBe('carry:finish')
  })

  it('leaves Helm’s database exactly as it was, whether the copy finished or stopped', async () => {
    const before = image()

    const stopped = host({ failConversations: { at: 1, error: () => new HostConnectionEnded('closed') } })
    const stoppedLink = fakeLink(stopped.connection)
    const a = copier(stoppedLink)
    await stoppedLink.connect()
    await a.copy.settled()
    expect(a.copy.state().state).toBe('unfinished')
    expect(image()).toBe(before)

    const finished = host()
    const finishedLink = fakeLink(finished.connection)
    const b = copier(finishedLink)
    await finishedLink.connect()
    await b.copy.settled()
    expect(b.copy.state().state).toBe('finished')
    expect(image()).toBe(before)
  })
})
