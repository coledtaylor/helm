import type { HelmErrorCode } from '@helm/plugin-sdk'

/**
 * A bridge call that failed for a reason the plugin should be told.
 *
 * Thrown anywhere under the dispatcher and turned into `{ ok: false, code,
 * message }` at the IPC boundary, because an invoke's rejection keeps only a
 * message - prefixed with Electron's own words - and a plugin needs the code to
 * tell "not declared" from "the network was down".
 */
export class PluginCallError extends Error {
  readonly code: HelmErrorCode

  constructor(code: HelmErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'PluginCallError'
  }
}

/** The answer to a bridge call, as it crosses IPC. */
export type CallOutcome = { ok: true; value: unknown } | { ok: false; code: HelmErrorCode; message: string }

/** Anything thrown under a call, as the outcome the page gets. A fault that is Helm's own is said as one. */
export function failure(error: unknown): CallOutcome {
  if (error instanceof PluginCallError) return { ok: false, code: error.code, message: error.message }
  if (error instanceof Error && error.name === 'AbortError') return { ok: false, code: 'aborted', message: 'the call was cancelled' }
  console.error('[plugins] a bridge call failed inside Helm:', error)
  return { ok: false, code: 'unavailable', message: `Helm could not complete the call: ${error instanceof Error ? error.message : String(error)}` }
}
