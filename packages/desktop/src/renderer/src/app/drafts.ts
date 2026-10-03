import type { ParkedDraft } from './useDocument'

/**
 * Unsaved notes, by file, for as long as the window is open.
 *
 * A note's editor lives in its tab, and a tab is unmounted whenever another
 * tab comes to the front of its pane - so the draft is kept here rather than
 * in the editor, and handed back when the tab is drawn again. Closing the tab
 * keeps it too: opening the file again brings the edits back, marked unsaved,
 * rather than losing them to a click on a cross.
 *
 * Not React state, deliberately. A draft changes on every keystroke and
 * nothing outside the tab draws it; the tab strip's unsaved dot is told
 * separately, once per change of dirty, not once per letter.
 */
const parked = new Map<string, ParkedDraft>()

export const drafts = {
  get(key: string): ParkedDraft | null {
    return parked.get(key) ?? null
  },
  /** Null forgets it - the draft was saved, reverted, or reloaded over. */
  set(key: string, draft: ParkedDraft | null): void {
    if (draft === null) parked.delete(key)
    else parked.set(key, draft)
  }
}
