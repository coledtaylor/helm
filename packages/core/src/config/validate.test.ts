import { describe, expect, it } from 'vitest'
import { frontmatterField, parseFrontmatter, validateJson } from './validate'

/**
 * These two run in the renderer, which is what makes them worth testing on
 * their own: the editor refuses to send malformed JSON, so the *location* it
 * reports is a product surface rather than a diagnostic.
 */

describe('validateJson', () => {
  it('accepts valid documents', () => {
    expect(validateJson('{"a":1}')).toBeNull()
    expect(validateJson('[]')).toBeNull()
    expect(validateJson('  {\n  "a": [1, 2]\n}\n')).toBeNull()
  })

  it('treats an empty document as nothing to complain about', () => {
    // Not valid JSON, but also not an error worth blocking a save for - the
    // user is at the start of a file, not at the end of a broken one.
    expect(validateJson('')).toBeNull()
    expect(validateJson('   \n  ')).toBeNull()
  })

  it('locates the offending character by line and column', () => {
    const problem = validateJson('{\n  "a": 1,\n  "b": ,\n}\n')
    expect(problem).not.toBeNull()
    expect(problem?.line).toBe(3)
    // The comma the parser choked on, not the start of the line.
    expect(problem?.column).toBeGreaterThan(1)
    expect(problem?.text).toBe('  "b": ,')
  })

  it('reports the first line for a document that opens wrong', () => {
    const problem = validateJson('not json at all')
    expect(problem?.line).toBe(1)
  })

  it('counts lines the way a textarea does, ignoring carriage returns', () => {
    // A file read from disk with CRLF is edited as LF in the DOM; the two
    // counts only agree if this one leaves the \r inside the line.
    const problem = validateJson('{\r\n  "a": 1,\r\n  ]\r\n}')
    expect(problem?.line).toBe(3)
    expect(problem?.text).toBe('  ]')
  })

  it('keeps a message even when it cannot strip the position out of it', () => {
    const problem = validateJson('{')
    expect(problem?.message).not.toBe('')
  })
})

describe('parseFrontmatter', () => {
  it('reads top-level scalars between the fences', () => {
    const parsed = parseFrontmatter(
      ['---', 'name: think', 'description: Think about it.', '---', '', '# Body'].join('\n')
    )
    expect(parsed?.fields).toEqual([
      { key: 'name', value: 'think' },
      { key: 'description', value: 'Think about it.' }
    ])
    expect(parsed?.endLine).toBe(4)
  })

  it('is null when there is no opening fence', () => {
    expect(parseFrontmatter('# Just a heading\n')).toBeNull()
    expect(parseFrontmatter('')).toBeNull()
  })

  it('is null when the block is never closed', () => {
    // Which is what a file looks like halfway through being typed.
    expect(parseFrontmatter('---\nname: half\n')).toBeNull()
  })

  it('tolerates a BOM and CRLF, which another editor will have left', () => {
    const parsed = parseFrontmatter('﻿---\r\nname: bommed\r\n---\r\n\r\nbody')
    expect(parsed?.fields).toEqual([{ key: 'name', value: 'bommed' }])
  })

  it('skips nested keys rather than flattening them into the header', () => {
    const parsed = parseFrontmatter(
      ['---', 'name: nested', 'allowed-tools:', '  - Read', '  - Write', '---', ''].join('\n')
    )
    expect(parsed?.fields).toEqual([{ key: 'name', value: 'nested' }])
  })

  it('unquotes values', () => {
    const parsed = parseFrontmatter('---\ndescription: "Quoted, with a comma"\n---\n')
    expect(parsed?.fields[0]?.value).toBe('Quoted, with a comma')
  })

  it('finds one field by name', () => {
    const text = '---\nname: a\ndescription: b\n---\n'
    expect(frontmatterField(text, 'description')).toBe('b')
    expect(frontmatterField(text, 'model')).toBeNull()
    expect(frontmatterField('no frontmatter', 'description')).toBeNull()
  })
})
