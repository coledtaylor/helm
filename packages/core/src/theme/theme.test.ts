import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { contrastRatio, formatColor, parseColor } from './color'
import { readUserThemes, seedThemesDir, THEMES_README, writeThemeCopy } from './load'
import {
  ACCENT_SWATCHES,
  BUILTIN_THEMES,
  deriveAccent,
  parseThemeFile,
  resolveTheme,
  THEME_TOKENS,
  themeIdFromFileName,
  TRANSLUCENT_TOKENS,
  type ThemeChoice,
  type ThemeDefinition
} from './themes'

const must = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error('expected a value')
  return value
}

describe('parseColor', () => {
  it.each([
    ['#abc', '#aabbcc'],
    ['#ABCDEF', '#abcdef'],
    ['#11121a', '#11121a'],
    ['#ffffff80', 'rgb(255 255 255 / 0.502)'],
    ['#fff8', 'rgb(255 255 255 / 0.533)'],
    ['rgb(1 2 3)', '#010203'],
    ['rgb(1, 2, 3)', '#010203'],
    ['rgba(233, 233, 237, 0.08)', 'rgb(233 233 237 / 0.08)'],
    ['rgb(233 233 237 / 8%)', 'rgb(233 233 237 / 0.08)'],
    ['  rgb( 10 20 30 / .5 )  ', 'rgb(10 20 30 / 0.5)'],
    ['rgb(10 20 30 / 1)', '#0a141e']
  ])('reads %s as %s', (input, canonical) => {
    expect(formatColor(must(parseColor(input)))).toBe(canonical)
  })

  it.each([
    'red',
    'transparent',
    'hsl(10 20% 30%)',
    '#abcd1',
    '#ggg',
    'rgb(256 0 0)',
    'rgb(1 2)',
    'rgb(1 2 3 4 5)',
    'rgb(1 2 3 / 1.5)',
    'rgb(-1 2 3)',
    '#fff; } body { display: none',
    'rgb(1 2 3)) url(x',
    'var(--helm-bg)',
    ''
  ])('refuses %j', (input) => {
    expect(parseColor(input)).toBeNull()
  })
})

describe('built-in themes', () => {
  it.each(BUILTIN_THEMES.map((t) => [t.id, t] as const))('%s spells every token canonically', (_id, theme) => {
    for (const token of THEME_TOKENS) {
      const parsed = must(parseColor(theme.tokens[token]))
      expect(formatColor(parsed), token).toBe(theme.tokens[token])
      if (!TRANSLUCENT_TOKENS.has(token)) expect(parsed.a, `${token} is opaque`).toBe(1)
    }
  })

  /**
   * The floors the palettes were tuned to. Body text and the 11px chip text on
   * every ground they sit on; the accent as a mark (3:1, non-text) and as a
   * label (4.5:1).
   */
  it.each(BUILTIN_THEMES.map((t) => [t.id, t] as const))('%s holds its contrast floors', (_id, theme) => {
    const c = (token: keyof ThemeDefinition['tokens']) => must(parseColor(theme.tokens[token]))
    for (const ground of ['surface', 'surface-raised'] as const) {
      expect(contrastRatio(c('fg'), c(ground)), `fg on ${ground}`).toBeGreaterThanOrEqual(7)
      expect(contrastRatio(c('fg-muted'), c(ground)), `fg-muted on ${ground}`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(c('accent-text'), c(ground)), `accent-text on ${ground}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrastRatio(c('fg-subtle'), c('surface')), 'fg-subtle on surface').toBeGreaterThanOrEqual(
      theme.kind === 'light' ? 4.5 : 3.5
    )
    expect(contrastRatio(c('accent'), c('surface')), 'accent mark').toBeGreaterThanOrEqual(3)
  })

  it('keeps Nocturne on the v1 dark values, so the default look does not move', () => {
    const nocturne = must(BUILTIN_THEMES.find((t) => t.id === 'nocturne'))
    expect(nocturne.tokens).toMatchObject({
      bg: '#12131f',
      surface: '#1a1c2b',
      hover: '#242639',
      fg: '#e9e9ed',
      accent: '#9184d9',
      'accent-text': '#d2cefd'
    })
  })
})

describe('themeIdFromFileName', () => {
  it.each([
    ['My Theme.json', 'my-theme'],
    ['solarized_light.JSON', 'solarized-light'],
    ['--odd--.json', 'odd'],
    ['é.json', null],
    ['.json', null]
  ])('%s is %s', (file, id) => {
    expect(themeIdFromFileName(file)).toBe(id)
  })
})

describe('parseThemeFile', () => {
  it('reads a theme that only says what it changes', () => {
    const parsed = parseThemeFile(
      'Warm.json',
      JSON.stringify({ name: 'Warm', extends: 'nocturne', colors: { bg: '#16131A', accent: 'rgb(217 160 102)' } })
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const nocturne = must(BUILTIN_THEMES.find((t) => t.id === 'nocturne'))
    expect(parsed.theme).toMatchObject({ id: 'warm', name: 'Warm', kind: 'dark', builtin: false, file: 'Warm.json' })
    expect(parsed.theme.tokens.bg).toBe('#16131a')
    expect(parsed.theme.tokens.accent).toBe('#d9a066')
    expect(parsed.theme.tokens.surface).toBe(nocturne.tokens.surface)
    expect(parsed.theme.problems).toEqual([])
  })

  it('inherits from the built-in of its kind when it extends nothing', () => {
    const parsed = parseThemeFile('paper.json', JSON.stringify({ kind: 'light', colors: {} }))
    const daylight = must(BUILTIN_THEMES.find((t) => t.id === 'daylight'))
    expect(parsed.ok && parsed.theme.tokens).toEqual(daylight.tokens)
    expect(parsed.ok && parsed.theme.name).toBe('paper')
  })

  it('keeps the theme and names the problem when one value is wrong', () => {
    const parsed = parseThemeFile(
      'half.json',
      JSON.stringify({
        kind: 'dark',
        colours: {},
        colors: { bg: 'midnight', surface: 'rgb(0 0 0 / 0.5)', border: 'rgb(0 0 0 / 0.5)', sidebar: '#000000', fg: '#ffffff' }
      })
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const nocturne = must(BUILTIN_THEMES.find((t) => t.id === 'nocturne'))
    expect(parsed.theme.tokens.bg).toBe(nocturne.tokens.bg)
    expect(parsed.theme.tokens.surface).toBe(nocturne.tokens.surface)
    expect(parsed.theme.tokens.border).toBe('rgb(0 0 0 / 0.5)')
    expect(parsed.theme.tokens.fg).toBe('#ffffff')
    expect(parsed.theme.problems).toHaveLength(4)
    expect(parsed.theme.problems.join('\n')).toMatch(/colours.*not a theme field/)
    expect(parsed.theme.problems.join('\n')).toMatch(/bg: "midnight" is not a colour/)
    expect(parsed.theme.problems.join('\n')).toMatch(/surface must be opaque/)
    expect(parsed.theme.problems.join('\n')).toMatch(/sidebar.*not a colour Helm uses/)
  })

  it.each([
    ['not JSON', 'x.json', '{ "kind": "dark", }', /not valid JSON/],
    ['an array', 'x.json', '[]', /JSON object/],
    ['no kind', 'x.json', '{ "colors": {} }', /dark or a light/],
    ['a bad kind', 'x.json', '{ "kind": "dusk" }', /"dark" or "light"/],
    ['extending a file', 'x.json', '{ "extends": "warm" }', /built-in theme/],
    ['a built-in id', 'Graphite.json', '{ "kind": "dark" }', /built-in theme's name/],
    ['no id', '___.json', '{ "kind": "dark" }', /no letters or digits/]
  ])('skips a file with %s', (_what, file, text, message) => {
    const parsed = parseThemeFile(file, text)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toMatch(message)
  })
})

describe('deriveAccent', () => {
  /** Every swatch on every theme meets the floors the built-in accents were tuned to. */
  for (const theme of BUILTIN_THEMES) {
    it.each(ACCENT_SWATCHES.map((s) => [s.name, s.hex] as const))(`%s on ${theme.id}`, (_name, hex) => {
      const derived = deriveAccent(theme.tokens, theme.kind, hex)
      const surface = must(parseColor(theme.tokens.surface))
      expect(contrastRatio(must(parseColor(derived.accent)), surface)).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(must(parseColor(derived['accent-text'])), surface)).toBeGreaterThanOrEqual(4.5)
      // The tints keep the theme's own alpha, on the derived accent.
      const soft = must(parseColor(derived['accent-soft']))
      expect(soft.a).toBe(must(parseColor(theme.tokens['accent-soft'])).a)
      expect(formatColor({ ...soft, a: 1 })).toBe(derived.accent)
    })
  }

  it('leaves an accent that already reads alone', () => {
    const nocturne = must(BUILTIN_THEMES.find((t) => t.id === 'nocturne'))
    expect(deriveAccent(nocturne.tokens, 'dark', '#d9a066').accent).toBe('#d9a066')
  })

  it('darkens one that does not, on a light theme', () => {
    const daylight = must(BUILTIN_THEMES.find((t) => t.id === 'daylight'))
    const accent = deriveAccent(daylight.tokens, 'light', '#d9a066').accent
    expect(accent).not.toBe('#d9a066')
    expect(must(parseColor(accent)).r).toBeLessThan(0xd9)
  })
})

describe('resolveTheme', () => {
  const choice = (over: Partial<ThemeChoice>): ThemeChoice => ({
    preference: 'system',
    systemDark: true,
    themeDark: 'nocturne',
    themeLight: 'daylight',
    accentColor: null,
    ...over
  })
  const user = (): ThemeDefinition => {
    const parsed = parseThemeFile('ink.json', JSON.stringify({ kind: 'dark', colors: { bg: '#000000' } }))
    if (!parsed.ok) throw new Error(parsed.message)
    return parsed.theme
  }

  it('asks Windows only when the preference is system', () => {
    expect(resolveTheme(choice({ systemDark: true }), []).id).toBe('nocturne')
    expect(resolveTheme(choice({ systemDark: false }), []).id).toBe('daylight')
    expect(resolveTheme(choice({ preference: 'dark', systemDark: false }), []).id).toBe('nocturne')
    expect(resolveTheme(choice({ preference: 'light', systemDark: true }), []).id).toBe('daylight')
  })

  it('shows what each slot names, built-in or not', () => {
    expect(resolveTheme(choice({ themeDark: 'graphite' }), []).id).toBe('graphite')
    const applied = resolveTheme(choice({ themeDark: 'ink' }), [user()])
    expect(applied).toMatchObject({ id: 'ink', kind: 'dark', fallback: false })
    expect(applied.tokens.bg).toBe('#000000')
  })

  it('falls back to the built-in of the slot, not to the other slot, when a theme is gone', () => {
    const applied = resolveTheme(choice({ themeDark: 'ink' }), [])
    expect(applied).toMatchObject({ id: 'nocturne', kind: 'dark', fallback: true })
  })

  it('folds a chosen accent in, and only the accent', () => {
    const plain = resolveTheme(choice({}), [])
    const teal = resolveTheme(choice({ accentColor: '#4fc3b4' }), [])
    expect(teal.tokens.accent).toBe('#4fc3b4')
    expect(teal.tokens.bg).toBe(plain.tokens.bg)
    expect(teal.tokens['accent-fg']).toBe(plain.tokens['accent-fg'])
  })
})

describe('user themes on disk', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'helm-themes-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads every .json file and says why it skipped the rest', () => {
    // Two spellings of one id. Not `Ink` and `ink`: NTFS would make those one file.
    writeFileSync(join(dir, 'My Ink.json'), JSON.stringify({ kind: 'dark' }))
    writeFileSync(join(dir, 'my_ink.json'), JSON.stringify({ kind: 'light' }))
    writeFileSync(join(dir, 'broken.json'), '{')
    writeFileSync(join(dir, 'bom.json'), `\uFEFF${JSON.stringify({ kind: 'light' })}`)
    writeFileSync(join(dir, 'huge.json'), `{"kind":"dark","pad":"${'x'.repeat(70 * 1024)}"}`)
    writeFileSync(join(dir, 'README.md'), '# not a theme')
    mkdirSync(join(dir, 'folder.json'))

    const read = readUserThemes(dir)
    expect(read.themes.map((t) => t.id)).toEqual(['bom', 'my-ink'])
    expect(read.errors.map((e) => e.file).sort()).toEqual(['broken.json', 'huge.json', 'my_ink.json'])
    expect(read.errors.find((e) => e.file === 'my_ink.json')?.message).toMatch(/same id as My Ink.json/)
  })

  it('is no themes, not an error, when the directory is absent', () => {
    expect(readUserThemes(join(dir, 'nope'))).toEqual({ themes: [], errors: [] })
  })

  it('seeds the README once, and never into a directory that exists', () => {
    const fresh = join(dir, 'themes')
    expect(seedThemesDir(fresh)).toEqual({ seeded: true, problem: null })
    expect(readFileSync(join(fresh, 'README.md'), 'utf8')).toBe(THEMES_README)
    writeFileSync(join(fresh, 'README.md'), 'edited')
    expect(seedThemesDir(fresh)).toEqual({ seeded: false, problem: null })
    expect(readFileSync(join(fresh, 'README.md'), 'utf8')).toBe('edited')
  })

  it('writes a duplicate that reads back as the same palette, without overwriting', () => {
    const graphite = must(BUILTIN_THEMES.find((t) => t.id === 'graphite'))
    const first = writeThemeCopy(dir, graphite)
    const second = writeThemeCopy(dir, graphite)
    expect(first.endsWith('graphite-copy.json')).toBe(true)
    expect(second.endsWith('graphite-copy-2.json')).toBe(true)
    expect(existsSync(first) && existsSync(second)).toBe(true)

    const read = readUserThemes(dir)
    expect(read.errors).toEqual([])
    const copy = must(read.themes.find((t) => t.id === 'graphite-copy'))
    expect(copy).toMatchObject({ name: 'Graphite copy', kind: 'dark', problems: [] })
    expect(copy.tokens).toEqual(graphite.tokens)
  })
})
