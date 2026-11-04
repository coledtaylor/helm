import { hueForText, type PaletteHue } from '@helm/core/types'

/**
 * A palette tag's classes, per hue (DESIGN.md "The categorical palette"): the
 * hue's tint behind the hue's text, and no border - the state chip stays the
 * one pill with a coloured edge.
 *
 * Spelled out in full because Tailwind finds classes by reading the source;
 * a class built from a template string would never be generated. The tint's
 * weights are `HUE_TINT_ALPHA`, the ones the floors in `theme.test.ts` are
 * measured at: 10% on a light theme, 14% on a dark one (`hues.test.ts` holds
 * the two together).
 */
const PALETTE_TAG: Readonly<Record<PaletteHue, string>> = {
  blue: 'bg-hue-blue/10 text-hue-blue dark:bg-hue-blue/14',
  teal: 'bg-hue-teal/10 text-hue-teal dark:bg-hue-teal/14',
  green: 'bg-hue-green/10 text-hue-green dark:bg-hue-green/14',
  amber: 'bg-hue-amber/10 text-hue-amber dark:bg-hue-amber/14',
  orange: 'bg-hue-orange/10 text-hue-orange dark:bg-hue-orange/14',
  red: 'bg-hue-red/10 text-hue-red dark:bg-hue-red/14',
  pink: 'bg-hue-pink/10 text-hue-pink dark:bg-hue-pink/14',
  violet: 'bg-hue-violet/10 text-hue-violet dark:bg-hue-violet/14'
}

/** The classes that draw a palette tag in `hue`. */
export function paletteTagClass(hue: PaletteHue): string {
  return PALETTE_TAG[hue]
}

/** The hue a tag's text is drawn in, and its classes: the same text, the same colour, everywhere. */
export function tagHue(text: string): { hue: PaletteHue; className: string } {
  const hue = hueForText(text)
  return { hue, className: PALETTE_TAG[hue] }
}
