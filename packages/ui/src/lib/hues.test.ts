import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HUE_TINT_ALPHA, hueForText, PALETTE_HUES } from '@helm/core/types'
import { paletteTagClass, tagHue } from './hues'

describe('palette tag classes', () => {
  it.each(PALETTE_HUES.map((hue) => [hue] as const))('draw a %s tag in its own hue at the measured tint', (hue) => {
    expect(paletteTagClass(hue).split(' ').sort()).toEqual(
      [
        `bg-hue-${hue}/${String(Math.round(HUE_TINT_ALPHA.light * 100))}`,
        `dark:bg-hue-${hue}/${String(Math.round(HUE_TINT_ALPHA.dark * 100))}`,
        `text-hue-${hue}`
      ].sort()
    )
  })

  it('pick the hue from the tag’s text', () => {
    expect(tagHue('floti')).toEqual({ hue: hueForText('floti'), className: paletteTagClass(hueForText('floti')) })
  })

  it('have a Tailwind colour for every hue', () => {
    const css = readFileSync(join(import.meta.dirname, '../styles/theme.css'), 'utf8')
    for (const hue of PALETTE_HUES) expect(css).toContain(`--color-hue-${hue}: var(--helm-hue-${hue});`)
  })
})
