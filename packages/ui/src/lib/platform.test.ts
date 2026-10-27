import { describe, expect, it } from 'vitest'
import { hasPrimaryModifier, hostOs, isMac, shortcutLabel } from './platform'

describe('hostOs', () => {
  it('reads the client hint first, then navigator.platform', () => {
    expect(hostOs({ userAgentData: { platform: 'macOS' }, platform: 'Win32' })).toBe('darwin')
    expect(hostOs({ userAgentData: { platform: 'Windows' } })).toBe('win32')
    expect(hostOs({ userAgentData: { platform: 'Linux' } })).toBe('linux')
    expect(hostOs({ userAgentData: { platform: '' }, platform: 'MacIntel' })).toBe('darwin')
    expect(hostOs({ platform: 'Win32' })).toBe('win32')
    expect(hostOs({ platform: 'Linux x86_64' })).toBe('linux')
  })

  it('treats a navigator that says nothing as not a Mac', () => {
    expect(hostOs({})).toBe('linux')
    expect(hostOs(undefined)).toBe('linux')
    expect(isMac({ platform: '' })).toBe(false)
    expect(isMac({ platform: 'MacIntel' })).toBe(true)
  })
})

describe('hasPrimaryModifier', () => {
  it('on macOS a Helm shortcut is Cmd, and the same chord with Ctrl is not Helm’s', () => {
    expect(hasPrimaryModifier({ metaKey: true, ctrlKey: false }, true)).toBe(true)
    expect(hasPrimaryModifier({ metaKey: false, ctrlKey: true }, true)).toBe(false)
    expect(hasPrimaryModifier({ metaKey: true, ctrlKey: true }, true)).toBe(false)
  })

  it('on Windows and Linux every shortcut stays on Ctrl', () => {
    expect(hasPrimaryModifier({ metaKey: false, ctrlKey: true }, false)).toBe(true)
    expect(hasPrimaryModifier({ metaKey: true, ctrlKey: false }, false)).toBe(false)
    expect(hasPrimaryModifier({ metaKey: true, ctrlKey: true }, false)).toBe(false)
  })
})

describe('shortcutLabel', () => {
  it('names Cmd on macOS, in Apple’s glyphs and modifier order', () => {
    expect(shortcutLabel('P', { mac: true })).toBe('⌘P')
    expect(shortcutLabel('F', { shift: true, mac: true })).toBe('⇧⌘F')
    expect(shortcutLabel('I', { shift: true, alt: true, mac: true })).toBe('⌥⇧⌘I')
    expect(shortcutLabel('N', { separator: ' ', mac: true })).toBe('⌘N')
  })

  it('reads Ctrl on Windows and Linux, as today', () => {
    expect(shortcutLabel('P', { mac: false })).toBe('Ctrl+P')
    expect(shortcutLabel('F', { shift: true, mac: false })).toBe('Ctrl+Shift+F')
    expect(shortcutLabel('=', { separator: ' ', mac: false })).toBe('Ctrl =')
    expect(shortcutLabel('↵', { separator: ' ', mac: false })).toBe('Ctrl ↵')
  })
})
