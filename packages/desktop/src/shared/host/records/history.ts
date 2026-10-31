import type { HistoryPage, HistoryQuery, HistorySession, HistorySummary, UsageSnapshot } from '@helm/core'
import type * as P from '../protocol'

/**
 * The host's history, archive and usage records in the window's vocabulary.
 * Both main and a Helm page's own connection read them, so they live where
 * both builds reach.
 */

/** What the history index holds; "the record could be read" is no `error` at all. */
export function historySummaryFromHost(summary: P.HistorySummary): HistorySummary {
  return {
    sessions: summary.sessions,
    prompts: summary.prompts,
    projects: summary.projects,
    resumable: summary.resumable,
    latestAt: summary.latestAt,
    historyFile: summary.historyFile,
    indexedBytes: summary.indexedBytes,
    ...(summary.error === null ? {} : { error: summary.error })
  }
}

/**
 * A conversation in the host's index. Every one the window lists is Claude
 * Code's, so the backend is not carried; a listing with no search has no
 * `match` at all, as Helm's own index answers.
 */
export function historySessionFromHost(session: P.HistorySession): HistorySession {
  return {
    sessionId: session.sessionId,
    project: session.project,
    projectName: session.projectName,
    promptCount: session.promptCount,
    firstAt: session.firstAt,
    lastAt: session.lastAt,
    firstPrompt: session.firstPrompt,
    title: session.title,
    titleFallback: session.titleFallback,
    label: session.label,
    transcriptFile: session.transcriptFile,
    transcriptBytes: session.transcriptBytes,
    projectExists: session.projectExists,
    archive: session.archive,
    archivedMessages: session.archivedMessages,
    ...(session.match === null ? {} : { match: session.match })
  }
}

export function historyPageFromHost(page: P.HistoryPage): HistoryPage {
  return { sessions: page.sessions.map(historySessionFromHost), total: page.total, tookMs: page.tookMs }
}

/** The window's query, with every field it left out said as null. */
export function historyQueryForHost(query: HistoryQuery): P.HistoryQuery {
  return {
    search: query.search ?? null,
    scope: query.scope ?? null,
    project: query.project ?? null,
    resumableOnly: query.resumableOnly ?? null,
    limit: query.limit ?? null
  }
}

/**
 * The reading the status bar shows: `backend`'s, out of the host's one per
 * backend. A host with none for it has not read any, which is a reading that
 * paints nothing and says why, never a zero.
 */
export function usageFromHost(readings: readonly P.UsageSnapshot[], backend: string): UsageSnapshot {
  const reading = readings.find((candidate) => candidate.backend === backend)
  if (reading === undefined) {
    return unreadableUsage('The local host has no usage reading for Claude Code.')
  }
  return {
    file: reading.file,
    fetchedAtMs: reading.fetchedAtMs,
    limits: reading.limits,
    problem: reading.problem,
    spend: reading.spend
  }
}

/** A reading of nothing, with the sentence that says why. */
export function unreadableUsage(detail: string): UsageSnapshot {
  return { file: '', fetchedAtMs: null, limits: [], problem: { kind: 'unreadable', detail }, spend: null }
}
