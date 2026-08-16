/**
 * What a text editor does when you press a key, as pure functions over a string.
 *
 * Helm edits files in two places - the config console and the content viewer -
 * and both are a `<textarea>`. That is a decision with evidence behind it (SPEC
 * "The editors"), and it comes with a consequence: a textarea gives you
 * selection, scrolling, an IME and a native undo stack, and *nothing else*. Tab
 * moves focus, Enter starts a line in column one, and a bracket is a bracket.
 * Everything a person expects from a box that edits text has to be written.
 *
 * It is written **here**, away from the DOM, for two reasons.
 *
 *   - The interesting part of "Shift+Tab outdents a selection" is entirely
 *     about offsets in a string. A test that has to mount a component to ask
 *     what happens when the selection ends exactly on a line break is a test
 *     nobody writes; this one is nine lines and runs in `pnpm check`.
 *   - Every one of these produces a **patch**, never a new document. The caller
 *     applies it with `document.execCommand('insertText')` over a selection it
 *     sets first, because that is the one route that leaves Chromium's own undo
 *     stack intact. Assigning `.value` is the naive version and it silently
 *     throws the user's history away - the failure this whole shape exists to
 *     prevent. A function that returned a finished string would make that
 *     mistake the easy one.
 */

/**
 * What a keystroke does. Three shapes, because they are applied three
 * different ways and only the first inserts anything.
 *
 * `delete` is not a `replace` with an empty string: `insertText` with `''` is a
 * no-op in Chromium, so a deletion has to go through `execCommand('delete')`
 * over a selection. Collapsing the two would produce a Backspace that quietly
 * did nothing.
 */
export type EditAction =
  | {
      kind: 'replace'
      /** The range this replaces. Collapsed for a pure insertion. */
      from: number
      to: number
      text: string
      /** Where the selection lands afterwards, in the *resulting* document. */
      selectionStart: number
      selectionEnd: number
    }
  | { kind: 'delete'; from: number; to: number }
  /** No edit at all - typing over a closer that is already there. */
  | { kind: 'move'; selectionStart: number; selectionEnd: number }

/** How one file kind wants to be edited. */
export interface EditorSyntax {
  /** What Tab inserts. */
  indent: string
  /**
   * A line ending in `:` opens a block. True for the indentation-structured
   * kinds and false everywhere else - in JSON a colon ends a key, and Enter
   * after one must not indent.
   */
  colonOpens: boolean
  /**
   * The quote characters that auto-close, which is empty for prose.
   *
   * `don't` is the case that decides this. A guard on the surrounding
   * characters catches that one, but prose is full of near misses - a quote
   * opening a sentence, an apostrophe starting a word - and in a document
   * whose brackets are worth closing and whose quotes are not, the honest
   * answer is to close the brackets and leave the quotes alone.
   */
  quotes: string
  /** Whether this kind reads better wrapped. Prose does; structure does not. */
  wraps: boolean
}

/** Opener to closer. The set is deliberately small: no `<` (a `<` in prose is
 *  a `<`), and no `*` or `_` (markdown emphasis is not a pair you close). */
const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
const CLOSERS = new Set(Object.values(PAIRS))

const FOUR_SPACE = new Set(['py', 'pyi', 'python'])
const TAB_INDENTED = new Set(['go', 'mk', 'makefile', 'gd'])
/** Prose, and the kinds where a line is a paragraph rather than a statement. */
const PROSE = new Set(['md', 'markdown', 'mdx', 'txt', 'text', 'rst', 'adoc', ''])
/** Structure with a colon that opens a block rather than ending a key. */
const COLON_OPENS = new Set(['py', 'pyi', 'python', 'yml', 'yaml'])

/**
 * The extension, lowercased and without its dot. Takes a path or an extension
 * so the two callers - a config file's path and a content file's `ext` - do not
 * each have to remember which one this wants.
 */
export function editorExtension(pathOrExt: string): string {
  const tail = /[^.\\/]*$/.exec(pathOrExt)?.[0] ?? ''
  return tail.toLowerCase()
}

/** How a file of this kind is edited. Keyed on the extension, like everything
 *  else that has to guess what a file is before reading it. */
export function syntaxFor(pathOrExt: string): EditorSyntax {
  const ext = editorExtension(pathOrExt)
  const indent = FOUR_SPACE.has(ext) ? '    ' : TAB_INDENTED.has(ext) ? '\t' : '  '
  const prose = PROSE.has(ext)
  return {
    indent,
    colonOpens: COLON_OPENS.has(ext),
    // Brackets everywhere, quotes nowhere near prose. See `quotes` above.
    quotes: prose ? '' : '"\'`',
    wraps: prose
  }
}

/**
 * Whether a file of this kind starts wrapped.
 *
 * This is the whole of the `CLAUDE.md` horizontal scrollbar: a paragraph is one
 * very long line, and a box that will not wrap it makes reading it a horizontal
 * drag. A `settings.json` is the opposite - its structure *is* the line breaks,
 * and wrapping hides which key a value belongs to.
 */
export function wrapsByDefault(pathOrExt: string): boolean {
  return syntaxFor(pathOrExt).wraps
}

/** The offset each line starts at, `lines.length` long. */
export function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

/** 1-based line and column of an offset, for a status bar. */
export function caretAt(text: string, offset: number): { line: number; column: number } {
  const upTo = text.slice(0, Math.max(0, Math.min(offset, text.length)))
  const lastBreak = upTo.lastIndexOf('\n')
  return { line: upTo.split('\n').length, column: upTo.length - lastBreak }
}

/**
 * Every offset a literal query occurs at, case-insensitively and without
 * overlaps.
 *
 * Literal rather than a regular expression, because the box this serves is a
 * find bar in a notes app: somebody looking for `a.b` means `a.b`, and a
 * silently-regex find turns every `.` in the vault into a match.
 */
export function findMatchesIn(text: string, query: string): number[] {
  if (query === '') return []
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  const out: number[] = []
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) {
    out.push(i)
  }
  return out
}

/** The first line's start offset and the last line's end offset for a range. */
function lineSpan(text: string, start: number, end: number): { from: number; to: number } {
  const from = text.lastIndexOf('\n', start - 1) + 1
  // A selection that ends exactly on a line break has not selected the line
  // after it, and indenting one the user cannot see is the classic off-by-one.
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end
  const brk = text.indexOf('\n', last)
  return { from, to: brk === -1 ? text.length : brk }
}

/** How many characters of leading indentation one outdent removes. */
function outdentWidth(line: string, unit: string): number {
  if (line.startsWith('\t')) return 1
  let spaces = 0
  while (spaces < unit.length && line[spaces] === ' ') spaces += 1
  return spaces
}

/**
 * Tab and Shift+Tab.
 *
 * Selection-aware in the way that matters: a caret inserts one indent, and
 * anything spanning more than a caret moves whole lines, so Tab over a selected
 * block indents the block rather than replacing it with a tab character. That
 * last one is the behaviour people notice, because the alternative deletes what
 * they had selected.
 *
 * Empty lines are left alone when indenting. Indenting them produces trailing
 * whitespace on a line that has nothing on it, which every linter then flags.
 */
export function indentAction(
  text: string,
  start: number,
  end: number,
  unit: string,
  outdent: boolean
): EditAction | null {
  if (!outdent && start === end) {
    return {
      kind: 'replace',
      from: start,
      to: start,
      text: unit,
      selectionStart: start + unit.length,
      selectionEnd: start + unit.length
    }
  }

  const span = lineSpan(text, start, end)
  const block = text.slice(span.from, span.to)
  const lines = block.split('\n')

  // How far the two ends of the selection move, so the same text stays
  // selected afterwards rather than the selection collapsing to the block.
  let firstDelta = 0
  let total = 0
  const next = lines.map((line, index) => {
    if (outdent) {
      const width = outdentWidth(line, unit)
      if (index === 0) firstDelta = -width
      total -= width
      return line.slice(width)
    }
    if (line.trim() === '') return line
    if (index === 0) firstDelta = unit.length
    total += unit.length
    return unit + line
  })

  const replacement = next.join('\n')
  if (replacement === block) return null

  // The caret keeps its column where it can. Clamped to the line start, since
  // outdenting a line whose caret sat inside the indentation would otherwise
  // push it before the line.
  const newStart = Math.max(span.from, start + firstDelta)
  const newEnd = Math.max(newStart, end + total)
  return {
    kind: 'replace',
    from: span.from,
    to: span.to,
    text: replacement,
    selectionStart: start === end ? newEnd : newStart,
    selectionEnd: newEnd
  }
}

/**
 * Enter, keeping the indentation and going one level deeper after an opener.
 *
 * The third case is the one that makes it feel like an editor: pressing Enter
 * between `{` and `}` puts the closer on its own line and leaves the caret on a
 * blank indented line between them.
 */
export function enterAction(
  text: string,
  start: number,
  end: number,
  syntax: EditorSyntax
): EditAction {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const before = text.slice(lineStart, start)
  const indent = /^[ \t]*/.exec(before)?.[0] ?? ''
  const trimmed = before.trimEnd()
  const last = trimmed.slice(-1)
  const opens =
    last === '{' || last === '[' || last === '(' || (syntax.colonOpens && last === ':')
  const deeper = opens ? indent + syntax.indent : indent
  const after = text.slice(end, end + 1)
  const between = last !== '' && PAIRS[last] === after

  const inserted = between ? `\n${deeper}\n${indent}` : `\n${deeper}`
  const caret = start + 1 + deeper.length
  return {
    kind: 'replace',
    from: start,
    to: end,
    text: inserted,
    selectionStart: caret,
    selectionEnd: caret
  }
}

/** Whether auto-closing a quote here would be wrong. See `EditorSyntax.quotes`. */
function quoteWouldBeWrong(text: string, start: number, end: number, ch: string): boolean {
  const before = text.slice(Math.max(0, start - 1), start)
  const after = text.slice(end, end + 1)
  return /[\w]/.test(before) || /[\w]/.test(after) || before === ch
}

/**
 * A bracket or a quote: close it, type over it, or surround the selection.
 *
 * Returns null where the key should simply be typed, which is most of the time
 * - this is an addition to the textarea's behaviour, not a replacement for it.
 */
export function pairAction(
  text: string,
  start: number,
  end: number,
  ch: string,
  syntax: EditorSyntax
): EditAction | null {
  const isQuote = syntax.quotes.includes(ch)
  const closer = PAIRS[ch]

  // Something is selected: wrap it, and keep it selected. The one gesture here
  // that a person performs deliberately rather than discovers.
  if (start !== end && (closer !== undefined || isQuote)) {
    const close = closer ?? ch
    const inner = text.slice(start, end)
    return {
      kind: 'replace',
      from: start,
      to: end,
      text: `${ch}${inner}${close}`,
      selectionStart: start + 1,
      selectionEnd: end + 1
    }
  }
  if (start !== end) return null

  // Typing the closer that is already sitting under the caret walks over it
  // rather than doubling it - the other half of auto-closing, and the half
  // whose absence makes auto-closing worse than nothing.
  if ((CLOSERS.has(ch) || isQuote) && text.slice(start, start + 1) === ch) {
    return { kind: 'move', selectionStart: start + 1, selectionEnd: start + 1 }
  }
  if (CLOSERS.has(ch)) return null

  if (isQuote) {
    if (quoteWouldBeWrong(text, start, end, ch)) return null
    return {
      kind: 'replace',
      from: start,
      to: start,
      text: ch + ch,
      selectionStart: start + 1,
      selectionEnd: start + 1
    }
  }
  if (closer === undefined) return null
  return {
    kind: 'replace',
    from: start,
    to: start,
    text: ch + closer,
    selectionStart: start + 1,
    selectionEnd: start + 1
  }
}

/**
 * Backspace between the two halves of a pair takes both.
 *
 * Only exactly between them, and only with nothing selected: anywhere else this
 * returns null and the textarea does what it always did.
 */
export function backspaceAction(
  text: string,
  start: number,
  end: number,
  syntax: EditorSyntax
): EditAction | null {
  if (start !== end || start === 0) return null
  const before = text[start - 1] ?? ''
  const after = text[start] ?? ''
  const paired = PAIRS[before] === after || (syntax.quotes.includes(before) && before === after)
  if (!paired) return null
  return { kind: 'delete', from: start - 1, to: start + 1 }
}

/**
 * The whole keyboard, in one place.
 *
 * One entry point rather than five, so the component that owns the textarea has
 * a single question to ask and the order the rules are tried in is decided here
 * rather than in a chain of `if`s beside the DOM.
 *
 * Returns null for every key this does not change, which is nearly all of them.
 */
export function editorKeyAction(
  text: string,
  start: number,
  end: number,
  key: string,
  shift: boolean,
  syntax: EditorSyntax
): EditAction | null {
  if (key === 'Tab') return indentAction(text, start, end, syntax.indent, shift)
  if (key === 'Enter') return enterAction(text, start, end, syntax)
  if (key === 'Backspace') return backspaceAction(text, start, end, syntax)
  if (key.length !== 1) return null
  return pairAction(text, start, end, key, syntax)
}
