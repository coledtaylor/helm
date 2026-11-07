import { describe, expect, it } from 'vitest'
import { LOCAL_HOST_KEY } from '../hosts'
import {
  childMark,
  childPlace,
  childPlaces,
  closeParentButton,
  closeParentPlan,
  crumbChips,
  needsYouToast,
  type ChildMember,
  type PlaceScope
} from './childPlace'
import { shrinkFamilyChild } from './familyView'
import {
  fromSaved,
  openTab,
  paneId,
  sessionRef,
  type PaneLayout,
  type PaneRef,
  type SavedPane,
  type SavedPaneGroup
} from './panes'
import type { UrgentState } from './family'

const session = (id: number, parentId?: number, extra: Partial<ChildMember> = {}): ChildMember => ({
  id,
  status: 'running',
  ...(parentId === undefined ? {} : { parentId, parentName: 'lead' }),
  ...extra
})

const g = (...tabs: PaneRef[]): SavedPaneGroup => ({ panes: tabs as SavedPane[], activeId: null })
const windowOf = (...tabs: PaneRef[]): PaneLayout => fromSaved({ root: g(...tabs), focused: 0 })

/** A window with the parent, session 1, in a pane of its own. */
const layout = (): PaneLayout => windowOf(sessionRef(1))

const scope = (over: Partial<PlaceScope> = {}): PlaceScope => ({
  enabled: true,
  roomOf: () => true,
  capacityOf: () => 2,
  ...over
})

/** A parent, 1, running four children, 2 to 5. */
const FAMILY = [session(1), session(2, 1), session(3, 1), session(4, 1), session(5, 1)]

describe('where a child is on screen here', () => {
  it('is a card or a header in a parent’s family view as the cards that fit decide', () => {
    const places = childPlaces(layout(), FAMILY, LOCAL_HOST_KEY, scope())
    expect([2, 3, 4, 5].map((id) => places.get(id))).toEqual(['card', 'card', 'header', 'header'])
    expect(places.get(1)).toBe('tab')
  })

  it('is a header for a child the user shrank, whatever room there is', () => {
    const shrunk = shrinkFamilyChild(layout(), paneId(sessionRef(1)), FAMILY[1]!)
    expect(childPlace(shrunk, FAMILY, LOCAL_HOST_KEY, 2, scope({ capacityOf: () => 4 }))).toBe('header')
  })

  it('holds every wanted card in a pane that has not been measured', () => {
    const places = childPlaces(layout(), FAMILY, LOCAL_HOST_KEY, scope({ capacityOf: () => null }))
    expect([2, 3, 4, 5].map((id) => places.get(id))).toEqual(['card', 'card', 'card', 'card'])
  })

  it('is a tab for a child with one of its own, and not a card as well', () => {
    const own = openTab(layout(), sessionRef(3))
    const places = childPlaces(own, FAMILY, LOCAL_HOST_KEY, scope())
    expect(places.get(3)).toBe('tab')
    expect(places.get(2)).toBe('card')
  })

  it('is a chip in a pane with no room for the family view, and with the setting off', () => {
    for (const noFamily of [scope({ roomOf: () => false }), scope({ enabled: false })]) {
      const places = childPlaces(layout(), FAMILY, LOCAL_HOST_KEY, noFamily)
      expect([2, 3, 4, 5].map((id) => places.get(id))).toEqual(['chip', 'chip', 'chip', 'chip'])
    }
  })

  it('is nowhere for a child whose parent’s tab is not open here, and a chip for an ended child with no family view', () => {
    const away = windowOf({ kind: 'settings' })
    expect(childPlace(away, FAMILY, LOCAL_HOST_KEY, 3, scope())).toBe('nowhere')
    const done = [session(1), { ...session(2, 1), status: 'exited' }]
    expect(childPlace(layout(), done, LOCAL_HOST_KEY, 2, scope({ roomOf: () => false }))).toBe('chip')
  })

  it('reads another host’s tabs only', () => {
    const away = windowOf(sessionRef(1, 'build'))
    expect(childPlace(away, FAMILY, LOCAL_HOST_KEY, 2, scope())).toBe('nowhere')
    expect(childPlace(away, FAMILY, 'build', 2, scope())).toBe('card')
  })
})

describe('the toast a child that needs you gets', () => {
  it('S9, S10, S11: none for a card, Show for a header, Peek for a chip or a child on screen nowhere', () => {
    expect(needsYouToast('card')).toBeNull()
    expect(needsYouToast('header')).toBe('show')
    expect(needsYouToast('chip')).toBe('peek')
    expect(needsYouToast('nowhere')).toBe('peek')
  })

  it('is none for a child with a tab of its own', () => {
    expect(needsYouToast('tab')).toBeNull()
  })

  it('follows the place a child has in a family view', () => {
    const places = childPlaces(layout(), FAMILY, LOCAL_HOST_KEY, scope())
    expect([2, 4].map((id) => needsYouToast(places.get(id) ?? 'nowhere'))).toEqual([null, 'show'])
  })
})

describe('the chips a parent’s crumb holds', () => {
  const state = (id: number): UrgentState | null => (id === 3 ? 'waiting' : 'busy')
  const stateOf = (child: ChildMember): UrgentState | null => state(child.id)

  it('S7: is each running child with its dot, in the family view’s order, while the pane has no room', () => {
    const chips = crumbChips(layout(), FAMILY, LOCAL_HOST_KEY, 1, scope({ roomOf: () => false }), stateOf)
    expect(chips.map((chip) => [chip.child.id, chip.mark])).toEqual([
      [2, { glyph: 'dot', state: 'busy' }],
      [3, { glyph: 'dot', state: 'waiting' }],
      [4, { glyph: 'dot', state: 'busy' }],
      [5, { glyph: 'dot', state: 'busy' }]
    ])
  })

  it('S7: holds them too when Show children in their parent’s tab is off', () => {
    const chips = crumbChips(layout(), FAMILY, LOCAL_HOST_KEY, 1, scope({ enabled: false }), stateOf)
    expect(chips.map((chip) => chip.child.id)).toEqual([2, 3, 4, 5])
  })

  it('has none while the pane draws the family view, or for a parent whose tab is not here', () => {
    expect(crumbChips(layout(), FAMILY, LOCAL_HOST_KEY, 1, scope(), stateOf)).toEqual([])
    expect(crumbChips(layout(), FAMILY, LOCAL_HOST_KEY, 9, scope({ roomOf: () => false }), stateOf)).toEqual([])
  })

  it('draws a command child as a terminal glyph, holds an ended child, and leaves out a child with a tab of its own', () => {
    const family = [
      session(1),
      session(2, 1, { command: 'npm test' }),
      session(3, 1),
      { ...session(4, 1), status: 'exited' }
    ]
    const own = openTab(layout(), sessionRef(3))
    const chips = crumbChips(own, family, LOCAL_HOST_KEY, 1, scope({ roomOf: () => false }), () => 'running')
    expect(chips.map((chip) => [chip.child.id, chip.mark.glyph])).toEqual([
      [2, 'command'],
      [4, 'dot']
    ])
  })

  it('follows the arrangement’s order', () => {
    const shown = layout()
    const arranged = { ...shown, families: { [paneId(sessionRef(1))]: { order: [4, 2], shrunk: [], closed: [], screens: [] } } }
    const chips = crumbChips(arranged, FAMILY, LOCAL_HOST_KEY, 1, scope({ roomOf: () => false }), stateOf)
    expect(chips.map((chip) => chip.child.id)).toEqual([4, 2, 3, 5])
  })
})

describe('a child’s mark', () => {
  it('is a dot for an agent and a terminal glyph for a command, each with the state that tones it', () => {
    expect(childMark(session(2, 1), 'waiting')).toEqual({ glyph: 'dot', state: 'waiting' })
    expect(childMark(session(3, 1, { command: 'npm test' }), 'failed')).toEqual({ glyph: 'command', state: 'failed' })
  })
})

describe('closing a parent', () => {
  const none = (): UrgentState | null => null
  const names = (items: Array<{ child: ChildMember }>): number[] => items.map((item) => item.child.id)

  it('S18: ends every running descendant, and its button counts the parent with them', () => {
    const family = [session(1), session(2, 1), session(3, 1), session(4, 2), session(5, 4)]
    const plan = closeParentPlan(family, 1, none)
    expect(names(plan.ends)).toEqual([2, 3, 4, 5])
    expect(plan.outlives).toEqual([])
    expect(closeParentButton(plan.ends.length)).toBe('End 5 sessions')
  })

  it('S18: leaves a child started to outlive running, and what it started with it', () => {
    const family = [
      session(1),
      session(2, 1),
      session(3, 1, { outlive: true }),
      session(4, 3),
      session(5, 2, { outlive: true }),
      session(6, 5)
    ]
    const plan = closeParentPlan(family, 1, none)
    expect(names(plan.ends)).toEqual([2])
    expect(names(plan.outlives)).toEqual([3, 5])
    expect(closeParentButton(plan.ends.length)).toBe('End 2 sessions')
  })

  it('counts three children and the parent as End 4 sessions', () => {
    const plan = closeParentPlan([session(1), session(2, 1), session(3, 1), session(4, 1)], 1, none)
    expect(closeParentButton(plan.ends.length)).toBe('End 4 sessions')
  })

  it('does not count a child that has ended, or one of another parent', () => {
    const family = [session(1), { ...session(2, 1), status: 'exited' }, session(3, 9), session(4, 1)]
    expect(names(closeParentPlan(family, 1, none).ends)).toEqual([4])
  })

  it('gives each child its dot or glyph, in the order the sessions are listed', () => {
    const family = [session(1), session(3, 1, { command: 'npm test' }), session(2, 1)]
    const plan = closeParentPlan(family, 1, (child) => (child.id === 2 ? 'waiting' : 'running'))
    expect(plan.ends.map((item) => [item.child.id, item.mark])).toEqual([
      [3, { glyph: 'command', state: 'running' }],
      [2, { glyph: 'dot', state: 'waiting' }]
    ])
  })

  it('is End session when nothing else ends', () => {
    expect(closeParentPlan([session(1)], 1, none)).toEqual({ ends: [], outlives: [] })
    expect(closeParentButton(0)).toBe('End session')
    expect(closeParentButton(1)).toBe('End 2 sessions')
  })

  it('does not loop on links that come back round', () => {
    const family = [session(1, 2), session(2, 1)]
    expect(names(closeParentPlan(family, 1, none).ends)).toEqual([2])
  })
})
