import { describe, expect, it } from 'vitest'
import {
  backspaceAction,
  caretAt,
  editorKeyAction,
  enterAction,
  findMatchesIn,
  indentAction,
  lineStarts,
  pairAction,
  syntaxFor,
  wrapsByDefault,
  type EditAction
} from './editing'

/**
 * These are the rules the editors are made of, and every one of them is here
 * rather than in the real-window check because the interesting cases are about
 * offsets in a string. `pnpm highlight-check --only=behaviour` still drives
 * each of them through a real textarea - what a patch says and what Chromium
 * does with it are two claims - but "the selection ended exactly on a line
 * break" is a case a driver would never think to type.
 */

/** Applies a patch the way the component does, so a test states before/after. */
function applyTo(text: string, action: EditAction | null): { text: string; at: [number, number] } {
  if (action === null) return { text, at: [0, 0] }
  if (action.kind === 'move') return { text, at: [action.selectionStart, action.selectionEnd] }
  if (action.kind === 'delete') {
    return { text: text.slice(0, action.from) + text.slice(action.to), at: [action.from, action.from] }
  }
  return {
    text: text.slice(0, action.from) + action.text + text.slice(action.to),
    at: [action.selectionStart, action.selectionEnd]
  }
}

describe('syntaxFor', () => {
  it('gives JSON two spaces and Python four', () => {
    expect(syntaxFor('settings.json').indent).toBe('  ')
    expect(syntaxFor('/a/b/hook.py').indent).toBe('    ')
    expect(syntaxFor('Makefile.mk').indent).toBe('\t')
  })

  it('does not auto-close quotes in prose, and does close brackets', () => {
    expect(syntaxFor('CLAUDE.md').quotes).toBe('')
    expect(syntaxFor('settings.json').quotes).toContain('"')
  })

  it('opens a block on a colon only where a colon opens one', () => {
    expect(syntaxFor('a.yaml').colonOpens).toBe(true)
    expect(syntaxFor('a.py').colonOpens).toBe(true)
    expect(syntaxFor('settings.json').colonOpens).toBe(false)
  })
})

describe('wrapsByDefault', () => {
  it('wraps prose and not structure', () => {
    // The `CLAUDE.md` horizontal scrollbar, as a one-line assertion.
    expect(wrapsByDefault('CLAUDE.md')).toBe(true)
    expect(wrapsByDefault('notes/Todo.md')).toBe(true)
    expect(wrapsByDefault('settings.json')).toBe(false)
    expect(wrapsByDefault('hook.ps1')).toBe(false)
  })
})

describe('indentAction', () => {
  it('inserts one indent at a caret', () => {
    const out = applyTo('ab', indentAction('ab', 1, 1, '  ', false))
    expect(out.text).toBe('a  b')
    expect(out.at).toEqual([3, 3])
  })

  it('indents every line of a selection rather than replacing it', () => {
    const text = 'one\ntwo\nthree'
    const out = applyTo(text, indentAction(text, 1, 9, '  ', false))
    expect(out.text).toBe('  one\n  two\n  three')
  })

  it('leaves the line after a selection that ends on the break alone', () => {
    const text = 'one\ntwo\nthree'
    // The selection is `one\n` exactly: `two` is not selected and must not move.
    const out = applyTo(text, indentAction(text, 0, 4, '  ', false))
    expect(out.text).toBe('  one\ntwo\nthree')
  })

  it('skips empty lines, which would otherwise gain trailing whitespace', () => {
    const text = 'a\n\nb'
    const out = applyTo(text, indentAction(text, 0, 4, '  ', false))
    expect(out.text).toBe('  a\n\n  b')
  })

  it('outdents spaces and a tab alike, and never past the line start', () => {
    expect(applyTo('    a', indentAction('    a', 5, 5, '  ', true)).text).toBe('  a')
    expect(applyTo('\ta', indentAction('\ta', 2, 2, '  ', true)).text).toBe('a')
    expect(indentAction('a', 1, 1, '  ', true)).toBeNull()
  })

  it('outdents a whole selection in one patch', () => {
    const text = '  one\n  two'
    const out = applyTo(text, indentAction(text, 3, 9, '  ', true))
    expect(out.text).toBe('one\ntwo')
  })
})

describe('enterAction', () => {
  const json = syntaxFor('a.json')

  it('keeps the previous line indentation', () => {
    const text = '  "a": 1'
    const out = applyTo(text, enterAction(text, 8, 8, json))
    expect(out.text).toBe('  "a": 1\n  ')
    expect(out.at).toEqual([11, 11])
  })

  it('goes one level deeper after an opener', () => {
    const text = '  {'
    expect(applyTo(text, enterAction(text, 3, 3, json)).text).toBe('  {\n    ')
  })

  it('puts a closer on its own line when the caret is between the pair', () => {
    const text = '{}'
    const out = applyTo(text, enterAction(text, 1, 1, json))
    expect(out.text).toBe('{\n  \n}')
    expect(out.at).toEqual([4, 4])
  })

  it('treats a colon as an opener only where the syntax says so', () => {
    const yaml = syntaxFor('a.yaml')
    expect(applyTo('a:', enterAction('a:', 2, 2, yaml)).text).toBe('a:\n  ')
    expect(applyTo('a:', enterAction('a:', 2, 2, json)).text).toBe('a:\n')
  })
})

describe('pairAction', () => {
  const json = syntaxFor('a.json')
  const md = syntaxFor('a.md')

  it('closes a bracket and leaves the caret inside', () => {
    const out = applyTo('', pairAction('', 0, 0, '(', json))
    expect(out.text).toBe('()')
    expect(out.at).toEqual([1, 1])
  })

  it('surrounds a selection and keeps it selected', () => {
    const out = applyTo('abc', pairAction('abc', 0, 3, '[', json))
    expect(out.text).toBe('[abc]')
    expect(out.at).toEqual([1, 4])
  })

  it('types over a closer that is already there', () => {
    const action = pairAction('()', 1, 1, ')', json)
    expect(action?.kind).toBe('move')
    expect(applyTo('()', action)).toEqual({ text: '()', at: [2, 2] })
  })

  it('does not double a closer that is not there', () => {
    expect(pairAction('a', 1, 1, ')', json)).toBeNull()
  })

  it('leaves an apostrophe in prose alone', () => {
    // `don't` is the whole reason quotes are off for markdown, and the guard
    // catches it even where they are on.
    expect(pairAction("don", 3, 3, "'", md)).toBeNull()
    expect(pairAction("don", 3, 3, "'", json)).toBeNull()
  })

  it('closes a quote where a quote is what was meant', () => {
    const out = applyTo('{}', pairAction('{}', 1, 1, '"', json))
    expect(out.text).toBe('{""}')
  })
})

describe('backspaceAction', () => {
  const json = syntaxFor('a.json')

  it('takes both halves of a pair', () => {
    const out = applyTo('a()b', backspaceAction('a()b', 2, 2, json))
    expect(out.text).toBe('ab')
  })

  it('leaves an unmatched bracket to the textarea', () => {
    expect(backspaceAction('a(b', 2, 2, json)).toBeNull()
    expect(backspaceAction('()', 1, 2, json)).toBeNull()
  })
})

describe('editorKeyAction', () => {
  const json = syntaxFor('a.json')

  it('answers nothing for the keys it does not change', () => {
    expect(editorKeyAction('a', 1, 1, 'ArrowLeft', false, json)).toBeNull()
    expect(editorKeyAction('a', 1, 1, 'x', false, json)).toBeNull()
    expect(editorKeyAction('a', 1, 1, 'F5', false, json)).toBeNull()
  })

  it('routes Tab, Enter, Backspace and a bracket', () => {
    expect(editorKeyAction('', 0, 0, 'Tab', false, json)?.kind).toBe('replace')
    expect(editorKeyAction('', 0, 0, 'Enter', false, json)?.kind).toBe('replace')
    expect(editorKeyAction('()', 1, 1, 'Backspace', false, json)?.kind).toBe('delete')
    expect(editorKeyAction('', 0, 0, '{', false, json)?.kind).toBe('replace')
  })
})

describe('findMatchesIn', () => {
  it('finds every occurrence, case-insensitively and without overlaps', () => {
    expect(findMatchesIn('aAaA', 'aa')).toEqual([0, 2])
    expect(findMatchesIn('Helm helm HELM', 'helm')).toEqual([0, 5, 10])
    expect(findMatchesIn('abc', '')).toEqual([])
  })

  it('is literal, not a regular expression', () => {
    expect(findMatchesIn('axb a.b', 'a.b')).toEqual([4])
  })
})

describe('lineStarts and caretAt', () => {
  it('indexes every line, the empty last one included', () => {
    expect(lineStarts('a\nbb\n')).toEqual([0, 2, 5])
  })

  it('reports 1-based line and column', () => {
    expect(caretAt('ab\ncd', 4)).toEqual({ line: 2, column: 2 })
    expect(caretAt('ab\ncd', 0)).toEqual({ line: 1, column: 1 })
  })
})
