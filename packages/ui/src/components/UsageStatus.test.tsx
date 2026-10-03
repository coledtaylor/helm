import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState, type JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  parseUsage,
  usageProblem,
  type UsageDisplayMode,
  type UsageLimit,
  type UsageSnapshot,
  type UsageSpend,
  type UsageWindowCost
} from '@helm/core/types'
import { formatResetsIn } from '../lib/time'
import { UsageStatus } from './UsageStatus'

/**
 * The status bar's usage segment, rendered from readings shaped the way the
 * main process hands them over. The rules about which reading may be shown are
 * asserted in `core/usage/usage.test.ts`; these assert what the segment paints
 * from them, and that it re-decides on its own clock.
 */

const NOW = Date.parse('2026-08-10T09:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const FILE = 'C:\\Users\\someone\\.claude.json'

function limit(
  fields: Pick<UsageLimit, 'kind' | 'group' | 'percent'> & Partial<UsageLimit>
): UsageLimit {
  return { severity: 'normal', resetsAtMs: null, scope: null, isActive: false, ...fields }
}

function reading(limits: UsageLimit[], fields: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return { file: FILE, fetchedAtMs: NOW - 5 * MINUTE, limits, problem: null, spend: null, ...fields }
}

/** A session limit and two weekly ones, the per-model one binding. */
const LIMITS: UsageLimit[] = [
  limit({
    kind: 'session',
    group: 'session',
    percent: 51.4,
    resetsAtMs: NOW + 2 * HOUR + 5 * MINUTE,
    isActive: true
  }),
  limit({ kind: 'weekly_all', group: 'weekly', percent: 38, severity: 'warning', resetsAtMs: NOW + 34 * HOUR }),
  limit({
    kind: 'weekly_scoped',
    group: 'weekly',
    percent: 62.6,
    severity: 'critical',
    resetsAtMs: NOW + 34 * HOUR,
    scope: 'Fable'
  })
]

const spent = (dollars: number): UsageWindowCost => ({
  tokens: { input: 1200, output: 340, cacheWrite: 0, cacheRead: 5_400_000 },
  dollars,
  messages: 3
})

const SPEND: UsageSpend = {
  session: spent(1.234),
  today: spent(7.5),
  week: spent(412.38),
  pricedAt: '2026-08-10',
  unpricedModels: ['claude-mystery-9'],
  indexMs: 12
}

/** The segment is a button whose name is what it paints. */
const segment = (): HTMLElement => screen.getByRole('button')

function Controlled({
  snapshot,
  initial,
  onWrite
}: {
  snapshot: UsageSnapshot | null
  initial: UsageDisplayMode
  onWrite: (mode: UsageDisplayMode) => void
}): JSX.Element {
  const [mode, setMode] = useState(initial)
  return (
    <UsageStatus
      snapshot={snapshot}
      mode={mode}
      onModeChange={(next) => {
        onWrite(next)
        setMode(next)
      }}
    />
  )
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('UsageStatus in percent mode', () => {
  it('paints the session limit and the binding weekly limit with its model, rounded', () => {
    render(<UsageStatus snapshot={reading(LIMITS)} mode="percent" onModeChange={vi.fn()} />)

    const text = segment().textContent ?? ''
    expect(text).toContain('Session 51%')
    expect(text).toContain('Week (Fable) 63%')
    // The all-models weekly limit is lower, so it is not the one on screen.
    expect(text).not.toContain('38%')
  })

  it('colours each figure by the server severity, not by a threshold of its own', () => {
    const limits = [
      limit({ kind: 'session', group: 'session', percent: 95, severity: 'normal' }),
      limit({ kind: 'weekly_all', group: 'weekly', percent: 12, severity: 'critical' })
    ]
    const { rerender } = render(
      <UsageStatus snapshot={reading(limits)} mode="percent" onModeChange={vi.fn()} />
    )
    expect(within(segment()).getByText('95%').className).toContain('text-fg-muted')
    expect(within(segment()).getByText('12%').className).toContain('text-danger')

    rerender(
      <UsageStatus
        snapshot={reading([limit({ kind: 'session', group: 'session', percent: 12, severity: 'warning' })])}
        mode="percent"
        onModeChange={vi.fn()}
      />
    )
    const warning = within(segment()).getByText('12%').className
    expect(warning).toContain('text-warn')
    expect(warning).not.toContain('text-danger')
  })

  it('counts down a reset under a day', () => {
    render(<UsageStatus snapshot={reading(LIMITS)} mode="percent" onModeChange={vi.fn()} />)
    expect(segment().textContent).toContain('resets in 2h 5m')
  })

  it('drops a window that resets while it is on screen, and keeps the one that has not', () => {
    const limits = [
      limit({ kind: 'session', group: 'session', percent: 40, resetsAtMs: NOW + 10_000 }),
      limit({ kind: 'weekly_all', group: 'weekly', percent: 20, resetsAtMs: NOW + 3 * 24 * HOUR })
    ]
    render(<UsageStatus snapshot={reading(limits)} mode="percent" onModeChange={vi.fn()} />)
    expect(segment().textContent).toContain('Session 40%')

    // No new reading arrives: the segment's own tick is what notices.
    act(() => {
      vi.advanceTimersByTime(15_000)
    })

    expect(segment().textContent).not.toContain('Session')
    expect(segment().textContent).toContain('Week 20%')
  })

  it('paints a stale reading of a running window as lower bounds, with its age', () => {
    render(
      <UsageStatus
        snapshot={reading(LIMITS, { fetchedAtMs: NOW - 2 * HOUR })}
        mode="percent"
        onModeChange={vi.fn()}
      />
    )

    const text = segment().textContent ?? ''
    expect(text).toContain('Session ≥51%')
    expect(text).toContain('Week (Fable) ≥63%')
    expect(text).toContain('2h old')
    expect(segment().title).toContain('lower bounds')
  })

  it('paints a fresh reading as exact figures', () => {
    render(<UsageStatus snapshot={reading(LIMITS)} mode="percent" onModeChange={vi.fn()} />)

    expect(segment().textContent).not.toContain('≥')
    expect(segment().textContent).not.toContain('old')
    expect(segment().title).not.toContain('lower bounds')
  })

  it.each([
    ['has not cached', parseUsage({ numStartups: 3 }, FILE), /has not cached any usage figures/],
    [
      'reshaped',
      parseUsage({ cachedUsageUtilization: { fetchedAtMs: NOW, utilization: { limits: { session: 51 } } } }, FILE),
      /limits is not an array/
    ],
    [
      'did not parse',
      usageProblem(FILE, 'not-json', `${FILE} did not parse: Unexpected end of JSON input`),
      /did not parse/
    ],
    [
      'already reset',
      reading([
        limit({ kind: 'session', group: 'session', percent: 51, resetsAtMs: NOW - MINUTE }),
        limit({ kind: 'weekly_all', group: 'weekly', percent: 38, resetsAtMs: NOW - MINUTE })
      ]),
      /already reset/
    ]
  ])('paints no figure for a reading that %s, and says why', (_case, snapshot, reason) => {
    render(<UsageStatus snapshot={snapshot} mode="percent" onModeChange={vi.fn()} />)

    expect(segment().textContent).toBe('Usage')
    expect(segment().title).toMatch(reason)
  })
})

describe('UsageStatus display modes', () => {
  it('cycles percent, cost, off and back once there is an estimate, writing each mode', () => {
    const onWrite = vi.fn()
    render(<Controlled snapshot={reading(LIMITS, { spend: SPEND })} initial="percent" onWrite={onWrite} />)

    fireEvent.click(segment())
    expect(segment().textContent).toMatch(/^Est\./)
    fireEvent.click(segment())
    expect(segment().textContent).toBe('Usage')
    fireEvent.click(segment())
    expect(segment().textContent).toContain('Session 51%')

    expect(onWrite.mock.calls).toEqual([['cost'], ['off'], ['percent']])
  })

  it('skips cost while the index has no estimate', () => {
    const onWrite = vi.fn()
    render(<Controlled snapshot={reading(LIMITS)} initial="percent" onWrite={onWrite} />)

    fireEvent.click(segment())
    fireEvent.click(segment())

    expect(onWrite.mock.calls).toEqual([['off'], ['percent']])
  })

  it('shows percentages and no dollars, dollars and no percentages, or neither', () => {
    const snapshot = reading(LIMITS, { spend: SPEND })
    const { rerender } = render(<UsageStatus snapshot={snapshot} mode="percent" onModeChange={vi.fn()} />)
    expect(segment().textContent).toContain('%')
    expect(segment().textContent).not.toContain('$')

    rerender(<UsageStatus snapshot={snapshot} mode="cost" onModeChange={vi.fn()} />)
    expect(segment().textContent).toContain('$')
    expect(segment().textContent).not.toContain('%')

    rerender(<UsageStatus snapshot={snapshot} mode="off" onModeChange={vi.fn()} />)
    expect(segment().textContent).toBe('Usage')
    expect(segment().title).toContain('Usage is hidden.')
  })

  it('leads cost mode with "Est." and the price table date, and calls it estimated', () => {
    render(<UsageStatus snapshot={reading(LIMITS, { spend: SPEND })} mode="cost" onModeChange={vi.fn()} />)

    const text = segment().textContent ?? ''
    expect(text).toMatch(/^Est\./)
    // Cents below ten dollars, whole dollars above: an estimate does not get
    // to claim a precision the price table cannot give it.
    expect(text).toContain('$1.23 5h')
    expect(text).toContain('$7.50 today')
    expect(text).toContain('$412 7d')
    expect(text).toContain('2026-08-10 prices')

    const title = segment().title
    expect(title).toContain('Estimated, not billed')
    expect(title).toContain('2026-08-10 list prices')
    // A model with no rate on file is counted and named, not priced as another.
    expect(title).toContain('Not priced (no rate on file): claude-mystery-9')
  })
})

describe('formatResetsIn', () => {
  it('counts down under a day, to the minute', () => {
    expect(formatResetsIn(NOW + 2 * HOUR + 5 * MINUTE, NOW)).toBe('in 2h 5m')
    expect(formatResetsIn(NOW + 2 * HOUR, NOW)).toBe('in 2h')
    expect(formatResetsIn(NOW + 45 * MINUTE + 59_000, NOW)).toBe('in 45m')
    expect(formatResetsIn(NOW + 30_000, NOW)).toBe('in <1m')
    expect(formatResetsIn(NOW - 1, NOW)).toBe('now')
  })

  it('names the weekday and the clock time over a day', () => {
    const at = NOW + 34 * HOUR
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(at)

    const text = formatResetsIn(at, NOW)

    expect(text).not.toMatch(/^in /)
    expect(text).toContain(weekday)
    expect(text).toMatch(/\d{1,2}[:.]\d{2}/)
  })
})
