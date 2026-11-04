import type { Project } from '../types'

/**
 * A project as the host's discovery cache gives it to the launcher, which
 * paints from it before a scan finishes.
 */
export interface CachedProject extends Project {
  lastSeenAt: string
  /** The harness manifest's `template:`, for a harness row. Null otherwise. */
  template: string | null
}
