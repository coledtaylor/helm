/**
 * How long a client waits between tries to reach its host again after the
 * connection ended without a stop or a quit: the first wait, doubled after
 * each try that fails, never more than two minutes. Main's link and each
 * page's link wait the same way, so they give up on nothing and try no faster
 * than each other.
 */

/** The first wait, the same as a start waits between tries while another host still has the folders. */
export const RECONNECT_FIRST_MS = 250

/** The longest wait between two tries. */
export const RECONNECT_MOST_MS = 120_000

/** The wait after `wait`, once a try has failed. */
export function nextReconnectWait(wait: number): number {
  return Math.min(wait * 2, RECONNECT_MOST_MS)
}
