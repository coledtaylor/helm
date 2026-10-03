import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { RestorableSession, RestoreOffer } from '@helm/core/types'
import { RestorePane, type RestorePaneProps } from './RestorePane'

const NOW = new Date(2026, 9, 2, 13, 0, 0).getTime()
const EARLIER = NOW - 20 * 60_000
const LAST_WEEK = new Date(2026, 8, 30, 9, 15).getTime()

function session(id: number, name: string, extra: Partial<RestorableSession> = {}): RestorableSession {
  return {
    id,
    name,
    cwd: `C:\\work\\${name}`,
    branch: 'main',
    profile: null,
    profileGone: false,
    lastAt: EARLIER,
    blocked: null,
    ...extra
  }
}

const QUIET_REASON = 'Claude Code has no record of a conversation in it to reopen.'

const OFFER: RestoreOffer = {
  sessions: [
    session(4, 'tab baseline', { cwd: 'C:\\work\\helm', branch: 'feat/tab-baseline', profile: 'dev' }),
    session(7, 'accruals report', { cwd: 'C:\\work\\reporting', profileGone: true, lastAt: LAST_WEEK }),
    session(9, 'quiet', { blocked: QUIET_REASON, lastAt: null })
  ],
  elsewhere: 0,
  layout: null
}

function renderPane(overrides: Partial<RestorePaneProps> = {}): RestorePaneProps {
  const props: RestorePaneProps = {
    offer: OFFER,
    withoutAsking: false,
    onWithoutAskingChange: vi.fn(),
    busy: false,
    onResume: vi.fn(),
    onNotNow: vi.fn(),
    now: NOW,
    ...overrides
  }
  render(<RestorePane {...props} />)
  return props
}

function row(id: number): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-restore-row="${String(id)}"]`)
  if (found === null) throw new Error(`no row ${String(id)}`)
  return found
}

const text = (id: number): string => row(id).textContent ?? ''
const button = (name: string): HTMLElement => screen.getByRole('button', { name })

describe('RestorePane', () => {
  it('lists every session the crash took, ticked, and the one that cannot come back with its reason', () => {
    renderPane()
    screen.getByRole('region', { name: '3 sessions were running when Helm closed' })

    expect(within(row(4)).getByRole('checkbox', { name: 'tab baseline' })).toHaveProperty('checked', true)
    expect(text(4)).toContain('helm · feat/tab-baseline')
    expect(text(4)).toContain('dev')
    expect(text(4)).toContain(
      new Date(EARLIER).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    )

    // A profile deleted since is said; an older session shows its date.
    expect(text(7)).toContain('Profile deleted')
    expect(text(7)).toContain(new Date(LAST_WEEK).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))

    const quiet = within(row(9)).getByRole('checkbox', { name: 'quiet' })
    expect(quiet).toHaveProperty('checked', false)
    expect(quiet).toHaveProperty('disabled', true)
    expect(text(9)).toContain(QUIET_REASON)
    expect(button('Resume 2 sessions')).toHaveProperty('disabled', false)
  })

  it('reopens what stays ticked, in list order', async () => {
    const props = renderPane()
    await userEvent.click(screen.getByRole('checkbox', { name: 'tab baseline' }))
    await userEvent.click(button('Resume 1 session'))
    expect(props.onResume).toHaveBeenCalledWith([7])

    // The row is a label, so a click on its name ticks it back.
    await userEvent.click(within(row(4)).getByText('tab baseline'))
    await userEvent.click(button('Resume 2 sessions'))
    expect(props.onResume).toHaveBeenLastCalledWith([4, 7])
  })

  it('cannot resume nothing', async () => {
    renderPane()
    await userEvent.click(screen.getByRole('checkbox', { name: 'tab baseline' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'accruals report' }))
    expect(button('Resume 0 sessions')).toHaveProperty('disabled', true)
  })

  it('is busy while reopening', () => {
    renderPane({ busy: true })
    expect(button('Resuming…')).toHaveProperty('disabled', true)
    expect(button('Not now')).toHaveProperty('disabled', true)
  })

  it('answers not now, and ticks the setting from its own checkbox', async () => {
    const props = renderPane()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Always resume without asking' }))
    expect(props.onWithoutAskingChange).toHaveBeenCalledWith(true)
    await userEvent.click(button('Not now'))
    expect(props.onNotNow).toHaveBeenCalledTimes(1)
  })

  it('says how many more are still running elsewhere, and reads one session in the singular', () => {
    renderPane({ offer: { ...OFFER, sessions: [OFFER.sessions[0]!], elsewhere: 2 } })
    screen.getByRole('heading', { name: '1 session was running when Helm closed' })
    expect(document.body.textContent).toContain('2 more are still running somewhere else, and left alone.')
  })
})
