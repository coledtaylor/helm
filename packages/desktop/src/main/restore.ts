import {
  readHistorySession,
  savedGroups,
  readProfile,
  sessionLabel,
  type HistorySession,
  type LostSession,
  type RestorableSession,
  type RestoreOffer,
  type SavedPaneLayout,
  type Store
} from '@helm/core'
import type { SessionHost } from './sessions'
import type { RestoreSessionsRequest, RestoreSessionsResult } from '../shared/ipc'

/**
 * Putting back what a crash took.
 *
 * The record is already there by the time this runs: every session row is
 * written on spawn, a crash leaves them claiming to be running, and the next
 * start reconciles them to `lost` (`createServices`). The saved pane layout
 * names each one by row id. So the offer is a reading of two things the last
 * run wrote anyway - nothing here records anything while a session runs, apart
 * from the conversation a `/clear` moves it to (`noteConversation`).
 *
 * Offered once. Answered - with some sessions or with none - it is gone for
 * the rest of this run, and the next start finds those rows `lost` rather than
 * running, so it cannot come back either. Not reopening a session does not
 * lose it: its conversation is still in the history pane and the launcher.
 */
export interface RestoreService {
  /** What there is to reopen, or null when there is nothing or it was answered. */
  offer: () => RestoreOffer | null
  /**
   * Reopens the sessions asked for, one at a time, and answers the offer.
   * Asking for none is "not now".
   */
  restore: (req: RestoreSessionsRequest) => Promise<RestoreSessionsResult>
}

export interface RestoreDeps {
  lost: { sessions: readonly LostSession[]; layout: SavedPaneLayout | null }
  store: Store
  sessions: Pick<SessionHost, 'restore'>
  /**
   * Brings the history index up to date. Called once, before the first offer
   * is read: the index is what says a conversation can be reopened, and the
   * last prompts before a crash may not have reached it.
   */
  refreshHistory: () => void
  /**
   * The conversations a live process is in right now, anywhere on the machine,
   * from Claude Code's own registry.
   */
  liveConversations: () => ReadonlySet<string>
}

/**
 * Why a lost session cannot be reopened, or null when it can - the checks
 * `SessionHost.restore` makes again at the moment it runs, said here first so
 * the offer can show them before anybody presses anything.
 */
function blockedReason(lost: LostSession, history: HistorySession | null): string | null {
  if (lost.conversationId === null) return 'Helm never learned which conversation this was.'
  if (history === null) return 'Claude Code has no record of a conversation in it to reopen.'
  if (!history.projectExists) return `${history.project} is no longer on disk.`
  if (history.transcriptFile === null) return 'Claude Code has removed its transcript.'
  return null
}

/** Each saved session's place across the panes, in reading order. */
function tabOrder(layout: SavedPaneLayout | null): Map<number, number> {
  const order = new Map<number, number>()
  for (const group of savedGroups(layout)) {
    for (const pane of group.panes) if (pane.kind === 'session') order.set(pane.id, order.size)
  }
  return order
}

export function createRestoreService({
  lost,
  store,
  sessions,
  refreshHistory,
  liveConversations
}: RestoreDeps): RestoreService {
  let answered = false
  let refreshed = false
  const order = tabOrder(lost.layout)
  const ordered = [...lost.sessions].sort(
    (a, b) =>
      (order.get(a.record.id) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.record.id) ?? Number.MAX_SAFE_INTEGER) || a.record.id - b.record.id
  )

  function describe(entry: LostSession): RestorableSession {
    const { record } = entry
    const history = entry.conversationId === null ? null : readHistorySession(store, entry.conversationId)
    const profile = record.profileId === null ? null : readProfile(store, record.profileId)
    return {
      id: record.id,
      name: sessionLabel(record),
      cwd: record.cwd,
      branch: record.branch,
      profile: profile?.name ?? null,
      profileGone: record.profileId !== null && profile === null,
      lastAt: history?.lastAt ?? null,
      blocked: blockedReason(entry, history)
    }
  }

  function build(): RestoreOffer | null {
    if (answered || ordered.length === 0) return null
    if (!refreshed) {
      refreshed = true
      try {
        refreshHistory()
      } catch {
        // The index as it stands is still the best answer there is; a row it
        // cannot vouch for is offered as blocked, with the reason.
      }
    }
    /*
     * A conversation that is still running was not lost. Two ways that
     * happens: a second Helm on the same data directory, or the dev build,
     * whose database is a copy of the installed app's - running rows and all.
     * Reopening one would be a second process on one conversation, so it is
     * left alone and counted rather than listed.
     */
    const live = liveConversations()
    const offered: RestorableSession[] = []
    let elsewhere = 0
    for (const entry of ordered) {
      if (entry.conversationId !== null && live.has(entry.conversationId)) elsewhere += 1
      else offered.push(describe(entry))
    }
    return offered.length === 0 ? null : { sessions: offered, elsewhere, layout: lost.layout }
  }

  return {
    offer: build,

    async restore(req) {
      if (answered) throw new Error('The sessions from before Helm closed have already been answered for.')
      // Read again rather than trusted from when the window asked: a
      // conversation that started running somewhere since is not to be opened
      // a second time.
      const offer = build()
      answered = true
      const result: RestoreSessionsResult = { restored: [], failed: [] }
      if (offer === null) return result

      const offered = new Map(offer.sessions.map((session) => [session.id, session]))
      // One at a time: each launch uniques its name against the tabs already
      // open, and composes its own overlays.
      for (const pick of req.sessions) {
        const session = offered.get(pick.id)
        const entry = ordered.find((candidate) => candidate.record.id === pick.id)
        if (session === undefined || entry === undefined) {
          result.failed.push({
            id: pick.id,
            name: `Session ${String(pick.id)}`,
            reason: 'It was not one of the sessions offered.'
          })
          continue
        }
        if (session.blocked !== null) {
          result.failed.push({ id: pick.id, name: session.name, reason: session.blocked })
          continue
        }
        try {
          const launched = await sessions.restore(entry, { cols: pick.cols, rows: pick.rows })
          result.restored.push({ from: pick.id, launched })
        } catch (err) {
          result.failed.push({
            id: pick.id,
            name: session.name,
            reason: err instanceof Error ? err.message : String(err)
          })
        }
      }
      return result
    }
  }
}
