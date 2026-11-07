import { bridgeFor, eachHostNotices } from './bridge'
import { createHostNotices } from './useNotices'

/**
 * The notices standing on every host the window reaches, over each host's own
 * bridge. Made once: it joins the hosts' stores and attaches to them when the
 * first view listens.
 */
export const hostNoticesSource = createHostNotices({
  each: eachHostNotices,
  dismiss: async (host, id) => {
    await bridgeFor(host).invoke('notices:dismiss', { id })
  },
  allowMore: (host, parentId) => bridgeFor(host).invoke('notices:allowMore', { parentId })
})
