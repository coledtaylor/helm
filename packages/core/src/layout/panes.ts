import type { WorkspaceTab } from '../types'
import { pluginTabId } from '../plugins/tabs'

/**
 * The panes in the window and the tabs in each, as data.
 *
 * Panes are **groups** - each an island with its own strip of tabs, one of
 * them in front - arranged by a tree of **splits**, the way VS Code arranges
 * editor groups. A split lays its children side by side (`row`) or one above
 * the other (`column`), each taking a share of its room, and a child is a group
 * or a split across the other axis. One group is **focused**: the one a new tab
 * opens into. Any kind of tab may sit in any group.
 *
 * A group is named by an `id` that stays its own for as long as it exists,
 * never by where it is. A launch that resolves after the panes were rearranged
 * still lands in the pane that asked for it, and a pane that moves is the same
 * pane. `groups` lists them in **reading order** - depth first through the
 * tree, so left to right and top to bottom within each split - which is the
 * order the keyboard walks and the panes are named in.
 *
 * Pure and browser-safe, so the renderer imports it through `@helm/core/types`
 * and every rule about where a tab lands is tested here rather than discovered
 * in a window. Every operation takes a layout and returns one, normalised: no
 * empty group survives beside a group with tabs in it, no split holds fewer
 * than two children or a child split across its own axis, a split's shares are
 * positive and sum to one, every group's `activeId` names a tab that is in it,
 * and `focused` names a group that exists.
 */

/**
 * Anything a pane can show.
 *
 * `WorkspaceTab` is what reopens on its own at the next start. A session is a
 * process `before-quit` ends, a browser tab is a `WebContentsView` it
 * destroys, a terminal tab is a shell that dies with its tab, and the restore
 * offer is one start's question about the last.
 *
 * A terminal tab's `id` is the window's own name for it, never a pty's: the
 * shell behind it is opened once the tab has somewhere to draw it.
 */
export type PaneRef =
  | WorkspaceTab
  | { kind: 'browser'; id: number }
  | { kind: 'session'; id: number }
  | { kind: 'terminal'; id: number; path: string }
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

/** Side by side (`row`) or one above the other (`column`). */
export type PaneAxis = 'row' | 'column'

/** A side of a pane - where a tab dropped at its edge opens a new one. */
export type PaneEdge = 'left' | 'right' | 'top' | 'bottom'

export interface PaneGroup {
  /** Its own for as long as it exists. See the file comment. */
  readonly id: number
  readonly tabs: readonly PaneRef[]
  /** Which tab is in front. Null only for an empty group. */
  readonly activeId: string | null
}

/** A place in the tree, holding the group with this id. */
export interface PaneLeaf {
  readonly group: number
}

export interface PaneSplit {
  readonly axis: PaneAxis
  readonly children: readonly PaneNode[]
  /** Each child's share of the split's room, in the children's order. */
  readonly sizes: readonly number[]
}

export type PaneNode = PaneLeaf | PaneSplit

export function isSplit(node: PaneNode): node is PaneSplit {
  return 'axis' in node
}

export interface PaneLayout {
  readonly root: PaneNode
  /** Every group, in reading order. */
  readonly groups: readonly PaneGroup[]
  /** The id of the group a new tab opens into, and whose front tab the keyboard means. */
  readonly focused: number
  /**
   * The id the next group opened takes. Never handed out twice in a layout's
   * life, so an id held across an `await` cannot come to mean another pane.
   */
  readonly nextId: number
}

/** One group as `AppSettings.paneLayout` stores it. See `SavedPane`. */
export interface SavedPaneGroup {
  panes: SavedPane[]
  activeId: string | null
}

export interface SavedPaneSplit {
  axis: PaneAxis
  children: SavedPaneNode[]
  sizes: number[]
}

export type SavedPaneNode = SavedPaneGroup | SavedPaneSplit

export function isSavedSplit(node: SavedPaneNode): node is SavedPaneSplit {
  return 'axis' in node
}

/**
 * The layout as `AppSettings.paneLayout` keeps it: the tree, with each group's
 * persistable tabs in its leaf, and the focused group by its place in reading
 * order. Ids are not written down - they are one run's names for its panes.
 */
export interface SavedPaneLayout {
  root: SavedPaneNode
  focused: number
}

/** The window with nothing open: one group, empty, focused. */
export const EMPTY_LAYOUT: PaneLayout = {
  root: { group: 1 },
  groups: [{ id: 1, tabs: [], activeId: null }],
  focused: 1,
  nextId: 2
}

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
    case 'browser':
      return `browser:${String(ref.id)}`
    case 'session':
      return `session:${String(ref.id)}`
    case 'terminal':
      return `terminal:${String(ref.id)}`
    case 'file':
      return `file:${ref.path}`
    case 'plugin':
      return pluginTabId(ref.plugin, ref.tab, ref.params)
    default:
      // history, sessions, config, settings: one of each, so
      // the kind is the identity.
      return ref.kind
  }
}

/** Whether a tab is written down across a restart. See `SavedPane`. */
export function isPersistable(ref: PaneRef): ref is SavedPane {
  return ref.kind !== 'browser' && ref.kind !== 'terminal' && ref.kind !== 'restore'
}

/** The tab in front of a group: its `activeId`, or the last tab if that is gone. */
export function activeRef(group: PaneGroup): PaneRef | null {
  if (group.activeId !== null) {
    const found = group.tabs.find((ref) => paneId(ref) === group.activeId)
    if (found) return found
  }
  return group.tabs.at(-1) ?? null
}

/** The group with this id, if there is one. */
export function groupById(layout: PaneLayout, id: number): PaneGroup | undefined {
  return layout.groups.find((group) => group.id === id)
}

/** The focused group - always one, because `focused` names a group that exists. */
export function focusedGroup(layout: PaneLayout): PaneGroup {
  return groupById(layout, layout.focused) ?? layout.groups[0]!
}

/** Where a tab is - its group's id and its place in the strip - or null if no group holds it. */
export function findTab(layout: PaneLayout, id: string): { group: number; index: number } | null {
  for (const group of layout.groups) {
    const index = group.tabs.findIndex((ref) => paneId(ref) === id)
    if (index >= 0) return { group: group.id, index }
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

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

function leafIds(node: PaneNode): number[] {
  return isSplit(node) ? node.children.flatMap(leafIds) : [node.group]
}

/** The splits from the root down to a group, each with the child taken. Null if no leaf holds it. */
function pathTo(node: PaneNode, group: number): { split: PaneSplit; index: number }[] | null {
  if (!isSplit(node)) return node.group === group ? [] : null
  for (let index = 0; index < node.children.length; index += 1) {
    const rest = pathTo(node.children[index]!, group)
    if (rest !== null) return [{ split: node, index }, ...rest]
  }
  return null
}

/**
 * A split's shares as they are kept: each positive and finite, summing to one.
 *
 * Rescaled only when they do not already sum to one, so normalising a
 * normalised layout changes nothing. That is not tidiness: the saved layout is
 * compared as JSON against what is stored, and a share that drifted in its
 * last bit on every pass would rewrite the setting forever.
 */
function shares(sizes: readonly number[], count: number): number[] {
  const usable = sizes.length === count && sizes.every((size) => Number.isFinite(size) && size > 0)
  const raw = usable ? [...sizes] : Array.from({ length: count }, () => 1)
  const sum = raw.reduce((total, size) => total + size, 0)
  return Math.abs(sum - 1) < 1e-9 ? raw : raw.map((size) => size / sum)
}

/**
 * The tree holding only the groups in `keep`.
 *
 * A child that goes gives its share to the sibling before it, or to the one
 * after it when it was first, so the pane beside it grows into the room - and
 * `closeGroup` hands a pane's tabs to the same side its room goes to. A split
 * left with one child is that child, and a child split across its parent's
 * own axis is folded into the parent with its shares scaled to the room it
 * had, so a row of three is one split of three and not a split of a split.
 */
function prune(node: PaneNode, keep: ReadonlySet<number>): PaneNode | null {
  if (!isSplit(node)) return keep.has(node.group) ? node : null
  const given = shares(node.sizes, node.children.length)
  const children: PaneNode[] = []
  const sizes: number[] = []
  let carried = 0
  node.children.forEach((child, index) => {
    const share = given[index]!
    const kept = prune(child, keep)
    if (kept === null) {
      if (sizes.length > 0) sizes[sizes.length - 1] = sizes[sizes.length - 1]! + share
      else carried += share
      return
    }
    const room = share + carried
    carried = 0
    if (isSplit(kept) && kept.axis === node.axis) {
      kept.children.forEach((inner, at) => {
        children.push(inner)
        sizes.push(room * kept.sizes[at]!)
      })
    } else {
      children.push(kept)
      sizes.push(room)
    }
  })
  if (children.length === 0) return null
  if (children.length === 1) return children[0]!
  return { axis: node.axis, children, sizes: shares(sizes, children.length) }
}

/** The tree with `leaf` on `edge` of group `target`, the two sharing the room the target had. */
function insertBeside(node: PaneNode, target: number, leaf: PaneLeaf, edge: PaneEdge): PaneNode {
  if (!isSplit(node)) {
    if (node.group !== target) return node
    const before = edge === 'left' || edge === 'top'
    return {
      axis: edge === 'left' || edge === 'right' ? 'row' : 'column',
      children: before ? [leaf, node] : [node, leaf],
      sizes: [0.5, 0.5]
    }
  }
  return { ...node, children: node.children.map((child) => insertBeside(child, target, leaf, edge)) }
}

/**
 * The focus once some groups have gone: where it was, or else the nearest
 * group before it in reading order that is still there, or else the first.
 */
function survivor(order: readonly number[], keep: ReadonlySet<number>, focused: number): number {
  if (keep.has(focused)) return focused
  for (let at = order.indexOf(focused) - 1; at >= 0; at -= 1) {
    if (keep.has(order[at]!)) return order[at]!
  }
  return order.find((id) => keep.has(id))!
}

/**
 * The one shape every operation returns.
 *
 * Empty groups are dropped - a group exists to hold tabs - except that the
 * window always has one, so an empty layout is one empty group rather than
 * none. A tab id that appears twice keeps its first place in reading order,
 * and the focus follows the group it was on, or `survivor` when that group
 * went.
 */
function normalize(
  root: PaneNode,
  groups: readonly PaneGroup[],
  focused: number,
  nextId: number
): PaneLayout {
  const byId = new Map(groups.map((group) => [group.id, group]))
  const placed = leafIds(root).filter((id) => byId.has(id))
  const next = Math.max(nextId, ...groups.map((group) => group.id + 1))

  // A group the tree does not place has nowhere to be drawn, and its tabs join
  // the last group that is placed rather than vanish. No operation here makes
  // one; this is the floor under a hand-edited setting.
  const stray = groups.filter((group) => !placed.includes(group.id)).flatMap((group) => group.tabs)
  if (placed.length === 0) {
    const id = groups[0]?.id ?? next
    return normalize({ group: id }, [{ id, tabs: stray, activeId: groups[0]?.activeId ?? null }], id, next)
  }

  const seen = new Set<string>()
  const cleaned = new Map<number, PaneGroup>()
  placed.forEach((id, at) => {
    const group = byId.get(id)!
    const tabs = (at === placed.length - 1 ? [...group.tabs, ...stray] : group.tabs).filter((ref) => {
      const tab = paneId(ref)
      if (seen.has(tab)) return false
      seen.add(tab)
      return true
    })
    cleaned.set(id, { id, tabs, activeId: group.activeId })
  })

  const keep = new Set(placed.filter((id) => cleaned.get(id)!.tabs.length > 0))
  if (keep.size === 0) {
    const id = cleaned.has(focused) ? focused : placed[0]!
    return { root: { group: id }, groups: [{ id, tabs: [], activeId: null }], focused: id, nextId: next }
  }

  const pruned = prune(root, keep)!
  return {
    root: pruned,
    groups: leafIds(pruned).map((id) => {
      const group = cleaned.get(id)!
      return { id, tabs: group.tabs, activeId: paneId(activeRef(group)!) }
    }),
    focused: survivor(placed, keep, focused),
    nextId: next
  }
}

/** The layout's groups with some of them replaced, matched by id. */
function replaced(layout: PaneLayout, ...changes: PaneGroup[]): PaneGroup[] {
  const byId = new Map(changes.map((group) => [group.id, group]))
  return layout.groups.map((group) => byId.get(group.id) ?? group)
}

// ---------------------------------------------------------------------------
// Where the panes are
// ---------------------------------------------------------------------------

/** A pane's place as a fraction of the whole arrangement. */
export interface PaneRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where each group sits in a unit square: shares only, no gutters. For the
 * questions about arrangement rather than pixels - which pane is beside which,
 * and whether one has the window's full width.
 */
export function paneRects(layout: PaneLayout): Map<number, PaneRect> {
  const out = new Map<number, PaneRect>()
  const place = (node: PaneNode, rect: PaneRect): void => {
    if (!isSplit(node)) {
      out.set(node.group, rect)
      return
    }
    let offset = 0
    node.children.forEach((child, index) => {
      const share = node.sizes[index]!
      place(
        child,
        node.axis === 'row'
          ? { x: rect.x + offset * rect.width, y: rect.y, width: share * rect.width, height: rect.height }
          : { x: rect.x, y: rect.y + offset * rect.height, width: rect.width, height: share * rect.height }
      )
      offset += share
    })
  }
  place(layout.root, { x: 0, y: 0, width: 1, height: 1 })
  return out
}

const EPSILON = 1e-6

function overlap(start: number, length: number, otherStart: number, otherLength: number): number {
  return Math.min(start + length, otherStart + otherLength) - Math.max(start, otherStart)
}

/**
 * The group across `edge` of group `id`: of those touching that side, the one
 * sharing the most of it, the first in reading order on a tie. Null at the
 * edge of the arrangement.
 */
export function neighbourAt(layout: PaneLayout, id: number, edge: PaneEdge): number | null {
  const rects = paneRects(layout)
  const me = rects.get(id)
  if (me === undefined) return null
  let best: number | null = null
  let most = EPSILON
  for (const group of layout.groups) {
    if (group.id === id) continue
    const other = rects.get(group.id)!
    const touching =
      edge === 'right'
        ? Math.abs(other.x - (me.x + me.width)) < EPSILON
        : edge === 'left'
          ? Math.abs(other.x + other.width - me.x) < EPSILON
          : edge === 'bottom'
            ? Math.abs(other.y - (me.y + me.height)) < EPSILON
            : Math.abs(other.y + other.height - me.y) < EPSILON
    if (!touching) continue
    const shared =
      edge === 'left' || edge === 'right'
        ? overlap(me.y, me.height, other.y, other.height)
        : overlap(me.x, me.width, other.x, other.width)
    if (shared > most + EPSILON) {
      best = group.id
      most = shared
    }
  }
  return best
}

/**
 * The pane a tab sent "beside" goes to: the one to the right, else the left,
 * else below, else above - and null for a pane alone in the window. With two
 * panes that is simply the other one, which is all the split button and
 * Ctrl+\ ever meant.
 */
export function besideOf(layout: PaneLayout, id: number): number | null {
  for (const edge of ['right', 'left', 'bottom', 'top'] as const) {
    const found = neighbourAt(layout, id, edge)
    if (found !== null) return found
  }
  return null
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

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

/** A group with one of its tabs taken out, and its front moved on if that tab was it. */
function without(group: PaneGroup, index: number): PaneGroup {
  const id = paneId(group.tabs[index]!)
  return {
    id: group.id,
    tabs: group.tabs.filter((_, at) => at !== index),
    activeId: group.activeId === id ? neighbourOf(group.tabs, index) : group.activeId
  }
}

/**
 * Brings a tab to the front, opening it if no group has it.
 *
 * A tab already open anywhere is activated where it is rather than opened a
 * second time, which is what makes every "open this" in the app also a way
 * back to it. A new one lands in group `group`, the focused group unless told
 * otherwise, or the focused one when that group is gone.
 */
export function openTab(layout: PaneLayout, ref: PaneRef, group = layout.focused): PaneLayout {
  const id = paneId(ref)
  if (findTab(layout, id) !== null) return activateTab(layout, id)
  const target = groupById(layout, group) ?? focusedGroup(layout)
  return normalize(
    layout.root,
    replaced(layout, { id: target.id, tabs: [...target.tabs, ref], activeId: id }),
    target.id,
    layout.nextId
  )
}

/** Puts a tab in front of its group and focuses that group. */
export function activateTab(layout: PaneLayout, id: string): PaneLayout {
  const at = findTab(layout, id)
  if (at === null) return layout
  const group = groupById(layout, at.group)!
  if (group.activeId === id && layout.focused === at.group) return layout
  return normalize(layout.root, replaced(layout, { ...group, activeId: id }), at.group, layout.nextId)
}

/**
 * A plugin's tab, renamed in place: its page set a title of its own, or put
 * the manifest's back (null). Nothing else about the layout moves, so a page
 * naming itself is not a change of focus. Any other tab is left as it is.
 */
export function retitleTab(layout: PaneLayout, id: string, title: string | null): PaneLayout {
  const at = findTab(layout, id)
  if (at === null) return layout
  const group = groupById(layout, at.group)!
  const ref = group.tabs[at.index]!
  if (ref.kind !== 'plugin' || ref.title === title) return layout
  const tabs = group.tabs.map((tab, index) => (index === at.index ? { ...ref, title } : tab))
  return { ...layout, groups: layout.groups.map((other) => (other.id === group.id ? { ...other, tabs } : other)) }
}

export function focusGroup(layout: PaneLayout, id: number): PaneLayout {
  if (id === layout.focused || groupById(layout, id) === undefined) return layout
  return { ...layout, focused: id }
}

export function closeTab(layout: PaneLayout, id: string): PaneLayout {
  const at = findTab(layout, id)
  if (at === null) return layout
  return normalize(
    layout.root,
    replaced(layout, without(groupById(layout, at.group)!, at.index)),
    layout.focused,
    layout.nextId
  )
}

/**
 * Moves a tab to `toIndex` in group `toGroup`, which may be its own group (a
 * reorder) or another. `toIndex` is the place it ends up, counted after it has
 * left wherever it was.
 *
 * The moved tab is in front of the group it lands in and that group takes the
 * focus, because the gesture that moved it was aimed there. A group it leaves
 * empty goes, and its room goes to the pane beside it.
 */
export function moveTab(layout: PaneLayout, id: string, toGroup: number, toIndex: number): PaneLayout {
  const from = findTab(layout, id)
  const target = groupById(layout, toGroup)
  if (from === null || target === undefined) return layout
  const source = groupById(layout, from.group)!
  const ref = source.tabs[from.index]!

  if (toGroup === from.group) {
    const remaining = source.tabs.filter((_, index) => index !== from.index)
    const at = Math.max(0, Math.min(toIndex, remaining.length))
    if (at === from.index) return activateTab(layout, id)
    const tabs = [...remaining.slice(0, at), ref, ...remaining.slice(at)]
    return normalize(layout.root, replaced(layout, { id: source.id, tabs, activeId: id }), source.id, layout.nextId)
  }

  const at = Math.max(0, Math.min(toIndex, target.tabs.length))
  const tabs = [...target.tabs.slice(0, at), ref, ...target.tabs.slice(at)]
  return normalize(
    layout.root,
    replaced(layout, without(source, from.index), { id: target.id, tabs, activeId: id }),
    target.id,
    layout.nextId
  )
}

/**
 * Moves a tab into a new group on `edge` of group `target` - a tab dropped at
 * a pane's edge. The new group takes half of the room the target had, on that
 * side, and the focus.
 *
 * A pane's only tab cannot be split off from that pane: the pane it left would
 * go, and the new one would stand exactly where it stood.
 */
export function splitWith(layout: PaneLayout, id: string, target: number, edge: PaneEdge): PaneLayout {
  const from = findTab(layout, id)
  if (from === null || groupById(layout, target) === undefined) return layout
  const source = groupById(layout, from.group)!
  if (from.group === target && source.tabs.length === 1) return layout
  const created = layout.nextId
  return normalize(
    insertBeside(layout.root, target, { group: created }, edge),
    [...replaced(layout, without(source, from.index)), { id: created, tabs: [source.tabs[from.index]!], activeId: id }],
    created,
    created + 1
  )
}

/**
 * Sends the focused group's front tab to the pane beside it (`besideOf`), or
 * splits it off into a new pane on the right when the focused one is alone.
 * The split button and Ctrl+\ both mean this.
 *
 * A pane alone with one tab has nothing to split, and is left alone.
 */
export function sendBeside(layout: PaneLayout): PaneLayout {
  const group = focusedGroup(layout)
  const front = activeRef(group)
  if (front === null) return layout
  const beside = besideOf(layout, group.id)
  if (beside === null) return splitWith(layout, paneId(front), group.id, 'right')
  return moveTab(layout, paneId(front), beside, groupById(layout, beside)!.tabs.length)
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
  const home = layout.focused
  const opened = openTab(layout, ref, home)
  const beside = besideOf(opened, home)
  if (beside === null) return splitWith(opened, id, home, 'right')
  return moveTab(opened, id, beside, groupById(opened, beside)!.tabs.length)
}

/**
 * Puts a tab in group `group` and in front of it - the pane whose `+` asked
 * for it, whichever pane is focused by the time it arrives.
 *
 * Opened and then moved, for the reason `placeBeside` is: `reconcile` may have
 * given a new session a tab in the focused group first. A group that is gone
 * by then - its pane closed while a launch was in flight - means the focused
 * one, because a tab with nowhere it was asked to go still has to go somewhere.
 */
export function placeIn(layout: PaneLayout, ref: PaneRef, group: number): PaneLayout {
  if (groupById(layout, group) === undefined) return openTab(layout, ref)
  const id = paneId(ref)
  const opened = openTab(layout, ref, group)
  const at = findTab(opened, id)
  if (at === null || at.group === group) return opened
  return moveTab(opened, id, group, groupById(opened, group)!.tabs.length)
}

/** A file tab, as `openFile` takes it. */
export type FileRef = Extract<PaneRef, { kind: 'file' }>

/**
 * Opens a file to be read beside the session that is changing it.
 *
 * Where it lands is the whole point of the rule. With a session in front of the
 * focused pane, the file goes to the pane **beside** it (`besideOf`) - opening
 * one if the focused pane is alone - so the terminal and the file are side by
 * side rather than one hiding the other. With anything else in front, the file
 * opens in the focused pane: that is the pane already being used for reading,
 * and a file sent past it would take the session's place on the far side.
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

  const home = focusedGroup(layout)
  const reading = activeRef(home)?.kind !== 'session'
  const beside = reading ? null : besideOf(layout, home.id)
  if (!reading && beside === null) {
    return { layout: splitWith(openTab(layout, ref, home.id), id, home.id, 'right'), preview: keep ? still : id }
  }
  const target = beside ?? home.id

  if (!keep && still !== null && findTab(layout, still)!.group === target) {
    const group = groupById(layout, target)!
    const tabs = group.tabs.map((tab) => (paneId(tab) === still ? ref : tab))
    return {
      layout: normalize(layout.root, replaced(layout, { id: target, tabs, activeId: id }), target, layout.nextId),
      preview: id
    }
  }

  return { layout: openTab(layout, ref, target), preview: keep ? still : id }
}

/**
 * The group that takes over a closing one: across the side its room goes to
 * (`prune`), the pane sharing the most of that side. A closed pane's tabs and
 * its room go to the same place.
 */
function heirOf(layout: PaneLayout, id: number): number {
  const parent = pathTo(layout.root, id)?.at(-1)
  if (parent !== undefined) {
    const { split, index } = parent
    const towards: PaneEdge =
      index > 0 ? (split.axis === 'row' ? 'left' : 'top') : split.axis === 'row' ? 'right' : 'bottom'
    const across = neighbourAt(layout, id, towards)
    if (across !== null) return across
  }
  return layout.groups.find((group) => group.id !== id)!.id
}

/**
 * Closes a group by handing its tabs to the pane that takes its room, never by
 * closing them. A group's close button that ended the sessions in it would be
 * a destructive control dressed as a layout one.
 */
export function closeGroup(layout: PaneLayout, id: number): PaneLayout {
  const leaving = groupById(layout, id)
  if (leaving === undefined || layout.groups.length < 2) return layout
  const heir = groupById(layout, heirOf(layout, id))!
  return normalize(
    layout.root,
    replaced(
      layout,
      { id: heir.id, tabs: [...heir.tabs, ...leaving.tabs], activeId: heir.activeId },
      { id, tabs: [], activeId: null }
    ),
    heir.id,
    layout.nextId
  )
}

/**
 * The split at `path` - child indexes from the root - given new shares: a
 * divider let go. Left alone when the tree changed under the drag and `path`
 * no longer names a split of that many children.
 */
export function resizeSplit(layout: PaneLayout, path: readonly number[], sizes: readonly number[]): PaneLayout {
  const walk = (node: PaneNode, depth: number): PaneNode | null => {
    if (!isSplit(node)) return null
    if (depth === path.length) {
      return node.children.length === sizes.length ? { ...node, sizes: [...sizes] } : null
    }
    const at = path[depth]!
    const child = node.children[at]
    const changed = child === undefined ? null : walk(child, depth + 1)
    if (changed === null) return null
    return { ...node, children: node.children.map((current, index) => (index === at ? changed : current)) }
  }
  const root = walk(layout.root, 0)
  return root === null ? layout : normalize(root, layout.groups, layout.focused, layout.nextId)
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
    const into = Math.max(0, groups.findIndex((group) => group.id === layout.focused))
    const target = groups[into]!
    groups[into] = { ...target, tabs: [...target.tabs, ...added] }
  }
  return normalize(layout.root, groups, layout.focused, layout.nextId)
}

/**
 * Ctrl+Tab: the next tab across every group, as one ring.
 *
 * Counted from the focused group's front tab, in reading order, and wrapping
 * from the last tab of the last group to the first of the first. Landing in
 * another group moves the focus there, so the keyboard and the eye stay on the
 * same pane.
 */
export function cycleTab(layout: PaneLayout, step: 1 | -1): PaneLayout {
  const ring = layout.groups.flatMap((group) => group.tabs.map(paneId))
  if (ring.length < 2) return layout
  const current = activeRef(focusedGroup(layout))
  const at = current === null ? -1 : ring.indexOf(paneId(current))
  const next = ring[(at + step + ring.length) % ring.length]
  return next === undefined ? layout : activateTab(layout, next)
}

// ---------------------------------------------------------------------------
// Written down and read back
// ---------------------------------------------------------------------------

/**
 * What `AppSettings.paneLayout` keeps: the tree, with the persistable tabs in
 * their groups and which was in front. A group with nothing written down in it
 * - only browser tabs - is not written down either, and its room goes where it
 * would have gone had it closed. A group holding only sessions comes back
 * empty and disappears on an ordinary start, which is the honest restore of a
 * group whose every tab was a process that did not survive; after a crash,
 * `placeRestored` reads it to put them back.
 *
 * A front tab that is not written down is not written down as the front
 * either: naming it would restore nothing.
 */
export function toSaved(layout: PaneLayout): SavedPaneLayout {
  const written = new Map<number, SavedPaneGroup>(
    layout.groups.map((group) => {
      const panes = group.tabs.filter(isPersistable)
      const front = panes.find((ref) => paneId(ref) === group.activeId)
      return [group.id, { panes, activeId: front === undefined ? null : paneId(front) }]
    })
  )
  const keep = new Set([...written].flatMap(([id, group]) => (group.panes.length > 0 ? [id] : [])))
  const root = keep.size === 0 ? null : prune(layout.root, keep)
  if (root === null) return { root: { panes: [], activeId: null }, focused: 0 }

  const write = (node: PaneNode): SavedPaneNode =>
    isSplit(node)
      ? { axis: node.axis, children: node.children.map(write), sizes: [...node.sizes] }
      : written.get(node.group)!
  const focus = survivor(leafIds(layout.root), keep, layout.focused)
  return { root: write(root), focused: leafIds(root).indexOf(focus) }
}

/** A saved layout's groups, in reading order. */
export function savedGroups(saved: SavedPaneLayout | null): SavedPaneGroup[] {
  if (saved === null) return []
  const walk = (node: SavedPaneNode): SavedPaneGroup[] =>
    isSavedSplit(node) ? node.children.flatMap(walk) : [node]
  return walk(saved.root)
}

/**
 * Tab kinds an older build wrote down that open nothing now. The content
 * viewer's tab went when it merged into Files, and the pull request list and
 * its per-PR tabs went when pull requests left Helm for a plugin: a layout
 * naming any of them still loads, without them.
 */
export const RETIRED_TAB_KINDS: ReadonlySet<string> = new Set(['content', 'pulls', 'pr'])

/**
 * The saved layout as a live one, its groups numbered in reading order. A
 * saved `activeId` that names a tab no longer there falls to that group's last
 * tab, as a stale one always has, and a saved session is left for `reconcile`
 * to drop when nothing hosts it.
 */
export function fromSaved(saved: SavedPaneLayout | null): PaneLayout {
  if (saved === null) return EMPTY_LAYOUT
  const groups: PaneGroup[] = []
  const read = (node: SavedPaneNode): PaneNode => {
    if (isSavedSplit(node)) return { axis: node.axis, children: node.children.map(read), sizes: node.sizes }
    const id = groups.length + 1
    groups.push({
      id,
      tabs: node.panes.filter((pane) => !RETIRED_TAB_KINDS.has((pane as { kind: string }).kind)),
      activeId: node.activeId
    })
    return { group: id }
  }
  const root = read(saved.root)
  return normalize(root, groups, groups[saved.focused]?.id ?? 1, groups.length + 1)
}

/**
 * `AppSettings.paneLayout` as this build reads it.
 *
 * Before panes were a tree the setting held one or two groups side by side -
 * `{ groups, focused }` - and the divider between them was its own setting,
 * `paneSplitPct`, the second pane's share as a percentage. That shape is read
 * as the row it was, with the divider where it was left, so the first start of
 * this build opens on the same panes the last start of the old one closed on.
 * A value that is neither shape is no layout at all.
 */
export function upgradeSavedLayout(value: unknown, splitPct: unknown): SavedPaneLayout | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (typeof record.root === 'object' && record.root !== null) return value as SavedPaneLayout
  const { groups, focused } = record
  if (!Array.isArray(groups) || groups.length === 0) return null
  const list = groups as SavedPaneGroup[]
  const second = typeof splitPct === 'number' && splitPct > 0 && splitPct < 100 ? splitPct / 100 : 0.45
  const root: SavedPaneNode =
    list.length === 1
      ? list[0]!
      : {
          axis: 'row',
          children: list,
          sizes: list.length === 2 ? [1 - second, second] : list.map(() => 1 / list.length)
        }
  return { root, focused: typeof focused === 'number' ? focused : 0 }
}

/**
 * Where a reopened group goes when no tab of its own survived to say: beside
 * the nearest pane, in the saved tree, that is open now - on the side it was
 * on. `currentOf` says which open group, if any, a saved group became.
 */
function anchorFor(
  tree: PaneNode,
  at: number,
  currentOf: (at: number) => number | null
): { anchor: number; edge: PaneEdge } | null {
  const path = pathTo(tree, at) ?? []
  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const { split, index } = path[depth]!
    const siblings = split.children
      .map((_, sibling) => sibling)
      .filter((sibling) => sibling !== index)
      .sort((a, b) => Math.abs(a - index) - Math.abs(b - index) || a - b)
    for (const sibling of siblings) {
      const before = sibling < index
      const leaves = leafIds(split.children[sibling]!)
      for (const leaf of before ? leaves.reverse() : leaves) {
        const anchor = currentOf(leaf)
        if (anchor === null) continue
        const edge: PaneEdge = split.axis === 'row' ? (before ? 'right' : 'left') : before ? 'bottom' : 'top'
        return { anchor, edge }
      }
    }
  }
  return null
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
 * opened again on the side it was on, beside the nearest pane in the saved
 * tree that is open now (`anchorFor`). A reopened session the saved layout
 * does not name is left wherever it already is.
 *
 * A group's front tab comes back when it was one of these sessions, and the
 * focus goes back to the pane that had it when that pane is one these
 * sessions went back into.
 */
export function placeRestored(
  layout: PaneLayout,
  saved: SavedPaneLayout | null,
  pairs: ReadonlyMap<number, number>
): PaneLayout {
  if (saved === null) return layout
  const leaves = savedGroups(saved)
  const named = new Map<number, number>()
  for (const group of leaves) {
    for (const pane of group.panes) {
      const reopened = pane.kind === 'session' ? pairs.get(pane.id) : undefined
      if (pane.kind === 'session' && reopened !== undefined) named.set(pane.id, reopened)
    }
  }
  if (named.size === 0) return layout

  let next = 0
  const indexed = (node: SavedPaneNode): PaneNode =>
    isSavedSplit(node)
      ? { axis: node.axis, children: node.children.map(indexed), sizes: node.sizes }
      : { group: next++ }
  const tree = indexed(saved.root)

  // Off wherever `reconcile` put them, to go back where they were.
  const placing = new Set([...named.values()].map((id) => paneId({ kind: 'session', id })))
  const groups = new Map(
    layout.groups.map((group) => [
      group.id,
      { tabs: group.tabs.filter((ref) => !placing.has(paneId(ref))), activeId: group.activeId }
    ])
  )
  let root = layout.root
  let nextId = layout.nextId
  let focused = layout.focused
  const became = new Map<number, number>()
  const holding = (id: string): number | null => {
    for (const [group, { tabs }] of groups) if (tabs.some((ref) => paneId(ref) === id)) return group
    return null
  }
  const currentOf = (at: number): number | null => {
    const placed = became.get(at)
    if (placed !== undefined) return placed
    for (const pane of leaves[at]!.panes) {
      if (pane.kind === 'session') continue
      const group = holding(paneId(pane))
      if (group !== null) return group
    }
    return null
  }

  leaves.forEach((savedGroup, at) => {
    if (!savedGroup.panes.some((pane) => pane.kind === 'session' && named.has(pane.id))) return

    let target = currentOf(at)
    if (target === null) {
      if ([...groups.values()].every((group) => group.tabs.length === 0)) {
        target = groups.keys().next().value!
      } else {
        target = nextId
        nextId += 1
        groups.set(target, { tabs: [], activeId: null })
        const found = anchorFor(tree, at, currentOf)
        if (found !== null) {
          root = insertBeside(root, found.anchor, { group: target }, found.edge)
        } else {
          const leaf = { group: target }
          root = { axis: 'row', children: at === 0 ? [leaf, root] : [root, leaf], sizes: [0.5, 0.5] }
        }
      }
    }

    const tabs = [...groups.get(target)!.tabs]
    let activeId = groups.get(target)!.activeId
    let position = 0
    for (const pane of savedGroup.panes) {
      if (pane.kind === 'session') {
        const reopened = named.get(pane.id)
        if (reopened === undefined) continue
        const ref: PaneRef = { kind: 'session', id: reopened }
        tabs.splice(position, 0, ref)
        position += 1
        if (savedGroup.activeId === paneId(pane)) activeId = paneId(ref)
        continue
      }
      const index = tabs.findIndex((ref) => paneId(ref) === paneId(pane))
      if (index >= 0) position = index + 1
    }
    groups.set(target, { tabs, activeId })
    if (saved.focused === at) focused = target
    became.set(at, target)
  })

  return normalize(
    root,
    [...groups].map(([id, group]) => ({ id, ...group })),
    focused,
    nextId
  )
}
