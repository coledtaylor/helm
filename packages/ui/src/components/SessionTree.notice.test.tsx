import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_INVENTORY, type DiscoveryResult, type Project } from '@helm/core/types'
import { SessionTree, type TreeNoticeActions, type TreeSession } from './SessionTree'

/**
 * The line a parent's refused start leaves under its children in the Sessions
 * tree: the limit and what holds it, Allow n more for the starts limit, Settings
 * > Agents, and Dismiss.
 */

const HELM = 'C:\\work\\north\\repos\\helm'

const PROJECT: Project = {
  path: HELM,
  name: 'helm',
  kind: 'repo',
  harnessPath: 'C:\\work\\north',
  hasClaudeDir: false,
  inventory: EMPTY_INVENTORY,
  git: null
}

const DISCOVERY: DiscoveryResult = {
  roots: ['C:\\work'],
  harnesses: [{ path: 'C:\\work\\north', name: 'north', template: null, version: null, repoPaths: [HELM] }],
  projects: [PROJECT],
  errors: [],
  scannedAt: '2026-10-03T00:00:00.000Z',
  durationMs: 1
}

const row = (id: number, label: string, extra: Partial<TreeSession> = {}): TreeSession => ({
  id: `session:${String(id)}`,
  label,
  state: 'busy',
  note: '',
  hint: HELM,
  outside: false,
  shown: null,
  ...extra
})

function renderTree(parent: TreeSession, actions?: TreeNoticeActions): void {
  render(
    <SessionTree
      discovery={DISCOVERY}
      scanning={false}
      selectedPath={null}
      pinnedPaths={[]}
      onTogglePin={vi.fn()}
      sessionsByPath={new Map([[HELM.toLowerCase(), [parent]]])}
      elsewhere={[]}
      onSelect={vi.fn()}
      onLaunch={vi.fn()}
      launchingPath={null}
      onOpenSession={vi.fn()}
      onAddRoot={vi.fn()}
      noticeActions={actions}
    />
  )
}

/** The kinds of guide a session's row draws, in document order. */
const guidesOf = (id: number): string[] =>
  [
    ...document.querySelector(`[data-session-row="session:${String(id)}"]`)!.querySelectorAll('[data-session-guide]')
  ].map((each) => each.getAttribute('data-session-guide') ?? '')

const SENTENCE =
  'The limit of 4 running agents per parent holds: you have 4 running (reviewer, worker). Wait for news from them and start again.'

describe('the limit notice under a parent children', () => {
  it('S16: names the limit and what holds it under the parent children, with Settings and Dismiss, and no Allow for a limit that is not the starts limit', () => {
    renderTree(
      row(1, 'api-refactor', {
        nested: [row(2, 'reviewer'), row(3, 'worker')],
        notice: { key: 'n1', text: SENTENCE, allowMore: null }
      })
    )
    const notice = document.querySelector<HTMLElement>('[data-limit-notice]')!
    expect(notice.textContent).toContain('Limit reached.')
    expect(notice.textContent).toContain(SENTENCE)
    expect(within(notice).getByRole('button', { name: 'Settings \u203a Agents' })).toBeTruthy()
    expect(within(notice).getByRole('button', { name: 'Dismiss' })).toBeTruthy()
    expect(within(notice).queryByRole('button', { name: /Allow/ })).toBeNull()
    // Under the parent's children, not before them.
    const rows = [...document.querySelectorAll('[data-session-row], [data-limit-notice]')].map(
      (each) => each.getAttribute('data-session-row') ?? 'notice'
    )
    expect(rows).toEqual(['session:1', 'session:2', 'session:3', 'notice'])
  })

  it('S16: offers Allow 16 more first for the starts limit, says the number the host gave, and calls the window for each button', async () => {
    const actions: TreeNoticeActions = { onAllowMore: vi.fn(), onSettings: vi.fn(), onDismiss: vi.fn() }
    renderTree(
      row(1, 'api-refactor', {
        nested: [row(2, 'reviewer')],
        notice: { key: 'n1', text: SENTENCE, allowMore: 16 }
      }),
      actions
    )
    const notice = document.querySelector<HTMLElement>('[data-limit-notice]')!
    const buttons = within(notice)
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(buttons).toEqual(['Allow 16 more', 'Settings \u203a Agents', 'Dismiss'])
    const user = userEvent.setup()
    await user.click(within(notice).getByRole('button', { name: 'Allow 16 more' }))
    expect(actions.onAllowMore).toHaveBeenCalledWith('n1')
    await user.click(within(notice).getByRole('button', { name: 'Settings \u203a Agents' }))
    expect(actions.onSettings).toHaveBeenCalledTimes(1)
    await user.click(within(notice).getByRole('button', { name: 'Dismiss' }))
    expect(actions.onDismiss).toHaveBeenCalledWith('n1')
  })

  it('S16: keeps the host’s full sentence as the notice’s hover text', () => {
    renderTree(
      row(1, 'api-refactor', {
        nested: [row(2, 'reviewer')],
        notice: {
          key: 'n1',
          text: 'api-refactor asked for a fifth agent at 14:41; a session may run 4 at once.',
          detail: SENTENCE,
          allowMore: null
        }
      })
    )
    const notice = document.querySelector<HTMLElement>('[data-limit-notice]')!
    expect(notice.textContent).toContain('api-refactor asked for a fifth agent at 14:41; a session may run 4 at once.')
    expect(notice.getAttribute('title')).toBe(SENTENCE)
  })

  it('S16: the last child’s guide runs on down to the notice instead of ending at its elbow', () => {
    renderTree(
      row(1, 'api-refactor', {
        nested: [row(2, 'reviewer'), row(3, 'worker')],
        notice: { key: 'n1', text: SENTENCE, allowMore: null }
      })
    )
    expect(guidesOf(3)).toEqual(['more', 'elbow'])
  })

  it('S16: with no notice the last child’s guide ends at its elbow', () => {
    renderTree(row(1, 'api-refactor', { nested: [row(2, 'reviewer'), row(3, 'worker')] }))
    expect(guidesOf(3)).toEqual(['last', 'elbow'])
  })

  it('S16: a parent with no refused start shows no notice', () => {
    renderTree(row(1, 'api-refactor', { nested: [row(2, 'reviewer')] }))
    expect(document.querySelector('[data-limit-notice]')).toBeNull()
  })

  it('S16: shows the notice under a parent that has no children running', () => {
    renderTree(row(1, 'api-refactor', { notice: { key: 'n1', text: 'The depth limit holds.', allowMore: null } }))
    expect(screen.getByText('The depth limit holds.', { exact: false })).toBeTruthy()
  })
})
