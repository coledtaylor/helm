import { describe, expect, it } from 'vitest'
import { browserKeyCommand, type BrowserKey } from '../shared/browserKeys'

/** A press, unmodified unless said. */
const press = (key: string, mods: Partial<Omit<BrowserKey, 'key'>> = {}): BrowserKey => ({
  key,
  control: false,
  shift: false,
  alt: false,
  meta: false,
  ...mods
})

describe('browserKeyCommand', () => {
  it('maps the bindings every browser on Windows has', () => {
    const table: Array<[BrowserKey, string]> = [
      [press('t', { control: true }), 'new-page'],
      [press('w', { control: true }), 'close-page'],
      [press('F4', { control: true }), 'close-page'],
      [press('T', { control: true, shift: true }), 'reopen-page'],
      [press('f', { control: true }), 'find'],
      [press('l', { control: true }), 'address'],
      [press('r', { control: true }), 'reload'],
      [press('F5'), 'reload'],
      [press('R', { control: true, shift: true }), 'hard-reload'],
      [press('F5', { shift: true }), 'hard-reload'],
      [press('F5', { control: true }), 'hard-reload'],
      [press('ArrowLeft', { alt: true }), 'back'],
      [press('ArrowRight', { alt: true }), 'forward'],
      [press('=', { control: true }), 'zoom-in'],
      [press('+', { control: true, shift: true }), 'zoom-in'],
      [press('-', { control: true }), 'zoom-out'],
      [press('0', { control: true }), 'zoom-reset'],
      [press('F12'), 'devtools'],
      [press('I', { control: true, shift: true }), 'devtools']
    ]
    for (const [key, command] of table) expect(browserKeyCommand(key), JSON.stringify(key)).toBe(command)
  })

  it('leaves everything else to the page, AltGr and Ctrl+N included', () => {
    const theirs = [
      press('n', { control: true }),
      press('t'),
      press('w', { control: true, alt: true }),
      press('l', { control: true, meta: true }),
      press('ArrowLeft'),
      press('ArrowLeft', { alt: true, shift: true }),
      press('a', { control: true }),
      press('Escape'),
      press('F12', { shift: true }),
      press('w', { control: true, shift: true })
    ]
    for (const key of theirs) expect(browserKeyCommand(key), JSON.stringify(key)).toBeNull()
  })
})
