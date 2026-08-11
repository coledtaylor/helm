import { useEffect, useState } from 'react'
import type { UpdateCheck } from '../../../shared/ipc'
import { helm } from './bridge'

/**
 * The result of the launch's update check, if it made one.
 *
 * Push-only, and there is deliberately no `invoke` here to go with it. The
 * check is the main process's decision - it owns the setting that gates it and
 * the timestamp that throttles it - and a window that could ask on its own
 * would be a second, unbounded way for the one request Helm makes to happen.
 *
 * Null means nothing has been heard, which covers three different situations
 * and is on purpose: the setting is off, the throttle has not elapsed, or
 * GitHub could not be reached. None of them is a fact about *this* Helm being
 * out of date, so none of them belongs on screen.
 */
export function useUpdate(): UpdateCheck | null {
  const [check, setCheck] = useState<UpdateCheck | null>(null)

  useEffect(() => {
    const off = helm.on('update:checked', (next) => {
      setCheck(next)
    })
    return off
  }, [])

  return check
}
