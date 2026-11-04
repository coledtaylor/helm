import type { RemoteHost } from '@helm/core/types'
import type { HostConnection } from './client'

/**
 * Keeping a WSL distro running while its host has sessions.
 *
 * WSL stops a distro shortly after the last Windows process attached to it
 * through `wsl.exe` exits, and a process inside the distro does not keep it
 * running, so a WSL host's sessions would end once Helm's last bridge to it
 * did: every window closed, or Helm quit keeping its sessions. The Windows
 * host on the distro's PC holds the distro instead (`wsl:keepAwake`, one
 * `wsl.exe` per distro, let go once no session runs there), for as long as
 * that host runs, which is past Helm's exit.
 *
 * Main asks it: on this PC's own host link for a distro here, and on the link
 * of the connected host reached with the same ssh target for a distro
 * through a Windows PC. It asks as soon as the WSL host's `session:activity`
 * (whose list holds a row for each live session) shows a running session,
 * and again after either link connects anew, so the ask is in place before
 * any window closes. A link not connected is asked once it connects. An ask
 * for a distro already held starts nothing there, so asking again is safe.
 */

export interface WslKeepAwakeDeps {
  /** This PC's own host's connection now, or null while it is not connected. */
  local: () => HostConnection | null
  /** The connection now to the host this device reaches with `ssh <target>`, or null. */
  reachedWithSsh: (target: string) => HostConnection | null
  log: (line: string) => void
}

export interface WslKeepAwake {
  /**
   * What `host`'s `session:activity` said on `connection`: whether a session
   * runs there. Ignored for a host that is not a WSL distro.
   */
  activity(host: RemoteHost, connection: HostConnection, running: boolean): void
  /** This PC's own host link connected: each distro here with sessions is asked for again. */
  localConnected(): void
  /** `host`'s link connected: a distro through it, with sessions, is asked for again. */
  connected(host: RemoteHost): void
  /** `host` was removed: it is not asked for again. */
  forget(id: string): void
}

interface Running {
  host: RemoteHost & { transport: { kind: 'wsl' } }
  /** The WSL host's connection its running session was seen on. */
  seenOn: HostConnection
}

export function createWslKeepAwake(deps: WslKeepAwakeDeps): WslKeepAwake {
  const running = new Map<string, Running>()

  const ask = (entry: Running): void => {
    const { transport, floti, name } = entry.host
    const through = transport.through
    const windows = through === undefined ? deps.local() : deps.reachedWithSsh(through)
    // Asked once that link connects.
    if (windows === null) return
    windows
      .request('wsl:keepAwake', {
        distro: transport.distro,
        ...(floti !== undefined ? { floti } : {})
      })
      .catch((error: unknown) => {
        deps.log(`host: ${through ?? 'this PC'} was not asked to keep ${name} running (${(error as Error).message})`)
      })
  }

  return {
    activity(host, connection, isRunning) {
      if (host.transport.kind !== 'wsl') return
      if (!isRunning) {
        running.delete(host.id)
        return
      }
      const known = running.get(host.id)
      // Asked already for what this connection showed.
      if (known?.seenOn === connection) {
        known.host = host as Running['host']
        return
      }
      const entry: Running = {
        host: host as Running['host'],
        seenOn: connection
      }
      running.set(host.id, entry)
      ask(entry)
    },

    localConnected() {
      for (const entry of running.values()) if (entry.host.transport.through === undefined) ask(entry)
    },

    connected(host) {
      if (host.transport.kind !== 'ssh') return
      const target = host.transport.target
      for (const entry of running.values()) if (entry.host.transport.through === target) ask(entry)
    },

    forget(id) {
      running.delete(id)
    }
  }
}
