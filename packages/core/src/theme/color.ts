/**
 * Colour values for themes.
 *
 * A theme file is something a person writes by hand, and every value in it ends
 * up as a CSS custom property on the window and, for two of them, as the colour
 * Windows paints its own title-bar buttons with. So a value is parsed into
 * numbers here and written back out in one canonical spelling, and nothing a
 * file says reaches either place as the text it was typed as. A value that does
 * not parse is not a colour, whatever a browser might have made of it.
 *
 * Pure: no DOM, no Node. The renderer may import this through `@helm/core/types`.
 */

/** Channels 0-255, alpha 0-1. Always whole numbers on the channels. */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const FUNCTIONAL = /^rgba?\(([^()]*)\)$/i

/**
 * `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(r g b)`, `rgb(r g b / a)`,
 * `rgb(r, g, b)` and `rgba(r, g, b, a)`. Alpha may be a fraction or a
 * percentage. Anything else - a name, `hsl()`, a channel past 255 - is null.
 *
 * Names are refused on purpose rather than for want of a table: `red` in a
 * theme is almost always a placeholder somebody meant to come back to, and a
 * file that names the twenty colours a palette is made of is better off saying
 * them in one notation the next person can compare by eye.
 */
export function parseColor(input: string): Rgba | null {
  const text = input.trim()
  const hex = HEX.exec(text)
  if (hex) return fromHex(hex[1] ?? '')
  const fn = FUNCTIONAL.exec(text)
  if (fn) return fromFunctional(fn[1] ?? '')
  return null
}

function fromHex(digits: string): Rgba {
  const full =
    digits.length <= 4
      ? digits
          .split('')
          .map((d) => d + d)
          .join('')
      : digits
  const channel = (i: number): number => parseInt(full.slice(i * 2, i * 2 + 2), 16)
  return {
    r: channel(0),
    g: channel(1),
    b: channel(2),
    a: full.length === 8 ? roundAlpha(channel(3) / 255) : 1
  }
}

function fromFunctional(body: string): Rgba | null {
  const parts = body
    .trim()
    .split(/\s*[,/]\s*|\s+/)
    .filter((p) => p !== '')
  if (parts.length !== 3 && parts.length !== 4) return null
  const channels = parts.slice(0, 3).map(parseChannel)
  const [r, g, b] = channels
  if (r === undefined || g === undefined || b === undefined) return null
  if (r === null || g === null || b === null) return null
  const alphaText = parts[3]
  const a = alphaText === undefined ? 1 : parseAlpha(alphaText)
  if (a === null) return null
  return { r, g, b, a }
}

const NUMBER = /^\d+(\.\d+)?$|^\.\d+$/

function parseChannel(text: string): number | null {
  if (!NUMBER.test(text)) return null
  const value = Number(text)
  return value <= 255 ? Math.round(value) : null
}

function parseAlpha(text: string): number | null {
  const percent = text.endsWith('%')
  const digits = percent ? text.slice(0, -1) : text
  if (!NUMBER.test(digits)) return null
  const value = Number(digits) / (percent ? 100 : 1)
  return value <= 1 ? roundAlpha(value) : null
}

/** Three places is past what any display distinguishes and keeps the text short. */
function roundAlpha(a: number): number {
  return Math.round(a * 1000) / 1000
}

/** `#rrggbb` when opaque, `rgb(r g b / a)` otherwise. The only spellings written out. */
export function formatColor(c: Rgba): string {
  if (c.a >= 1) {
    return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
  }
  return `rgb(${String(c.r)} ${String(c.g)} ${String(c.b)} / ${String(roundAlpha(c.a))})`
}

/** The same colour at a different alpha. */
export function withAlpha(c: Rgba, a: number): Rgba {
  return { r: c.r, g: c.g, b: c.b, a: roundAlpha(Math.min(1, Math.max(0, a))) }
}

/** `t` of the way from `from` to `to`, opaque. Mixed in sRGB, which is what CSS paints. */
export function mix(from: Rgba, to: Rgba, t: number): Rgba {
  const k = Math.min(1, Math.max(0, t))
  const lerp = (x: number, y: number): number => Math.round(x + (y - x) * k)
  return { r: lerp(from.r, to.r), g: lerp(from.g, to.g), b: lerp(from.b, to.b), a: 1 }
}

/** WCAG 2 relative luminance of the opaque colour. */
export function luminance(c: Rgba): number {
  const linear = (v: number): number => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b)
}

/** WCAG 2 contrast ratio, 1 to 21. Alpha is ignored: callers pass opaque colours. */
export function contrastRatio(x: Rgba, y: Rgba): number {
  const a = luminance(x)
  const b = luminance(y)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
