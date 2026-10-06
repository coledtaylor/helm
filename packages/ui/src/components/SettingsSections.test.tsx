import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SETTINGS_SECTIONS, SettingsSections, pluginSection } from './SettingsSections'

describe('SettingsSections', () => {
  it('lists every section in order, marks the one on screen, and picks another', () => {
    const onSelect = vi.fn()
    render(<SettingsSections current="terminal" onSelect={onSelect} />)
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    const rows = [...nav.querySelectorAll('button')]
    expect(rows.map((row) => row.textContent)).toEqual(SETTINGS_SECTIONS.map((section) => section.label))
    expect(rows.filter((row) => row.getAttribute('aria-current') === 'page').map((row) => row.textContent)).toEqual([
      'Terminal'
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Browser' }))
    expect(onSelect).toHaveBeenCalledWith('browser')
  })
})

describe("SettingsSections: each plugin's page", () => {
  // Folders as Windows writes them: a path with backslashes is the common case.
  const SAMPLE = String.raw`C:\plugins\sample`
  const OFF = String.raw`C:\plugins\off`
  const plugins = [
    { path: SAMPLE, name: 'Sample', state: 'on' as const },
    { path: OFF, name: 'Off one', state: 'off' as const },
    { path: String.raw`C:\plugins\broken`, name: 'Broken', state: 'error' as const }
  ]

  it('lists every plugin under Plugins, saying which are off or failed, and opens one', () => {
    const onSelect = vi.fn()
    render(<SettingsSections current={pluginSection(OFF)} onSelect={onSelect} plugins={plugins} />)
    const rows = [...screen.getByRole('navigation', { name: 'Settings sections' }).querySelectorAll('button')].map(
      (row) => row.textContent
    )
    const at = rows.indexOf('Plugins')
    expect(rows.slice(at, at + 5)).toEqual(['Plugins', 'Sample', 'Off oneOff', 'BrokenNot loaded', 'Secrets'])
    const off = screen.getByRole('button', { name: /^Off one/ })
    expect(off.getAttribute('aria-current')).toBe('page')
    expect(off.getAttribute('title')).toBe(OFF)
    // The plugin's page is chosen, not Plugins itself.
    expect(screen.getByRole('button', { name: 'Plugins' }).getAttribute('aria-current')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Sample' }))
    expect(onSelect).toHaveBeenCalledWith(`plugin:${SAMPLE}`)
  })

  it('lists no plugins when there are none', () => {
    render(<SettingsSections current="plugins" onSelect={vi.fn()} plugins={[]} />)
    const rows = [...screen.getByRole('navigation', { name: 'Settings sections' }).querySelectorAll('button')]
    expect(rows.map((row) => row.textContent)).toEqual(SETTINGS_SECTIONS.map((section) => section.label))
  })
})
