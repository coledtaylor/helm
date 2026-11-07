import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { overlayOpen } from '../lib/overlay'
import { AwayList, type AwayRowView } from './AwayList'
import { NeedsYouToast, type NeedsYouToastProps } from './NeedsYouToast'

/** The needs-you toast and While you were away: what each names, offers, and calls. */

function toast(overrides: Partial<NeedsYouToastProps> = {}): NeedsYouToastProps {
  return {
    name: 'worker-2',
    detail: 'It is waiting on a permission prompt. Started by api-refactor, which has been told.',
    action: { label: 'Show', onPress: vi.fn() },
    onOpen: vi.fn(),
    onClose: vi.fn(),
    ...overrides
  }
}

describe('the needs-you toast', () => {
  it('S10: names the child, what it waits on and who started it, and offers Show and Open as tab', async () => {
    const props = toast()
    render(<NeedsYouToast {...props} />)
    const status = screen.getByRole('status')
    expect(status.textContent).toContain('worker-2 needs you')
    expect(status.textContent).toContain(
      'It is waiting on a permission prompt. Started by api-refactor, which has been told.'
    )
    expect(screen.queryByRole('button', { name: 'Peek' })).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Show' }))
    expect(props.action.onPress).toHaveBeenCalledTimes(1)
    await user.click(screen.getByRole('button', { name: 'Open as tab' }))
    expect(props.onOpen).toHaveBeenCalledTimes(1)
  })

  it('S11: offers Peek in place of Show for a child with nowhere on screen', async () => {
    const props = toast({ action: { label: 'Peek', onPress: vi.fn() } })
    render(<NeedsYouToast {...props} />)
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Peek' }))
    expect(props.action.onPress).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Open as tab' })).toBeTruthy()
  })

  it('has a close button, and is not an overlay: a browser view is not stood down for it', async () => {
    const props = toast()
    render(<NeedsYouToast {...props} />)
    expect(overlayOpen()).toBe(false)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close notification' }))
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })
})

const NO_ACTIONS = { peek: vi.fn(), open: vi.fn(), dismiss: vi.fn(), dismissError: vi.fn() }

const rowsOf = (actions: typeof NO_ACTIONS): AwayRowView[] => [
  {
    key: 'a',
    tone: 'needs',
    title: 'worker-2 needs you',
    detail: 'Waiting on a permission prompt since 03:12. Started by api-refactor, which was told.',
    actions: [
      { label: 'Peek', onPress: actions.peek },
      { label: 'Open', onPress: actions.open }
    ]
  },
  {
    key: 'b',
    tone: 'needs',
    title: 'api-refactor was refused a start',
    detail: 'The limit of 4 starts per parent holds.',
    actions: [{ label: 'Dismiss', onPress: actions.dismiss }]
  },
  {
    key: 'c',
    tone: 'danger',
    title: 'docs-check ended in error',
    detail: 'It exited with code 3.',
    actions: [{ label: 'Dismiss', onPress: actions.dismissError }]
  }
]

describe('While you were away', () => {
  it('S15: lists each notice with what it is about, Peek and Open for a child that needs you and Dismiss for a refused start or an error', async () => {
    const actions = { peek: vi.fn(), open: vi.fn(), dismiss: vi.fn(), dismissError: vi.fn() }
    render(<AwayList host="home-server" rows={rowsOf(actions)} onClose={vi.fn()} />)
    const list = screen.getByRole('region', { name: 'While you were away' })
    expect(list.textContent).toContain('While you were away on home-server')
    const rows = [...list.querySelectorAll('[data-away-row]')]
    expect(rows.map((each) => each.getAttribute('data-away-row'))).toEqual(['a', 'b', 'c'])
    expect(rows[0]!.textContent).toContain('worker-2 needs you')
    expect(rows[0]!.textContent).toContain('since 03:12')
    expect([...rows[0]!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Peek', 'Open'])
    expect([...rows[1]!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Dismiss'])
    expect([...rows[2]!.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Dismiss'])

    const user = userEvent.setup()
    await user.click(rows[0]!.querySelectorAll('button')[0]!)
    await user.click(rows[0]!.querySelectorAll('button')[1]!)
    await user.click(rows[1]!.querySelector('button')!)
    await user.click(rows[2]!.querySelector('button')!)
    expect(actions.peek).toHaveBeenCalledTimes(1)
    expect(actions.open).toHaveBeenCalledTimes(1)
    expect(actions.dismiss).toHaveBeenCalledTimes(1)
    expect(actions.dismissError).toHaveBeenCalledTimes(1)
  })

  it('S15: the close button closes the list, and the list is not an overlay', async () => {
    const onClose = vi.fn()
    render(<AwayList host="home-server" rows={rowsOf(NO_ACTIONS)} onClose={onClose} />)
    expect(overlayOpen()).toBe(false)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close list' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
