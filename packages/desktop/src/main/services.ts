import {
  cleanStaleShims,
  openStore,
  readSettings,
  reconcileRunningSessions,
  writeSettings,
  type AppSettings,
  type LostSession,
  type SavedPaneLayout,
  type Store
} from '@helm/core'
import { dbFile, shimRoot } from './paths'

/**
 * The main process's stateful bits, in one object rather than module-level
 * singletons: the spike modes never open a database, and a module that opened
 * one on import would create a file the fidelity harness has no use for.
 */

export interface Services {
  store: Store
  settings: AppSettings
  /**
   * What the previous run left behind when it stopped without shutting down -
   * a crash, or a kill from Task Manager: the sessions still claiming to be
   * running, reconciled to `lost` on the way in, and the panes as that run
   * last wrote them.
   *
   * Read together and before the window exists, because the window rewrites
   * `paneLayout` within a second of opening, without the sessions it can no
   * longer see - and that layout is the only record of where they were.
   */
  lost: { sessions: LostSession[]; layout: SavedPaneLayout | null }
  /**
   * Overlay shim directories left behind by the previous run. Counted for the
   * same reason lost sessions are: it is evidence of how the last run ended.
   */
  staleShims: number
}

export function createServices(): Services {
  const store = openStore({ file: dbFile })
  const settings = readSettings(store)
  return {
    store,
    settings,
    lost: { sessions: reconcileRunningSessions(store), layout: settings.paneLayout },
    /*
     * The shims no live process is holding.
     *
     * This used to sweep *every* shim, reasoning that at this point in startup
     * nothing is hosting a session and therefore nothing is reading a plugin
     * directory. That reasoning was wrong, and wrong in the way that matters:
     * it is a statement about this process, and the directory belongs to the
     * machine. A second Helm - the dev build beside the installed one, a
     * portable copy beside an install, two installs - starting while the first
     * has a live session unlinked that session's `--plugin-dir` out from under
     * it. The session kept running and silently lost its skills.
     *
     * So a shim now records the processes holding it and `cleanStaleShims`
     * asks the kernel about each one, removing only what it can positively
     * establish is dead. This is still the only place they are swept: doing it
     * per launch would churn directories a session in *this* app is reading.
     */
    staleShims: cleanStaleShims(shimRoot).length
  }
}

export function updateSettings(services: Services, patch: Partial<AppSettings>): AppSettings {
  services.settings = writeSettings(services.store, patch)
  return services.settings
}

/**
 * An install that predates the setup pane, brought up to date.
 *
 * It has roots and no stamp, which would read as "never set up" and answer
 * with a setup pane over a working launcher; the stamp goes to the local host
 * with the roots on its first connect (`host/workspace.ts`). Done here rather than
 * during the first scan because the window is created immediately afterwards:
 * a stamp written a second later would show that pane and then take it away.
 */
export function adoptExistingProfile(services: Services): boolean {
  if (services.settings.firstRunCompletedAt !== null) return false
  if (services.settings.scanRoots.length === 0) return false
  updateSettings(services, { firstRunCompletedAt: new Date().toISOString() })
  return true
}
