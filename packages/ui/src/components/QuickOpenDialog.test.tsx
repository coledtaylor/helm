import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { FileListing } from '@helm/core'
import { QuickOpenDialog } from './QuickOpenDialog'

const LISTING: FileListing = {
  root: 'C:\\p',
  files: ['packages/ui/src/components/TabBar.tsx', 'packages/ui/src/components/TabBar.test.tsx', 'README.md', 'docs/notes.md'],
  source: 'git',
  truncated: false,
  error: null
}

const field = (): HTMLInputElement => screen.getByRole('combobox', { name: 'File name' }) as HTMLInputElement
const options = (): string[] => screen.queryAllByRole('option').map((option) => option.getAttribute('aria-label') ?? '')

describe('QuickOpenDialog', () => {
  it('ranks the project’s files by what is typed and opens the best on Enter', () => {
    const onOpen = vi.fn()
    render(<QuickOpenDialog rootLabel="p" listing={LISTING} recent={[]} onOpen={onOpen} onDismiss={vi.fn()} />)
    fireEvent.change(field(), { target: { value: 'tabbar' } })
    expect(options()).toEqual(['packages/ui/src/components/TabBar.tsx', 'packages/ui/src/components/TabBar.test.tsx'])
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledWith('packages/ui/src/components/TabBar.tsx')
  })

  it('walks the list with the arrows, wrapping, and opens a row on a click', () => {
    const onOpen = vi.fn()
    render(<QuickOpenDialog rootLabel="p" listing={LISTING} recent={[]} onOpen={onOpen} onDismiss={vi.fn()} />)
    fireEvent.change(field(), { target: { value: 'tabbar' } })
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onOpen).toHaveBeenLastCalledWith('packages/ui/src/components/TabBar.test.tsx')
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('option', { name: 'packages/ui/src/components/TabBar.test.tsx' }))
    expect(onOpen).toHaveBeenLastCalledWith('packages/ui/src/components/TabBar.test.tsx')
  })

  it('offers what was opened lately before anything is typed, and only files still in the project', () => {
    render(
      <QuickOpenDialog rootLabel="p" listing={LISTING} recent={['README.md', 'gone.ts']} onOpen={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.getByText('Recently opened')).toBeTruthy()
    expect(options()).toEqual(['README.md'])
  })

  it('says it is listing, and says when nothing matches', () => {
    const { rerender } = render(
      <QuickOpenDialog rootLabel="p" listing={null} recent={[]} onOpen={vi.fn()} onDismiss={vi.fn()} />
    )
    expect(screen.getByText('Listing p…')).toBeTruthy()
    rerender(<QuickOpenDialog rootLabel="p" listing={LISTING} recent={[]} onOpen={vi.fn()} onDismiss={vi.fn()} />)
    fireEvent.change(field(), { target: { value: 'zzz' } })
    expect(screen.getByText('No file in p matches “zzz”.')).toBeTruthy()
  })

  it('closes on Escape', () => {
    const onDismiss = vi.fn()
    render(<QuickOpenDialog rootLabel="p" listing={LISTING} recent={[]} onOpen={vi.fn()} onDismiss={onDismiss} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onDismiss).toHaveBeenCalled()
  })
})
