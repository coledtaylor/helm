import { within } from '@testing-library/react'
import { expect } from 'vitest'

/**
 * A page drawn on the pane it is in (DESIGN.md 3): the pane is the island, so
 * nothing inside the page is one, and the bar under the tab strip names no
 * title the tab above it already says.
 */
export function expectOnThePane(root: HTMLElement, bar: string): void {
  expect(root.querySelector('.rounded-island')).toBeNull()
  const header = root.querySelector<HTMLElement>(`[data-pane-header="${bar}"]`)
  expect(header).not.toBeNull()
  expect(within(header!).queryByRole('heading')).toBeNull()
}
