import {
  readArchivedConversation,
  readHistoryProjects,
  readHistoryPrompts,
  readHistorySessions,
  renameHistorySession,
  type ArchivedConversation,
  type ArchiveStats,
  type HistoryPage,
  type HistoryProject,
  type HistoryPrompt,
  type HistoryQuery,
  type HistorySession,
  type HistorySummary,
  type Store,
  type UsageSnapshot
} from '@helm/core'
import type { ArchiveService } from './archive'
import type { HistoryService } from './history'
import type { UsageService } from './usage'

/**
 * What the window reads of session history, the transcript archive and usage
 * from Helm's own index, archive and usage reader over `helm.db`
 * (`localHistoryReads`). The `history:*`, `archive:*` and `usage:read`
 * handlers answer through this and nothing else. When sessions run in the
 * local host, the window reads the host's over its own connection
 * (`renderer/src/app/host/history.ts`), and these handlers refuse
 * (`refusedHistoryReads`).
 *
 * Resuming is not here: it starts a session, so it is the session host's.
 */

type Answer<T> = T | Promise<T>

export interface HistoryReads {
  /** The index's totals as last counted. */
  summary(): Answer<HistorySummary>
  sessions(query: HistoryQuery): Answer<HistoryPage>
  prompts(sessionId: string): Answer<HistoryPrompt[]>
  projects(): Answer<HistoryProject[]>
  /** A pass now, and its totals. */
  refresh(): Answer<HistorySummary>
  /** Names a conversation by hand, or clears its name; null when there is no such conversation. */
  rename(sessionId: string, name: string | null): Answer<HistorySession | null>
  /** One archived conversation, or null for one never archived. */
  conversation(sessionId: string): Answer<ArchivedConversation | null>
  archiveStats(): Answer<ArchiveStats>
  /** Claude Code's plan-limit figures, as last read. */
  usage(): Answer<UsageSnapshot>
}

export interface LocalHistoryServices {
  history: HistoryService
  archive: ArchiveService
  usage: UsageService
}

/** What main answers a host feature asked of it over Electron IPC while sessions run in the local host. */
export const ASK_THE_HOST =
  'Sessions run in the local host, so Helm’s window reaches this over its own connection to the host, not through Helm’s main process.'

/** Reads that refuse, saying where the window reaches them: main builds no history of its own then. */
export function refusedHistoryReads(): HistoryReads {
  const refuse = (): Promise<never> => Promise.reject(new Error(ASK_THE_HOST))
  return {
    summary: refuse,
    sessions: refuse,
    prompts: refuse,
    projects: refuse,
    refresh: refuse,
    rename: refuse,
    conversation: refuse,
    archiveStats: refuse,
    usage: refuse
  }
}

/**
 * Helm's own: the index and the archive in `helm.db`, and the usage reader in
 * this process. Each service is read when it is asked, not when this is made.
 */
export function localHistoryReads(store: Store, services: LocalHistoryServices): HistoryReads {
  return {
    summary: () => services.history.summary(),
    sessions: (query) => readHistorySessions(store, query),
    prompts: (sessionId) => readHistoryPrompts(store, sessionId),
    projects: () => readHistoryProjects(store),
    refresh: () => services.history.refresh(),
    rename: (sessionId, name) => renameHistorySession(store, sessionId, name),
    conversation: (sessionId) => readArchivedConversation(store, sessionId),
    archiveStats: () => services.archive.stats(),
    // The last reading rather than a fresh read: the service keeps itself
    // current, and a status bar that hit the disk every time it repainted
    // would be the one surface in the app that does.
    usage: () => services.usage.snapshot()
  }
}
