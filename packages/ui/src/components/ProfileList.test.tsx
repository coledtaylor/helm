import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Profile } from '@helm/core/types'
import { ProfileList, type ProfileListProps } from './ProfileList'

const HUB = 'C:\\work\\hub'

const profile = (id: number, name: string, patch: Partial<Profile> = {}): Profile => ({
  id,
  name,
  root: HUB,
  overlays: [],
  access: [],
  model: null,
  effort: null,
  permissionMode: null,
  agent: null,
  mcp: [],
  openingPrompt: null,
  pinnedOrder: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...patch
})

const DEV = profile(1, 'hub dev', { overlays: [`${HUB}\\repos\\tools`], access: [`${HUB}\\repos\\tools`] })
const PLAIN = profile(2, 'plain')

function renderList(overrides: Partial<ProfileListProps> = {}) {
  const props: ProfileListProps = {
    profiles: [DEV, PLAIN],
    harnesses: [{ name: 'hub', path: HUB }],
    onLaunch: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onExport: vi.fn(),
    onTogglePin: vi.fn(),
    onReorder: vi.fn(),
    ...overrides
  }
  render(<ProfileList {...props} />)
  return props
}

const row = (name: RegExp): HTMLElement => screen.getByRole('button', { name })

describe('ProfileList', () => {
  it('lists each saved profile with what it composes and the harness it launches into', () => {
    renderList()
    const list = screen.getByRole('list', { name: 'Saved profiles' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(within(row(/^hub dev/)).getByText('1 composed · 1 access')).toBeTruthy()
    expect(within(row(/^hub dev/)).getByText('hub')).toBeTruthy()
    expect(within(row(/^plain/)).getByText(HUB)).toBeTruthy()
  })

  it('launches the profile a row names, once per click', async () => {
    const props = renderList()
    await userEvent.click(row(/^hub dev/))
    expect(props.onLaunch).toHaveBeenCalledTimes(1)
    expect(props.onLaunch).toHaveBeenCalledWith(DEV)
  })

  it('holds a row while its session is starting', async () => {
    const props = renderList({ launchingIds: [DEV.id] })
    expect(row(/^hub dev/).hasAttribute('disabled')).toBe(true)
    expect(within(row(/^hub dev/)).getByText('Starting…')).toBeTruthy()

    await userEvent.click(row(/^hub dev/))
    await userEvent.click(row(/^plain/))
    expect(props.onLaunch).toHaveBeenCalledTimes(1)
    expect(props.onLaunch).toHaveBeenCalledWith(PLAIN)
  })
})

describe('ProfileList on a host', () => {
  it('names the host its profiles are on, in mono for a remote host, with New profile there', async () => {
    const onNew = vi.fn()
    const onLaunch = vi.fn()
    renderList({
      profiles: [DEV],
      onLaunch,
      host: { id: 'h1', name: 'build-box', remote: true, connected: true, onNew }
    })
    const section = screen.getByRole('region', { name: 'Profiles on build-box' })
    expect(section.querySelector('[data-profile-host-header] .font-mono')?.textContent).toBe('build-box')
    expect(within(section).getByRole('list', { name: 'Saved profiles on build-box' })).toBeTruthy()
    await userEvent.click(within(section).getByRole('button', { name: 'New profile on build-box' }))
    expect(onNew).toHaveBeenCalledOnce()
  })

  it('says a remote host has none yet, rather than the first-run sentence', () => {
    renderList({ profiles: [], host: { id: 'h1', name: 'build-box', remote: true, connected: false, onNew: vi.fn() } })
    expect(screen.getByText('No profiles on build-box yet.')).toBeTruthy()
    expect(screen.getByText('retrying')).toBeTruthy()
  })
})
