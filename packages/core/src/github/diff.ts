import type { PullDiff, PullDiffHunk, PullFileDiff } from './types'

/**
 * `gh pr diff`, turned into rows a pane can paint.
 *
 * Pure and host-free, like the rest of `github/`: this takes the text git
 * produced and returns structure, and the fetching, capping and caching of that
 * text all happen elsewhere. It is also the only thing that ever reads a patch -
 * the cache holds the raw text and this runs on every read, for the reason the
 * markdown pipeline is not cached either: a parse belongs to the version of the
 * code that made it, and a database full of last month's shapes is a migration
 * nobody wrote.
 *
 * The tolerance here is deliberate and one-directional. Anything unrecognised
 * between file headers is skipped rather than thrown on - `index`, mode changes,
 * similarity indices and whatever git adds next are all real lines in a real
 * diff, and a parser that rejected the file because of one of them would blank
 * a pull request over a header it did not need. What is *not* tolerated is
 * guessing at content: a file git described as binary carries no lines at all
 * rather than a plausible-looking empty patch.
 */

/**
 * How many lines of one file are kept.
 *
 * The whole view is structured-cloned to the renderer and then becomes DOM, so
 * the ceiling is about what a pane can paint rather than what a diff can
 * contain: a generated lockfile is fifty thousand lines nobody scrolls, and the
 * rows for it cost more than every other pane in the app put together. What is
 * dropped is **counted** and the file says so on its own header - a diff that
 * quietly stopped halfway would be a diff that reads as complete.
 */
export const MAX_FILE_LINES = 1200

export interface ParseDiffOptions {
  /** Lines kept per file. `Infinity` keeps all of them. */
  maxLinesPerFile?: number
  /** True when the text handed in was already cut short. */
  truncated?: boolean
}

/**
 * `@@ -12,7 +12,9 @@ function name()`.
 *
 * Exactly two `@`, which rules out a combined diff's `@@@` deliberately: those
 * carry one sign column per parent and a parser that read them as ordinary
 * hunks would paint every line shifted by a character. A merge diff therefore
 * arrives here as a file with no hunks, and the Files view says it has no patch
 * to show - which is true.
 */
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function parseUnifiedDiff(text: string, options: ParseDiffOptions = {}): PullDiff {
  const maxLines = options.maxLinesPerFile ?? MAX_FILE_LINES
  const files: PullFileDiff[] = []

  let file: PullFileDiff | null = null
  let hunk: PullDiffHunk | null = null
  let oldAt = 0
  let newAt = 0
  /** Lines kept for the current file, against `maxLines`. */
  let kept = 0

  const finish = (): void => {
    if (file !== null) files.push(file)
    file = null
    hunk = null
  }

  const rows = text.split('\n')
  // A patch ends with a newline, and a newline **terminates** the last line
  // rather than starting another one. Splitting leaves an empty string behind
  // for it, and the tolerant read below - an unsigned empty line inside a hunk
  // is a context line whose trailing space was eaten in transit - would take
  // that one seriously and hang a phantom blank row off the end of every file.
  if (rows[rows.length - 1] === '') rows.pop()

  for (const raw of rows) {
    // Written by git on CRLF checkouts; the payload's own line endings are
    // inside the content and are not this parser's to normalise.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw

    if (line.startsWith('diff --git ')) {
      finish()
      // Provisional: the real paths come off the `---`/`+++` pair below, which
      // git quotes unambiguously. This is the fallback for a header pair that
      // never arrives - a pure mode change or a binary file.
      const guess = pathsFromGitLine(line)
      file = {
        path: guess.b ?? guess.a ?? '',
        oldPath: null,
        status: 'modified',
        additions: 0,
        deletions: 0,
        hunks: [],
        binary: false,
        droppedLines: 0
      }
      hunk = null
      kept = 0
      continue
    }

    if (file === null) continue

    // Inside a hunk every content line carries a sign, so an unsigned line at
    // column 0 is git talking rather than somebody's code. That is what makes
    // the header checks below safe to run at any point in the file.
    if (hunk !== null && isContent(line)) {
      if (line.startsWith('\\')) continue // "\ No newline at end of file"
      const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'context'
      if (kind === 'add') file.additions += 1
      if (kind === 'del') file.deletions += 1

      if (kept >= maxLines) {
        file.droppedLines += 1
      } else {
        kept += 1
        hunk.lines.push({
          kind,
          oldLine: kind === 'add' ? null : oldAt,
          newLine: kind === 'del' ? null : newAt,
          // Empty rather than sliced when the line is bare: a context line whose
          // trailing space was eaten in transit is still a context line.
          text: line.length === 0 ? '' : line.slice(1)
        })
      }
      if (kind !== 'add') oldAt += 1
      if (kind !== 'del') newAt += 1
      continue
    }

    const bounds = HUNK.exec(line)
    if (bounds !== null) {
      oldAt = Number(bounds[1])
      newAt = Number(bounds[2])
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }

    if (line.startsWith('--- ')) {
      const path = headerPath(line.slice(4))
      if (path !== null) file.oldPath ??= path
      continue
    }
    if (line.startsWith('+++ ')) {
      const path = headerPath(line.slice(4))
      if (path !== null) file.path = path
      continue
    }

    if (line.startsWith('new file mode')) file.status = 'added'
    else if (line.startsWith('deleted file mode')) file.status = 'removed'
    else if (line.startsWith('rename from ')) {
      file.status = 'renamed'
      file.oldPath = unquote(line.slice('rename from '.length))
    } else if (line.startsWith('rename to ')) {
      file.status = 'renamed'
      file.path = unquote(line.slice('rename to '.length))
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      file.binary = true
    }
  }

  finish()

  for (const parsed of files) {
    // A delete has no `+++ b/...` to take a name from - `/dev/null` is not a
    // path - so it keeps the one it had. Read after the loop rather than
    // during it because the two headers arrive in the other order.
    if (parsed.path === '' && parsed.oldPath !== null) parsed.path = parsed.oldPath
    if (parsed.status !== 'renamed' && parsed.oldPath === parsed.path) parsed.oldPath = null
  }

  return { files, truncated: options.truncated === true }
}

/** Whether a line inside a hunk is content rather than the next header. */
function isContent(line: string): boolean {
  if (line === '') return true
  const first = line[0]
  return first === '+' || first === '-' || first === ' ' || first === '\\'
}

/**
 * `a/docs/x.md` or `"b/with space.md"` off a `---`/`+++` header.
 *
 * Null for `/dev/null`, which is git's way of saying this side does not exist -
 * a file that took it as a path would list a pull request's deletions under a
 * device node.
 */
function headerPath(rest: string): string | null {
  // git appends a tab and a timestamp in some formats; gh's does not, and a
  // path containing a tab is not a path anybody has.
  const cut = rest.split('\t')[0] ?? rest
  const path = unquote(cut.trim())
  if (path === '/dev/null') return null
  return stripPrefix(path)
}

/** `a/` and `b/` are git's, not the repository's. */
function stripPrefix(path: string): string {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2)
  return path
}

/**
 * The two paths on a `diff --git` line, when they can be had at all.
 *
 * "When they can be had" is the whole caveat: the line is `a/<x> b/<y>` with a
 * space between them and no quoting unless a path needs it, so a file with a
 * space in its name makes the split genuinely ambiguous. This is why it is only
 * the fallback - the `---`/`+++` pair is unambiguous and is what normally wins.
 */
function pathsFromGitLine(line: string): { a: string | null; b: string | null } {
  const rest = line.slice('diff --git '.length)
  if (rest.startsWith('"')) {
    const [first, second] = splitQuoted(rest)
    return { a: first === null ? null : stripPrefix(first), b: second === null ? null : stripPrefix(second) }
  }
  const at = rest.indexOf(' b/')
  if (at < 0) return { a: null, b: null }
  return { a: stripPrefix(rest.slice(0, at)), b: stripPrefix(rest.slice(at + 1)) }
}

/** Two C-quoted paths, `"a/x" "b/y"`. */
function splitQuoted(rest: string): [string | null, string | null] {
  const close = findClosingQuote(rest)
  if (close < 0) return [null, null]
  const first = unquote(rest.slice(0, close + 1))
  const second = rest.slice(close + 1).trim()
  return [first, second === '' ? null : unquote(second)]
}

function findClosingQuote(text: string): number {
  for (let at = 1; at < text.length; at += 1) {
    if (text[at] === '\\') {
      at += 1
      continue
    }
    if (text[at] === '"') return at
  }
  return -1
}

/**
 * git's C-style quoting, undone.
 *
 * `core.quotePath` is on by default, so anything outside plain ASCII arrives
 * as `"\303\251clair.md"` - octal escapes over the **UTF-8 bytes**, which is why
 * the bytes are collected and decoded together rather than turned into
 * characters one escape at a time.
 */
function unquote(value: string): string {
  const text = value.trim()
  if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) return text

  const bytes: number[] = []
  const push = (chunk: string): void => {
    for (const byte of new TextEncoder().encode(chunk)) bytes.push(byte)
  }

  for (let at = 1; at < text.length - 1; at += 1) {
    const char = text[at] as string
    if (char !== '\\') {
      push(char)
      continue
    }
    const next = text[at + 1]
    if (next === undefined) break
    const simple = SIMPLE_ESCAPES[next]
    if (simple !== undefined) {
      bytes.push(simple)
      at += 1
      continue
    }
    const octal = /^[0-7]{1,3}/.exec(text.slice(at + 1, at + 4))
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8) & 0xff)
      at += octal[0].length
      continue
    }
    push(next)
    at += 1
  }

  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes))
  } catch {
    return text.slice(1, -1)
  }
}

const SIMPLE_ESCAPES: Record<string, number> = {
  '"': 0x22,
  '\\': 0x5c,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b
}

/**
 * The patch, matched up with the file list GitHub's JSON gave.
 *
 * Keyed on the path and nothing else. A rename is looked up under **both**
 * names, because `pr view --json files` reports the head-side path and a patch
 * that only renamed something has no other line to be found by.
 */
export function indexDiffByPath(diff: PullDiff): Map<string, PullFileDiff> {
  const byPath = new Map<string, PullFileDiff>()
  for (const file of diff.files) {
    byPath.set(file.path, file)
    if (file.oldPath !== null && !byPath.has(file.oldPath)) byPath.set(file.oldPath, file)
  }
  return byPath
}
