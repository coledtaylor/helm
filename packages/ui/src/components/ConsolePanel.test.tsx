import { useState, type JSX } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ConsolePanel, type ConsoleEntry, type ConsolePanelProps } from './ConsolePanel'

const LOG: ConsoleEntry = { level: 'info', message: 'page says hello', source: 'http://localhost:3000/app.js', line: 4, at: 0 }
const WARNING: ConsoleEntry = { level: 'warning', message: 'careful now', source: '', line: 0, at: 0 }
const ERROR: ConsoleEntry = { level: 'error', message: 'it broke', source: '', line: 0, at: 0 }

/** The panel with its open state held the way its two callers hold it. */
function Panel(props: Omit<ConsolePanelProps, 'open' | 'onToggle'> & { startOpen?: boolean }): JSX.Element {
  const { startOpen = false, ...rest } = props
  const [open, setOpen] = useState(startOpen)
  return <ConsolePanel {...rest} open={open} onToggle={() => setOpen((current) => !current)} />
}

// jsdom does no layout, so it runs the label's spans together ("Consoleclean");
// Chromium blockifies them as flex items and puts a space between.
const toggle = (): HTMLElement => screen.getByRole('button', { name: /^Console/ })

describe('ConsolePanel', () => {
  it('counts errors and warnings on its chip, and starts clean', () => {
    const { rerender } = render(<ConsolePanel name="browser" entries={[]} open={false} onToggle={vi.fn()} />)
    expect(screen.getByRole('button', { name: /^Console\s*clean$/ })).toBe(toggle())

    rerender(<ConsolePanel name="browser" entries={[LOG]} open={false} onToggle={vi.fn()} />)
    expect(screen.getByRole('button', { name: /^Console\s*1$/ })).toBe(toggle())

    rerender(<ConsolePanel name="browser" entries={[LOG, WARNING, ERROR]} open={false} onToggle={vi.fn()} />)
    expect(screen.getByRole('button', { name: /^Console\s*2 errors$/ })).toBe(toggle())
  })

  it('opens from the chip, shows what was logged, and closes again', async () => {
    const user = userEvent.setup()
    render(<Panel name="browser" entries={[LOG, ERROR]} />)
    expect(screen.queryByText('page says hello')).toBeNull()
    expect(toggle().getAttribute('aria-expanded')).toBe('false')

    await user.click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('page says hello')).toBeTruthy()
    expect(screen.getByText('it broke')).toBeTruthy()
    expect(screen.getByText('app.js:4')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Hide the console' }))
    expect(screen.queryByText('page says hello')).toBeNull()
  })

  it('filters by level', async () => {
    const user = userEvent.setup()
    render(<Panel name="browser" entries={[LOG, WARNING, ERROR]} startOpen />)
    const filters = screen.getByRole('group', { name: 'Filter console entries' })
    const shown = (): string[] =>
      ['page says hello', 'careful now', 'it broke'].filter((text) => screen.queryByText(text) !== null)

    expect(shown()).toEqual(['page says hello', 'careful now', 'it broke'])
    await user.click(within(filters).getByRole('button', { name: 'Errors' }))
    expect(within(filters).getByRole('button', { name: 'Errors' }).getAttribute('aria-pressed')).toBe('true')
    expect(shown()).toEqual(['it broke'])
    await user.click(within(filters).getByRole('button', { name: 'Warnings' }))
    expect(shown()).toEqual(['careful now'])
    await user.click(within(filters).getByRole('button', { name: 'Logs' }))
    expect(shown()).toEqual(['page says hello'])
    await user.click(within(filters).getByRole('button', { name: 'All' }))
    expect(shown()).toEqual(['page says hello', 'careful now', 'it broke'])
  })

  it('evaluates a line in the page and prints what came back, or the error', async () => {
    const user = userEvent.setup()
    const onEvaluate = vi.fn((source: string) =>
      Promise.resolve(
        source === 'window.answer'
          ? { ok: true, value: 'FIXTURE-EVAL-VALUE', error: null }
          : { ok: false, value: '', error: 'ReferenceError: nope is not defined' }
      )
    )
    render(<Panel name="browser" entries={[]} onEvaluate={onEvaluate} startOpen />)
    const input = screen.getByRole('textbox', { name: 'Evaluate JavaScript in the page' })

    await user.type(input, 'window.answer{Enter}')
    expect(onEvaluate).toHaveBeenCalledWith('window.answer')
    expect(await screen.findByText('FIXTURE-EVAL-VALUE')).toBeTruthy()
    expect((input as HTMLInputElement).value).toBe('')

    await user.type(input, 'nope{Enter}')
    expect(await screen.findByText('ReferenceError: nope is not defined')).toBeTruthy()
  })

  it("is read-only for an artifact: no input line, and it says why", () => {
    render(
      <Panel
        name="artifact"
        entries={[LOG]}
        note="Read-only. Helm can watch what it logs and cannot run anything inside it."
        startOpen
      />
    )
    expect(screen.getByText('page says hello')).toBeTruthy()
    expect(screen.getByText(/^Read-only\./)).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
  })
})
