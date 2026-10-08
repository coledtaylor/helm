import type { PluginSession } from '@coledtaylor/helm-plugin-sdk'
import type { LiveSession } from '../types'

/**
 * Helm's sessions as a plugin may see them (`helm.sessions.list`).
 *
 * The rule is the one `describe.ts` makes structural for the session tools,
 * and it is made structural the same way: **nothing of a session's
 * conversation reaches a plugin**, so the input has no field that could carry
 * it. No argv (a first message rides in it, and so does the `--mcp-config`
 * file holding the session's bearer token), no conversation id (the name of
 * its transcript), and no `waitingFor` - the CLI's sentence for a `waiting`
 * session names the command or file it is asking about, which is the
 * conversation in one line. The activity itself is a word from a fixed set and
 * says only that the session is waiting.
 */
export interface PluginSessionFacts {
  /** What plugins know the session by: the id its tool calls carry. Never Helm's row id. */
  id: string
  /** Helm's row id, to find the session among the registry's. Not handed on. */
  helmSessionId: number
  /** `sessionLabel`: what its tab is called. */
  name: string
  cwd: string
  running: boolean
  startedAtMs: number
  endedAtMs: number | null
}

/**
 * The plugin's list: Helm's facts, with what the registry says each running
 * session is doing. A session the registry has no record for yet, or whose
 * process could not be proved alive, is running with an activity of null:
 * "Helm cannot tell", never a guess.
 */
export function describePluginSessions(
  facts: readonly PluginSessionFacts[],
  live: readonly LiveSession[]
): PluginSession[] {
  const byRow = new Map<number, LiveSession>()
  for (const session of live) {
    if (session.helmSessionId !== null) byRow.set(session.helmSessionId, session)
  }
  return facts.map((fact) => {
    const seen = fact.running ? byRow.get(fact.helmSessionId) : undefined
    const activity = seen?.activity ?? null
    return {
      id: fact.id,
      name: fact.name,
      cwd: fact.cwd,
      state: fact.running ? 'running' : 'ended',
      activity,
      activitySince: activity === null ? null : (seen?.statusSinceMs ?? null),
      startedAt: fact.startedAtMs,
      endedAt: fact.running ? null : fact.endedAtMs
    }
  })
}
