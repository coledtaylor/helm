/**
 * The two parsers that have to run on both sides of the wire.
 *
 * The editor validates before it asks main to write - criterion 5 is that
 * malformed JSON never reaches the disk, and "never reaches the disk" means the
 * renderer refuses to send it, not that the main process rejects it afterwards.
 * So this file has no `node:` imports and is re-exported from `types.ts`, which
 * is the one entry point the renderer may import values from (CLAUDE.md, hard
 * rules).
 */

/** A syntax error, placed. Columns and lines are 1-based, as an editor counts. */
export interface JsonProblem {
  message: string
  line: number
  column: number
  /** Character offset from the start of the text. */
  offset: number
  /** The offending line, for showing the error in place. */
  text: string
}

/**
 * Turns a character offset into a line and column.
 *
 * Counted over `\n` with `\r` left in the line, because that is how a textarea
 * addresses its own content: the DOM normalises CRLF to LF on the way in, so a
 * file read from disk with CRLF endings is displayed and edited with LF and the
 * two counts agree only if this one ignores the carriage returns.
 */
function locate(text: string, offset: number): { line: number; column: number; text: string } {
  const clamped = Math.max(0, Math.min(offset, text.length))
  let line = 1
  let lineStart = 0
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++
      lineStart = i + 1
    }
  }
  let lineEnd = text.indexOf('\n', lineStart)
  if (lineEnd < 0) lineEnd = text.length
  return {
    line,
    column: clamped - lineStart + 1,
    text: text.slice(lineStart, lineEnd).replace(/\r$/, '')
  }
}

/**
 * Where a document stops being JSON, found by scanning it.
 *
 * The obvious implementation reads the offset out of V8's exception message,
 * and it does not work: the wording has changed three times and the current one
 * carries no offset at all. On Node 24 a trailing comma inside an object
 * reports `Unexpected token ',', ..."1,\n  "b": ,\n}\n" is not valid JSON` -
 * a quoted excerpt, no `position`, no line and column. Falling back to the end
 * of the file, which is what a missing offset leaves, puts the marker on the
 * closing brace of a file whose error is twenty lines above it.
 *
 * So the position is scanned for rather than parsed out. `JSON.parse` is still
 * the authority on *whether* the document is valid; this only answers *where*,
 * and it answers the same way on every runtime.
 */
interface Scan {
  offset: number
  message: string
}

function scanJson(text: string): Scan | null {
  let at = 0

  const skipSpace = (): void => {
    while (at < text.length && /[\s]/.test(text[at] ?? '')) at++
  }

  const fail = (message: string): Scan => ({ offset: Math.min(at, text.length), message })

  /** Returns null on success, or where it gave up. */
  const value = (depth: number): Scan | null => {
    // A document nested past this is not something a person is editing by hand,
    // and an unbounded recursion on hostile input is a stack overflow.
    if (depth > 200) return fail('Nested too deeply to check')
    skipSpace()
    if (at >= text.length) return fail('The document ends before this value')

    const char = text[at] ?? ''

    if (char === '{') {
      at++
      skipSpace()
      if (text[at] === '}') {
        at++
        return null
      }
      for (;;) {
        skipSpace()
        if (text[at] !== '"') return fail('Expected a quoted property name')
        const key = string()
        if (key) return key
        skipSpace()
        if (text[at] !== ':') return fail("Expected ':' after the property name")
        at++
        const nested = value(depth + 1)
        if (nested) return nested
        skipSpace()
        if (text[at] === ',') {
          const comma = at
          at++
          skipSpace()
          // The single most common mistake in a hand-edited settings file, and
          // the one V8's message locates worst. Reported at the comma rather
          // than at the brace that follows it, because the comma is the
          // character to delete - and the two are usually on different lines.
          if (text[at] === '}') {
            at = comma
            return fail('Trailing comma before the closing brace')
          }
          continue
        }
        if (text[at] === '}') {
          at++
          return null
        }
        return fail("Expected ',' or '}'")
      }
    }

    if (char === '[') {
      at++
      skipSpace()
      if (text[at] === ']') {
        at++
        return null
      }
      for (;;) {
        const nested = value(depth + 1)
        if (nested) return nested
        skipSpace()
        if (text[at] === ',') {
          const comma = at
          at++
          skipSpace()
          if (text[at] === ']') {
            at = comma
            return fail('Trailing comma before the closing bracket')
          }
          continue
        }
        if (text[at] === ']') {
          at++
          return null
        }
        return fail("Expected ',' or ']'")
      }
    }

    if (char === '"') return string()

    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, at)) {
        at += literal.length
        return null
      }
    }

    const number = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(at))
    if (number && number[0].length > 0) {
      at += number[0].length
      return null
    }

    return fail(`Unexpected ${JSON.stringify(char)} where a value should be`)
  }

  const string = (): Scan | null => {
    const opened = at
    at++
    while (at < text.length) {
      const char = text[at]
      if (char === '\\') {
        at += 2
        continue
      }
      if (char === '"') {
        at++
        return null
      }
      if (char === '\n') {
        at = opened
        return fail('This string is not closed before the end of the line')
      }
      at++
    }
    at = opened
    return fail('This string is never closed')
  }

  const problem = value(0)
  if (problem) return problem

  skipSpace()
  if (at < text.length) return fail('Unexpected content after the end of the document')
  return null
}

export function validateJson(text: string): JsonProblem | null {
  // An empty document is not valid JSON, but it is also not an error worth
  // stopping a save for - `{}` is what the user means and what gets written.
  if (text.trim() === '') return null

  try {
    JSON.parse(text)
    return null
  } catch (err) {
    const scanned = scanJson(text)
    const offset = scanned?.offset ?? text.length
    const at = locate(text, offset)
    const fallback = (err instanceof Error ? err.message : String(err))
      // The offset is shown as a line and column, so repeating it is noise.
      .replace(/\s*\(?(at\s+)?position\s+\d+.*$/i, '')
      .trim()
    return {
      message: scanned?.message ?? (fallback || 'Not valid JSON'),
      line: at.line,
      column: at.column,
      offset,
      text: at.text
    }
  }
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/**
 * The YAML block at the top of a SKILL.md, an agent, or a command.
 *
 * Parsed by hand rather than with the `yaml` package, for one reason: this runs
 * in the renderer, and the header it feeds shows `name` and `description` -
 * flat scalars - for a file the user is about to edit as text. A real YAML
 * parser would buy nested structures nothing displays, at the cost of a parse
 * that throws on the half-finished frontmatter of a file being typed into.
 */
export interface Frontmatter {
  /** The block between the fences, without them. */
  raw: string
  /** Flat `key: value` pairs, values unquoted. Nested keys are skipped. */
  fields: Array<{ key: string; value: string }>
  /** Line the closing fence is on, 1-based. The body starts after it. */
  endLine: number
}

export function parseFrontmatter(text: string): Frontmatter | null {
  // Tolerates a leading BOM and CRLF; a file written by another editor has both
  // and neither means the file has no frontmatter.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = body.split('\n')
  if ((lines[0] ?? '').replace(/\r$/, '').trim() !== '---') return null

  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').replace(/\r$/, '').trim() === '---') {
      end = i
      break
    }
  }
  if (end < 0) return null

  const block = lines.slice(1, end)
  const fields: Array<{ key: string; value: string }> = []
  for (const line of block) {
    const clean = line.replace(/\r$/, '')
    // Only top-level scalars: an indented line belongs to a structure the
    // header does not render, and a `key:` with nothing after it is a mapping.
    if (/^\s/.test(clean)) continue
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(clean)
    if (!match) continue
    const key = match[1] ?? ''
    const value = (match[2] ?? '').trim().replace(/^['"]|['"]$/g, '')
    if (value === '') continue
    fields.push({ key, value })
  }

  return { raw: block.join('\n'), fields, endLine: end + 1 }
}

/** The `description:` a skill declares, which is what selects it at runtime. */
export function frontmatterField(text: string, key: string): string | null {
  const parsed = parseFrontmatter(text)
  if (!parsed) return null
  return parsed.fields.find((field) => field.key === key)?.value ?? null
}
