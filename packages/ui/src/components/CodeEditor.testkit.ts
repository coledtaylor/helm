/**
 * The two layout APIs the editor and the markdown body call that jsdom lacks:
 * `ResizeObserver` and `Element.scrollTo`. Both are no-ops here, for the reason
 * `test-setup.ts` gives for `scrollIntoView` - jsdom does no layout, so where
 * something lands is an end-to-end question.
 */
export function installLayoutStandIns(): void {
  Element.prototype.scrollTo ??= function scrollTo() {}
  globalThis.ResizeObserver ??= class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
}

/**
 * Chromium's `document.execCommand('insertText' | 'delete')`, which jsdom does
 * not implement.
 *
 * `CodeEditor` applies every programmatic edit through it so the browser's undo
 * stack keeps the edit. This stand-in makes the same change to the focused
 * textarea and fires the `input` event Chromium fires, so React receives it the
 * way it would in the app - and it records each call, so a test can say the
 * edit went this way rather than by assigning `.value`.
 */
export interface ExecCommandStandIn {
  calls: Array<{ command: string; value: string | undefined }>
  restore: () => void
}

export function installExecCommand(): ExecCommandStandIn {
  const calls: ExecCommandStandIn['calls'] = []
  const previous = Object.getOwnPropertyDescriptor(document, 'execCommand')

  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: (command: string, _showUi?: boolean, value?: string): boolean => {
      calls.push({ command, value })
      const area = document.activeElement
      if (!(area instanceof HTMLTextAreaElement)) return false
      const start = area.selectionStart
      const end = area.selectionEnd
      if (command === 'insertText') {
        area.setRangeText(value ?? '', start, end, 'end')
      } else if (command === 'delete') {
        // A collapsed selection deletes the character before the caret, as a
        // Backspace does; a selection deletes itself.
        if (start === end && start > 0) area.setRangeText('', start - 1, end, 'end')
        else if (start !== end) area.setRangeText('', start, end, 'end')
      } else {
        return false
      }
      area.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    }
  })

  return {
    calls,
    restore: () => {
      if (previous) Object.defineProperty(document, 'execCommand', previous)
      else delete (document as { execCommand?: unknown }).execCommand
    }
  }
}
