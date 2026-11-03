/**
 * The agents on a host being added, as the add-a-host dialog lists them.
 *
 * Pure by construction and re-exported through `types.ts`. Each agent is
 * judged on that computer by the host, with the agent's own check: its
 * version command for whether it is installed, and for its sign-in, its own
 * status command where it has one or its sign-in artefacts existing where it
 * does not (`crates/host/src/agent`). No credential's contents are read, sent
 * or shown: what arrives here is the host's `setup:status` answer, and this
 * module only words it.
 *
 * A missing agent or sign-in names the command to run there, from the table
 * below, keyed by the backend's id.
 */

import type { FlotiOs } from './hostInstall'

/** What `setup:status` says of one backend: the fields the dialog reads (`BackendStatus` in floti-protocol). */
export interface AgentStatus {
  installed: boolean
  version: string | null
  semver: string | null
  signedIn: { state: 'known'; value: boolean } | { state: 'unknown' }
  /** Which signal decided `signedIn`. */
  signInSignal: string
  error: string | null
}

/** The commands that put an agent right on a host's computer, run there by the user. */
export interface AgentFix {
  /** What every surface calls the agent. */
  name: string
  /** The program its version line is named after: `claude 2.1.241`. */
  command: string
  /** The line that installs it, by the OS of the computer it goes on. */
  install: { posix: string; windows: string }
  /** The command that signs it in. */
  login: string
}

/** Each backend Helm knows, by its id (`CLAUDE_CODE_BACKEND` in the desktop). */
export const AGENT_FIXES: Readonly<Record<string, AgentFix>> = {
  'claude-code': {
    name: 'Claude Code',
    command: 'claude',
    install: {
      posix: 'curl -fsSL https://claude.ai/install.sh | bash',
      windows: 'irm https://claude.ai/install.ps1 | iex'
    },
    login: 'claude'
  }
}

/** One agent's row on the added screen. */
export interface AgentRow {
  id: string
  name: string
  /** `claude 2.1.241`, or null when it is not installed. */
  version: string | null
  installed: boolean
  signIn: 'signedIn' | 'notSignedIn' | 'unknown'
  /** What to do there, or null when nothing is needed. */
  fix: string | null
}

/**
 * The rows for each backend a host answered for, in the order it listed them.
 * `os` is that computer's, for the install line; null when it is not known,
 * which names the POSIX line.
 */
export function describeAgents(backends: Readonly<Record<string, AgentStatus | undefined>>, os: FlotiOs | null): AgentRow[] {
  const rows: AgentRow[] = []
  for (const [id, status] of Object.entries(backends)) {
    if (status === undefined) continue
    const known = AGENT_FIXES[id]
    const name = known?.name ?? id
    if (!status.installed) {
      const line = known === undefined ? null : os === 'windows' ? known.install.windows : known.install.posix
      rows.push({
        id,
        name,
        version: null,
        installed: false,
        signIn: 'unknown',
        fix:
          line === null
            ? `${name} is not installed there.`
            : `Install it there with ${line}`
      })
      continue
    }
    const number = status.semver ?? status.version
    const version = number === null ? null : known === undefined ? number : `${known.command} ${number}`
    if (status.signedIn.state === 'unknown') {
      const why = status.error ?? status.signInSignal
      rows.push({ id, name, version, installed: true, signIn: 'unknown', fix: `Helm can’t tell whether it is signed in there: ${why}` })
    } else if (!status.signedIn.value) {
      const login = known?.login
      rows.push({
        id,
        name,
        version,
        installed: true,
        signIn: 'notSignedIn',
        fix:
          login === undefined
            ? `${name} is not signed in there.`
            : `Sign in by running ${login} there once, in a terminal. Helm never handles its sign-in.`
      })
    } else {
      rows.push({ id, name, version, installed: true, signIn: 'signedIn', fix: null })
    }
  }
  return rows
}
