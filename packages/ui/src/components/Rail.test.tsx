import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { overlayOpen } from '../lib/overlay'
import { Rail, type RailItem } from './Rail'

const item = (id: string, extra: Partial<RailItem> = {}): RailItem => ({
  id,
  label: id[0]!.toUpperCase() + id.slice(1),
  icon: <span />,
  kind: 'page',
  current: false,
  onSelect: vi.fn(),
  ...extra
})

const GROUPS = [
  [item('sessions'), item('profiles'), item('files'), item('history')],
  [item('browser'), item('config')]
]
const FOOTER = [item('settings', { hideable: false })]

/** The rail as `App` holds it: the hidden set is state the menu's ticks change. */
function Harness({ initial = [] }: { initial?: string[] }): React.JSX.Element {
  const [hidden, setHidden] = useState(() => new Set(initial))
  return (
    <Rail
      groups={GROUPS}
      footer={FOOTER}
      hidden={hidden}
      onToggleHidden={(id) =>
        setHidden((current) => {
          const next = new Set(current)
          if (!next.delete(id)) next.add(id)
          return next
        })
      }
    />
  )
}

const buttons = (): string[] =>
  within(screen.getByRole('navigation', { name: 'Destinations' }))
    .getAllByRole('button')
    .map((button) => button.getAttribute('data-rail') ?? '')

const rules = (): number => screen.getByRole('navigation', { name: 'Destinations' }).querySelectorAll('span.h-px').length

describe('Rail', () => {
  it('draws the destinations in the order given, with a rule between groups and Settings at the foot', () => {
    render(<Harness />)
    expect(buttons()).toEqual(['sessions', 'profiles', 'files', 'history', 'browser', 'config', 'settings'])
    expect(rules()).toBe(1)
  })

  it('lists every destination with a tick on right-click, and an untick hides it until it is ticked again', () => {
    render(<Harness />)
    fireEvent.contextMenu(screen.getByRole('navigation', { name: 'Destinations' }), { clientX: 20, clientY: 40 })
    const menu = screen.getByRole('menu', { name: 'Show on the rail' })
    const ticks = within(menu).getAllByRole('menuitemcheckbox')
    expect(ticks.map((tick) => tick.textContent)).toEqual([
      'Sessions',
      'Profiles',
      'Files',
      'History',
      'Browser',
      'Config',
      'Settings'
    ])
    expect(ticks.every((tick) => tick.getAttribute('aria-checked') === 'true')).toBe(true)
    // A browser tab's native view hides while the menu is up, as for a dialog.
    expect(overlayOpen()).toBe(true)

    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'History' }))
    // Several can be changed in one visit, so the menu stays.
    expect(within(menu).getByRole('menuitemcheckbox', { name: 'History' }).getAttribute('aria-checked')).toBe('false')
    expect(buttons()).not.toContain('history')

    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'History' }))
    expect(buttons()).toContain('history')

    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(overlayOpen()).toBe(false)
  })

  it('keeps Settings: ticked, disabled, and a click on it changes nothing', () => {
    render(<Harness />)
    fireEvent.contextMenu(screen.getByRole('navigation', { name: 'Destinations' }))
    const settings = screen.getByRole('menuitemcheckbox', { name: 'Settings' })
    expect(settings.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(settings)
    expect(buttons()).toContain('settings')
  })

  it('drops a group’s rule along with its last destination, so two rules never touch', () => {
    render(<Harness initial={['browser', 'config']} />)
    expect(buttons()).toEqual(['sessions', 'profiles', 'files', 'history', 'settings'])
    expect(rules()).toBe(0)
  })

  it('closes on a press anywhere else', () => {
    render(<Harness />)
    fireEvent.contextMenu(screen.getByRole('navigation', { name: 'Destinations' }))
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('Rail: a count on a destination', () => {
  const rail = (badge: number | null | undefined): HTMLElement => {
    render(<Rail groups={[[item('plugin:sample', { label: 'Sample', kind: 'view', badge })]]} />)
    return screen.getByRole('button', { name: /^Sample/ })
  }

  it('is drawn on the button and said in its name', () => {
    const button = rail(3)
    expect(button.querySelector('[data-rail-badge]')?.textContent).toBe('3')
    expect(button.getAttribute('aria-label')).toBe('Sample, 3')
    // The tooltip stays the destination's name.
    expect(button.getAttribute('title')).toBe('Sample')
  })

  it('stops at 99+, which is as much as the mark can hold', () => {
    expect(rail(1234).querySelector('[data-rail-badge]')?.textContent).toBe('99+')
  })

  it.each([0, null, undefined])('is not drawn for %s', (badge) => {
    const button = rail(badge)
    expect(button.querySelector('[data-rail-badge]')).toBeNull()
    expect(button.getAttribute('aria-label')).toBe('Sample')
  })
})
