import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Locates the `claude` CLI on this computer, for the local host Helm starts
 * (`hostSettingsFor`) and the spike page's self-test. The host checks the
 * version and the sign-in itself.
 */

/**
 * Where an install of `claude` lands, looked at before PATH.
 *
 * `~/.local/bin` is the native installer's on every OS. On macOS, Homebrew
 * puts it in `/opt/homebrew/bin` (Apple Silicon) or `/usr/local/bin` (Intel),
 * and an app opened from Finder or the Dock gets launchd's PATH, which has
 * neither - so they are named here rather than left to the PATH walk.
 */
export function installCandidates(platform: NodeJS.Platform = process.platform, home: string = homedir()): string[] {
  const local = join(home, '.local', 'bin')
  if (platform === 'win32') return [join(local, 'claude.exe'), join(local, 'claude.cmd'), join(local, 'claude')]
  const candidates = [join(local, 'claude')]
  if (platform === 'darwin') candidates.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude')
  return candidates
}

export function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * A path the user picked by hand, which wins over discovery.
 *
 * Module state, set once at startup from settings and again when the picker
 * writes a new one, rather than a parameter threaded through every caller:
 * the host's settings and the self-test want the same answer.
 */
let overridePath: string | null = null

export function setClaudeOverride(path: string | null): void {
  overridePath = path !== null && path.trim() !== '' && isExecutableFile(path) ? path : null
}

/**
 * PATH resolution, done here rather than left to a spawn, so a missing CLI is
 * a sentence rather than a process that fails to start.
 */
function searchPath(name: string): string | null {
  const path = process.env['PATH'] ?? process.env['Path']
  if (!path) return null

  const exts =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']

  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`)
      if (isExecutableFile(candidate)) return candidate
    }
  }
  return null
}

/** The `claude` entry point on this machine, or null if there is not one. */
export function findClaudeExecutable(): string | null {
  if (overridePath !== null) return overridePath
  for (const candidate of installCandidates()) {
    if (isExecutableFile(candidate)) return candidate
  }
  return searchPath('claude')
}
