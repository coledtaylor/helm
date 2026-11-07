// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Hooks = Record<string, (...args: never[]) => unknown>

const made = vi.hoisted(() => ({
  options: [] as unknown[],
  hooks: [] as unknown[],
  terminals: [] as Array<{
    term: { options: Record<string, unknown>; write: (text: string) => void }
    dispose: () => void
  }>
}))

vi.mock('../terminal', () => ({
  TERMINAL_DEFAULTS: { fontFamily: 'mono', fontSize: 14, cursorStyle: 'block', cursorBlink: true, scrollback: 10000 },
  terminalFontStack: (family: string | null) => family ?? 'mono',
  createTerminal: (_container: HTMLElement, opts: unknown, hooks: unknown) => {
    const host = { term: { options: {} as Record<string, unknown>, write: vi.fn() }, dispose: vi.fn() }
    made.options.push(opts)
    made.hooks.push(hooks)
    made.terminals.push(host)
    return host
  }
}))
vi.mock('./bridge', () => ({ helm: { invoke: vi.fn() } }))

import { PEEK_GRID, PeekTerminal, peekCut } from './PeekTerminal'

afterEach(() => {
  made.options.length = 0
  made.hooks.length = 0
  made.terminals.length = 0
})

describe('the peek terminal', () => {
  it('S4: is made at the child grid, never fits itself to its box, takes no keyboard and no input', () => {
    render(<PeekTerminal attach={() => () => undefined} windowsBuild={null} />)
    expect(made.options[0]).toMatchObject({ ...PEEK_GRID, fit: false, focus: false })
    expect(made.terminals[0]?.term.options).toMatchObject({ disableStdin: true, cursorBlink: false })
  })

  it('S4: whatever the terminal is given to send goes nowhere: no keys and no size', () => {
    render(<PeekTerminal attach={() => () => undefined} windowsBuild={null} />)
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

describe('where the peek cuts the screen of a child', () => {
  const blank = (rows: number): string[] => Array.from({ length: rows }, () => '')

  it('leaves out the empty rows under what a program drew from the top of its grid', () => {
    const lines = blank(32)
    lines[0] = 'Claude Code v2'
    lines[3] = '> hello'
    expect(peekCut(lines, 3, 120)).toEqual({ hiddenRows: 28, cols: 60 })
  })

  it('keeps the rows down to the cursor even when it sits on an empty row', () => {
    const lines = blank(32)
    lines[0] = 'ready'
    expect(peekCut(lines, 5, 120).hiddenRows).toBe(26)
  })

  it('leaves nothing out of a screen drawn to its last row, and fits it to the widest line shown', () => {
    const lines = blank(32)
    lines[31] = 'x'.repeat(100)
    lines[30] = 'short'
    expect(peekCut(lines, 31, 120)).toEqual({ hiddenRows: 0, cols: 101 })
  })

  it('never fits to more columns than the grid has or fewer than a short screen needs', () => {
    const lines = blank(32)
    lines[2] = 'y'.repeat(200)
    expect(peekCut(lines, 2, 120).cols).toBe(120)
    expect(peekCut(blank(32), 0, 120).cols).toBe(60)
  })
})
