import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PullDetailView } from '@helm/core/types'
import { PullRequestPane, type PullRequestPaneProps } from './PullRequestPane'
import { detailView, HOUR, renderedThread } from './pullFixtures.testkit'

function renderPane(overrides: Partial<PullRequestPaneProps> = {}) {
  const props: PullRequestPaneProps = {
    view: detailView(),
    loading: false,
    onRefresh: vi.fn(),
    refreshing: false,
    onOpenExternal: vi.fn(),
    onReview: vi.fn(),
    reviewing: false,
    reviewPrompt: '/code-review 7',
    reviewCheckout: false,
    onDismissReviewError: vi.fn(),
    ...overrides
  }
  const view = render(<PullRequestPane {...props} />)
  return { props, ...view }
}

/** The text of the whole row a diff line's code sits in: gutters, sign and code. */
const diffRow = (code: string): string => screen.getByText(code).parentElement?.textContent ?? ''

/** A review thread's header, by the `path:line` it shows on hover. */
const threadToggle = (place: string): HTMLElement => screen.getByTitle(place)

/**
 * Four threads: one open on a line the patch shows, one resolved, one outdated
 * whose current line is gone, and one on a line outside the patch.
 */
function withThreads(patch: Partial<PullDetailView> = {}): PullDetailView {
  const at = Date.now() - 3 * HOUR
  return detailView({
    conversation: [
      renderedThread('T1', 'src/old.ts', 2, { at }),
      renderedThread('T2', 'src/old.ts', 3, { at: at + 1, isResolved: true }),
      renderedThread('T3', 'src/new.ts', null, {
        at: at + 2,
        originalLine: 2,
        isOutdated: true,
        diffHunk: '@@ -1,2 +1,3 @@\n const a = 1\n // <b>not markup</b>\n+const b = 2'
      }),
      renderedThread('T4', 'src/old.ts', 40, { at: at + 3 })
    ],
    ...patch
  })
}

describe('PullRequestPane', () => {
  it('heads the tab with the number, title, state, branch, size, file count and checks', () => {
    renderPane()

    expect(screen.getByRole('heading', { level: 1, name: 'Cache the discovery walk' })).toBeTruthy()
    expect(screen.getByText('#7')).toBeTruthy()
    expect(screen.getByText('open')).toBeTruthy()
    expect(screen.getByText('fix/cache-walk → main')).toBeTruthy()
    expect(screen.getByText('+3')).toBeTruthy()
    expect(screen.getByText('−1')).toBeTruthy()
    expect(screen.getByText('2 files')).toBeTruthy()
    expect(screen.getByTitle('3 checks, 1 failing, 1 pending').textContent).toBe('1/3 failing')
    expect(screen.getByText('fetched 2m ago · acme/alpha')).toBeTruthy()
  })

  it('paints the description main rendered, as HTML', () => {
    const { container } = renderPane()
    expect(container.querySelector('strong')?.textContent).toBe('it')
  })

  it('lists the commits on the branch', async () => {
    const user = userEvent.setup()
    renderPane()

    await user.click(screen.getByRole('button', { name: 'Commits' }))

    expect(screen.getByTitle('a'.repeat(40)).textContent).toMatch(/^aaaaaaaCache the walk/)
    expect(screen.getByTitle('b'.repeat(40)).textContent).toMatch(/^bbbbbbbInvalidate on focus\+1 co-author/)
    expect(screen.getByText(/2 commits on/).textContent).toBe('2 commits on fix/cache-walk.')
  })

  it('paints each file’s patch: status, hunk header, and added, removed and context rows', async () => {
    const user = userEvent.setup()
    renderPane()
    await user.click(screen.getByRole('button', { name: 'Files' }))

    const added = screen.getByRole('button', { name: /^src\/new\.ts/ })
    expect(within(added).getByText('added')).toBeTruthy()
    expect(within(screen.getByRole('button', { name: /^src\/old\.ts/ })).getByText('modified')).toBeTruthy()
    expect(screen.getByText('@@ -1,3 +1,3 @@ function compute()')).toBeTruthy()
    // Old line, new line, sign, code - as a reader sees each row.
    expect(diffRow('export const a = 1')).toBe('1+export const a = 1')
    expect(diffRow('const gone = 2')).toBe('2-const gone = 2')
    expect(diffRow('const here = 3')).toBe('2+const here = 3')
    expect(diffRow('const keep = 1')).toBe('11const keep = 1')
  })

  it('collapses a file to its header and reopens it with the same rows', async () => {
    const user = userEvent.setup()
    renderPane()
    await user.click(screen.getByRole('button', { name: 'Files' }))
    const toggle = screen.getByRole('button', { name: /^src\/new\.ts/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    await user.click(toggle)
    expect(screen.queryByText('export const a = 1')).toBeNull()
    expect(screen.getByRole('button', { name: /^src\/new\.ts/ }).getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText('const here = 3')).toBeTruthy()

    await user.click(toggle)
    expect(diffRow('export const a = 1')).toBe('1+export const a = 1')
    expect(diffRow('export const b = 2')).toBe('2+export const b = 2')
  })

  it('counts what a ceiling cut, on screen', async () => {
    const user = userEvent.setup()
    const view = detailView({ diffNote: 'The patch is larger than the 2MB Helm fetches, so the files below it are listed without one.' })
    view.files[0]!.droppedLines = 37
    renderPane({ view })
    await user.click(screen.getByRole('button', { name: 'Files' }))

    expect(screen.getByText(/larger than the 2MB Helm fetches/)).toBeTruthy()
    expect(screen.getByText(/^37 more lines in this file/)).toBeTruthy()
  })

  describe('review threads', () => {
    it('gives each thread one card in Conversation, named by file and line, with its markdown as main rendered it', () => {
      const { container } = renderPane({ view: withThreads() })

      expect(screen.getAllByRole('button', { name: /^src\// })).toHaveLength(4)
      expect(threadToggle('src/old.ts:2')).toBeTruthy()
      // Outdated: no current line, so the original one is named.
      expect(threadToggle('src/new.ts:2')).toBeTruthy()
      expect(threadToggle('src/old.ts:40')).toBeTruthy()
      expect([...container.querySelectorAll('strong')].map((el) => el.textContent)).toEqual(
        expect.arrayContaining(['T1', 'T3', 'T4'])
      )
    })

    it('starts a resolved thread collapsed with a chip, an outdated one open with a chip, and the rest open with none', () => {
      renderPane({ view: withThreads() })

      const resolved = threadToggle('src/old.ts:3')
      expect(resolved.getAttribute('aria-expanded')).toBe('false')
      expect(within(resolved).getByText('resolved')).toBeTruthy()
      expect(screen.queryByText('T2')).toBeNull()

      const outdated = threadToggle('src/new.ts:2')
      expect(outdated.getAttribute('aria-expanded')).toBe('true')
      expect(within(outdated).getByText('outdated')).toBeTruthy()

      const plain = threadToggle('src/old.ts:2')
      expect(plain.getAttribute('aria-expanded')).toBe('true')
      expect(within(plain).queryByText('resolved')).toBeNull()
      expect(within(plain).queryByText('outdated')).toBeNull()
    })

    it('paints a thread’s hunk as text, so markup planted in it makes no element', () => {
      const { container } = renderPane({ view: withThreads() })

      expect(screen.getByText(/<b>not markup<\/b>/)).toBeTruthy()
      expect(container.querySelector('b')).toBeNull()
    })

    it('puts a thread on the head-side row it was left on, and one outside the patch at the foot of its file', async () => {
      const user = userEvent.setup()
      renderPane({ view: withThreads() })
      await user.click(screen.getByRole('button', { name: 'Files' }))

      // Under the row it was left on: new line 2 of old.ts, and for the
      // outdated one the line it was originally written against.
      const under = (code: string): HTMLElement =>
        screen.getByText(code).parentElement?.nextElementSibling as HTMLElement
      expect(within(under('const here = 3')).getByTitle('src/old.ts:2')).toBeTruthy()
      expect(within(under('export const b = 2')).getByTitle('src/new.ts:2')).toBeTruthy()

      expect(screen.getByText('1 comment on this file that the diff above has no row for.')).toBeTruthy()
      expect(screen.getByText('on a line that is not in this diff')).toBeTruthy()
      expect(threadToggle('src/old.ts:40')).toBeTruthy()
    })

    it('says threads were never fetched, in both views, rather than that there are none', async () => {
      const user = userEvent.setup()
      const note =
        'Comments left on lines of the diff have not been fetched for this pull request - it was cached before Helm could read them. Refresh to fetch them.'
      renderPane({ view: detailView({ threadsNote: note, threadsFetchedAtMs: null }) })

      expect(screen.getByText(note)).toBeTruthy()
      await user.click(screen.getByRole('button', { name: 'Files' }))
      expect(screen.getByText(note)).toBeTruthy()
    })

    it('says a re-read failed beside the age of the threads still shown', () => {
      renderPane({
        view: withThreads({
          threadsNote: 'Comments left on lines of the diff could not be re-read - HTTP 502. The 4 shown are the ones Helm already had.',
          threadsFetchedAtMs: Date.now() - 10 * 60_000
        })
      })

      expect(screen.getByText(/could not be re-read - HTTP 502/)).toBeTruthy()
      expect(screen.getByText('Fetched 10m ago.')).toBeTruthy()
    })
  })

  describe('Review with Claude', () => {
    it('stays disabled until the pull request has loaded', async () => {
      const user = userEvent.setup()
      const { props, rerender } = renderPane({ view: null, loading: true, reviewPrompt: '' })
      const button = screen.getByRole('button', { name: 'Review with Claude' }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(screen.getByText('Reading the pull request…')).toBeTruthy()

      rerender(<PullRequestPane {...props} view={detailView()} loading={false} reviewPrompt="/code-review 7" />)
      expect(button.disabled).toBe(false)
      await user.click(button)
      expect(props.onReview).toHaveBeenCalledTimes(1)
    })

    it('says what it will run before it is pressed, naming the model and effort flags only when they are set', () => {
      const { props, rerender } = renderPane()
      const disclosure = (): string => screen.getByText(/^Runs/).textContent ?? ''
      expect(disclosure()).toBe('Runs claude in C:\\work space\\alpha with the opening prompt /code-review 7.')
      expect(disclosure()).not.toMatch(/--model|--effort/)

      rerender(<PullRequestPane {...props} reviewModel="opus" reviewEffort="high" reviewCheckout />)
      expect(disclosure()).toMatch(/ On --model opus\. At --effort high\./)
      expect(disclosure()).toMatch(/Checks the branch out first with gh pr checkout/)
    })

    it('shows why a launch was refused until it is dismissed', async () => {
      const user = userEvent.setup()
      const { props } = renderPane({ reviewError: 'C:\\work space\\alpha has 2 uncommitted changes.' })

      expect(screen.getByRole('alert').textContent).toMatch(/has 2 uncommitted changes\./)
      await user.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Dismiss' }))
      expect(props.onDismissReviewError).toHaveBeenCalledTimes(1)
    })
  })
})
