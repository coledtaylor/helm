import { statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  findClaudeExecutable,
  isExecutableFile,
  readClaudeVersion,
  resolveClaudeCommand
} from './claude-cli'
import type { ClaudeStatus, ClaudeAuth } from '../shared/ipc'

/**
 * What Helm needs to know about the machine before it can launch anything: is
 * the CLI here, is it a version this build has been tested against, and has the
 * user signed in.
 *
 * The last of those is answered by looking for *evidence that a login happened*
 * and never by reading a credential. `.credentials.json` is checked for
 * existence and size, and nothing in it is opened; `~/.claude.json` is read for
 * two booleans it keeps beside a hundred other things. Helm does not hold, move,
 * refresh or forward a token - when the answer is "not signed in" the whole of
 * the response is a sentence telling the user to run `claude` themselves.
 *
 * The version guard warns and does not block (SPEC 7): a newer CLI is far more
 * likely to work than not, and an app that refuses to start because a patch
 * release moved is an app that breaks on its own schedule rather than on the
 * CLI's.
 */

/**
 * The range this build has been exercised against.
 *
 * 2.1.225 is the version every measurement in SPEC, CLAUDE.md and the milestone
 * drivers was taken on. The floor is the minor series rather than that exact
 * build because nothing here depends on a patch, and the ceiling is the next
 * minor because that is where the flags Helm passes could plausibly move.
 */
export const CLAUDE_TESTED_RANGE = { min: '2.1.0', max: '2.2.0' } as const

/** `[major, minor, patch]`, or null if the text does not carry one. */
function parseSemver(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Whether `version` is in `[min, max)`. Unparseable is not "in range". */
export function withinTestedRange(version: string | null): boolean {
  const found = version === null ? null : parseSemver(version)
  const min = parseSemver(CLAUDE_TESTED_RANGE.min)
  const max = parseSemver(CLAUDE_TESTED_RANGE.max)
  if (!found || !min || !max) return false
  return compare(found, min) >= 0 && compare(found, max) < 0
}

function fileWithBytes(path: string): boolean {
  try {
    const info = statSync(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** `~/.claude`, or wherever the CLI has been pointed instead. */
export function claudeConfigDir(): string {
  const override = process.env['CLAUDE_CONFIG_DIR']
  return override && override.trim() !== '' ? override : join(homedir(), '.claude')
}

/**
 * Has this machine signed in.
 *
 * Three signals, in the order they are trusted, and none of them opens a
 * credential:
 *
 *   1. `ANTHROPIC_API_KEY` in the environment - the CLI will use it, so a
 *      session will start whatever else is or is not on disk.
 *   2. `<config dir>/.credentials.json` exists and is not empty. This is where
 *      Claude Code puts an OAuth login on Windows.
 *   3. `~/.claude.json` says onboarding finished and carries a user id. A
 *      login that lives somewhere this cannot see - a keychain, a credential
 *      helper - still leaves those behind.
 *
 * When the config directory is not there at all the answer is "no" without
 * reading anything. When it is there and none of the three fired, the answer is
 * "no" on Windows and "cannot tell" elsewhere, because on macOS and Linux the
 * credential legitimately lives in a store this has no business opening.
 */
export async function readAuth(
  configDir: string
): Promise<{ auth: ClaudeAuth; signal: string }> {
  if ((process.env['ANTHROPIC_API_KEY'] ?? '').trim() !== '') {
    return { auth: 'authenticated', signal: 'ANTHROPIC_API_KEY is set' }
  }
  if (!directoryExists(configDir)) {
    return { auth: 'unauthenticated', signal: `${configDir} does not exist` }
  }
  if (fileWithBytes(join(configDir, '.credentials.json'))) {
    return { auth: 'authenticated', signal: '.credentials.json is present' }
  }

  // Beside the directory, not inside it: the CLI keeps `.claude/` and
  // `.claude.json` as siblings, and moving the directory moves both.
  const settingsFile = join(dirname(configDir), '.claude.json')
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsFile, 'utf8'))
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      if (record['hasCompletedOnboarding'] === true && typeof record['userID'] === 'string') {
        return { auth: 'authenticated', signal: '.claude.json records a completed sign-in' }
      }
    }
  } catch {
    // Absent or unreadable is not an error here - it is one signal of three.
  }

  return process.platform === 'win32'
    ? { auth: 'unauthenticated', signal: 'no credentials found' }
    : { auth: 'unknown', signal: 'credentials may live outside the config directory' }
}

export interface SetupOptions {
  /** The picked path from settings, which wins over discovery. */
  claudePath?: string | null | undefined
  /** A different config directory. Only the check driver passes one. */
  configDir?: string | undefined
}

export async function readClaudeStatus(options: SetupOptions = {}): Promise<ClaudeStatus> {
  const configDir = options.configDir ?? claudeConfigDir()
  const picked = options.claudePath?.trim() ? options.claudePath.trim() : null

  let path: string | null = null
  let source: ClaudeStatus['source'] = null
  let error: string | null = null

  // A picked path that has since been moved or deleted is reported rather than
  // silently ignored: the user chose it, and discovery quietly taking over
  // would leave them looking at a version they did not select.
  if (picked !== null) {
    if (isExecutableFile(picked)) {
      path = picked
      source = 'setting'
    } else {
      error = `The chosen ${picked} is no longer there.`
    }
  }
  if (path === null) {
    path = findClaudeExecutable()
    if (path !== null) source = 'discovered'
  }

  let version: string | null = null
  if (path === null) {
    error ??= 'claude was not found on PATH or in the usual install directory.'
  } else {
    version = await readClaudeVersion(path)
    if (version === null) error ??= `${path} did not answer \`claude --version\`.`
  }

  const semverParts = version === null ? null : parseSemver(version)
  const { auth, signal } = await readAuth(configDir)

  return {
    path,
    source,
    version,
    semver: semverParts === null ? null : semverParts.join('.'),
    tested: withinTestedRange(version),
    testedRange: { min: CLAUDE_TESTED_RANGE.min, max: CLAUDE_TESTED_RANGE.max },
    configDir,
    configDirExists: directoryExists(configDir),
    auth,
    authSignal: signal,
    error
  }
}

/**
 * Whether a path the user picked is actually the CLI, asked of the file rather
 * than assumed from its name. A picker that accepted anything would turn a
 * mis-click into a pty that opens and immediately closes with no explanation.
 */
export async function verifyClaudeAt(path: string): Promise<{ ok: boolean; version: string | null; problem: string | null }> {
  try {
    if (!statSync(path).isFile()) return { ok: false, version: null, problem: 'That is not a file.' }
  } catch {
    return { ok: false, version: null, problem: 'That file could not be read.' }
  }
  const command = resolveClaudeCommand(path)
  if (!command) return { ok: false, version: null, problem: 'That file is not executable.' }
  const version = await readClaudeVersion(path)
  if (version === null) {
    return { ok: false, version: null, problem: 'That program did not answer `claude --version`.' }
  }
  return { ok: true, version, problem: null }
}
