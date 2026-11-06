import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentWorktree, AgentWorktreeRemoval, SessionRecord } from '@helm/core'
import { helm } from './bridge'
import { readable } from './errors'

/**
 * The agent worktrees of one project on this PC's host: the checkouts Floti
 * made for its agents, as the project page lists them.
 *
 * Read when the page opens, after a removal, and whenever `activity` changes,
 * which is how a session in the project starting or ending reaches it: a
 * worktree gains a child when one starts there and its state changes when the
 * child ends. A read that fails keeps the list as it was; an empty list is the
 * host saying there are none, and the two are never merged.
 */

export interface AgentWorktreesState {
  worktrees: readonly AgentWorktree[]
  /** Asks the host to remove one; the answer is the host's, a refusal included. */
  remove: (worktree: AgentWorktree) => Promise<AgentWorktreeRemoval>
}

export function useAgentWorktrees(project: string, activity: string): AgentWorktreesState {
  const [worktrees, setWorktrees] = useState<readonly AgentWorktree[]>([])
  // Only the newest read counts: one that was slow must not replace a later one,
  // and one for a project the page has left must not paint on the next.
  const latest = useRef(0)

  const read = useCallback((): Promise<void> => {
    const mine = ++latest.current
    return helm
      .invoke('worktrees:list', { project })
      .then((listed) => {
        if (mine === latest.current) setWorktrees(listed)
      })
      .catch(() => {
        // Could not look: keep what was shown rather than claim there are none.
      })
  }, [project])

  // One hook per project page (the page is keyed by its project), so a new
  // project is a new hook and `project` never changes under a list.
  useEffect(() => {
    void read()
    return () => {
      latest.current += 1
    }
  }, [read])

  const seen = useRef(activity)
  useEffect(() => {
    if (seen.current === activity) return
    seen.current = activity
    void read()
  }, [activity, read])

  const remove = useCallback(
    async (worktree: AgentWorktree): Promise<AgentWorktreeRemoval> => {
      let removal: AgentWorktreeRemoval
      try {
        removal = await helm.invoke('worktrees:remove', { project, folder: worktree.folder })
      } catch (err) {
        return { removed: false, refusal: readable(err) }
      }
      // Listed again either way: a refusal can mean the world moved (a child
      // started there), and the row should say what is true now.
      await read()
      return removal
    },
    [project, read]
  )

  return { worktrees, remove }
}

/**
 * What changes when a session in this project starts or ends: its id and
 * state, for every session whose working directory is the project or inside it
 * (an agent's worktree is under the repository), joined into one string a
 * hook can compare.
 */
export function sessionActivityIn(sessions: readonly SessionRecord[], project: string): string {
  const root = comparable(project)
  return sessions
    .filter((session) => {
      const cwd = comparable(session.cwd)
      return cwd === root || cwd.startsWith(`${root}/`)
    })
    .map((session) => `${String(session.id)}:${session.status}`)
    .join(',')
}

/** A path spelled one way: forward slashes, no trailing slash, and lower case where the drive letter says Windows. */
function comparable(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed
}
