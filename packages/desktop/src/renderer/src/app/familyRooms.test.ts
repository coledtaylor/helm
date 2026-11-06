import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { familyCapacity, familyRoomFits, forgetFamilyRoom, reportFamilyRoom, useFamilyRoomOf } from './familyRooms'

/**
 * What the window last measured of each parent tab's pane: room is assumed
 * until a pane says otherwise, and anything that asks is told when a
 * measurement changes.
 */

const TAB = 'session:1'
const OTHER = 'session:2'

afterEach(() => {
  forgetFamilyRoom(TAB)
  forgetFamilyRoom(OTHER)
})

describe('the rooms the window has measured', () => {
  it('counts a tab nobody has measured as having room, with no card count yet', () => {
    expect(familyRoomFits(TAB)).toBe(true)
    expect(familyCapacity(TAB)).toBeNull()
  })

  it('reports a measured tab’s room and how many cards it holds, and none while it has no room', () => {
    reportFamilyRoom(TAB, { fits: true, capacity: 3 })
    expect(familyRoomFits(TAB)).toBe(true)
    expect(familyCapacity(TAB)).toBe(3)

    reportFamilyRoom(TAB, { fits: false, capacity: 3 })
    expect(familyRoomFits(TAB)).toBe(false)
    expect(familyCapacity(TAB)).toBeNull()
  })

  it('forgets a tab that has closed', () => {
    reportFamilyRoom(TAB, { fits: false, capacity: 0 })
    forgetFamilyRoom(TAB)
    expect(familyRoomFits(TAB)).toBe(true)
  })
})

describe('the room predicate a component reads', () => {
  it('changes only when a measurement does, and answers from the measurement it was made with', () => {
    const { result } = renderHook(() => useFamilyRoomOf())
    const first = result.current
    expect(first(TAB)).toBe(true)

    act(() => reportFamilyRoom(TAB, { fits: false, capacity: 0 }))
    const second = result.current
    expect(second).not.toBe(first)
    expect(second(TAB)).toBe(false)
    expect(second(OTHER)).toBe(true)
    // The earlier predicate still answers for the moment it was made.
    expect(first(TAB)).toBe(true)

    act(() => reportFamilyRoom(TAB, { fits: false, capacity: 0 }))
    expect(result.current).toBe(second)

    act(() => reportFamilyRoom(TAB, { fits: true, capacity: 2 }))
    expect(result.current(TAB)).toBe(true)
  })
})
