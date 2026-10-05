import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommandPalette, commandScore, type PaletteCommand } from './CommandPalette'

/**
 * Ctrl+Shift+P: the plugins' commands, by a few letters of a name.
 *
 * The ranking is the whole of what a palette is for, so it is pinned here
 * case by case; the dialog then runs the one the arrows or the pointer chose.
 */

const COMMANDS: PaletteCommand[] = [
  { key: 'beta/new', title: 'New item', source: 'Beta' },
  { key: 'alpha/refresh', title: 'Refresh items', source: 'Alpha' },
  { key: 'beta/renew', title: 'Renew licence', source: 'Beta' }
]

function palette(commands: PaletteCommand[] = COMMANDS) {
  const onRun = vi.fn()
  const onDismiss = vi.fn()
  render(<CommandPalette commands={commands} onRun={onRun} onDismiss={onDismiss} />)
  return { onRun, onDismiss }
}

const field = (): HTMLElement => screen.getByRole('combobox', { name: 'Command' })
const titles = (): string[] =>
  screen.queryAllByRole('option').map((option) => option.querySelector('.flex-1')?.textContent ?? '')

describe('commandScore', () => {
  it('ranks a prefix, then the start of a word, then anywhere, then the letters in order', () => {
    expect(commandScore('ref', 'Refresh items')).toBe(0)
    expect(commandScore('ite', 'Refresh items')).toBe(1)
    expect(commandScore('res', 'Refresh items')).toBe(2)
    expect(commandScore('rits', 'Refresh items')).toBe(3)
    expect(commandScore('zz', 'Refresh items')).toBeNull()
  })

  it('takes a dash, colon, slash or dot as the start of a word, and an empty query as a match', () => {
    expect(commandScore('item', 'open-item')).toBe(1)
    expect(commandScore('item', 'open:item')).toBe(1)
    expect(commandScore('item', 'open/item')).toBe(1)
    expect(commandScore('item', 'open.item')).toBe(1)
    expect(commandScore('   ', 'anything')).toBe(0)
  })
})

describe('CommandPalette', () => {
  it('lists every command with nothing typed, by plugin and then by name', () => {
    palette()
    expect(titles()).toEqual(['Refresh items', 'New item', 'Renew licence'])
  })

  it('ranks what is typed, and finds a command by its plugin after its own name', () => {
    palette()
    fireEvent.change(field(), { target: { value: 're' } })
    expect(titles()).toEqual(['Refresh items', 'Renew licence'])
    fireEvent.change(field(), { target: { value: 'beta' } })
    expect(titles()).toEqual(['New item', 'Renew licence'])
  })

  it('runs the highlighted one on Enter, walking with the arrows and wrapping', () => {
    const { onRun } = palette()
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onRun).toHaveBeenLastCalledWith('beta/new')
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onRun).toHaveBeenLastCalledWith('beta/renew')
  })

  it('marks the highlighted row, and the pointer moves it', () => {
    palette()
    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false'])
    fireEvent.mouseMove(options[2]!)
    expect(screen.getAllByRole('option')[2]!.getAttribute('aria-selected')).toBe('true')
    expect(field().getAttribute('aria-activedescendant')).toBe(options[2]!.id)
  })

  it('runs a row clicked', () => {
    const { onRun } = palette()
    fireEvent.click(screen.getByRole('option', { name: /New item/ }))
    expect(onRun).toHaveBeenCalledWith('beta/new')
  })

  it('says when no plugin has a command', () => {
    palette([])
    expect(screen.getByText('No commands. Plugins add theirs to this list.')).toBeTruthy()
  })

  it('says what matched nothing, and Enter then runs nothing', () => {
    const { onRun } = palette()
    fireEvent.change(field(), { target: { value: 'zzz' } })
    expect(screen.getByText('No command matches “zzz”.')).toBeTruthy()
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onRun).not.toHaveBeenCalled()
  })

  it('closes on Escape', () => {
    const { onDismiss } = palette()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalled()
  })
})
