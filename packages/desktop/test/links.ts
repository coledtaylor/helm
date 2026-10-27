import { spawnSync } from 'node:child_process'
import { rmdirSync, symlinkSync, unlinkSync } from 'node:fs'

/**
 * A link to a folder, of the kind overlays make: a junction on Windows, which
 * needs no elevation, and a symbolic link on macOS and Linux, where Node
 * ignores the `'junction'` type.
 */
export function linkFolder(link: string, target: string): void {
  symlinkSync(target, link, 'junction')
}

/** Removes a folder link without walking into it. */
export function unlinkFolder(link: string): void {
  try {
    unlinkSync(link)
  } catch {
    rmdirSync(link)
  }
}

/**
 * The 8.3 alias Windows keeps for an existing path, such as
 * `C:\Users\RUNNER~1` for a long user name - or null off Windows, and on a
 * volume that keeps no short names. A path can reach Helm spelled this way: a
 * GitHub Windows runner's TEMP is.
 */
export function shortPath(path: string): string | null {
  if (process.platform !== 'win32') return null
  const run = spawnSync(process.env['COMSPEC'] ?? 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`], {
    encoding: 'utf8',
    windowsHide: true,
    windowsVerbatimArguments: true
  })
  const short = run.status === 0 ? run.stdout.trim() : ''
  return short !== '' && short !== path ? short : null
}
