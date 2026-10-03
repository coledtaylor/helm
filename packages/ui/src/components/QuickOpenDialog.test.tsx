import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentSearchResult, FileListing } from '@helm/core'
import { QuickOpenDialog, type QuickOpenDialogProps } from './QuickOpenDialog'

const LISTING: FileListing = {
  root: 'C:\\p',
  files: ['packages/ui/src/components/TabBar.tsx', 'packages/ui/src/components/TabBar.test.tsx', 'README.md', 'docs/notes.md'],
  source: 'git',
  truncated: false,
  error: null
}

const field = (): HTMLInputElement => screen.getByRole('combobox') as HTMLInputElement
const options = (): string[] => screen.queryAllByRole('option').map((option) => option.getAttribute('aria-label') ?? '')

function dialog(overrides: Partial<QuickOpenDialogProps> = {}): QuickOpenDialogProps {
  return {
    rootLabel: 'p',
    listing: LISTING,
    recent: [],
    onSearchText: vi.fn(() => Promise.resolve(null)),
    onOpen: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides
  }
}

describe('QuickOpenDialog: names', () => {
  it('ranks the project’s files by what is typed and opens the best on Enter', () => {
    const props = dialog()
    render(<QuickOpenDialog {...props} />)
    fireEvent.change(field(), { target: { value: 'tabbar' } })
    expect(options()).toEqual(['packages/ui/src/components/TabBar.tsx', 'packages/ui/src/components/TabBar.test.tsx'])
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(props.onOpen).toHaveBeenCalledWith('packages/ui/src/components/TabBar.tsx')
  })

  it('walks the list with the arrows, wrapping, and opens a row on a click', () => {
    const props = dialog()
    render(<QuickOpenDialog {...props} />)
    fireEvent.change(field(), { target: { value: 'tabbar' } })
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(props.onOpen).toHaveBeenLastCalledWith('packages/ui/src/components/TabBar.test.tsx')
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(screen.getByRole('option', { name: 'packages/ui/src/components/TabBar.test.tsx' }))
    expect(props.onOpen).toHaveBeenLastCalledWith('packages/ui/src/components/TabBar.test.tsx')
  })

  it('offers what was opened lately before anything is typed, and only files still in the project', () => {
    render(<QuickOpenDialog {...dialog({ recent: ['README.md', 'gone.ts'] })} />)
    expect(screen.getByText('Recently opened')).toBeTruthy()
    expect(options()).toEqual(['README.md'])
  })

  it('says it is listing, and says when nothing matches', () => {
    const { rerender } = render(<QuickOpenDialog {...dialog({ listing: null })} />)
    expect(screen.getByText('Listing p…')).toBeTruthy()
    rerender(<QuickOpenDialog {...dialog()} />)
    fireEvent.change(field(), { target: { value: 'zzz' } })
    expect(screen.getByText('No file in p matches “zzz”.')).toBeTruthy()
  })

  it('closes on Escape', () => {
    const props = dialog()
    render(<QuickOpenDialog {...props} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(props.onDismiss).toHaveBeenCalled()
  })
})

const RESULT: ContentSearchResult = {
  query: 'geofenc',
  hits: [
    {
      path: 'C:\\p\\docs\\notes.md',
      relPath: 'docs/notes.md',
      root: 'docs',
      title: 'Notes',
      matches: 2,
      nameMatch: false,
      lines: [
        { line: 3, text: 'The geofence is drawn first.', from: 4, to: 11 },
        { line: 9, text: 'geofencing again', from: 0, to: 7 }
      ]
    },
    { path: 'C:\\p\\geofence.ts', relPath: 'geofence.ts', root: '', title: 'geofence.ts', matches: 0, nameMatch: true, lines: [] }
  ],
  filesSearched: 40,
  bodyKinds: ['markdown', 'data', 'text', 'source'],
  filesWithText: 38,
  bytesSearched: 1000,
  totalMatches: 2,
  tookMs: 1.2,
  cold: false,
  truncated: false
}

describe('QuickOpenDialog: text', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** Past the debounce, and the search's promise settled. */
  async function settle(): Promise<void> {
    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })
  }

  it('searches once typing pauses, lists each matching line under its file, and opens on the line', async () => {
    const onSearchText = vi.fn(() => Promise.resolve(RESULT))
    const props = dialog({ initialMode: 'text', onSearchText })
    render(<QuickOpenDialog {...props} />)
    expect(screen.getByRole('radio', { name: 'Text' }).getAttribute('aria-checked')).toBe('true')

    fireEvent.change(field(), { target: { value: 'geo' } })
    fireEvent.change(field(), { target: { value: 'geofenc' } })
    await settle()
    // One search, for what was typed once the typing stopped.
    expect(onSearchText).toHaveBeenCalledTimes(1)
    expect(onSearchText).toHaveBeenCalledWith('geofenc')

    expect(options()).toEqual([
      'docs/notes.md line 3: The geofence is drawn first.',
      'docs/notes.md line 9: geofencing again',
      'geofence.ts: name matches'
    ])
    expect(screen.getByText('2 matches in 2 files · 40 searched')).toBeTruthy()

    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(props.onOpen).toHaveBeenCalledWith('docs/notes.md', { line: 9, term: 'geofenc' })

    // A file that matched only by name opens where it starts.
    fireEvent.click(screen.getByRole('option', { name: 'geofence.ts: name matches' }))
    expect(props.onOpen).toHaveBeenLastCalledWith('geofence.ts', undefined)
  })

  it('says when nothing matches, and when the search itself failed', async () => {
    const empty = { ...RESULT, hits: [], totalMatches: 0 }
    const onSearchText = vi.fn((query: string) => Promise.resolve(query === 'broken' ? null : { ...empty, query }))
    render(<QuickOpenDialog {...dialog({ initialMode: 'text', onSearchText })} />)
    fireEvent.change(field(), { target: { value: 'nothing' } })
    await settle()
    expect(screen.getByText('Nothing in p says “nothing”.')).toBeTruthy()
    fireEvent.change(field(), { target: { value: 'broken' } })
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('The search could not run in p.')
  })

  it('switches halves from its own shortcuts and from the switch, keeping what was typed', async () => {
    const onSearchText = vi.fn(() => Promise.resolve(RESULT))
    render(<QuickOpenDialog {...dialog({ onSearchText })} />)
    fireEvent.change(field(), { target: { value: 'notes' } })
    expect(options()).toEqual(['docs/notes.md'])

    fireEvent.keyDown(field(), { key: 'F', ctrlKey: true, shiftKey: true })
    expect(field().getAttribute('aria-label')).toBe('Text to find')
    expect(field().value).toBe('notes')
    await settle()
    expect(onSearchText).toHaveBeenCalledWith('notes')

    fireEvent.click(screen.getByRole('radio', { name: 'Names' }))
    expect(field().getAttribute('aria-label')).toBe('File name')
    expect(options()).toEqual(['docs/notes.md'])
  })
})
