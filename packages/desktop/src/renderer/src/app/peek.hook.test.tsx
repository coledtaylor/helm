import { LOCAL_HOST_KEY, type ChildPlace } from '@helm/core/types'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { usePeek, type UsePeekDeps } from './peek'

function mount(initial: { place: ChildPlace; running: boolean } | null) {
  const closedHere: number[] = []
  const state = { current: initial }
  const deps: UsePeekDeps = {
    watch: (_host, id) => () => closedHere.push(id),
    stop: () => Promise.resolve(true),
    openTab: () => undefined,
    stateOf: () => state.current
  }
  const view = renderHook(() => usePeek(deps))
  return { ...view, closedHere, state, rerenderWith: (next: typeof initial) => {
    state.current = next
    view.rerender()
  } }
}

describe('the peek in the window', () => {
  it('S1: stays open while its child has nowhere on screen or is a chip', () => {
    const { result, rerenderWith } = mount({ place: 'nowhere', running: true })
    act(() => result.current.store.open(LOCAL_HOST_KEY, 8, { kind: 'row' }))
    expect(result.current.target).toEqual({ host: LOCAL_HOST_KEY, id: 8, anchor: { kind: 'row' } })
    rerenderWith({ place: 'chip', running: true })
    expect(result.current.target).not.toBeNull()
  })

  it('S3: closes when its child becomes shown here, and closes its stream', () => {
    const { result, rerenderWith, closedHere } = mount({ place: 'nowhere', running: true })
    act(() => result.current.store.open(LOCAL_HOST_KEY, 8, { kind: 'row' }))
    rerenderWith({ place: 'card', running: true })
    expect(result.current.target).toBeNull()
    expect(closedHere).toEqual([8])
  })

  it('closes when its child ends', () => {
    const { result, rerenderWith } = mount({ place: 'nowhere', running: true })
    act(() => result.current.store.open(LOCAL_HOST_KEY, 8, { kind: 'row' }))
    rerenderWith({ place: 'nowhere', running: false })
    expect(result.current.target).toBeNull()
  })

  it('S2: closes on its close button, and when the window goes', () => {
    const { result, unmount, closedHere } = mount({ place: 'nowhere', running: true })
    act(() => result.current.store.open(LOCAL_HOST_KEY, 8, { kind: 'row' }))
    act(() => result.current.store.close())
    expect(result.current.target).toBeNull()
    act(() => result.current.store.open(LOCAL_HOST_KEY, 9, { kind: 'row' }))
    unmount()
    expect(closedHere).toEqual([8, 9])
  })
})
