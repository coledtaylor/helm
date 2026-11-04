import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_THEMES, hueToken, PALETTE_HUES, THEME_TOKENS, type AppliedTheme } from '../theme/themes'
import { pluginThemeOf } from './theme'

const applied = (id: string): AppliedTheme => {
  const theme = BUILTIN_THEMES.find((t) => t.id === id)
  if (!theme) throw new Error(`no built-in theme ${id}`)
  return { id: theme.id, name: theme.name, kind: theme.kind, tokens: theme.tokens, shadow: 'none', fallback: false }
}

describe('pluginThemeOf', () => {
  it.each(BUILTIN_THEMES.map((t) => [t.id] as const))('hands a plugin page every palette hue of %s', (id) => {
    const theme = pluginThemeOf(applied(id), { cornerRadius: 3, density: 'compact' })
    for (const hue of PALETTE_HUES) expect(theme.tokens[hueToken(hue)], hue).toBe(applied(id).tokens[hueToken(hue)])
    expect(Object.keys(theme.tokens)).toEqual([...THEME_TOKENS])
  })
})

describe("the plugin SDK's authoring guide", () => {
  const readme = readFileSync(join(import.meta.dirname, '../../../plugin-sdk/README.md'), 'utf8')
  const section = (() => {
    const start = readme.indexOf('## Theme and styling')
    const end = readme.indexOf('\n## ', start + 1)
    if (start < 0) throw new Error('the README has no Theme and styling section')
    return readme.slice(start, end < 0 ? undefined : end)
  })()

  it('names every theme token in Theme and styling', () => {
    for (const token of THEME_TOKENS) expect(section, token).toContain(`\`${token}\``)
  })

  it('names the attribute the primitives take a palette hue by', () => {
    for (const primitive of ['helm-tag', 'helm-chip', 'helm-dot']) {
      const row = section.split('\n').find((line) => line.startsWith(`| \`${primitive}\``))
      expect(row, primitive).toContain('data-hue')
    }
    for (const hue of PALETTE_HUES) expect(section, hue).toContain(`"${hue}"`)
  })
})
