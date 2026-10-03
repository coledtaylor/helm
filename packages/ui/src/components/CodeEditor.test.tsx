import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { highlightLines, type EditorHighlight } from '@helm/core'
import { CodeEditor } from './CodeEditor'
import { installExecCommand, installLayoutStandIns, type ExecCommandStandIn } from './CodeEditor.testkit'

installLayoutStandIns()

/**
 * The one editor, driven the way a person drives it: keys into the textarea,
 * and the layers under it read back. The tokeniser is core's own, reached
 * through the same callback main answers over IPC.
 */

type Highlight = (path: string, source: string) => Promise<EditorHighlight>

/** What `editor:highlight` answers, computed in-process. */
const realHighlight: Highlight = async (path, source) => {
  const ext = path.slice(path.lastIndexOf('.') + 1)
  const out = await highlightLines(source, ext)
  return { lines: out.lines, language: out.language, highlighted: out.highlighted, tooLarge: false, tookMs: 0 }
}

/** The editor with the state a host gives it: the value it is handed back. */
function Editor({
  initial,
  path = 'C:\\scope\\file.json',
  onHighlight = null,
  wrap = false
}: {
  initial: string
  path?: string
  onHighlight?: Highlight | null
  wrap?: boolean
}): JSX.Element {
  const [value, setValue] = useState(initial)
  return (
    <CodeEditor
      value={value}
      onChange={setValue}
      surface="config"
      path={path}
      ariaLabel="Edit file"
      onHighlight={onHighlight}
      wrap={wrap}
    />
  )
}

let editing: ExecCommandStandIn

beforeEach(() => {
  editing = installExecCommand()
})

afterEach(() => {
  editing.restore()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const box = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Edit file' }) as HTMLTextAreaElement
const layer = (container: HTMLElement, name: 'underlay' | 'highlight'): HTMLElement =>
  container.querySelector(`[data-editor-${name}]`) as HTMLElement

/** Puts the caret (or a selection) somewhere and presses a key, as a person would. */
function press(at: number | [number, number], key: string, modifiers: { shiftKey?: boolean } = {}): boolean {
  const area = box()
  area.focus()
  const [start, end] = typeof at === 'number' ? [at, at] : at
  area.setSelectionRange(start, end)
  return fireEvent.keyDown(area, { key, ...modifiers })
}

describe('CodeEditor: the text', () => {
  it('stays a controlled textarea whose mirror holds exactly what is typed', async () => {
    const { container } = render(<Editor initial={'{\n  "a": 1\n}\n'} />)
    await userEvent.type(box(), 'tail')
    expect(box().value).toBe('{\n  "a": 1\n}\ntail')
    expect(layer(container, 'underlay').textContent).toBe(box().value)
  })

  it('paints each line of the tokeniser’s answer with both themes’ colours', async () => {
    const { container } = render(<Editor initial={'{ "a": 1 }\n{ "b": true }\n'} onHighlight={realHighlight} />)

    await vi.waitFor(() => expect(container.querySelector('.helm-editor')?.getAttribute('data-editor-coloured')).toBe('true'))
    const lines = [...layer(container, 'highlight').querySelectorAll<HTMLElement>('.line')]
    expect(lines.map((line) => line.textContent)).toEqual(['{ "a": 1 }', '{ "b": true }', ''])
    const tokens = [...lines[0]!.querySelectorAll<HTMLElement>('span[style]')]
    expect(tokens.length).toBeGreaterThan(1)
    for (const token of tokens) {
      expect(token.style.getPropertyValue('--shiki-light')).not.toBe('')
      expect(token.style.getPropertyValue('--shiki-dark')).not.toBe('')
    }
  })

  it('shows a keystroke in the text layer at once, before any colour comes back', () => {
    const never: Highlight = () => new Promise(() => undefined)
    const { container } = render(<Editor initial={'{}\n'} onHighlight={never} />)
    fireEvent.change(box(), { target: { value: '{}\nx\n' } })
    expect(layer(container, 'underlay').textContent).toBe('{}\nx\n')
    expect([...layer(container, 'highlight').querySelectorAll('.line')].map((line) => line.textContent)).toEqual([
      '{}',
      'x',
      ''
    ])
  })

  it('moves the layers with the textarea’s scroll', () => {
    const { container } = render(<Editor initial={'{}\n'} />)
    box().scrollTop = 120
    box().scrollLeft = 30
    fireEvent.scroll(box())
    expect((container.querySelector('.helm-editor-layers') as HTMLElement).style.transform).toBe(
      'translate(-30px, -120px)'
    )
    expect((container.querySelector('.helm-editor-gutter-rows') as HTMLElement).style.transform).toBe(
      'translateY(-120px)'
    )
  })
})

describe('CodeEditor: keys', () => {
  it('indents at a caret and over a selection by the file’s unit, and Shift+Tab outdents', () => {
    render(<Editor initial={'{\n"a": 1,\n"b": 2\n}'} />)

    expect(press(2, 'Tab')).toBe(false)
    expect(box().value).toBe('{\n  "a": 1,\n"b": 2\n}')
    expect(box().selectionStart).toBe(4)

    press([2, 18], 'Tab')
    expect(box().value).toBe('{\n    "a": 1,\n  "b": 2\n}')

    press([2, 22], 'Tab', { shiftKey: true })
    expect(box().value).toBe('{\n  "a": 1,\n"b": 2\n}')
  })

  it('keeps indentation on Enter, and opens a block between a bracket pair', () => {
    const { unmount } = render(<Editor initial={'{\n  "a": 1\n}'} />)
    // At the end of the indented line.
    press(10, 'Enter')
    expect(box().value).toBe('{\n  "a": 1\n  \n}')
    expect(box().selectionStart).toBe(13)
    unmount()

    render(<Editor initial="[]" />)
    press(1, 'Enter')
    expect(box().value).toBe('[\n  \n]')
    expect(box().selectionStart).toBe(4)
  })

  it('closes brackets, types over a closer, and takes an empty pair on Backspace', () => {
    render(<Editor initial="" />)

    press(0, '[')
    expect([box().value, box().selectionStart]).toEqual(['[]', 1])
    press(1, ']')
    expect([box().value, box().selectionStart]).toEqual(['[]', 2])
    press(1, 'Backspace')
    expect([box().value, box().selectionStart]).toEqual(['', 0])
    press(0, '"')
    expect([box().value, box().selectionStart]).toEqual(['""', 1])
  })

  it('leaves a quote in prose to the textarea', () => {
    render(<Editor initial="It is" path="C:\\scope\\CLAUDE.md" />)
    expect(press(2, '"')).toBe(true)
    expect(editing.calls).toEqual([])
  })

  it('applies every edit through the browser’s editing command, never by assignment', () => {
    const { container } = render(<Editor initial="{}" />)
    press(1, 'Enter')
    press(0, 'Tab')
    expect(editing.calls.map((call) => call.command)).toEqual(['insertText', 'insertText'])
    expect(container.querySelector('.helm-editor')?.getAttribute('data-editor-direct-writes')).toBe('0')
  })
})

describe('CodeEditor: find and go to line', () => {
  it('counts and paints matches, and steps through them', async () => {
    const { container } = render(<Editor initial={'one two\nOne three\nlast one'} path="C:\\scope\\notes.txt" />)

    box().focus()
    fireEvent.keyDown(box(), { key: 'f', ctrlKey: true })
    const find = await screen.findByPlaceholderText('Find')
    await userEvent.type(find, 'one')

    expect(screen.getByText('1 of 3')).toBeTruthy()
    const marks = [...layer(container, 'underlay').querySelectorAll('mark')]
    expect(marks.map((mark) => mark.textContent)).toEqual(['one', 'One', 'one'])
    expect(marks.map((mark) => mark.getAttribute('data-editor-match-current'))).toEqual(['true', 'false', 'false'])

    await userEvent.click(screen.getByRole('button', { name: 'Next match' }))
    expect(screen.getByText('2 of 3')).toBeTruthy()
    expect([box().selectionStart, box().selectionEnd]).toEqual([8, 11])

    await userEvent.click(screen.getByRole('button', { name: 'Previous match' }))
    await userEvent.click(screen.getByRole('button', { name: 'Previous match' }))
    expect(screen.getByText('3 of 3')).toBeTruthy()
    expect([box().selectionStart, box().selectionEnd]).toEqual([23, 26])
  })

  it('goes to a line on Ctrl+G and Enter', async () => {
    render(<Editor initial={'a\nbb\nccc\ndddd\ne'} path="C:\\scope\\notes.txt" />)
    box().focus()
    fireEvent.keyDown(box(), { key: 'g', ctrlKey: true })

    const line = await screen.findByPlaceholderText('1-5')
    await userEvent.type(line, '4{Enter}')
    expect(box().selectionStart).toBe('a\nbb\nccc\n'.length)
    expect(screen.queryByPlaceholderText('1-5')).toBeNull()
  })
})

describe('CodeEditor: the gutter', () => {
  it('marks the caret’s line number as the caret moves', () => {
    const { container } = render(<Editor initial={'a\nb\nc\nd'} path="C:\\scope\\notes.txt" />)
    const gutter = container.querySelector('[data-editor-gutter]') as HTMLElement
    const current = (): string[] =>
      within(gutter)
        .getAllByText(/^\d+$/)
        .filter((number) => number.getAttribute('data-editor-current') === 'true')
        .map((number) => number.textContent ?? '')

    expect(current()).toEqual(['1'])
    box().setSelectionRange(4, 4)
    fireEvent.keyUp(box(), { key: 'ArrowDown' })
    expect(current()).toEqual(['3'])
  })

  it('puts each number, and the caret band, on its own logical line’s box, wrapped lines included', () => {
    // Line 2 wraps to three rows. Boxes are measured from the layer stack's top.
    const heights = [20, 60, 20, 20]
    const box4 = (top: number, height: number): DOMRect => ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.classList.contains('helm-editor-layers')) return box4(100, 400)
      if (this.classList.contains('line') && this.closest('[data-editor-highlight]')) {
        const index = [...(this.parentElement?.children ?? [])].indexOf(this)
        return box4(108 + heights.slice(0, index).reduce((sum, h) => sum + h, 0), heights[index] ?? 0)
      }
      return box4(0, 0)
    })
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(400)

    const { container } = render(<Editor initial={'a\na long line\nc\nd'} path="C:\\scope\\notes.txt" wrap />)
    box().setSelectionRange(3, 3)
    fireEvent.keyUp(box(), { key: 'ArrowDown' })

    const numbers = [...container.querySelectorAll<HTMLElement>('[data-editor-gutter] [data-editor-line-number]')]
    expect(numbers.map((number) => [number.textContent, number.style.top])).toEqual([
      ['1', '8px'],
      ['2', '28px'],
      ['3', '88px'],
      ['4', '108px']
    ])
    const band = container.querySelector<HTMLElement>('.helm-editor-caret-line')
    expect([band?.style.top, band?.style.height]).toEqual(['28px', '60px'])
  })
})

describe('CodeEditor: colour arriving late, or not at all', () => {
  it('asks for colour only once typing pauses, and keeps the untouched lines coloured meanwhile', async () => {
    vi.useFakeTimers()
    const answers: Array<(value: EditorHighlight) => void> = []
    const asked: string[] = []
    const onHighlight: Highlight = (_path, source) => {
      asked.push(source)
      return new Promise((resolve) => answers.push(resolve))
    }
    const colour = (source: string): EditorHighlight => ({
      lines: source.split('\n').map((line) => `<span style="--shiki-light:#111;--shiki-dark:#eee">${line}</span>`),
      language: 'json',
      highlighted: true,
      tooLarge: false,
      tookMs: 1
    })
    const { container } = render(<Editor initial={'{}\n[]'} onHighlight={onHighlight} />)
    const root = container.querySelector('.helm-editor') as HTMLElement

    await act(async () => vi.advanceTimersByTime(110))
    expect(asked).toEqual(['{}\n[]'])
    await act(async () => answers[0]!(colour('{}\n[]')))
    expect(root.getAttribute('data-editor-coloured')).toBe('true')

    for (const value of ['{}\n[1]', '{}\n[12]', '{}\n[123]']) {
      fireEvent.change(box(), { target: { value } })
      await act(async () => vi.advanceTimersByTime(60))
    }
    expect(asked).toHaveLength(1)
    // The edited line is plain text now, the other one still carries colour.
    expect(root.getAttribute('data-editor-coloured')).toBe('false')
    const lines = [...layer(container, 'highlight').querySelectorAll<HTMLElement>('.line')]
    expect(lines[0]?.querySelector('span[style]')).not.toBeNull()
    expect(lines[1]?.querySelector('span[style]')).toBeNull()

    await act(async () => vi.advanceTimersByTime(50))
    expect(asked).toEqual(['{}\n[]', '{}\n[123]'])
    await act(async () => answers[1]!(colour('{}\n[123]')))
    expect(root.getAttribute('data-editor-coloured')).toBe('true')
  })

  it('colours only a window of a long file while the mirror holds all of it', () => {
    // Twenty-pixel lines in a 400-pixel box, so about twenty are on screen.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const at = (top: number, height: number): DOMRect =>
        ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
      if (this.classList.contains('line')) return at(20 * [...(this.parentElement?.children ?? [])].indexOf(this), 20)
      return at(0, 0)
    })
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(400)
    const value = Array.from({ length: 3000 }, (_, i) => `line ${String(i + 1)}`).join('\n')
    const { container } = render(<Editor initial={value} path="C:\\scope\\big.txt" />)

    const rendered = layer(container, 'highlight').querySelectorAll('.line')
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered.length).toBeLessThan(500)
    expect(rendered[0]?.textContent).toBe('line 1')
    expect(layer(container, 'underlay').textContent).toBe(value)
  })

  it('drops the layers and the gutter past the ceiling, and still takes typing', async () => {
    const tooLarge: Highlight = () =>
      Promise.resolve({ lines: [], language: 'plaintext', highlighted: false, tooLarge: true, tookMs: 0 })
    const { container } = render(<Editor initial={'a\nb'} path="C:\\scope\\big.txt" onHighlight={tooLarge} />)

    await vi.waitFor(() => expect(container.querySelector('.helm-editor')?.getAttribute('data-editor-plain')).toBe('true'))
    expect(layer(container, 'highlight').querySelectorAll('.line')).toHaveLength(0)
    expect(layer(container, 'underlay').textContent).toBe('')
    expect(container.querySelectorAll('[data-editor-line-number]')).toHaveLength(0)

    await userEvent.type(box(), 'c')
    expect(box().value).toBe('a\nbc')
  })
})
