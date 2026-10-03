import { describe, expect, it } from 'vitest'
import { BUILTIN_THEMES, type ThemeState } from '@helm/core/types'
import { applyShape, applyTheme } from './theme'

const stateOf = (id: string): ThemeState => {
  const theme = BUILTIN_THEMES.find((t) => t.id === id)
  if (!theme) throw new Error(`no built-in theme ${id}`)
  return {
    preference: theme.kind,
    resolved: theme.kind,
    applied: { id: theme.id, name: theme.name, kind: theme.kind, tokens: theme.tokens, shadow: '0 1px 2px black', fallback: false }
  }
}

describe('applyTheme', () => {
  it('paints a theme onto <html>: its id, its kind and every token the stylesheet reads', () => {
    const root = document.documentElement

    applyTheme(stateOf('graphite'))
    expect(root.dataset['theme']).toBe('graphite')
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.style.colorScheme).toBe('dark')
    // The canvas the body is painted with, and a glyph colour, from Graphite's palette.
    expect(root.style.getPropertyValue('--helm-bg')).toBe('#25282e')
    expect(root.style.getPropertyValue('--helm-fg-muted')).toBe('#a0a6b0')
    expect(root.style.getPropertyValue('--helm-shadow')).toBe('0 1px 2px black')

    applyTheme(stateOf('daylight'))
    expect(root.dataset['theme']).toBe('daylight')
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.style.colorScheme).toBe('light')
    expect(root.style.getPropertyValue('--helm-bg')).toBe('#e6e8ee')
  })
})

describe('applyShape', () => {
  it('puts the gap, the corner radius and the density on <html>', () => {
    applyShape({ paneGap: 9, cornerRadius: 5, density: 'compact' })
    const root = document.documentElement
    expect(root.style.getPropertyValue('--helm-gap')).toBe('9px')
    expect(root.style.getPropertyValue('--helm-radius')).toBe('5px')
    expect(root.dataset['density']).toBe('compact')

    applyShape({ paneGap: 2, cornerRadius: 0, density: 'comfortable' })
    expect(root.style.getPropertyValue('--helm-gap')).toBe('2px')
    expect(root.style.getPropertyValue('--helm-radius')).toBe('0px')
    expect(root.dataset['density']).toBe('comfortable')
  })
})
