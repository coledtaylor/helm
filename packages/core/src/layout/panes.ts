import type { WorkspaceTab } from '../types'

/**
 * The panes in the window and the tabs in each, as data.
 *
 * One or two **groups** side by side, each an island with its own strip of
 * tabs and one of them in front, and one group **focused** - the one a new tab
 * opens into. Any kind of tab may sit in either group: a session beside the
 * project page it was started from, a session beside another session, history
 * beside both. What phase 1 does not do is the free tiling the second phase is
 * about - more than two groups, or a group placed anywhere but beside the
 * other - and `PANE_GROUPS_MAX` is where that is decided.
 *
 * Pure and browser-safe, so the renderer imports it through `@helm/core/types`
 * and every rule about where a tab lands is tested here rather than discovered
 * in a window. Every operation takes a layout and returns one, normalised: no
 * empty group survives beside a group with tabs in it, every group's `activeId`
 * names a tab that is in it, and `focused` names a group that exists.
 */

/**
 * Anything a pane can show.
 *
 * `WorkspaceTab` is what reopens on its own at the next start. A session is a
 * process `before-quit` ends, a browser tab is a `WebContentsView` it
 * destroys, and the restore offer is one start's question about the last.
 */
export type PaneRef =
  | WorkspaceTab
  | { kind: 'browser'; id: number }
  | { kind: 'session'; id: number }
  | { kind: 'restore' }

/**
 * A tab as `AppSettings.paneLayout` writes it down: every `WorkspaceTab`, and
 * every session by its row id.
 *
 * A session is written down so that a crash can put its conversation back
 * where it was (`placeRestored`). It never reopens by itself: the next start
 * hosts no session with that id, so `reconcile` drops the tab before it is
 * drawn. A browser tab is not written down at all, because nothing could put
 * the page it was showing back.
 */
export type SavedPane = WorkspaceTab | { kind: 'session'; id: number }

/** Side by side, and no more, in this phase. */
export const PANE_GROUPS_MAX = 2

export interface PaneGroup {
  readonly tabs: readonly PaneRef[]
  /** Which tab is in front. Null only for an empty group. */
  readonly activeId: string | null
}

export interface PaneLayout {
  readonly groups: readonly PaneGroup[]
  /** The group a new tab opens into, and whose active tab the keyboard means. */
  readonly focused: number
}

/** One group as `AppSettings.paneLayout` stores it. See `SavedPane`. */
export interface SavedPaneGroup {
  panes: SavedPane[]
  activeId: string | null
}

export interface SavedPaneLayout {
  groups: SavedPaneGroup[]
  focused: number
}

/** The window with nothing open: one group, empty, focused. */
export const EMPTY_LAYOUT: PaneLayout = { groups: [{ tabs: [], activeId: null }], focused: 0 }

/**
 * A tab's identity, compared and never taken apart again.
 *
 * A Windows path can contain a `#` and a `:`, so this string is an identity and
 * not a record; whatever needs the path or the number reads them off the ref.
 * `session:<id>` is the shape the drivers locate session tabs by.
 */
export function paneId(ref: PaneRef): string {
  switch (ref.kind) {
    case 'project':
      return `project:${ref.path}`
    case 'pr':
      return `pr:${ref.repoPath}#${String(ref.number)}`
    case 'browser':
      return `browser:${String(ref.id)}`
    case 'session':
      return `session:${String(ref.id)}`
    case 'file':
      return `file:${ref.path}`
    default:
      // history, sessions, pulls, config, content, settings: one of each, so
      // the kind is the identity.
      return ref.kind
  }
}

/** Whether a tab is written down across a restart. See `SavedPane`. */
export function isPersistable(ref: PaneRef): ref is SavedPane {
  return ref.kind !== 'browser' && ref.kind !== 'restore'
}

/** The tab in front of a group: its `activeId`, or the last tab if that is gone. */
export function activeRef(group: PaneGroup): PaneRef | null {
  if (group.activeId !== null) {
    const found = group.tabs.find((ref) => paneId(ref) === group.activeId)
    if (found) return found
  }
  return group.tabs.at(-1) ?? null
}

/** Where a tab is, or null if no group holds it. */
export function findTab(layout: PaneLayout, id: string): { group: number; index: number } | null {
  for (let group = 0; group < layout.groups.length; group += 1) {
    const index = layout.groups[group]!.tabs.findIndex((ref) => paneId(ref) === id)
    if (index >= 0) return { group, index }
  }
  return null
}

/** Every tab that is in front of its group, which is every tab on screen. */
export function visibleTabs(layout: PaneLayout): PaneRef[] {
  return layout.groups.flatMap((group) => {
    const ref = activeRef(group)
    return ref === null ? [] : [ref]
  })
}

/**
 * The one shape every operation returns.
 *
 * Empty groups are dropped - a group exists to hold tabs - except that the
 * window always has one, so an empty layout is one empty group rather than
 * none. A tab id that appears twice keeps its first place, groups past
 * `PANE_GROUPS_MAX` fold into the last one allowed, and the focus follows the
 * group it was on, or the nearest surviving one when that group went.
 */
function normalize(groups: readonly PaneGroup[], focused: number): PaneLayout {
  const seen = new Set<string>()
  const deduped = groups.map((group) => ({
    activeId: group.activeId,
    tabs: group.tabs.filter((ref) => {
      const id = paneId(ref)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
  }))

  const capped = deduped.slice(0, PANE_GROUPS_MAX)
  const overflow = deduped.slice(PANE_GROUPS_MAX).flatMap((group) => group.tabs)
  if (overflow.length > 0) {
    const last = capped[capped.length - 1]!
    capped[capped.length - 1] = { ...last, tabs: [...last.tabs, ...overflow] }
  }

  const kept = capped.filter((group) => group.tabs.length > 0)
  if (kept.length === 0) return EMPTY_LAYOUT

  const wanted = Math.max(0, Math.min(focused, capped.length - 1))
  const before = capped.slice(0, wanted).filter((group) => group.tabs.length > 0).length

  return {
    groups: kept.map((group) => ({
      tabs: group.tabs,
      activeId: paneId(activeRef(group) ?? group.tabs[group.tabs.length - 1]!)
    })),
    focused: Math.min(before, kept.length - 1)
  }
}

function withGroup(layout: PaneLayout, index: number, group: PaneGroup): PaneGroup[] {
  return layout.groups.map((current, at) => (at === index ? group : current))
}

/**
 * The tab beside the one leaving, for a group whose front tab is closing.
 *
 * The one that slides into its place, which is the right-hand neighbour, and
 * the left-hand one when it was last. A fallback to the last tab - what a
 * stale `activeId` gets - would jump the strip's front to its far end every
 * time anything in the middle was closed.
 */
function neighbourOf(tabs: readonly PaneRef[], index: number): string | null {
  const next = tabs[index + 1] ?? tabs[index - 1]
  return next === undefined ? null : paneId(next)
}

/**
 * Brings a tab to the front, opening it if no group has it.
 *
 * A tab already open anywhere is activated where it is rather than opened a
 * second time, which is what makes every "open this" in the app also a way
 * back to it. A new one lands in `group`, the focused group unless told
 * otherwise; `group` equal to the number of groups opens a new one beside
 * them, while there is room.
 */
export function openTab(layout: PaneLayout, ref: PaneRef, group = layout.focused): PaneLayout {
  const id = paneId(ref)
  if (findTab(layout, id) !== null) return activateTab(layout, id)

  if (group >= layout.groups.length) {
    if (layout.groups.length >= PANE_GROUPS_MAX) return openTab(layout, ref, layout.groups.length - 1)
    // A layout whose only group is empty has nothing to sit beside.
    if (layout.groups.every((g) => g.tabs.length === 0)) return openTab(layout, ref, 0)
    return normalize([...layout.groups, { tabs: [ref], activeId: id }], layout.groups.length)
  }

  const index = Math.max(0, group)
  const target = layout.groups[index]!
  return normalize(withGroup(layout, index, { tabs: [...target.tabs, ref], activeId: id }), index)
}

/** Puts a tab in front of its group and focuses that group. */
export function activateTab(layout: PaneLayout, id: string): PaneLayout {
  const at = findTab(layout, id)
  if (at === null) return layout
  const group = layout.groups[at.group]!
  if (group.activeId === id && layout.focused === at.group) return layout
  return normalize(withGroup(layout, at.group, { ...group, activeId: id }), at.group)
}

export function focusGroup(layout: PaneLayout, index: number): PaneLayout {
  if (index === layout.focused || index < 0 || index >= layout.groups.length) return layout
  return { ...layout, focused: index }
}

export function closeTab(layout: PaneLayout, id: string): PaneLayout {
  const at = findTab(layout, id)
  if (at === null) return layout
  const group = layout.groups[at.group]!
  const tabs = group.tabs.filter((_, index) => index !== at.index)
  const activeId = group.activeId === id ? neighbourOf(group.tabs, at.index) : group.activeId
  return normalize(withGroup(layout, at.group, { tabs, activeId }), layout.focused)
}

/**
 * Moves a tab to `toIndex` in group `toGroup`, which may be its own group (a
 * reorder) or the other one. `toIndex` is the place it ends up, counted after
 * it has left wherever it was. `toGroup` equal to the number of groups opens a
 * new group for it, while there is room - which is how a split is made.
 *
 * The moved tab is in front of the group it lands in and that group takes the
 * focus, because the gesture that moved it was aimed there.
 */
export function moveTab(layout: PaneLayout, id: string, toGroup: number, toIndex: number): PaneLayout {
  const from = findTab(layout, id)
  if (from === null || toGroup < 0) return layout
  const creating = toGroup === layout.groups.length
  if (toGroup > layout.groups.length) return layout
  if (creating && layout.groups.length >= PANE_GROUPS_MAX) return layout

  const source = layout.groups[from.group]!
  const ref = source.tabs[from.index]!
  const remaining = source.tabs.filter((_, index) => index !== from.index)

  if (toGroup === from.group) {
    const at = Math.max(0, Math.min(toIndex, remaining.length))
    if (at === from.index) return activateTab(layout, id)
    const tabs = [...remaining.slice(0, at), ref, ...remaining.slice(at)]
    return normalize(withGroup(layout, from.group, { tabs, activeId: id }), from.group)
  }

  // A group cannot be split away from itself: moving the only tab of the only
  // group into a new one would leave the first empty and change nothing.
  if (creating && remaining.length === 0) return layout

  const groups: PaneGroup[] = [...layout.groups]
  groups[from.group] = {
    tabs: remaining,
    activeId: source.activeId === id ? neighbourOf(source.tabs, from.index) : source.activeId
  }
  const target = creating ? { tabs: [], activeId: null } : groups[toGroup]!
  const at = Math.max(0, Math.min(toIndex, target.tabs.length))
  const landed = { tabs: [...target.tabs.slice(0, at), ref, ...target.tabs.slice(at)], activeId: id }
  if (creating) groups.push(landed)
  else groups[toGroup] = landed
  return normalize(groups, toGroup)
}

/**
 * Sends the focused group's front tab to the other group, opening the other
 * group if there is only one. The Split button and Ctrl+\ both mean this.
 *
 * A single group with a single tab has nothing to split, and is left alone.
 */
export function sendToOtherGroup(layout: PaneLayout): PaneLayout {
  const group = layout.groups[layout.focused]
  const front = group === undefined ? null : activeRef(group)
  if (front === null) return layout
  if (layout.groups.length === 1) return moveTab(layout, paneId(front), 1, 0)
  const other = layout.focused === 0 ? 1 : 0
  return moveTab(layout, paneId(front), other, layout.groups[other]!.tabs.length)
}

/**
 * Puts a tab in the pane beside the focused one, opening that pane if there is
 * only one - the launcher's "Start beside".
 *
 * Opened and then moved, rather than opened there directly, because a session
 * may already have a tab by the time it is placed: `reconcile` gives every
 * hosted session one, in the focused group. A lone tab in a lone pane has
 * nothing to sit beside, and stays where it is.
 */
export function placeBeside(layout: PaneLayout, ref: PaneRef): PaneLayout {
  const id = paneId(ref)
  const opened = openTab(layout, ref)
  if (opened.groups.length === 1) return moveTab(opened, id, 1, 0)
  const other = layout.focused === 0 ? 1 : 0
  return moveTab(opened, id, other, opened.groups[other]!.tabs.length)
}

/** A file tab, as `openFile` takes it. */
export type FileRef = Extract<PaneRef, { kind: 'file' }>

/**
 * Opens a file to be read beside the session that is changing it.
 *
 * Where it lands is the whole point of the rule. With a session in front of the
 * focused pane, the file goes to the **other** pane - opening one if there is
 * only one - so the terminal and the file are side by side rather than one
 * hiding the other. With anything else in front, the file opens in the focused
 * pane: that is the pane already being used for reading, and a file sent past
 * it would take the session's place on the far side.
 *
 * **Preview.** A file opened by a single click stands as the pane's preview tab
 * and the next single click replaces it in place, so reading through a tree
 * does not leave a tab per file looked at. `keep` opens a tab that stays - a
 * double click, or Ctrl+P - and keeping the preview itself turns it into an
 * ordinary tab. `preview` is the id of the tab standing as the preview now, or
 * null; what comes back is the layout and the preview after.
 */
export function openFile(
  layout: PaneLayout,
  ref: FileRef,
  preview: string | null,
  keep: boolean
): { layout: PaneLayout; preview: string | null } {
  const id = paneId(ref)
  const still = preview !== null && findTab(layout, preview) !== null ? preview : null

  if (findTab(layout, id) !== null) {
    return { layout: activateTab(layout, id), preview: keep && still === id ? null : still }
  }

  const group = layout.groups[layout.focused]
  const front = group === undefined ? null : activeRef(group)
  const target =
    front?.kind !== 'session'
      ? layout.focused
      : layout.groups.length === 1
        ? layout.groups.length
        : layout.focused === 0
          ? 1
          : 0

  if (!keep && still !== null) {
    const at = findTab(layout, still)!
    if (at.group === target) {
      const tabs = layout.groups[target]!.tabs.map((tab) => (paneId(tab) === still ? ref : tab))
      return {
        layout: normalize(withGroup(layout, target, { tabs, activeId: id }), target),
        preview: id
      }
    }
  }

  return { layout: openTab(layout, ref, target), preview: keep ? still : id }
}

/**
 * Closes a group by handing its tabs to the other one, never by closing them.
 * A group's close button that ended the sessions in it would be a destructive
 * control dressed as a layout one.
 */
export function closeGroup(layout: PaneLayout, index: number): PaneLayout {
  if (layout.groups.length < 2 || index < 0 || index >= layout.groups.length) return layout
  const other = index === 0 ? 1 : 0
  const leaving = layout.groups[index]!
  const staying = layout.groups[other]!
  const merged = { tabs: [...staying.tabs, ...leaving.tabs], activeId: staying.activeId }
  return normalize([merged], 0)
}

/**
 * The layout as it can actually be drawn: tabs whose thing is gone are
 * dropped, and things that exist with no tab are given one.
 *
 * `keep` says whether a tab's thing still exists - a project discovery still
 * finds, a session main still hosts, a view main still holds. `extra` is what
 * exists and must have a tab whether or not anything placed it: every hosted
 * session and every browser view. Those land in the focused group.
 *
 * Derived, rather than synced into state in an effect, for the reason the
 * strips always were: a session that appears after a renderer reload, or a
 * page's `window.open`, would otherwise render once with no tab and again
 * with one.
 */
export function reconcile(
  layout: PaneLayout,
  keep: (ref: PaneRef) => boolean,
  extra: readonly PaneRef[]
): PaneLayout {
  const groups = layout.groups.map((group) => ({ ...group, tabs: group.tabs.filter(keep) }))
  const present = new Set(groups.flatMap((group) => group.tabs.map(paneId)))
  const added: PaneRef[] = []
  for (const ref of extra) {
    const id = paneId(ref)
    if (present.has(id)) continue
    present.add(id)
    added.push(ref)
  }
  if (added.length > 0) {
    const into = Math.max(0, Math.min(layout.focused, groups.length - 1))
    const target = groups[into]!
    groups[into] = { ...target, tabs: [...target.tabs, ...added] }
  }
  return normalize(groups, layout.focused)
}

/**
 * Ctrl+Tab: the next tab across every group, as one ring.
 *
 * Counted from the focused group's front tab, and wrapping from the last tab of
 * the last group to the first of the first. Landing in the other group moves
 * the focus there, so the keyboard and the eye stay on the same pane.
 */
export function cycleTab(layout: PaneLayout, step: 1 | -1): PaneLayout {
  const ring = layout.groups.flatMap((group) => group.tabs.map(paneId))
  if (ring.length < 2) return layout
  const group = layout.groups[layout.focused]
  const current = group === undefined ? null : activeRef(group)
  const at = current === null ? -1 : ring.indexOf(paneId(current))
  const next = ring[(at + step + ring.length) % ring.length]
  return next === undefined ? layout : activateTab(layout, next)
}

/**
 * What `AppSettings.paneLayout` keeps: the persistable tabs, in their groups,
 * and which was in front. A group holding only sessions comes back empty and
 * disappears on an ordinary start, which is the honest restore of a group whose
 * every tab was a process that did not survive; after a crash,
 * `placeRestored` reads it to put them back.
 *
 * A front tab that is not written down is not written down as the front
 * either: naming it would restore nothing.
 */
export function toSaved(layout: PaneLayout): SavedPaneLayout {
  return {
    groups: layout.groups.map((group) => {
      const panes = group.tabs.filter(isPersistable)
      const front = panes.find((ref) => paneId(ref) === group.activeId)
      return { panes, activeId: front === undefined ? null : paneId(front) }
    }),
    focused: layout.focused
  }
}

/**
 * Tab kinds an older build wrote down that open nothing now. The content
 * viewer's tab went when it merged into Files: a layout naming it still loads,
 * without it.
 */
export const RETIRED_TAB_KINDS: ReadonlySet<string> = new Set(['content'])

/** The saved layout as a live one. A saved `activeId` that names a tab no
 * longer there falls to that group's last tab, as a stale one always has, and
 * a saved session is left for `reconcile` to drop when nothing hosts it. */
export function fromSaved(saved: SavedPaneLayout | null): PaneLayout {
  if (saved === null) return EMPTY_LAYOUT
  return normalize(
    saved.groups.map((group) => ({
      tabs: group.panes.filter((pane) => !RETIRED_TAB_KINDS.has((pane as { kind: string }).kind)),
      activeId: group.activeId
    })),
    saved.focused
  )
}

/**
 * Puts reopened sessions where the sessions they replace were.
 *
 * `saved` is the layout the crashed run last wrote, and `pairs` maps each lost
 * session's row id to the row id of the session that reopened it. A session
 * lands after the nearest tab before it in its saved strip that is still open
 * in the same pane, or first in that pane when none is - so it keeps its place
 * among whatever survived, without depending on which of its neighbours were
 * reopened too.
 *
 * Its pane is the one holding the first tab of its saved group that is still
 * open. A saved group whose every tab was a session went with them, and is
 * opened again on the side it was on. A reopened session the saved layout does
 * not name is left wherever it already is.
 *
 * A group's front tab comes back when it was one of these sessions, and the
 * focus goes back to the pane that had it.
 */
export function placeRestored(
  layout: PaneLayout,
  saved: SavedPaneLayout | null,
  pairs: ReadonlyMap<number, number>
): PaneLayout {
  if (saved === null) return layout
  const named = new Map<number, number>()
  for (const group of saved.groups) {
    for (const pane of group.panes) {
      const reopened = pane.kind === 'session' ? pairs.get(pane.id) : undefined
      if (pane.kind === 'session' && reopened !== undefined) named.set(pane.id, reopened)
    }
  }
  if (named.size === 0) return layout

  // Off wherever `reconcile` put them, to go back where they were.
  const placing = new Set([...named.values()].map((id) => paneId({ kind: 'session', id })))
  const groups = layout.groups.map((group) => ({
    tabs: group.tabs.filter((ref) => !placing.has(paneId(ref))),
    activeId: group.activeId
  }))
  let focused = layout.focused
  const holding = (id: string): number =>
    groups.findIndex((group) => group.tabs.some((ref) => paneId(ref) === id))

  saved.groups.forEach((savedGroup, at) => {
    if (!savedGroup.panes.some((pane) => pane.kind === 'session' && named.has(pane.id))) return

    let target = -1
    for (const pane of savedGroup.panes) {
      if (pane.kind === 'session') continue
      target = holding(paneId(pane))
      if (target >= 0) break
    }
    if (target < 0) {
      if (groups.every((group) => group.tabs.length === 0)) target = 0
      else if (groups.length < PANE_GROUPS_MAX) {
        if (at === 0) {
          groups.unshift({ tabs: [], activeId: null })
          focused += 1
          target = 0
        } else {
          groups.push({ tabs: [], activeId: null })
          target = groups.length - 1
        }
      } else {
        target = at === 0 ? 0 : groups.length - 1
      }
    }

    const tabs = [...groups[target]!.tabs]
    let activeId = groups[target]!.activeId
    let insertAt = 0
    for (const pane of savedGroup.panes) {
      if (pane.kind === 'session') {
        const reopened = named.get(pane.id)
        if (reopened === undefined) continue
        const ref: PaneRef = { kind: 'session', id: reopened }
        tabs.splice(insertAt, 0, ref)
        insertAt += 1
        if (savedGroup.activeId === paneId(pane)) {
          activeId = paneId(ref)
          if (saved.focused === at) focused = target
        }
        continue
      }
      const index = tabs.findIndex((ref) => paneId(ref) === paneId(pane))
      if (index >= 0) insertAt = index + 1
    }
    groups[target] = { tabs, activeId }
  })

  return normalize(groups, focused)
}
