import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '@helm/core/types'
import { SessionCrumb } from './SessionCrumb'

const NOW = Date.parse('2026-10-02T12:00:00.000Z')

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 1,
    name: 'tests',
    label: null,
    cwd: 'C:\\work\\shop',
    branch: 'main',
    projectPath: 'C:\\work\\shop',
    profileId: null,
    argv: [],
    claudeSessionId: null,
    status: 'running',
    startedAt: new Date(NOW).toISOString(),
    endedAt: null,
    durationMs: null,
    exitCode: null,
    ...over
  }
}

function crumb(record: SessionRecord, state: 'running' | 'idle' | 'ended' | 'failed' = 'running') {
  return <SessionCrumb place="shop" session={record} state={state} since={null} now={NOW} message={null} />
}

const statusOf = (container: HTMLElement): string | null =>
  container.querySelector('[data-crumb="status"]')?.textContent ?? null

describe('SessionCrumb', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('S30: counts a running command’s seconds each second, then Running · 1m from a minute', () => {
    const { container } = render(crumb(session({ command: 'pnpm test' })))
    expect(statusOf(container)).toBe('Running · 1s')
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(statusOf(container)).toBe('Running · 1s')
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(statusOf(container)).toBe('Running · 2s')
    act(() => {
      vi.advanceTimersByTime(58_000)
    })
    expect(statusOf(container)).toBe('Running · 1m')
    expect(container.querySelector('[data-crumb="status"]')!.className).toContain('text-success')
  })

  it('does not tick for an agent session: its figure moves with the window’s clock only', () => {
    const { container } = render(crumb(session()))
    expect(statusOf(container)).toBe('Running')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('S31: does not tick for a command that has exited, which reads its exit as its ended header does', () => {
    const { container } = render(
      crumb(
        session({
          command: 'pnpm test',
          status: 'exited',
          exitCode: 2,
          endedAt: new Date(2026, 9, 29, 14, 52).toISOString()
        }),
        'failed'
      )
    )
    expect(statusOf(container)).toBe('exited 2 · 14:52')
    expect(container.querySelector('[data-crumb="status"]')!.className).toContain('text-danger')
    expect(vi.getTimerCount()).toBe(0)
  })
})
