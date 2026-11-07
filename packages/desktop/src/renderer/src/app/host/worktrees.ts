import type { AgentWorktree, AgentWorktreeRemoval } from '@helm/core'
import type { HostConnection } from '../../../../shared/host/client'
import type { HostReach } from './history'
import type { HostAdapter } from './router'

/**
 * The agent worktrees of a project: the host lists the checkouts Floti made
 * under `<repo>/.floti/worktrees` for its agents and removes one with git on
 * request. The window asks over its own connection, in ipc.ts's shapes.
 *
 * The host's answers are kept as they are: a worktree git could not be asked
 * about stays `uncommitted: null`, never false, and a removal the host refused
 * is the answer with its sentence, not a thrown error. A host that cannot be
 * reached rejects with the link's sentence, never an empty list.
 */

export function createWorktreesAdapter(link: HostReach): HostAdapter {
  const host = (): Promise<HostConnection> => link.connection()

  return {
    requests: {
      'worktrees:list': async ({ project }): Promise<AgentWorktree[]> => {
        const listing = await (await host()).request('worktrees:list', { project })
        return listing.worktrees.map((worktree) => ({
          name: worktree.name,
          folder: worktree.folder,
          branch: worktree.branch,
          child:
            worktree.child === null
              ? null
              : { name: worktree.child.name, parent: worktree.child.parent, running: worktree.child.running },
          uncommitted: worktree.uncommitted
        }))
      },
      'worktrees:remove': async ({ project, folder }): Promise<AgentWorktreeRemoval> => {
        const removal = await (await host()).request('worktrees:remove', { project, folder })
        return { removed: removal.removed, refusal: removal.refusal }
      }
    }
  }
}
