import { COPY_REFUSED, PASTE_REFUSED, REFUSED_SHOWN_MS } from '@helm/ui'
import type { ClipboardRead, ClipboardWriteOutcome } from '../../shared/ipc'

/**
 * What a terminal says when the clipboard refused it, in the pane that copied
 * or pasted rather than over the whole window.
 *
 * The terminal lives outside React (`app/terminals.ts`), so this is plain DOM,
 * a child of the element the terminal is in, which moves with it between panes.
 * Top right, clear of a TUI's composer along the bottom; it takes no pointer
 * events, so a selection or a click meant for the TUI goes where it was aimed;
 * and it leaves by itself after `CLIPBOARD_NOTICE_MS`. Another refusal while
 * it is up replaces its text and starts its time again.
 */

export const CLIPBOARD_NOTICE_MS = REFUSED_SHOWN_MS

const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

export function showClipboardNotice(container: HTMLElement, text: string): void {
  let notice = container.querySelector<HTMLElement>(':scope > [data-clipboard-notice]')
  if (notice === null) {
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative'
    // Two elements for one island, as the window's toast: the tint is
    // translucent, so it sits on an opaque ground rather than on the terminal.
    notice = document.createElement('div')
    notice.dataset.clipboardNotice = ''
    notice.setAttribute('role', 'status')
    notice.className =
      'pointer-events-none absolute right-2 top-2 z-20 max-w-[calc(100%-16px)] overflow-hidden rounded-raised bg-surface'
    const body = document.createElement('div')
    body.className = 'rounded-raised border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger'
    notice.appendChild(body)
    container.appendChild(notice)
  }
  const shown = notice
  shown.firstElementChild!.textContent = text
  clearTimeout(timers.get(shown))
  timers.set(
    shown,
    setTimeout(() => {
      timers.delete(shown)
      shown.remove()
    }, CLIPBOARD_NOTICE_MS)
  )
}

/** The one call a terminal makes to copy: the selection, said in the pane if refused. */
export async function copyToClipboard(
  container: HTMLElement,
  text: string,
  write: (text: string) => Promise<ClipboardWriteOutcome>
): Promise<void> {
  if ((await write(text)) === 'refused') showClipboardNotice(container, COPY_REFUSED)
}

/** The text to paste, or null with the refusal said in the pane. */
export async function readForPaste(
  container: HTMLElement,
  read: () => Promise<ClipboardRead>
): Promise<string | null> {
  const got = await read()
  if ('refused' in got) {
    showClipboardNotice(container, PASTE_REFUSED)
    return null
  }
  return got.text
}
