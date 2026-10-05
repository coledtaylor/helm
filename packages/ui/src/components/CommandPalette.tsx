import type { JSX, KeyboardEvent, ReactNode } from 'react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { cn } from '../lib/cn'
import { ROW_SELECTED } from '../lib/rows'
import { CommandIcon } from './icons'
import { Overlay } from './Overlay'

/**
 * Ctrl+Shift+P: a command, by a few letters of its name.
 *
 * The commands are the plugins' - each manifest's `commands` - and running one
 * is the plugin's business: a tab it opens, or an event its page handles.
 * Drawn as Quick Open is (a palette at the top of the window, the field over
 * its list) so the two read as one family, and kept apart from it because
 * Quick Open is about a project's files and a command is about no project.
 */

export interface PaletteCommand {
  /** Unique across the list: the plugin's id and the command's. */
  key: string
  title: string
  /** Where it comes from: the plugin's name. */
  source: string
  icon?: ReactNode | undefined
}

export interface CommandPaletteProps {
  commands: readonly PaletteCommand[]
  onRun: (key: string) => void
  onDismiss: () => void
}

const keepFocus = (event: { preventDefault: () => void }): void => event.preventDefault()

/**
 * How well `query` names `text`, lower is better, or null for not at all: a
 * prefix, then a word's start, then anywhere, then its letters in order.
 */
export function commandScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase()
  if (q === '') return 0
  const t = text.toLowerCase()
  const at = t.indexOf(q)
  if (at === 0) return 0
  if (at > 0) return /[\s\-_:/.]/.test(t[at - 1] ?? '') ? 1 : 2
  let next = 0
  for (const char of t) {
    if (char === q[next]) next += 1
    if (next === q.length) return 3
  }
  return null
}

export function CommandPalette({ commands, onRun, onDismiss }: CommandPaletteProps): JSX.Element {
  const ids = useId()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    const scored = commands.flatMap((command) => {
      const byTitle = commandScore(query, command.title)
      const bySource = commandScore(query, `${command.source} ${command.title}`)
      const score = byTitle ?? (bySource === null ? null : bySource + 4)
      return score === null ? [] : [{ command, score }]
    })
    scored.sort(
      (a, b) =>
        a.score - b.score ||
        a.command.source.localeCompare(b.command.source) ||
        a.command.title.localeCompare(b.command.title)
    )
    return scored.map((entry) => entry.command)
  }, [commands, query])

  const at = Math.min(cursor, Math.max(0, rows.length - 1))
  const highlighted = rows[at]

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${String(at)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (rows.length === 0) return
      setCursor((at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length)
      return
    }
    if (event.key === 'Enter' && highlighted !== undefined) {
      event.preventDefault()
      onRun(highlighted.key)
    }
  }

  return (
    <Overlay
      aria-label="Run a command"
      data-command-palette
      align="top"
      className="max-w-[560px] bg-surface-raised"
      onDismiss={onDismiss}
      onKeyDown={onKeyDown}
    >
      <header className="flex h-[50px] shrink-0 items-center gap-2.5 border-b border-border px-4">
        <CommandIcon width={15} height={15} className="shrink-0 text-accent" />
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setCursor(0)
          }}
          role="combobox"
          aria-label="Command"
          aria-expanded="true"
          aria-controls={`${ids}-list`}
          aria-activedescendant={highlighted === undefined ? undefined : `${ids}-${String(at)}`}
          aria-autocomplete="list"
          spellCheck={false}
          placeholder="Run a command"
          className="min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-subtle focus:outline-none"
        />
      </header>

      <div
        ref={listRef}
        id={`${ids}-list`}
        role="listbox"
        aria-label="Commands"
        tabIndex={-1}
        className="max-h-[380px] min-h-0 overflow-y-auto px-1.5 pt-1.5 pb-1 outline-none"
      >
        {rows.map((command, index) => {
          const chosen = index === at
          return (
            <div
              key={command.key}
              id={`${ids}-${String(index)}`}
              data-index={index}
              data-command={command.key}
              role="option"
              aria-selected={chosen}
              onMouseDown={keepFocus}
              onMouseMove={chosen ? undefined : () => setCursor(index)}
              onClick={() => onRun(command.key)}
              className={cn(
                'relative flex h-[34px] cursor-default items-center gap-2.5 rounded-raised px-2.5 transition-colors',
                chosen ? ROW_SELECTED : 'hover:bg-hover'
              )}
            >
              {chosen && <span aria-hidden className="absolute top-[8px] bottom-[8px] left-0 w-[2px] rounded-full bg-accent" />}
              <span className="grid size-[14px] shrink-0 place-items-center text-fg-muted">{command.icon}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{command.title}</span>
              <span className="max-w-[40%] shrink-0 truncate text-[11px] text-fg-subtle">{command.source}</span>
            </div>
          )
        })}
        {rows.length === 0 && (
          <p className="px-2.5 pt-1 pb-3 text-[12px] text-fg-muted">
            {commands.length === 0
              ? 'No commands. Plugins add theirs to this list.'
              : `No command matches “${query.trim()}”.`}
          </p>
        )}
      </div>

      <footer className="flex h-[34px] shrink-0 items-center gap-3 border-t border-border bg-surface px-4 text-[11px] text-fg-subtle">
        <span>
          <span className="font-mono text-fg-muted">↵</span> Run
        </span>
        <span>
          <span className="font-mono text-fg-muted">↑↓</span> Choose
        </span>
        <span className="flex-1" />
        <span>
          <span className="font-mono text-fg-muted">Esc</span> Close
        </span>
      </footer>
    </Overlay>
  )
}
