import type { RemoteHost, RemoteHostConnection, WslDistroList } from '@helm/core/types'
import { lastLineOf, type RunTransport } from './remote-install'
import { transportArgv, type TransportPrograms } from './remote-launcher'

/**
 * The WSL distros the add-a-host dialog offers (`remoteHosts:wslDistros`):
 * this PC's, from its own `wsl.exe --list --quiet`, and each connected
 * Windows host's, from `ssh -o BatchMode=yes <target> wsl.exe --list --quiet`,
 * that PC's own `wsl.exe` run by its `cmd`. Listing changes nothing on any
 * computer, and starts no distro: `--list` only reads WSL's registry of them.
 *
 * Only Windows has WSL, so this PC is listed only on Windows, and another PC
 * only when it is a connected host whose OS, as its floti said it, is
 * Windows. A PC with no distros, or no WSL, is listed with the line `wsl.exe`
 * (or ssh) wrote, read as UTF-16LE when it is, so the dialog shows why.
 */

export interface WslDistrosDeps {
  run: RunTransport
  /** This PC's `process.platform`. */
  platform: NodeJS.Platform
  /** The programs that run this PC's ssh (`ssh` when absent) and `wsl.exe`. */
  programs: TransportPrograms & { wsl: readonly string[] }
  /** The hosts this device added, and where each stands now. */
  hosts: () => readonly RemoteHost[]
  states: () => Readonly<Record<string, RemoteHostConnection | undefined>>
}

/** The distros one `--list --quiet` names: one a line, with nothing around them. */
export function parseWslList(text: string): string[] {
  return text
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\uFEFF/, '').trim())
    .filter((line) => line !== '')
}

/** A Windows host this device reaches with its own ssh: its OS, as its floti said it, names Windows. */
function windowsHostTarget(host: RemoteHost): string | null {
  if (host.transport.kind !== 'ssh') return null
  return host.system !== undefined && /^windows/i.test(host.system.os) ? host.transport.target : null
}

async function listOn(
  deps: WslDistrosDeps,
  argv: readonly string[],
  through: string | null,
  pcName: string
): Promise<WslDistroList> {
  // This PC's wsl.exe runs as written, which gives it WSL_UTF8=1 like every
  // wsl.exe Helm starts; `--quiet`, its last word, needs no quoting.
  const run = through === null ? await deps.run(argv, null, undefined, { asWritten: true }) : await deps.run(argv, null)
  const distros = run.code === 0 ? parseWslList(run.stdout) : []
  return {
    through,
    pcName,
    distros,
    said: distros.length > 0 ? null : lastLineOf(run)
  }
}

export async function listWslDistros(deps: WslDistrosDeps): Promise<WslDistroList[]> {
  const lists: Promise<WslDistroList>[] = []
  if (deps.platform === 'win32') {
    lists.push(listOn(deps, [...deps.programs.wsl, '--list', '--quiet'], null, 'this PC'))
  }
  const states = deps.states()
  for (const host of deps.hosts()) {
    const target = windowsHostTarget(host)
    if (target === null || states[host.id]?.state !== 'connected') continue
    const ssh = transportArgv({ kind: 'ssh', target }, deps.programs)
    lists.push(listOn(deps, [...ssh, 'wsl.exe --list --quiet'], target, host.name))
  }
  return Promise.all(lists)
}
