import type { UsageSnapshot } from '@helm/core'
import type { HistoryReads } from '../history-reads'
import type { HostConnection, HostSubscription } from './client'
import type { HostLink } from './link'
import {
  historyPageFromHost,
  historyQueryForHost,
  historySessionFromHost,
  historySummaryFromHost,
  unreadableUsage,
  usageFromHost
} from './records'
import { CLAUDE_CODE_BACKEND, type Emit } from './sessions'

/**
 * Session history, the transcript archive and usage when sessions run in the
 * local host: the host indexes Claude Code's history, archives its transcripts
 * into its own database and reads its usage figures, and this is how the
 * window reads them (`HistoryReads`). Helm's main process runs none of it.
 *
 * On every connect it subscribes to the host's `history:changed`,
 * `archive:changed` and `usage:changed` and hands each state to the window,
 * converted, so a conversation that ends in the host, a transcript it
 * captures and a reading it takes reach the window without it asking.
 *
 * Every read goes through `link.connection()`, which joins the first connect
 * while it is in flight, so a window that asks before Helm has reached the
 * host gets the host's answer, never an empty one first. When the host cannot
 * be reached, a read says so with the link's sentence: history and the
 * archive reject with it, and usage answers a reading of nothing whose problem
 * is that sentence, which the status bar shows in its tooltip. Neither is
 * ever an empty list or a zero standing in for "could not look".
 */

export interface HostHistoryDeps {
  link: HostLink
  /** Sends an event to the window. */
  emit: Emit
  log: (line: string) => void
}

export interface HostHistory extends HistoryReads {
  shutdown(): void
}

export function createHostHistory({ link, emit, log }: HostHistoryDeps): HostHistory {
  let subscriptions: HostSubscription[] = []

  const host = (): Promise<HostConnection> => link.connection()
  const ended = (channel: string) => (error: Error) => log(`host: ${channel} ended (${error.message})`)

  link.onConnected((connection) => {
    for (const subscription of subscriptions) subscription.unsubscribe()
    const history = (summary: Parameters<typeof historySummaryFromHost>[0]): void =>
      emit('history:changed', historySummaryFromHost(summary))
    const usage = (readings: Parameters<typeof usageFromHost>[0]): void =>
      emit('usage:changed', usageFromHost(readings, CLAUDE_CODE_BACKEND))
    subscriptions = [
      connection.subscribe('history:changed', { snapshot: history, event: history, error: ended('history:changed') }),
      connection.subscribe('archive:changed', {
        snapshot: (stats) => emit('archive:changed', stats),
        event: (stats) => emit('archive:changed', stats),
        error: ended('archive:changed')
      }),
      connection.subscribe('usage:changed', { snapshot: usage, event: usage, error: ended('usage:changed') })
    ]
  })

  return {
    async summary() {
      return historySummaryFromHost(await (await host()).request('history:summary', null))
    },

    async sessions(query) {
      return historyPageFromHost(await (await host()).request('history:sessions', historyQueryForHost(query)))
    },

    async prompts(sessionId) {
      return (await host()).request('history:prompts', { sessionId })
    },

    async projects() {
      return (await host()).request('history:projects', null)
    },

    async refresh() {
      return historySummaryFromHost(await (await host()).request('history:refresh', null))
    },

    async rename(sessionId, name) {
      const renamed = await (await host()).request('history:rename', { sessionId, name })
      return renamed === null ? null : historySessionFromHost(renamed)
    },

    async conversation(sessionId) {
      return (await host()).request('archive:conversation', { sessionId })
    },

    async archiveStats() {
      return (await host()).request('archive:stats', null)
    },

    async usage(): Promise<UsageSnapshot> {
      try {
        return usageFromHost(await (await host()).request('usage:read', null), CLAUDE_CODE_BACKEND)
      } catch (error) {
        return unreadableUsage((error as Error).message)
      }
    },

    shutdown() {
      for (const subscription of subscriptions) subscription.unsubscribe()
      subscriptions = []
    }
  }
}
