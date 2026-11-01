import {
  DEFAULT_COPY_BUDGET,
  countCopyableData,
  readConfigSnapshotPage,
  readConversationKeys,
  readConversationPage,
  readSessionNames,
  readUsagePage,
  type ConversationCursor,
  type CopyBudget,
  type Store
} from '@helm/core'
import type { OwnDataCopied, OwnDataCopyState } from '../../shared/ipc'
import { HostConnectionEnded, HostRequestError, type HostConnection } from './client'
import type { HostLink } from './link'

/**
 * What only Helm's own database holds, copied into the local host the first
 * time Helm reaches it with sessions running there: archived conversations
 * whose transcripts Claude Code has since deleted, their usage, the names
 * given to sessions in History and the config console's file versions. The
 * host rebuilds everything else from disk.
 *
 * Main reads `helm.db` through core's read-only pages and sends each one on
 * the protocol's `carry:*` channels, awaiting every answer, so neither main
 * nor the window is held and the host answers its other requests between
 * batches. The host merges each batch so what it already holds wins, and
 * records that the copy finished in its own database (`carry:finish`); main
 * asks `carry:status` first and copies nothing once it says so. Nothing here
 * writes `helm.db` and no marker is kept on Helm's side, so a host set up
 * before this existed still gets the copy, once.
 *
 * A copy that stops part way, because the connection ended or the host
 * refused a batch, leaves the host's marker unset: the next connect, or the
 * next start, sends everything again, and the host's merge adds only what it
 * lacks. Its state is kept here for the window's notice.
 *
 * No row can stop every copy: core cuts a message too long for one frame and
 * leaves out a config version too long for one, and the log counts both.
 *
 * What is sent is the user's own conversation text: the log says how many
 * rows of each kind were copied, and why a copy stopped, never what any of it
 * said.
 */

export interface OwnDataCopyDeps {
  link: HostLink
  /** Helm's own database, only ever read. */
  store: Store
  /** How much one batch carries; core's default unless a test needs smaller. */
  budget?: CopyBudget
  log: (line: string) => void
}

export interface OwnDataCopy {
  state(): OwnDataCopyState
  /** Called with each new state; returns the unsubscribe. */
  onChange(listener: (state: OwnDataCopyState) => void): () => void
  /** Settles once the copy in flight, if any, has stopped. */
  settled(): Promise<void>
}

const NOTHING_COPIED: OwnDataCopied = {
  conversations: 0,
  messages: 0,
  usageRows: 0,
  sessionNames: 0,
  configVersions: 0
}

/** Why a copy stopped, in words that never carry what was sent. */
function stoppedBecause(error: unknown, what: string): string {
  if (error instanceof HostConnectionEnded) return 'the connection to the local host ended'
  if (error instanceof HostRequestError) return `the local host refused ${what} (${error.code})`
  // Anything else is Helm's own: reading its database, which names no row.
  return error instanceof Error ? error.message : String(error)
}

const tally = (copied: OwnDataCopied): string =>
  `${copied.conversations} conversations (${copied.messages} messages), ${copied.usageRows} usage rows, ` +
  `${copied.sessionNames} session names and ${copied.configVersions} config versions`

export function createOwnDataCopy(deps: OwnDataCopyDeps): OwnDataCopy {
  const { store, log } = deps
  const budget = deps.budget ?? DEFAULT_COPY_BUDGET
  const listeners = new Set<(state: OwnDataCopyState) => void>()
  let current: OwnDataCopyState = { state: 'idle' }
  let running: Promise<void> | null = null

  const set = (next: OwnDataCopyState): void => {
    current = next
    for (const listener of listeners) listener(next)
  }

  /** `items` in slices of at most `size`. */
  const slices = <T>(items: readonly T[], size: number): T[][] => {
    const out: T[][] = []
    for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size))
    return out
  }

  const copy = async (connection: HostConnection): Promise<void> => {
    if ((await connection.request('carry:status', null)).finishedAt !== null) {
      set({ state: 'finished' })
      return
    }

    set({ state: 'copying' })
    const counts = countCopyableData(store)
    log(
      `host: copying Helm's own data into the local host: ${counts.archivedConversations + counts.evictedConversations} ` +
        `conversations (${counts.messages} messages), ${counts.usageMessages} usage rows, ` +
        `${counts.sessionNames} session names and ${counts.configSnapshots} config versions to offer`
    )
    const copied: OwnDataCopied = { ...NOTHING_COPIED }
    // Rows too long for one frame (core's `MAX_COPIED_TEXT_BYTES`): messages
    // sent cut short and config versions left in Helm's database.
    const tooLong = { cut: 0, skipped: 0 }
    const tooLongSaid = (): string =>
      (tooLong.cut > 0 ? `; ${tooLong.cut} messages too long for one batch were sent cut short` : '') +
      (tooLong.skipped > 0 ? `; ${tooLong.skipped} config versions too long for one batch were left out` : '')
    // What the batch in flight carries, for the sentence if it is refused.
    let what = 'the copy'
    try {
      what = 'a batch of session names'
      for (const names of slices(readSessionNames(store), budget.maxRows)) {
        copied.sessionNames += (await connection.request('carry:names', { names })).added
      }

      what = 'a batch of config versions'
      for (let after: number | null = null, first = true; first || after !== null; first = false) {
        const page = readConfigSnapshotPage(store, after, budget)
        tooLong.skipped += page.skipped
        if (page.rows.length > 0) {
          const versions = page.rows.map(({ id: _id, ...version }) => version)
          copied.configVersions += (await connection.request('carry:versions', { versions })).added
        }
        after = page.next
      }

      what = 'a batch of usage rows'
      for (let after: string | null = null, first = true; first || after !== null; first = false) {
        const page = readUsagePage(store, after, budget.maxRows)
        if (page.rows.length > 0) {
          copied.usageRows += (await connection.request('carry:usage', { rows: page.rows })).added
        }
        after = page.next
      }

      what = 'the list of conversations it lacks'
      const missing = new Set<string>()
      const ids = readConversationKeys(store).map((key) => key.sessionId)
      for (const sessionIds of slices(ids, budget.maxRows)) {
        const lacked = await connection.request('carry:missing', { sessionIds })
        for (const id of lacked.sessionIds) missing.add(id.toLowerCase())
      }

      what = 'a batch of conversations'
      if (missing.size > 0) {
        let cursor: ConversationCursor | null = null
        do {
          const page = readConversationPage(store, cursor, { budget, only: missing })
          if (page.parts.length > 0) {
            const merged = await connection.request('carry:conversations', { parts: page.parts })
            copied.conversations += merged.added
            copied.messages += merged.messages
            tooLong.cut += page.cut
          }
          cursor = page.next
        } while (cursor !== null)
      }

      what = 'the copy’s end'
      await connection.request('carry:finish', null)
    } catch (error) {
      const reason = stoppedBecause(error, what)
      // Not recorded as finished, so the next connect sends it all again
      // and the host adds only what it lacks.
      log(
        `host: copying Helm's own data into the local host did not finish after ${tally(copied)}${tooLongSaid()} (${reason})`
      )
      set({ state: 'unfinished', copied, reason })
      return
    }
    log(`host: copied Helm's own data into the local host: ${tally(copied)}${tooLongSaid()}`)
    set({ state: 'finished' })
  }

  deps.link.onConnected((connection) => {
    // One copy at a time; a connect while one runs leaves it to finish or
    // fail, and the connect after that tries again.
    if (running !== null) return
    // Not awaited: the link resolves `connection()` once its listeners have,
    // and nothing else should wait on a copy.
    running = copy(connection)
      .catch((error: unknown) => {
        // `carry:status` itself failed; nothing was sent.
        const reason = stoppedBecause(error, 'the question whether it was copied')
        log(`host: could not ask the local host whether Helm's own data was copied into it (${reason})`)
        set({ state: 'unfinished', copied: { ...NOTHING_COPIED }, reason })
      })
      .finally(() => {
        running = null
      })
  })

  return {
    state: () => current,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    settled: () => running ?? Promise.resolve()
  }
}
