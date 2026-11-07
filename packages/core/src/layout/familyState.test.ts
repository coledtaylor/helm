import { describe, expect, it } from 'vitest'
import type { FamilyMember } from './family'
import {
  PLAIN_FAMILY,
  closeChild,
  endedHeaderText,
  familyChildren,
  familyEntries,
  isPlainFamily,
  pruneFamilyState,
  readFamilyState,
  readFamilyStates,
  shrinkChild,
  showChild,
  type FamilyState
} from './familyState'

const running = (id: number): FamilyMember => ({ id, status: 'running', parentId: 1 })
const ended = (id: number): FamilyMember => ({ id, status: 'exited', parentId: 1 })

/** The family drawn as text: cards first `C`, last screens `S`, running headers `h`, ended headers `e`, in order. */
function drawn(children: readonly FamilyMember[], state: FamilyState, capacity: number): string {
  return familyEntries(children, state, capacity)
    .map(({ child, shape }) => `${{ card: 'C', screen: 'S', header: 'h', ended: 'e' }[shape]}${String(child.id)}`)
    .join(' ')
}

const state = (patch: Partial<FamilyState> = {}): FamilyState => ({ ...PLAIN_FAMILY, ...patch })

describe('familyEntries', () => {
  it('shows the running children as cards while the pane has room for them, in the order they started', () => {
    expect(drawn([running(2), running(3), running(4)], PLAIN_FAMILY, 3)).toBe('C2 C3 C4')
  })

  it('shows as many as fit as cards and the rest as one-line headers after them', () => {
    expect(drawn([running(2), running(3), running(4), running(5)], PLAIN_FAMILY, 2)).toBe('C2 C3 h4 h5')
  })

  it('draws a shrunk child as a header whatever room there is, after the cards', () => {
    expect(drawn([running(2), running(3), running(4)], state({ shrunk: [2] }), 5)).toBe('C3 C4 h2')
  })

  it('draws an ended child as a header saying how it ended, and gives its card to the next child that wants one', () => {
    expect(drawn([running(2), ended(3), running(4), running(5)], PLAIN_FAMILY, 2)).toBe('C2 C4 e3 h5')
  })

  it('draws an ended child pressed open as its last screen, in a card’s place', () => {
    expect(drawn([running(2), ended(3), running(4)], state({ screens: [3] }), 2)).toBe('C2 S3 h4')
  })

  it('leaves an ended child the user closed out, and a running one is never closed', () => {
    const family = [running(2), ended(3), running(4)]
    expect(drawn(family, state({ closed: [3] }), 3)).toBe('C2 C4')
    expect(drawn(family, state({ closed: [2] }), 3)).toBe('C2 C4 e3')
  })

  it('puts the children the state orders first, then the rest as listed, so a child that starts is last', () => {
    expect(drawn([running(2), running(3), running(4)], state({ order: [4, 2] }), 3)).toBe('C4 C2 C3')
    expect(drawn([running(2), running(3), running(5)], state({ order: [4, 2] }), 3)).toBe('C2 C3 C5')
  })

  it('draws every child as a header with no room for a card', () => {
    expect(drawn([running(2), running(3)], PLAIN_FAMILY, 0)).toBe('h2 h3')
  })

  it('holds the children a view still has: all but the ended ones closed out', () => {
    const family = [running(2), ended(3), ended(4)]
    expect(familyChildren(family, state({ closed: [4] })).map((child) => child.id)).toEqual([2, 3])
  })
})

describe('shrinkChild', () => {
  it('shrinks a shown card to a header, and a header again changes nothing', () => {
    const shrunk = shrinkChild(PLAIN_FAMILY, running(2))
    expect(shrunk.shrunk).toEqual([2])
    expect(shrinkChild(shrunk, running(2))).toBe(shrunk)
  })

  it('puts an ended child’s last screen back to its header', () => {
    const open = state({ screens: [3] })
    expect(shrinkChild(open, ended(3)).screens).toEqual([])
  })
})

describe('showChild', () => {
  const family = [running(2), running(3), running(4), running(5)]

  it('shows a header as a card in the place of the last card, which shrinks to a header in its place', () => {
    const shown = showChild(PLAIN_FAMILY, family, 2, 4)
    expect(drawn(family, shown, 2)).toBe('C2 C4 h3 h5')
    expect(shown.shrunk).toEqual([3])
  })

  it('takes a shrunk child’s place among the cards the same way', () => {
    const arranged = state({ shrunk: [2] })
    const shown = showChild(arranged, family, 2, 2)
    expect(drawn(family, shown, 2)).toBe('C3 C2 h4 h5')
    expect(shown.shrunk).toEqual([4])
  })

  it('just un-shrinks the child when a card place is free', () => {
    const arranged = state({ shrunk: [3] })
    const shown = showChild(arranged, family, 4, 3)
    expect(shown.shrunk).toEqual([])
    expect(drawn(family, shown, 4)).toBe('C2 C3 C4 C5')
  })

  it('changes nothing for a child that is already a card', () => {
    expect(showChild(PLAIN_FAMILY, family, 2, 3)).toBe(PLAIN_FAMILY)
  })

  it('puts the child first when the pane has not been measured, so the last card is what falls away once it is', () => {
    const shown = showChild(PLAIN_FAMILY, family, null, 5)
    expect(drawn(family, shown, 3)).toBe('C5 C2 C3 h4')
    expect(drawn(family, shown, 1)).toBe('C5 h2 h3 h4')
  })

  it('treats a pane with no cards the same as one not measured', () => {
    expect(showChild(PLAIN_FAMILY, family, 0, 5).order[0]).toBe(5)
  })

  it('shows an ended child’s header as its last screen, and gives the last card’s place to it', () => {
    const mixed = [running(2), running(3), ended(4)]
    const shown = showChild(PLAIN_FAMILY, mixed, 2, 4)
    expect(drawn(mixed, shown, 2)).toBe('C2 S4 h3')
  })

  it('puts a last screen back to its header when another child takes its place', () => {
    const mixed = [running(2), ended(3), running(4)]
    const open = state({ screens: [3] })
    const shown = showChild(open, mixed, 2, 4)
    expect(drawn(mixed, shown, 2)).toBe('C2 C4 e3')
    expect(shown.screens).toEqual([])
  })

  it('brings a closed ended child back as its last screen when its row is pressed', () => {
    const mixed = [running(2), ended(3)]
    const closed = state({ closed: [3] })
    const shown = showChild(closed, mixed, 3, 3)
    expect(shown.closed).toEqual([])
    expect(drawn(mixed, shown, 3)).toBe('C2 S3')
  })

  it('is no change for a child it has never heard of', () => {
    expect(showChild(PLAIN_FAMILY, family, 2, 99)).toBe(PLAIN_FAMILY)
  })

  it('keeps the number of cards at what the pane holds however the children swap', () => {
    let arranged = PLAIN_FAMILY
    for (const press of [4, 5, 3, 2, 5, 4]) {
      arranged = showChild(arranged, family, 2, press)
      const cards = familyEntries(family, arranged, 2).filter((entry) => entry.shape === 'card')
      expect(cards).toHaveLength(2)
      expect(cards.map((entry) => entry.child.id)).toContain(press)
    }
  })
})

describe('closeChild', () => {
  it('takes an ended child out of the family view, and its last screen with it', () => {
    const closed = closeChild(state({ screens: [3] }), 3)
    expect(closed).toMatchObject({ closed: [3], screens: [] })
    expect(closeChild(closed, 3)).toBe(closed)
  })
})

describe('pruneFamilyState', () => {
  it('drops the children that are gone from every list', () => {
    const arranged = state({ order: [2, 3, 4], shrunk: [3], closed: [4], screens: [2] })
    expect(pruneFamilyState(arranged, (id) => id !== 3)).toEqual(
      state({ order: [2, 4], shrunk: [], closed: [4], screens: [2] })
    )
  })

  it('is the very same state when every child is still there, and null when nothing is left', () => {
    const arranged = state({ shrunk: [3] })
    expect(pruneFamilyState(arranged, () => true)).toBe(arranged)
    expect(pruneFamilyState(arranged, () => false)).toBeNull()
  })

  it('knows a plain family from an arranged one', () => {
    expect(isPlainFamily(PLAIN_FAMILY)).toBe(true)
    expect(isPlainFamily(state({ closed: [2] }))).toBe(false)
  })
})

describe('endedHeaderText', () => {
  const at = (hours: number, minutes: number): string => new Date(2026, 10, 5, hours, minutes).toISOString()

  it('says Stopped and the time of day for a child its parent, the user or the host ended', () => {
    expect(endedHeaderText({ status: 'exited', stopped: true, endedAt: at(14, 52) })).toBe('Stopped · 14:52')
  })

  it('says Stopped by you for a child the user stopped from this window, and only when the host stopped it', () => {
    expect(endedHeaderText({ status: 'exited', stopped: true, endedAt: at(14, 52) }, true)).toBe(
      'Stopped by you · 14:52'
    )
    expect(endedHeaderText({ status: 'exited', stopped: false, endedAt: at(14, 52) }, true)).toBe('Done · 14:52')
  })

  it('says Done and the time of day for a child whose agent exited by itself, a record that never said stopped included', () => {
    expect(endedHeaderText({ status: 'exited', stopped: false, endedAt: at(9, 5) })).toBe('Done · 09:05')
    expect(endedHeaderText({ status: 'exited', endedAt: at(9, 5) })).toBe('Done · 09:05')
  })

  it('says Lost for a child its host lost track of', () => {
    expect(endedHeaderText({ status: 'lost', endedAt: at(23, 0) })).toBe('Lost · 23:00')
  })

  it('says exited and the code for a command child, with the time of day, whoever ended it', () => {
    const command = 'pnpm test'
    expect(endedHeaderText({ status: 'exited', command, exitCode: 0, endedAt: at(14, 52) })).toBe('exited 0 · 14:52')
    expect(endedHeaderText({ status: 'exited', command, exitCode: 1, endedAt: at(9, 5) })).toBe('exited 1 · 09:05')
    expect(endedHeaderText({ status: 'exited', command, exitCode: 137, stopped: true, endedAt: at(9, 5) }, true)).toBe(
      'exited 137 · 09:05'
    )
  })

  it('says exited and the code without a time when it never saw the command end', () => {
    expect(endedHeaderText({ status: 'exited', command: 'make', exitCode: 2, endedAt: null })).toBe('exited 2')
    expect(endedHeaderText({ status: 'exited', command: 'make', exitCode: 0, endedAt: 'not a time' })).toBe('exited 0')
  })

  it('tells a command child whose code was never observed as an agent would be', () => {
    expect(endedHeaderText({ status: 'exited', command: 'make', exitCode: null, endedAt: at(14, 52) })).toBe(
      'Done · 14:52'
    )
    expect(endedHeaderText({ status: 'exited', command: 'make', stopped: true, endedAt: at(14, 52) })).toBe(
      'Stopped · 14:52'
    )
    expect(endedHeaderText({ status: 'lost', command: 'make', endedAt: null })).toBe('Lost')
  })

  it('does not read an exit code as a command’s for an agent child', () => {
    expect(endedHeaderText({ status: 'exited', exitCode: 1, endedAt: at(14, 52) })).toBe('Done · 14:52')
    expect(endedHeaderText({ status: 'exited', command: null, exitCode: 0, endedAt: at(14, 52) })).toBe('Done · 14:52')
  })

  it('leaves the time off when it never saw one end rather than guessing', () => {
    expect(endedHeaderText({ status: 'exited', stopped: true, endedAt: null })).toBe('Stopped')
    expect(endedHeaderText({ status: 'exited', endedAt: 'not a time' })).toBe('Done')
  })
})

describe('readFamilyStates', () => {
  it('reads an arrangement written down, dropping duplicates in a list', () => {
    expect(readFamilyStates({ 'session:7': { order: [3, 3, 2], shrunk: [2] } })).toEqual({
      'session:7': { order: [3, 2], shrunk: [2], closed: [], screens: [] }
    })
  })

  it('drops the parent whose arrangement does not read and keeps the others', () => {
    expect(
      readFamilyStates({ 'session:7': { shrunk: ['x'] }, 'session:8': { shrunk: [4] }, 'session:9': 'no' })
    ).toEqual({ 'session:8': { order: [], shrunk: [4], closed: [], screens: [] } })
  })

  it('is nothing for what is not an object or holds no arrangement', () => {
    expect(readFamilyStates(null)).toBeNull()
    expect(readFamilyStates([])).toBeNull()
    expect(readFamilyStates({ 'session:7': {} })).toBeNull()
    expect(readFamilyState({ order: [0] })).toBeNull()
  })
})
