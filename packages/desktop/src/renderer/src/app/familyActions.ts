import { bridgeFor } from './bridge'

/**
 * Stop on a child's card: the window asks first, as it does before any running
 * session ends (`session:close` asks when it is not forced), and once the user
 * agrees the host ends the session. The window keeps the session where it was
 * ended so its card can say how (`keep`); its ended row follows on
 * `session:exit` and the card shrinks to a header reading "Stopped by you".
 *
 * Settles true when the child was ended and false when the user declined. A
 * request that cannot reach the host leaves the card running and settles
 * false: the window already says the host is gone, and Stop is there to be
 * pressed again.
 */
export function stopChild(host: string, id: number): Promise<boolean> {
  return bridgeFor(host)
    .invoke('session:close', { id, keep: true })
    .then((answer) => answer.closed)
    .catch(() => false)
}
