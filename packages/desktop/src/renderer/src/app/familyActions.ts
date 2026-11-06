import { bridgeFor } from './bridge'

/**
 * Stop on a child's card: the host ends the session, asking nothing, and the
 * window keeps the session where it was ended so its card can say how
 * (`session:close` with `keep`). Its ended row follows on `session:exit` and
 * the card shrinks to a header reading "Stopped".
 *
 * A request that cannot reach the host leaves the card running: the window
 * already says the host is gone, and Stop is there to be pressed again.
 */
export function stopChild(host: string, id: number): void {
  bridgeFor(host)
    .invoke('session:close', { id, force: true, keep: true })
    .catch(() => undefined)
}
