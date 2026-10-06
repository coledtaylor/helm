import type { JSX, KeyboardEvent, ReactNode, RefObject } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/cn'
import { usePopup, type PopupAnchor } from '../lib/popup'
import { CheckIcon } from './icons'

/**
 * A list that drops from a control or opens at the pointer: a choice of one
 * (the Files view's project), or a set of ticks (which destinations the rail
 * shows).
 *
 * Drawn by Helm rather than left to the platform, which is what the native
 * `<select>` it replaces did - Chromium painted that list white, with the
 * app's light text on it, in every theme. This one is the popup recipe
 * (DESIGN.md "Menus"): `surface-raised` behind a `border-strong` edge, the
 * well's corner, no shadow, rows that answer the pointer.
 *
 * **It counts as an overlay while it is open.** A browser tab is a native view
 * that paints over every bit of renderer DOM, and a menu opened from the rail
 * or the sidebar can reach across a pane holding one - so it registers in
 * `lib/overlay.ts` exactly as a dialog does, and the view gets out of the way.
 *
 * Portalled to `document.body` and positioned in the viewport, because the
 * sidebar and the rail both clip their contents and a list cut off at the
 * sidebar's edge is the failure this is here to avoid.
 */

export type MenuEntry =
  | {
      kind: 'item'
      id: string
      label: string
      icon?: ReactNode
      /** Quieter text on the right - a path, a shortcut. */
      hint?: string | undefined
      /** A tick menu's state, or a list's current choice. Undefined draws no tick column. */
      checked?: boolean | undefined
      disabled?: boolean | undefined
      /** Said on hover - why a disabled row is disabled. */
      title?: string | undefined
    }
  | { kind: 'separator'; id: string }
  | { kind: 'heading'; id: string; label: string }

/** Where the menu opens: at a point (a right-click), or under a control. */
export type MenuAnchor = PopupAnchor

export interface MenuProps {
  /** The menu's accessible name. */
  label: string
  entries: readonly MenuEntry[]
  at: MenuAnchor
  /**
   * `listbox` for a choice of one (the row picked closes it), `menu` for
   * commands and ticks.
   */
  role?: 'menu' | 'listbox'
  /** A tick menu stays open so several can be changed in one visit. */
  stayOpen?: boolean
  /** Never narrower than this - the control it drops from, usually. */
  minWidth?: number
  /**
   * The control that opened it. A press on it is not a press outside: the
   * control's own click is what closes the menu, and treating the press as
   * outside too would close it and open it again in one click.
   */
  anchorRef?: RefObject<HTMLElement | null> | undefined
  onSelect: (id: string) => void
  onDismiss: () => void
}

/** Letters typed within this of each other are one prefix. */
const TYPEAHEAD_MS = 600

type Item = Extract<MenuEntry, { kind: 'item' }>

const isItem = (entry: MenuEntry): entry is Item => entry.kind === 'item'

export function Menu({
  label,
  entries,
  at,
  role = 'menu',
  stayOpen = false,
  minWidth = 180,
  anchorRef,
  onSelect,
  onDismiss
}: MenuProps): JSX.Element {
  const ids = useId()
  const menuRef = useRef<HTMLDivElement>(null)
  const items = entries.filter(isItem)
  const ticks = items.some((item) => item.checked !== undefined)

  // A list opens on its current choice; a menu on its first row.
  const [active, setActive] = useState(() => {
    const current = role === 'listbox' ? items.findIndex((item) => item.checked === true && !item.disabled) : -1
    return current >= 0 ? current : items.findIndex((item) => !item.disabled)
  })
  const typed = useRef({ text: '', at: 0 })

  const place = usePopup({ ref: menuRef, at, anchorRef, onDismiss })

  // Focus goes back to whatever had it when the menu closes...
  useEffect(() => {
    const before = document.activeElement
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true })
    }
  }, [])
  // ...and moves in once the menu is placed. Not before: it is drawn hidden
  // for the frame it is measured in, and a hidden element refuses focus - so
  // focusing it on mount left the keys going to the control that opened it.
  const placed = place !== null
  useEffect(() => {
    if (placed) menuRef.current?.focus({ preventScroll: true })
  }, [placed])

  // The row the keyboard is on stays in view in a list long enough to scroll.
  useEffect(() => {
    menuRef.current?.querySelector(`[data-menu-index="${String(active)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (item: Item | undefined): void => {
    if (item === undefined || item.disabled === true) return
    onSelect(item.id)
    if (!stayOpen) onDismiss()
  }

  /** The next row that can be chosen, `step` at a time from `from`, wrapping. */
  const next = (from: number, step: 1 | -1): number => {
    for (let i = 1; i <= items.length; i += 1) {
      const at = (from + step * i + items.length * 2) % items.length
      if (items[at]?.disabled !== true) return at
    }
    return from
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const key = event.key
    if (key === 'Escape' || key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      onDismiss()
      return
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault()
      setActive((current) => next(current, key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (key === 'Home' || key === 'End') {
      event.preventDefault()
      setActive(key === 'Home' ? next(-1, 1) : next(items.length, -1))
      return
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault()
      choose(items[active])
      return
    }
    if (key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      // Type-ahead: the letters typed so far, matched against the start of
      // each label from the row after this one.
      const now = Date.now()
      const text = (now - typed.current.at < TYPEAHEAD_MS ? typed.current.text : '') + key.toLowerCase()
      typed.current = { text, at: now }
      const start = text.length === 1 ? active + 1 : active
      for (let i = 0; i < items.length; i += 1) {
        const at = (start + i) % items.length
        const item = items[at]
        if (item !== undefined && item.disabled !== true && item.label.toLowerCase().startsWith(text)) {
          setActive(at)
          break
        }
      }
    }
  }

  // Which row the keyboard counts each item as, worked out before drawing:
  // separators and headings are in `entries` but are not stops.
  const stop = new Map(items.map((item, at) => [item.id, at]))
  return createPortal(
    <div
      ref={menuRef}
      role={role}
      aria-label={label}
      aria-activedescendant={active >= 0 ? `${ids}-${String(active)}` : undefined}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      data-menu={label}
      style={{
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        minWidth,
        // Measured where it lands, then shown - one frame at 0,0 would flash
        // in the corner of the window.
        visibility: place === null ? 'hidden' : undefined
      }}
      className={cn(
        'fixed z-50 max-h-[min(420px,calc(100vh-16px))] max-w-[360px] overflow-y-auto',
        'rounded-well border border-border-strong bg-surface-raised p-1 text-fg outline-none'
      )}
    >
      {entries.map((entry) => {
        if (entry.kind === 'separator') {
          return <div key={entry.id} role="separator" className="mx-1 my-1 h-px bg-border" />
        }
        if (entry.kind === 'heading') {
          return (
            <div
              key={entry.id}
              role="presentation"
              className="px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-[.07em] text-fg-subtle uppercase"
            >
              {entry.label}
            </div>
          )
        }
        const at = stop.get(entry.id) ?? -1
        const on = at === active
        return (
          <div
            key={entry.id}
            id={`${ids}-${String(at)}`}
            data-menu-index={at}
            data-menu-item={entry.id}
            // A tick is said on the rows that have one: a menu that mixes
            // commands with a choice (the browser's) keeps its commands menu items.
            role={role === 'listbox' ? 'option' : entry.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={role === 'menu' && entry.checked !== undefined ? entry.checked : undefined}
            aria-selected={role === 'listbox' ? entry.checked === true : undefined}
            aria-disabled={entry.disabled === true ? true : undefined}
            title={entry.title}
            // The pointer never takes focus from the menu, so the arrows go on
            // from wherever it left the highlight.
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={entry.disabled === true || on ? undefined : () => setActive(at)}
            onClick={() => choose(entry)}
            className={cn(
              'flex h-7 cursor-default items-center gap-2 rounded-raised px-2 text-[12px] whitespace-nowrap',
              entry.disabled === true ? 'text-fg-subtle' : on ? 'bg-hover text-fg' : 'text-fg'
            )}
          >
            {ticks && (
              <span aria-hidden className="grid w-3.5 shrink-0 place-items-center text-accent-text">
                {entry.checked === true && <CheckIcon width={12} height={12} />}
              </span>
            )}
            {entry.icon !== undefined && (
              <span aria-hidden className="grid shrink-0 place-items-center text-fg-muted">
                {entry.icon}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.hint !== undefined && (
              <span className="ml-3 shrink-0 font-mono text-[11px] text-fg-subtle">{entry.hint}</span>
            )}
          </div>
        )
      })}
    </div>,
    document.body
  )
}
