import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Locates the `claude` CLI and reads its version.
 *
 * SPEC 8 pins the response to flag drift: assert on the version at startup,
 * warn, do not block. A missing CLI is not fatal - the config console and the
 * content viewer work without it, and telling the user what is wrong beats a
 * failed launch later with no explanation.
 */

const CANDIDATES = [
  join(homedir(), '.local', 'bin', 'claude.exe'),
  join(homedir(), '.local', 'bin', 'claude')
]

export function findClaudeExecutable(): string | null {
  for (const candidate of CANDIDATES) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  // Fall back to PATH resolution by the shell that spawns it.
  return null
}

export async function readClaudeVersion(): Promise<string | null> {
  const exe = findClaudeExecutable() ?? (process.platform === 'win32' ? 'claude.exe' : 'claude')
  try {
    const { stdout } = await run(exe, ['--version'], { timeout: 15_000, windowsHide: true })
    return stdout.trim() || null
  } catch {
    return null
  }
}
