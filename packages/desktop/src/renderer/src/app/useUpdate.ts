import { useCallback, useEffect, useState } from 'react'
import type { UpdateCheck } from '../../../shared/ipc'
import { helm } from './bridge'

/**
 * What Helm knows about newer releases, and the one way to ask.
 *
 * This hook was push-only, and the comment here argued against ever giving it
 * an `invoke`: the check is the main process's decision - it owns the setting
 * that gates it and the timestamp that throttles it - and a window that could
 * ask on its own would be a second, unbounded way for the one request Helm
 * makes to happen.
 *
 * That is amended rather than deleted, because half of it was right. The
 * unbounded thing to fear is a *window* asking - on a render, a focus, a timer,
 * a mount. What `check` adds is not the window asking but a person asking, and
 * a person pressing a button is its own bound: it happens as often as somebody
 * chooses to press it and not once more. `checkForUpdate` is therefore
 * deliberately unthrottled, and `main/update.ts` says why at the code site.
 *
 * Nothing here may call `check` on its own. It is passed to a button and to
 * nothing else.
 *
 * Two results rather than one, because they answer different questions:
 *
 *   `answered` is the last check that actually completed. The status bar reads
 *   it, so a failed manual check cannot take down a link that a successful one
 *   put up - the newer release did not stop existing because the network went
 *   away.
 *
 *   `attempted` is the last check made, complete or not. The settings pane
 *   reads it, because "could not ask" is an outcome a person who just pressed
 *   Check now is owed.
 *
 * Both start null, which covers three situations on purpose: the setting is
 * off, the throttle has not elapsed, or nobody has asked. None of them is a
 * fact about *this* Helm being out of date, so none of them belongs on screen.
 */
export interface UpdateState {
  answered: UpdateCheck | null
  attempted: UpdateCheck | null
  /** A check the user asked for is in flight, so the button can say so. */
  checking: boolean
  check: () => void
}

export function useUpdate(): UpdateState {
  const [answered, setAnswered] = useState<UpdateCheck | null>(null)
  const [attempted, setAttempted] = useState<UpdateCheck | null>(null)
  const [checking, setChecking] = useState(false)

  const adopt = useCallback((next: UpdateCheck) => {
    setAttempted(next)
    if (next.error === null) setAnswered(next)
  }, [])

  useEffect(() => {
    const off = helm.on('update:checked', adopt)
    return off
  }, [adopt])

  const check = useCallback(() => {
    setChecking(true)
    void helm
      .invoke('update:check')
      .then(adopt)
      .finally(() => setChecking(false))
  }, [adopt])

  return { answered, attempted, checking, check }
}
