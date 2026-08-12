import { extname, join } from 'node:path'
import { homedir } from 'node:os'
import type { GhCommand } from '@helm/core'
import { isExecutableFile, searchPath } from './claude-cli'

/**
 * Locating the `gh` CLI, exactly the way `claude-cli.ts` locates Claude's.
 *
 * Same shape on purpose: a settings override wins over discovery, discovery
 * checks the places an installer puts it and then walks PATH, and a machine
 * without one is warned about rather than blocked. Helm's other surfaces work
 * perfectly well with no `gh` - only the pull-request pane does not, and it
 * says so in a sentence.
 *
 * And the same hard rule: this module locates an executable and never touches a
 * credential. `gh` owns the GitHub token, `gh auth login` is the whole remedy
 * for not having one, and nothing here opens `hosts.yml` or the keyring behind
 * it.
 */

const WINDOWS_CANDIDATES = [
  // The MSI and the winget package.
  join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'GitHub CLI', 'gh.exe'),
  join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'GitHub CLI',
    'gh.exe'
  ),
  // A per-user MSI install.
  join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), 'Programs', 'GitHub CLI', 'gh.exe'),
  // scoop, which leaves a shim rather than the binary.
  join(homedir(), 'scoop', 'shims', 'gh.exe')
]

const UNIX_CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']

const INSTALL_CANDIDATES = process.platform === 'win32' ? WINDOWS_CANDIDATES : UNIX_CANDIDATES

/**
 * A path the user picked by hand, which wins over discovery.
 *
 * Module state for the reason `claudeOverride` is: every caller wants the same
 * answer, and an override some code paths honoured and others did not would be
 * a machine where the list fetches and the auth check does not.
 */
let overridePath: string | null = null

export function setGhOverride(path: string | null): void {
  overridePath = path !== null && path.trim() !== '' && isExecutableFile(path) ? path : null
}

export function ghOverride(): string | null {
  return overridePath
}

/** The `gh` entry point on this machine, or null if there is not one. */
export function findGhExecutable(): string | null {
  if (overridePath !== null) return overridePath
  for (const candidate of INSTALL_CANDIDATES) {
    if (isExecutableFile(candidate)) return candidate
  }
  return searchPath('gh')
}

/**
 * How to run `gh`, or null when there is nothing to run.
 *
 * The `.cmd` case is not hypothetical: scoop and npm both install gh as a batch
 * shim on Windows, and `CreateProcess` cannot execute one - so it goes through
 * `cmd.exe /c`, the same arrangement `resolveClaudeCommand` makes.
 */
export function resolveGhCommand(at?: string): GhCommand | null {
  const resolved = at !== undefined ? (isExecutableFile(at) ? at : null) : findGhExecutable()
  if (!resolved) return null

  const ext = extname(resolved).toLowerCase()
  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    return { file: process.env['COMSPEC'] ?? 'cmd.exe', prefixArgs: ['/c', resolved], resolved }
  }
  return { file: resolved, prefixArgs: [], resolved }
}

/** The sentence a machine with no `gh` gets. Names the remedy, not the failure. */
export const GH_MISSING_SENTENCE =
  'GitHub CLI is not installed. Get it from https://cli.github.com, or point Helm at it in Settings.'

/** The sentence an unauthenticated `gh` gets. The remedy is the user’s to run. */
export const GH_UNAUTHENTICATED_SENTENCE =
  'GitHub CLI is not signed in. Run `gh auth login` in a terminal - Helm never handles a GitHub credential.'

/**
 * The sentence for a machine that cannot reach GitHub.
 *
 * Names no remedy on purpose, and above all not `gh auth login`. This branch is
 * reached when the connection failed, which `gh auth status` reports by
 * announcing that the token is invalid - so the one instruction a user is
 * likely to be given here is the one that would have them replace a credential
 * that works. Helm says what it saw and waits; the next sweep recovers on its
 * own when the network does.
 */
export const GH_OFFLINE_SENTENCE =
  'GitHub could not be reached, so Helm is showing what it fetched last. Your sign-in is fine - this is the connection, and Helm will try again on the next sweep.'
