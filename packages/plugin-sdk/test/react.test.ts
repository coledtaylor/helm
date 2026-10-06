// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { StrictMode, createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useHelmEvent, useHelmSettings, useHelmTheme, useHelmVisible, useSecret } from '../src/react.js'
import { DARK, LIGHT, installBridge, removeBridge, type FakeBridge } from './bridge'

/** The React hooks, over the stores, the way a plugin's components use them. */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let fake: FakeBridge

/** StrictMode subscribes, unsubscribes and subscribes again on mount: what a plugin in development gets. */
const strict = ({ children }: { children: ReactNode }): ReactNode => createElement(StrictMode, null, children)

beforeEach(() => {
  fake = installBridge()
})

afterEach(() => {
  cleanup()
  removeBridge()
})

describe('the React hooks', () => {
  it('read settings and a secret once for every component, follow Helm, and let go on unmount', async () => {
    const { result, unmount } = renderHook(
      () => ({ panel: useHelmSettings(), list: useHelmSettings(), token: useSecret('github-token') }),
      { wrapper: strict }
    )
    expect(result.current.panel).toBeNull()
    expect(result.current.token[0]).toBeNull()

    await act(async () => {
      for (const read of fake.settingsReads) await read.answer({ query: 'is:open' })
      for (const read of fake.stateReads) await read.answer('missing')
    })
    expect(result.current.panel).toEqual({ query: 'is:open' })
    expect(result.current.list).toBe(result.current.panel)
    expect(result.current.token[0]).toBe('missing')

    await act(async () => {
      const asked = result.current.token[1]()
      await fake.requests[0]!.answer('ready')
      await asked
    })
    expect(result.current.token[0]).toBe('ready')

    act(() => fake.emit('settings', { query: 'is:closed' }))
    expect(result.current.panel).toEqual({ query: 'is:closed' })

    unmount()
    expect(fake.listeners('settings')).toBe(0)
    expect(fake.listeners('secrets')).toBe(0)
  })

  it('re-render on theme and visibility', () => {
    const { result, unmount } = renderHook(() => ({ theme: useHelmTheme(), visible: useHelmVisible() }), { wrapper: strict })
    expect(result.current).toEqual({ theme: DARK, visible: false })

    act(() => {
      fake.emit('theme', LIGHT)
      fake.emit('visibility', true)
    })
    expect(result.current).toEqual({ theme: LIGHT, visible: true })

    unmount()
    expect(fake.listeners('theme')).toBe(0)
    expect(fake.listeners('visibility')).toBe(0)
  })

  it('call the latest listener for an event, until unmount', () => {
    const seen: string[] = []
    const { rerender, unmount } = renderHook(
      ({ label }: { label: string }) => useHelmEvent('action', ({ id }) => seen.push(`${label}:${id}`)),
      { initialProps: { label: 'first' }, wrapper: strict }
    )
    act(() => fake.emit('action', { id: 'refresh' }))
    rerender({ label: 'second' })
    act(() => fake.emit('action', { id: 'refresh' }))
    expect(seen).toEqual(['first:refresh', 'second:refresh'])

    unmount()
    expect(fake.listeners('action')).toBe(0)
  })
})
