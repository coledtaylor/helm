import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UsageSnapshot } from '@helm/core/types'
import { bridge } from './bridge.testkit'
import { useUsage } from './useUsage'

vi.mock('./bridge', () => import('./bridge.testkit'))

/**
 * The window's copy of the usage reading: one read when it mounts, then
 * whatever main pushes when `~/.claude.json` changes - no poll, no click.
 */

const reading = (percent: number): UsageSnapshot => ({
  file: 'C:\\Users\\someone\\.claude.json',
  fetchedAtMs: Date.parse('2026-08-10T08:55:00Z'),
  limits: [
    { kind: 'session', group: 'session', percent, severity: 'normal', resetsAtMs: null, scope: null, isActive: true }
  ],
  problem: null,
  spend: null
})

afterEach(() => {
  bridge.reset()
})

describe('useUsage', () => {
  it('reads once, then takes every reading main pushes', async () => {
    bridge.answer('usage:read', () => reading(10))
    const { result } = renderHook(() => useUsage())
    await waitFor(() => expect(result.current?.limits[0]?.percent).toBe(10))

    act(() => bridge.emit('usage:changed', reading(42)))

    expect(result.current?.limits[0]?.percent).toBe(42)
    expect(bridge.invoked('usage:read')).toHaveLength(1)
  })

  it('does not let the first read overwrite a push that beat it', async () => {
    let answer: (snapshot: UsageSnapshot) => void = () => undefined
    bridge.answer('usage:read', () => new Promise<UsageSnapshot>((resolve) => (answer = resolve)))
    const { result } = renderHook(() => useUsage())
    await waitFor(() => expect(bridge.invoked('usage:read')).toHaveLength(1))

    act(() => bridge.emit('usage:changed', reading(42)))
    await act(async () => {
      answer(reading(10))
      await Promise.resolve()
    })

    expect(result.current?.limits[0]?.percent).toBe(42)
  })
})
