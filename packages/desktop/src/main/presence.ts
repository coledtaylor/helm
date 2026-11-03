import type { PresenceAnswer } from '../shared/ipc'

/**
 * Asks this computer to confirm its user is present, for a host on another
 * computer that refused an admin action until it is (`devices:presence`).
 *
 * The check is the OS's, run by `floti presence [--window <handle>]
 * <reason>` (`crates/host/src/presence.rs`): Windows Hello on Windows, Touch
 * ID or the account password on macOS, and none on Linux. Its exit status is
 * the answer; nothing it prints is read. On Windows the window's handle is
 * passed so the prompt is the window's own.
 */

/** `floti presence`'s exit statuses (`PresenceExit` in presence.rs). */
export const PRESENCE_EXIT = {
  confirmed: 0,
  declined: 3,
  unavailable: 4
} as const

/** How a run of `floti presence` ended. */
export interface PresenceRun {
  /** Its exit status, or null when it could not be run or was ended by a signal. */
  code: number | null
}

export interface PresenceDeps {
  platform: NodeJS.Platform
  /** Where this build's `floti` is. */
  binary: () => string
  /** The window's native handle as the OS gives it, or null when there is no window. */
  windowHandle: () => Buffer | null
  /** Runs `binary` with `args` to its end, with no shell and no window of its own. */
  run: (binary: string, args: readonly string[]) => Promise<PresenceRun>
  log: (line: string) => void
}

export interface PresenceCheck {
  confirm(reason: string): Promise<PresenceAnswer>
}

/** An `HWND` from the buffer Electron gives, in decimal; null for anything else. */
export function windowsHandle(handle: Buffer | null): string | null {
  if (handle === null) return null
  if (handle.length >= 8) return handle.readBigUInt64LE(0).toString()
  if (handle.length >= 4) return String(handle.readUInt32LE(0))
  return null
}

/** `floti presence`'s arguments. */
export function presenceArgs(reason: string, window: string | null): string[] {
  return ['presence', ...(window === null ? [] : ['--window', window]), reason]
}

export function createPresenceCheck(deps: PresenceDeps): PresenceCheck {
  return {
    async confirm(reason) {
      const window = deps.platform === 'win32' ? windowsHandle(deps.windowHandle()) : null
      let ran: PresenceRun
      try {
        ran = await deps.run(deps.binary(), presenceArgs(reason, window))
      } catch (error) {
        deps.log(`presence: floti presence could not be run (${(error as Error).message})`)
        return 'unavailable'
      }
      if (ran.code === PRESENCE_EXIT.confirmed) return 'confirmed'
      if (ran.code === PRESENCE_EXIT.declined) return 'declined'
      if (ran.code !== PRESENCE_EXIT.unavailable) {
        deps.log(`presence: floti presence ended with status ${String(ran.code)}`)
      }
      return 'unavailable'
    }
  }
}
