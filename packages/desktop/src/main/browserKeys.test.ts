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

describe('browserKeyCommand on Windows and Linux', () => {
  const windowsTable: Array<[BrowserKey, string]> = [
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

  it('maps the bindings every browser on Windows has, unchanged', () => {
    for (const platform of ['win32', 'linux']) {
      for (const [key, command] of windowsTable) {
        expect(browserKeyCommand(key, platform), `${platform} ${JSON.stringify(key)}`).toBe(command)
      }
    }
  })

  it('leaves everything else to the page, AltGr, Cmd and Ctrl+N included', () => {
    const theirs = [
      press('n', { control: true }),
      press('t'),
      press('w', { control: true, alt: true }),
      press('l', { control: true, meta: true }),
      press('t', { meta: true }),
      press('[', { meta: true }),
      press('ArrowLeft'),
      press('ArrowLeft', { alt: true, shift: true }),
      press('a', { control: true }),
      press('Escape'),
      press('F12', { shift: true }),
      press('w', { control: true, shift: true })
    ]
    for (const key of theirs) expect(browserKeyCommand(key, 'win32'), JSON.stringify(key)).toBeNull()
  })
})

describe('browserKeyCommand on macOS', () => {
  it('maps the Cmd bindings every Mac browser has', () => {
    const table: Array<[BrowserKey, string]> = [
      [press('t', { meta: true }), 'new-page'],
      [press('w', { meta: true }), 'close-page'],
      [press('T', { meta: true, shift: true }), 'reopen-page'],
      [press('l', { meta: true }), 'address'],
      [press('f', { meta: true }), 'find'],
      [press('r', { meta: true }), 'reload'],
      [press('R', { meta: true, shift: true }), 'hard-reload'],
      [press('[', { meta: true }), 'back'],
      [press(']', { meta: true }), 'forward'],
      [press('=', { meta: true }), 'zoom-in'],
      [press('+', { meta: true, shift: true }), 'zoom-in'],
      [press('-', { meta: true }), 'zoom-out'],
      [press('0', { meta: true }), 'zoom-reset'],
      // Option changes the character the key types; the physical key decides.
      [press('ˆ', { meta: true, alt: true, code: 'KeyI' }), 'devtools'],
      [press('Dead', { meta: true, alt: true, code: 'KeyI' }), 'devtools'],
      [press('i', { meta: true, alt: true }), 'devtools']
    ]
    for (const [key, command] of table) expect(browserKeyCommand(key, 'darwin'), JSON.stringify(key)).toBe(command)
  })

  it('gives Ctrl chords, Option-typed characters and every Windows-only binding to the page', () => {
    const theirs = [
      // The Windows table's chords, with Ctrl: a Mac page's own.
      press('t', { control: true }),
      press('w', { control: true }),
      press('l', { control: true }),
      press('r', { control: true }),
      press('I', { control: true, shift: true }),
      // Ctrl and Cmd together.
      press('t', { control: true, meta: true }),
      // Characters typed with Option, and Option+Arrow moving the caret a word.
      press('ø', { alt: true, code: 'KeyO' }),
      press('ArrowLeft', { alt: true }),
      press('ArrowRight', { alt: true }),
      // Function keys are not a Mac browser's.
      press('F5'),
      press('F12'),
      // Cmd chords that are the page's.
      press('n', { meta: true }),
      press('a', { meta: true }),
      press('c', { meta: true }),
      press('ArrowLeft', { meta: true }),
      press('i', { meta: true, alt: true, shift: true }),
      press('w', { meta: true, alt: true })
    ]
    for (const key of theirs) expect(browserKeyCommand(key, 'darwin'), JSON.stringify(key)).toBeNull()
  })
})
