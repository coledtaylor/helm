import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SETTINGS_SECTIONS, SettingsSections } from './SettingsSections'

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
    fireEvent.click(screen.getByRole('button', { name: 'GitHub' }))
    expect(onSelect).toHaveBeenCalledWith('github')
  })
})
