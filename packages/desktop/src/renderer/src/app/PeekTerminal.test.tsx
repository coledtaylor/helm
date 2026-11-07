// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Hooks = Record<string, (...args: never[]) => unknown>

const made = vi.hoisted(() => ({
  options: [] as unknown[],
  hooks: [] as unknown[],
  prefs: [] as unknown[],
  terminals: [] as Array<{
    term: { options: Record<string, unknown>; write: (text: string) => void }
    dispose: () => void
  }>
}))

vi.mock('../terminal', () => ({
  TERMINAL_DEFAULTS: { fontFamily: 'mono', fontSize: 14, cursorStyle: 'block', cursorBlink: true, scrollback: 10000 },
  terminalFontStack: (family: string | null) => family ?? 'mono',
  createTerminal: (_container: HTMLElement, opts: unknown, hooks: unknown, prefs: unknown) => {
    const host = { term: { options: {} as Record<string, unknown>, write: vi.fn() }, dispose: vi.fn() }
    made.options.push(opts)
    made.hooks.push(hooks)
    made.prefs.push(prefs)
    made.terminals.push(host)
    return host
  }
}))
vi.mock('./bridge', () => ({ helm: { invoke: vi.fn() } }))

import { PeekTerminal, peekHiddenRows } from './PeekTerminal'

const GRID = { cols: 90, rows: 20 }

afterEach(() => {
  made.options.length = 0
  made.hooks.length = 0
  made.prefs.length = 0
  made.terminals.length = 0
})

describe('the peek terminal', () => {
  it('S1: is made at the grid the child has, in 11px mono at a line height of 1.5, never fits itself to its box, takes no keyboard and no input', () => {
    render(<PeekTerminal attach={() => () => undefined} grid={GRID} windowsBuild={null} />)
    expect(made.options[0]).toMatchObject({ ...GRID, fit: false, focus: false })
    expect(made.prefs[0]).toMatchObject({ fontSize: 11, scrollback: 0 })
    expect(made.terminals[0]?.term.options).toMatchObject({ disableStdin: true, cursorBlink: false, lineHeight: 1.5 })
  })

  it('S4: whatever the terminal is given to send goes nowhere: no keys and no size', () => {
    render(<PeekTerminal attach={() => () => undefined} grid={GRID} windowsBuild={null} />)
    const hooks = made.hooks[0] as Hooks
    expect(hooks.onInput?.('echo hi' as never)).toBeUndefined()
    expect(hooks.onResize?.(10 as never, 5 as never)).toBeUndefined()
  })

  it('S1: draws what the peek kept and then each chunk as it arrives, and stops with the view', () => {
    let sink: (text: string) => void = () => undefined
    const detach = vi.fn()
    const view = render(
      <PeekTerminal
        attach={(next) => {
          sink = next
          next('screen so far')
          return detach
        }}
        grid={GRID}
        windowsBuild={null}
      />
    )
    const host = made.terminals[0]
    expect(host?.term.write).toHaveBeenCalledWith('screen so far', expect.any(Function))
    sink('more')
    expect(host?.term.write).toHaveBeenLastCalledWith('more', expect.any(Function))
    view.unmount()
    expect(detach).toHaveBeenCalledTimes(1)
    expect(host?.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('where the peek ends the screen of a child', () => {
  const blank = (rows: number): string[] => Array.from({ length: rows }, () => '')

  it('leaves out the empty rows under what a program drew from the top of its grid', () => {
    const lines = blank(32)
    lines[0] = 'Claude Code v2'
    lines[3] = '> hello'
    expect(peekHiddenRows(lines, 3)).toBe(28)
  })

  it('keeps the rows down to the cursor even when it sits on an empty row', () => {
    const lines = blank(32)
    lines[0] = 'ready'
    expect(peekHiddenRows(lines, 5)).toBe(26)
  })

  it('leaves nothing out of a screen drawn to its last row', () => {
    const lines = blank(32)
    lines[31] = 'x'.repeat(100)
    expect(peekHiddenRows(lines, 31)).toBe(0)
  })
})
