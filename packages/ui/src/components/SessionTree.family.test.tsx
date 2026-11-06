import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_INVENTORY, type DiscoveryResult, type Project } from '@helm/core/types'
import { SessionTree, type SessionTreeProps, type TreeSession } from './SessionTree'

/**
 * Sessions that started other sessions, in the Sessions tree: each child under
 * its parent, a step in with a hairline guide, whatever folder either runs in;
 * a parent folding its children the way a project folds its sessions; and a
 * child whose parent has ended standing on its own, naming it.
 */

const HELM = 'C:\\work\\north\\repos\\helm'
const TRACKR = 'C:\\work\\north\\repos\\trackr'

const project = (path: string): Project => ({
  path,
  name: path.split('\\').pop() ?? path,
  kind: 'repo',
  harnessPath: 'C:\\work\\north',
  hasClaudeDir: false,
  inventory: EMPTY_INVENTORY,
  git: null
})

const DISCOVERY: DiscoveryResult = {
  roots: ['C:\\work'],
  harnesses: [{ path: 'C:\\work\\north', name: 'north', template: null, version: null, repoPaths: [HELM, TRACKR] }],
  projects: [project(HELM), project(TRACKR)],
  errors: [],
  scannedAt: '2026-10-03T00:00:00.000Z',
  durationMs: 1
}

const row = (id: number, label: string, state: TreeSession['state'], extra: Partial<TreeSession> = {}): TreeSession => ({
  id: `session:${String(id)}`,
  label,
  state,
  note: '',
  hint: HELM,
  outside: false,
  shown: null,
  ...extra
})

interface Rendered {
  props: SessionTreeProps
  rerender: (patch?: Partial<SessionTreeProps>) => void
}

function renderTree(
  byPath: ReadonlyMap<string, readonly TreeSession[]>,
  patch: Partial<SessionTreeProps> = {},
  elsewhere: readonly TreeSession[] = []
): Rendered {
  const props: SessionTreeProps = {
    discovery: DISCOVERY,
    scanning: false,
    selectedPath: null,
    pinnedPaths: [],
    onTogglePin: vi.fn(),
    sessionsByPath: byPath,
    elsewhere,
    onSelect: vi.fn(),
    onLaunch: vi.fn(),
    launchingPath: null,
    onOpenSession: vi.fn(),
    onAddRoot: vi.fn(),
    reveal: null,
    ...patch
  }
  const view = render(<SessionTree {...props} />)
  return {
    props,
    rerender: (next = {}) => {
      Object.assign(props, next)
      view.rerender(<SessionTree {...props} />)
    }
  }
}

const sessionRows = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('[data-session-row]')]

const rowOf = (id: number): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-session-row="session:${String(id)}"]`)
  if (found === null) throw new Error(`no row for session ${String(id)}`)
  return found
}

const indentOf = (id: number): number => Number.parseFloat(rowOf(id).style.paddingLeft)

const guides = (id: number): string[] =>
  [...rowOf(id).querySelectorAll('[data-session-guide]')].map((each) => each.getAttribute('data-session-guide') ?? '')

/** api-refactor in helm, with a reviewer and two workers it started in other folders. */
const family = (): ReadonlyMap<string, readonly TreeSession[]> =>
  new Map([
    [
      HELM.toLowerCase(),
      [
        row(1, 'api-refactor', 'idle', {
          nested: [
            row(2, 'reviewer', 'busy', { hint: TRACKR }),
            row(3, 'worker', 'busy', { hint: TRACKR }),
            row(4, 'worker-2', 'waiting', { hint: TRACKR, note: 'needs you' })
          ]
        }),
        row(5, 'docs pass', 'idle')
      ]
    ]
  ])

describe('SessionTree: sessions that started sessions', () => {
  it('S18: draws each child under its parent, one step in with a hairline guide, whatever folder it runs in', () => {
    renderTree(family())

    // The parent's row, its three children, then the next session of the folder.
    expect(sessionRows().map((each) => each.getAttribute('data-session-row'))).toEqual([
      'session:1',
      'session:2',
      'session:3',
      'session:4',
      'session:5'
    ])

    // One step in from the parent: the child's dot sits 16px right of its parent's.
    expect(indentOf(2)).toBe(indentOf(1) + 16)
    expect(indentOf(3)).toBe(indentOf(1) + 16)
    expect(indentOf(5)).toBe(indentOf(1))

    // Each child has a hairline guide and an elbow into its row; the last
    // child's guide stops at the elbow and the others run on to the next.
    expect(guides(2)).toEqual(['more', 'elbow'])
    expect(guides(3)).toEqual(['more', 'elbow'])
    expect(guides(4)).toEqual(['last', 'elbow'])
    expect(guides(1)).toEqual([])
    expect(guides(5)).toEqual([])

    // The guide is a hairline in the border token, not a raw colour.
    const guide = rowOf(2).querySelector('[data-session-guide="more"]')
    expect(guide?.className).toContain('border-border-strong')

    // They run in trackr, but trackr's project lists none of them.
    expect(screen.queryByRole('button', { name: 'Fold the sessions in trackr' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Fold the sessions in helm' })).toBeTruthy()
  })

  it('S18: a child whose parent has ended is a top-level row marked with its parent’s name', () => {
    renderTree(
      new Map([
        [
          HELM.toLowerCase(),
          [
            row(1, 'api-refactor', 'ended'),
            row(2, 'worker', 'busy', { parentName: 'api-refactor', hint: TRACKR }),
            row(3, 'docs pass', 'idle')
          ]
        ]
      ])
    )

    // Level with the sessions around it, with no guide to a parent that is not there.
    expect(indentOf(2)).toBe(indentOf(1))
    expect(guides(2)).toEqual([])
    const mark = rowOf(2).querySelector('[data-session-parent]')
    expect(mark?.getAttribute('data-session-parent')).toBe('api-refactor')
    expect(mark?.textContent).toContain('api-refactor')
    expect(rowOf(2).getAttribute('aria-label')).toBe('worker, working, started by api-refactor')
    // A session nobody started carries no mark.
    expect(rowOf(3).querySelector('[data-session-parent]')).toBeNull()
  })

  it('S18: nests children under a parent in the Elsewhere list too', () => {
    renderTree(new Map(), {}, [
      row(1, 'scratch · tmp', 'idle', { nested: [row(2, 'checker', 'busy')] })
    ])
    expect(sessionRows().map((each) => each.getAttribute('data-session-row'))).toEqual(['session:1', 'session:2'])
    expect(indentOf(2)).toBe(indentOf(1) + 16)
    expect(guides(2)).toEqual(['last', 'elbow'])
  })

  it('S18: a grandchild is another step in, and the rule of a child with more below it runs on through its rows', () => {
    renderTree(
      new Map([
        [
          HELM.toLowerCase(),
          [
            row(1, 'api-refactor', 'idle', {
              nested: [
                row(2, 'lead', 'busy', { nested: [row(3, 'helper', 'busy')] }),
                row(4, 'worker', 'busy')
              ]
            })
          ]
        ]
      ])
    )
    expect(indentOf(3)).toBe(indentOf(2) + 16)
    // `lead` has a sibling after it, so the rule down its dot continues past `helper`.
    expect(guides(3)).toContain('through')
    expect(guides(3)).toContain('last')
    // A last child's rows below it carry no rule of that child's.
    expect(guides(4)).toEqual(['last', 'elbow'])
    // A row with children of its own has a caret where its elbow would be.
    expect(guides(2)).toEqual(['more', 'more'])
    expect(within(rowOf(2).parentElement as HTMLElement).getByRole('button', { name: /Fold the sessions started by lead/ })).toBeTruthy()
  })

  it('S19: folds its children the way a project folds its sessions, and shows the most pressing child’s dot', async () => {
    renderTree(family())
    const fold = screen.getByRole('button', { name: 'Fold the sessions started by api-refactor' })
    expect(fold.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[data-family-summary]')).toBeNull()

    await userEvent.click(fold)

    // Only the parent and the next session remain, and the parent wears the
    // dot of the child that most wants you: worker-2 is waiting.
    expect(sessionRows().map((each) => each.getAttribute('data-session-row'))).toEqual(['session:1', 'session:5'])
    const unfold = screen.getByRole('button', { name: 'Unfold the sessions started by api-refactor' })
    expect(unfold.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('[data-family-summary]')?.getAttribute('data-family-summary')).toBe('waiting')
    // The parent's own dot still says what the parent is doing.
    expect(rowOf(1).querySelector('[data-session-dot]')?.getAttribute('data-session-dot')).toBe('idle')

    await userEvent.click(unfold)
    expect(sessionRows()).toHaveLength(5)
    expect(document.querySelector('[data-family-summary]')).toBeNull()
  })

  it('S19: a folded parent shows working when that is the most pressing child, and nothing for a child with no state', async () => {
    renderTree(
      new Map([
        [
          HELM.toLowerCase(),
          [row(1, 'api-refactor', 'idle', { nested: [row(2, 'reviewer', 'busy'), row(3, 'worker', 'idle')] })]
        ]
      ])
    )
    await userEvent.click(screen.getByRole('button', { name: 'Fold the sessions started by api-refactor' }))
    expect(document.querySelector('[data-family-summary]')?.getAttribute('data-family-summary')).toBe('busy')
  })

  it('S19: folds one parent without touching another’s children', async () => {
    renderTree(
      new Map([
        [
          HELM.toLowerCase(),
          [
            row(1, 'first', 'idle', { nested: [row(2, 'first-child', 'busy')] }),
            row(3, 'second', 'idle', { nested: [row(4, 'second-child', 'busy')] })
          ]
        ]
      ])
    )
    await userEvent.click(screen.getByRole('button', { name: 'Fold the sessions started by first' }))
    expect(sessionRows().map((each) => each.getAttribute('data-session-row'))).toEqual([
      'session:1',
      'session:3',
      'session:4'
    ])
  })

  it('S20: pressing a child’s row asks for that child and opens nothing else', async () => {
    const { props } = renderTree(family())
    await userEvent.click(rowOf(3))
    // Which tab comes forward is the window’s to decide (the child’s own, else its parent’s).
    expect(props.onOpenSession).toHaveBeenCalledTimes(1)
    expect(props.onOpenSession).toHaveBeenCalledWith('session:3')
    expect(props.onSelect).not.toHaveBeenCalled()
    expect(props.onLaunch).not.toHaveBeenCalled()
  })

  it('S20: a child that appears never opens or unfolds anything by itself', () => {
    const { props, rerender } = renderTree(
      new Map([[HELM.toLowerCase(), [row(1, 'api-refactor', 'idle')]]])
    )
    rerender({ sessionsByPath: family() })
    expect(props.onOpenSession).not.toHaveBeenCalled()
    expect(sessionRows()).toHaveLength(5)
  })

  it('keeps a folded parent folded when a child is added, and shows the new child once it is unfolded', async () => {
    const { rerender } = renderTree(family())
    await userEvent.click(screen.getByRole('button', { name: 'Fold the sessions started by api-refactor' }))
    const more = new Map([
      [
        HELM.toLowerCase(),
        [
          row(1, 'api-refactor', 'idle', {
            nested: [row(2, 'reviewer', 'busy'), row(6, 'late', 'idle')]
          })
        ]
      ]
    ])
    rerender({ sessionsByPath: more })
    expect(sessionRows().map((each) => each.getAttribute('data-session-row'))).toEqual(['session:1'])
    await userEvent.click(screen.getByRole('button', { name: 'Unfold the sessions started by api-refactor' }))
    expect(sessionRows().map((each) => each.getAttribute('data-session-row'))).toEqual([
      'session:1',
      'session:2',
      'session:6'
    ])
  })

  it('finds a child by its name from the filter, with its parent’s project and family open', async () => {
    renderTree(family())
    await userEvent.type(screen.getByRole('textbox', { name: 'Filter projects and sessions' }), 'worker-2')
    expect(screen.queryByRole('button', { name: 'Fold the sessions in trackr' })).toBeNull()
    expect(rowOf(4)).toBeTruthy()
    expect(rowOf(1)).toBeTruthy()
  })

  it('opens the parent a revealed child is folded under', async () => {
    const { rerender } = renderTree(family())
    await userEvent.click(screen.getByRole('button', { name: 'Fold the sessions started by api-refactor' }))
    expect(sessionRows()).toHaveLength(2)
    rerender({ reveal: { seq: 1, kind: 'session', id: 'session:3' } })
    expect(sessionRows()).toHaveLength(5)
  })

  it('counts every session drawn under a folder in its group’s running figure', () => {
    renderTree(family())
    expect(screen.getByTitle('5 sessions running here')).toBeTruthy()
  })
})

const dotOf = (id: number): HTMLElement => {
  const found = rowOf(id).querySelector<HTMLElement>('[data-session-dot]')
  if (found === null) throw new Error(`no dot on session ${String(id)}`)
  return found
}

/**
 * What the design draws on a parent's row and a child's: the caret and where
 * the parent's dot sits beside it, the count of children that need you, a
 * command's terminal glyph in place of a dot, and a shell's hollow ring.
 */
describe('SessionTree: a parent’s row and a child’s as the design draws them', () => {
  it('draws the fold caret as the triangle glyph in the column before the parent’s dot, and that dot three pixels in from where a plain session’s sits', async () => {
    renderTree(family())
    const fold = screen.getByRole('button', { name: 'Fold the sessions started by api-refactor' })
    expect(fold.textContent).toBe('▾')
    // A 16px target centred on the 10px glyph, which sits 14px to 4px before the dot.
    expect(fold.style.left).toBe(`${String(indentOf(1) - 17)}px`)
    expect(fold.className).toContain('size-4')

    // The caret's column pushes the parent's dot in by three pixels; a session
    // with no children, and a child, keep theirs where the row's padding puts it.
    expect(dotOf(1).style.marginLeft).toBe('3px')
    expect(dotOf(5).style.marginLeft).toBe('')
    expect(dotOf(2).style.marginLeft).toBe('')

    await userEvent.click(fold)
    expect(screen.getByRole('button', { name: 'Unfold the sessions started by api-refactor' }).textContent).toBe('▸')
  })

  it('draws the same caret on a child that started children of its own', () => {
    renderTree(
      new Map([
        [
          HELM.toLowerCase(),
          [row(1, 'api-refactor', 'idle', { nested: [row(2, 'lead', 'busy', { nested: [row(3, 'helper', 'busy')] })] })]
        ]
      ])
    )
    const fold = screen.getByRole('button', { name: 'Fold the sessions started by lead' })
    expect(fold.textContent).toBe('▾')
    expect(fold.style.left).toBe(`${String(indentOf(2) - 17)}px`)
    expect(dotOf(2).style.marginLeft).toBe('3px')
  })

  it('counts on the parent’s row the children that need you, and says nothing when none does', async () => {
    renderTree(family())
    const pill = rowOf(1).querySelector('[data-session-needs]')
    expect(pill?.textContent).toBe('1')
    expect(pill?.getAttribute('data-session-needs')).toBe('1')
    expect(pill?.className).toContain('text-warn')
    expect(rowOf(1).getAttribute('aria-label')).toBe('api-refactor, ready, 1 of its sessions waiting for you')
    // Only a parent counts, and only its own children.
    expect(rowOf(4).querySelector('[data-session-needs]')).toBeNull()
    expect(rowOf(5).querySelector('[data-session-needs]')).toBeNull()

    // Still said while the family is folded away, beside the dot of the most pressing child.
    await userEvent.click(screen.getByRole('button', { name: 'Fold the sessions started by api-refactor' }))
    expect(rowOf(1).querySelector('[data-session-needs]')?.textContent).toBe('1')
  })

  it('counts every child that needs you, and shows no count for a family that waits on nobody', () => {
    renderTree(
      new Map([
        [
          HELM.toLowerCase(),
          [
            row(1, 'api-refactor', 'idle', {
              nested: [row(2, 'a', 'waiting'), row(3, 'b', 'waiting'), row(4, 'c', 'busy')]
            }),
            row(5, 'calm', 'idle', { nested: [row(6, 'd', 'busy'), row(7, 'e', 'idle')] })
          ]
        ]
      ])
    )
    expect(rowOf(1).querySelector('[data-session-needs]')?.textContent).toBe('2')
    expect(rowOf(5).querySelector('[data-session-needs]')).toBeNull()
  })

  it('draws a command child with the terminal glyph where a session has its dot', () => {
    renderTree(
      new Map([
        [
          HELM.toLowerCase(),
          [
            row(1, 'api-refactor', 'idle', {
              nested: [
                row(2, 'reviewer', 'busy'),
                row(3, 'tests', 'running', { command: true }),
                row(4, 'lint', 'ended', { command: true }),
                row(5, 'build', 'failed', { command: true })
              ]
            })
          ]
        ]
      ])
    )
    const glyph = (id: number): HTMLElement | null =>
      rowOf(id).querySelector<HTMLElement>('[data-session-command]')
    expect(glyph(3)?.querySelector('svg')).not.toBeNull()
    expect(glyph(3)?.getAttribute('data-session-command')).toBe('running')
    expect(rowOf(3).querySelector('[data-session-dot]')).toBeNull()
    // A session that is not a command keeps its dot and has no glyph.
    expect(glyph(2)).toBeNull()
    expect(rowOf(2).querySelector('[data-session-dot]')).not.toBeNull()
    // The glyph takes the tone a dot would: success while it runs, subtle once ended, danger when it failed.
    expect(glyph(3)?.className).toContain('text-success')
    expect(glyph(4)?.className).toContain('text-fg-subtle')
    expect(glyph(5)?.className).toContain('text-danger')
    // It is still a child of its parent: a step in, with the guide.
    expect(indentOf(3)).toBe(indentOf(1) + 16)
    expect(guides(3)).toEqual(['more', 'elbow'])
  })

  it('draws a hollow ring for a session whose agent is back at the shell, and on a folded parent for a child that is', async () => {
    renderTree(
      new Map([
        [
          HELM.toLowerCase(),
          [row(1, 'api-refactor', 'shell', { nested: [row(2, 'worker', 'shell')] })]
        ]
      ])
    )
    // A ring is an outline with no fill.
    const ring = dotOf(1)
    expect(ring.getAttribute('data-session-dot')).toBe('shell')
    expect(ring.className).toContain('border-success')
    expect(ring.className).not.toContain('bg-success')

    await userEvent.click(screen.getByRole('button', { name: 'Fold the sessions started by api-refactor' }))
    const summary = rowOf(1).querySelector('[data-family-summary]')
    expect(summary?.getAttribute('data-family-summary')).toBe('shell')
    expect(summary?.className).toContain('border-success')
  })
})
