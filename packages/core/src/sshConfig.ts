/**
 * The Host names in the user's `~/.ssh/config`, for the add-a-host dialog's
 * pick list.
 *
 * Pure by construction and re-exported through `types.ts`. Main reads the
 * files (`main/host/ssh-config.ts`), through a reader given the folder; this
 * module only reads text it is handed. Two keywords are read and every other
 * line is passed over unread:
 *
 * - `Host`, whose names are listed, in the order first seen, each once. A name
 *   holding `*`, `?` or `!` is a pattern, not a host a person picks, and is
 *   left out.
 * - `Include`, whose files are read too, as ssh reads them: a path relative to
 *   the `~/.ssh` folder, `~` for the home folder, and glob patterns.
 *
 * Nothing in `~/.ssh` is ever written. ssh itself works out the address, user
 * and key when it connects; Helm keeps only the name it is given.
 */

/** What one config file names: its Host names and the files its Include lines name, as written. */
export interface SshConfigLines {
  hosts: string[]
  includes: string[]
}

/**
 * The words of an argument list as ssh splits it: blanks separate them, and a
 * double-quoted stretch is one word with its quotes removed.
 */
function sshWords(text: string): string[] {
  const words: string[] = []
  let word = ''
  let started = false
  let quoted = false
  for (const char of text) {
    if (char === '"') {
      quoted = !quoted
      started = true
    } else if (!quoted && /\s/.test(char)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      word += char
      started = true
    }
  }
  if (started) words.push(word)
  return words
}

/** Whether a Host name is a pattern rather than one host: it holds `*`, `?` or `!`. */
export function isSshHostPattern(name: string): boolean {
  return /[*?!]/.test(name)
}

/**
 * The Host names and Include paths in one config file's text. A keyword is
 * matched without regard to case, and is followed by blanks or by `=`
 * (`Host=build-box`). One Host line may name several hosts. Comments and
 * every other keyword are passed over.
 */
export function parseSshConfig(text: string): SshConfigLines {
  const hosts: string[] = []
  const includes: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/.exec(line)
    if (match === null) continue
    const keyword = (match[1] as string).toLowerCase()
    const rest = match[2] as string
    if (keyword === 'host') {
      for (const name of sshWords(rest)) if (!isSshHostPattern(name)) hosts.push(name)
    } else if (keyword === 'include') {
      includes.push(...sshWords(rest))
    }
  }
  return { hosts, includes }
}

/** Each name once, in the order first seen. */
export function firstSeen(names: Iterable<string>): string[] {
  return [...new Set(names)]
}

/**
 * The path an Include names, as ssh reads it: `~/` is the home folder, an
 * absolute path is itself, and anything else is relative to the user's
 * `~/.ssh` folder. Paths use `/`; main joins them for its OS.
 */
export function includePath(written: string, sshFolder: string, home: string): string {
  const slash = (path: string): string => path.replace(/\\/g, '/').replace(/\/+$/, '')
  if (written === '~') return slash(home)
  if (written.startsWith('~/')) return `${slash(home)}/${written.slice(2)}`
  if (written.startsWith('/') || /^[A-Za-z]:[\\/]/.test(written)) return slash(written)
  return `${slash(sshFolder)}/${written}`
}

/** Whether a path segment holds a glob pattern: `*`, `?` or `[`. */
export function isGlobSegment(segment: string): boolean {
  return /[*?[]/.test(segment)
}

/**
 * A matcher for one glob segment as glob(3) reads it: `*` any run of
 * characters, `?` one, `[...]` one of a set, with `!` or `^` first to negate
 * it. A name starting with `.` matches only a pattern that starts with `.`.
 */
export function globSegmentMatcher(pattern: string): (name: string) => boolean {
  let source = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string
    if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else if (char === '[') {
      const close = pattern.indexOf(']', i + 2)
      if (close === -1) {
        source += '\\['
        continue
      }
      let set = pattern.slice(i + 1, close)
      const negated = set.startsWith('!') || set.startsWith('^')
      if (negated) set = set.slice(1)
      source += `[${negated ? '^' : ''}${set.replace(/[\\\]]/g, '\\$&')}]`
      i = close
    } else source += char.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  const regex = new RegExp(`^${source}$`)
  return (name) => (name.startsWith('.') && !pattern.startsWith('.') ? false : regex.test(name))
}

/** How deep Include lines may nest, as ssh allows: a loop of includes ends here. */
export const SSH_INCLUDE_DEPTH = 16

/** What the pick list shows: each Host name, and whether a config was there to read at all. */
export interface SshConfigHosts {
  /** Whether `~/.ssh/config` exists. */
  found: boolean
  /** The Host names, without patterns, in the order first seen. */
  hosts: string[]
}
