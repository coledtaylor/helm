/**
 * The hosts this device reaches on other computers, as this device keeps them.
 *
 * Pure by construction and re-exported through `types.ts`: Settings > Hosts
 * checks what is typed into its add form in the window, and the settings
 * validator checks the stored list again on the main side. Nothing here
 * connects to anything; the links are the desktop's.
 *
 * A host is reached the way the user already reaches that computer: their own
 * `ssh` with the target exactly as typed, or a command of their choosing that
 * carries bytes. This device keeps the target or the command and nothing else
 * about how to get there: no key, password or passphrase, and no ssh option.
 */

/** The key `quitSessions` holds this PC's own host under; no remote host has it as its id. */
export const LOCAL_HOST_KEY = 'local'

/** How this device reaches a host on another computer. */
export type HostTransport =
  /** The user's own `ssh`, given `target` exactly as typed: `user@host`, or a Host from `~/.ssh/config`. */
  | { kind: 'ssh'; target: string }
  /**
   * A command that carries stdin and stdout unchanged, run without a shell.
   * `program` and `args` are the words of the line the user typed
   * (`splitCommandLine`); the line to run on the other side is added as one
   * last argument when it runs.
   */
  | { kind: 'command'; program: string; args: readonly string[] }

/** A host on another computer, as this device keeps it in the `hosts` setting. */
export interface RemoteHost {
  /** Minted when the host is added, and never `LOCAL_HOST_KEY`. `quitSessions` keys the host by it. */
  id: string
  /** What every surface calls the host. */
  name: string
  transport: HostTransport
  /**
   * The role this device is approved with while it pairs, in the same step,
   * through the host's own transport. Absent for a host added before a role
   * could be chosen, which is approved on the host by hand.
   */
  role?: PairingRole
}

/** The roles Settings > Hosts offers when adding a host: Admin by default. */
export type PairingRole = 'admin' | 'operator'

/** The roles a host pairs a device with. */
export type DeviceRoleName = 'viewer' | 'operator' | 'admin'

/** The role a new host is added with unless the user picks another. */
export const DEFAULT_PAIRING_ROLE: PairingRole = 'admin'

/**
 * Where this device stands with a remote host, as its link reports it. Absent
 * while nothing has been heard yet.
 *
 * - `connected`: the handshake held the host to its pinned key; `role` is
 *   what the host says this device is paired as.
 * - `retrying`: the link ended (the ssh or command process exited) and it is
 *   trying again by itself. Nothing on the host ended.
 * - `pairing`: this device is not paired with the host; `code` is the short
 *   code the host showed this device, approved there with
 *   `floti devices approve <code>`. `approvalFailed` is the last line the
 *   approval run through the host's transport wrote when it failed, unedited.
 * - `failed`: the transport could not reach the host; `lastLine` is the last
 *   line ssh or the command wrote, unedited.
 */
export type RemoteHostConnection =
  | { state: 'connected'; role?: DeviceRoleName }
  | { state: 'retrying' }
  | { state: 'pairing'; code: string; approvalFailed?: string }
  | { state: 'failed'; lastLine: string }

/** More hosts than anybody adds, and a ceiling on a value rewritten whole. */
export const REMOTE_HOSTS_MAX = 32
export const REMOTE_HOST_NAME_MAX = 64
/** The longest id: the same room `quitSessions` gives a host key. */
export const REMOTE_HOST_ID_MAX = 200
const SSH_TARGET_MAX = 255
const COMMAND_WORDS_MAX = 64
const COMMAND_WORD_MAX = 4096

/** What the window calls this PC's own host. A remote host may not take the name. */
export const LOCAL_HOST_LABEL = 'This PC'

/** The line a remote host runs on the other side. */
export const REMOTE_CONNECT_LINE = 'floti connect'

// ---------------------------------------------------------------------------
// A typed command line
// ---------------------------------------------------------------------------

export type SplitCommandLine = { ok: true; words: string[] } | { ok: false; error: string }

/**
 * The words of a typed command line, split the way a shell splits words and
 * nothing more: whitespace separates them, and a single- or double-quoted
 * stretch is part of the word it touches, spaces and all. Nothing is expanded:
 * no variables, globs, `~` or substitutions.
 *
 * A backslash is an ordinary character, so a Windows path such as
 * `C:\Windows\System32\wsl.exe` is typed as it is written. A quote is put into
 * a word by the other kind of quote around it (`'"'` or `"'"`).
 */
export function splitCommandLine(line: string): SplitCommandLine {
  const words: string[] = []
  let word = ''
  // Whether a word has started: `""` is an empty word, not none.
  let started = false
  let quote: '"' | "'" | null = null
  for (const char of line) {
    if (quote !== null) {
      if (char === quote) quote = null
      else word += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      word += char
      started = true
    }
  }
  if (quote !== null) return { ok: false, error: `A ${quote === '"' ? 'double' : 'single'} quote is not closed.` }
  if (started) words.push(word)
  if (words.length === 0) return { ok: false, error: 'Type the command that reaches the host.' }
  return { ok: true, words }
}

/** A command's words as one line `splitCommandLine` reads back to the same words. */
export function formatCommandLine(words: readonly string[]): string {
  return words.map(quoteWord).join(' ')
}

function quoteWord(word: string): string {
  if (word !== '' && !/[\s"']/.test(word)) return word
  if (!word.includes('"')) return `"${word}"`
  if (!word.includes("'")) return `'${word}'`
  // Both kinds: each double quote in single quotes, the rest in double quotes.
  return word
    .split('"')
    .map((part) => (part === '' ? '' : `"${part}"`))
    .join(`'"'`)
}

/** How a host is reached, as Settings and the status bar's tooltip say it: `ssh build-box`, or the command. */
export function describeTransport(transport: HostTransport): string {
  return transport.kind === 'ssh'
    ? `ssh ${transport.target}`
    : formatCommandLine([transport.program, ...transport.args])
}

/** What to do when a host's transport could not reach it, after the line it wrote. */
export function transportFix(transport: HostTransport): string {
  return transport.kind === 'ssh'
    ? `Sign in with ssh ${transport.target} in a terminal, then try again.`
    : `Run ${formatCommandLine([transport.program, ...transport.args])} in a terminal to see what it needs, then try again.`
}

// ---------------------------------------------------------------------------
// Checking a host
// ---------------------------------------------------------------------------

/**
 * Why an ssh target is not one this device will pass to `ssh`, or null.
 *
 * A target is one word, given to ssh as it was typed. One that starts with `-`
 * would be read by ssh as an option (`-oProxyCommand=...`), so it is refused
 * rather than passed: this device adds no ssh option, typed or not.
 */
export function sshTargetProblem(target: unknown): string | null {
  if (typeof target !== 'string' || target === '') return 'Type the ssh target, such as build-box or you@build-box.'
  if (target.length > SSH_TARGET_MAX) return `An ssh target is at most ${String(SSH_TARGET_MAX)} characters.`
  if (/[\s\p{Cc}]/u.test(target)) return 'An ssh target has no spaces in it.'
  if (target.startsWith('-')) return 'An ssh target cannot start with a dash: ssh would read it as an option.'
  return null
}

function commandProblem(program: unknown, args: unknown): string | null {
  if (typeof program !== 'string' || program === '') return 'expected the command’s program'
  if (!Array.isArray(args)) return `expected the command’s arguments, got ${describe(args)}`
  if (args.length + 1 > COMMAND_WORDS_MAX) return `expected at most ${String(COMMAND_WORDS_MAX)} words in the command`
  for (const word of [program, ...(args as unknown[])]) {
    if (typeof word !== 'string') return `expected each argument to be a string, got ${describe(word)}`
    if (word.length > COMMAND_WORD_MAX || word.includes('\0')) return 'expected a word a program can be given'
  }
  return null
}

function transportProblem(transport: unknown): string | null {
  if (typeof transport !== 'object' || transport === null || Array.isArray(transport)) {
    return `expected how the host is reached, got ${describe(transport)}`
  }
  const { kind } = transport as { kind?: unknown }
  if (kind === 'ssh') {
    const problem = sshTargetProblem((transport as { target?: unknown }).target)
    return problem === null ? null : `expected an ssh target: ${problem}`
  }
  if (kind === 'command') {
    const { program, args } = transport as { program?: unknown; args?: unknown }
    return commandProblem(program, args)
  }
  return `expected ssh or a command, got ${describe(kind)}`
}

function nameProblem(name: unknown): string | null {
  if (typeof name !== 'string' || name.trim() === '') return 'Give the host a name.'
  if (name !== name.trim()) return 'A host’s name has no spaces around it.'
  if (name.length > REMOTE_HOST_NAME_MAX) return `A host’s name is at most ${String(REMOTE_HOST_NAME_MAX)} characters.`
  if (name.toLowerCase() === LOCAL_HOST_LABEL.toLowerCase()) return `${LOCAL_HOST_LABEL} is this computer’s own host.`
  return null
}

/**
 * Why a stored host list is not one, or null when it is: at most
 * `REMOTE_HOSTS_MAX` hosts, each with an id that is not `LOCAL_HOST_KEY`, a
 * name, and an ssh target or a command; no two share an id or a name.
 */
export function remoteHostsProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return `expected a list of hosts, got ${describe(value)}`
  if (value.length > REMOTE_HOSTS_MAX) {
    return `expected at most ${String(REMOTE_HOSTS_MAX)} hosts, got ${String(value.length)}`
  }
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const host of value as unknown[]) {
    if (typeof host !== 'object' || host === null || Array.isArray(host)) return `expected a host, got ${describe(host)}`
    const { id, name, transport } = host as { id?: unknown; name?: unknown; transport?: unknown }
    if (typeof id !== 'string' || id.trim() === '' || id.length > REMOTE_HOST_ID_MAX) {
      return `expected a host id, got ${describe(id)}`
    }
    if (id === LOCAL_HOST_KEY) return `expected a remote host's id, got ${JSON.stringify(id)}, which is this PC's`
    if (ids.has(id)) return `expected each host once, got ${JSON.stringify(id)} twice`
    ids.add(id)
    const named = nameProblem(name)
    if (named !== null) return `expected a host name for ${JSON.stringify(id)}: ${named}`
    const key = (name as string).toLowerCase()
    if (names.has(key)) return `expected each host name once, got ${JSON.stringify(name)} twice`
    names.add(key)
    const reached = transportProblem(transport)
    if (reached !== null) return `${reached} for ${JSON.stringify(name)}`
    const { role } = host as { role?: unknown }
    if (role !== undefined && role !== 'admin' && role !== 'operator') {
      return `expected admin or operator as the role for ${JSON.stringify(name)}, got ${describe(role)}`
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Adding and removing one
// ---------------------------------------------------------------------------

/** What Settings > Hosts' add form holds: the name, and an ssh target or a command line. */
export interface RemoteHostDraft {
  name: string
  via: HostTransport['kind']
  /** The ssh target, read when `via` is `ssh`. */
  target: string
  /** The command line as typed, read when `via` is `command`. */
  command: string
  /** The role this device is approved with as it pairs. */
  role: PairingRole
}

export type RemoteHostFromDraft = { ok: true; host: RemoteHost } | { ok: false; error: string }

/**
 * The host a filled-in add form describes, given the id it will have, or the
 * sentence saying what to fix.
 *
 * A blank name takes the ssh target, which is what most people would type
 * there anyway. The target is the field's text without the spaces around it;
 * a command is split into its words (`splitCommandLine`).
 */
export function remoteHostFromDraft(
  draft: RemoteHostDraft,
  hosts: readonly RemoteHost[],
  id: string
): RemoteHostFromDraft {
  if (hosts.length >= REMOTE_HOSTS_MAX) return { ok: false, error: `This PC keeps at most ${String(REMOTE_HOSTS_MAX)} hosts.` }
  let transport: HostTransport
  if (draft.via === 'ssh') {
    const target = draft.target.trim()
    const problem = sshTargetProblem(target)
    if (problem !== null) return { ok: false, error: problem }
    transport = { kind: 'ssh', target }
  } else {
    const split = splitCommandLine(draft.command)
    if (!split.ok) return { ok: false, error: split.error }
    const [program, ...args] = split.words as [string, ...string[]]
    if (program === '') return { ok: false, error: 'Type the program the command runs first.' }
    const problem = commandProblem(program, args)
    if (problem !== null) return { ok: false, error: 'That command is longer than a host’s command can be.' }
    transport = { kind: 'command', program, args }
  }
  const typed = draft.name.trim()
  const name = typed === '' && transport.kind === 'ssh' ? transport.target : typed
  const named = nameProblem(name)
  if (named !== null) return { ok: false, error: named }
  if (hosts.some((host) => host.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: `There is already a host named ${name}.` }
  }
  if (id === LOCAL_HOST_KEY || hosts.some((host) => host.id === id)) {
    return { ok: false, error: 'That host id is taken.' }
  }
  return { ok: true, host: { id, name, transport, role: draft.role } }
}

/**
 * The settings patch that forgets a host on this device: out of the list, and
 * its quit choice with it. Nothing on the host is touched.
 */
export function withoutRemoteHost(
  settings: { hosts: readonly RemoteHost[]; quitSessions: Readonly<Record<string, 'end' | 'keep'>> },
  id: string
): { hosts: RemoteHost[]; quitSessions: Record<string, 'end' | 'keep'> } {
  const quitSessions = { ...settings.quitSessions }
  delete quitSessions[id]
  return { hosts: settings.hosts.filter((host) => host.id !== id), quitSessions }
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value === 'string' ? JSON.stringify(value) : typeof value
}
