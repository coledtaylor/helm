import { holdRunRoot } from '../../../test/run-root'

/**
 * Playwright's global setup: the run's root (`test/run-root.ts`), in which
 * every world the end-to-end tests make lands, and the app's own temp folder
 * with them. Playwright runs it in its main process before any worker starts
 * and calls what it returns as the global teardown when the run ends, a
 * crashed worker's run included.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const { release } = await holdRunRoot()
  return release
}
