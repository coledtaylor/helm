import type { JSX } from 'react'
import { cn } from '../lib/cn'
import { commandTone, SESSION_STATE_DOT, type SessionState } from '../lib/sessionstate'
import { CommandChildIcon } from './icons'

/**
 * What a child wears where an agent session has its state dot: the dot itself,
 * or for a command, which has no conversation to be busy or waiting in, a
 * terminal glyph in the dot's tones. Chips in a parent's crumb and the peek's
 * header both draw it, so the two agree with the Sessions tree's rows.
 */
export interface ChildMarkView {
  glyph: 'dot' | 'command'
  /** The state it is toned by, or null when the window cannot say. */
  state: SessionState | null
}

export function ChildMarkIcon({ mark }: { mark: ChildMarkView }): JSX.Element {
  if (mark.glyph === 'command') {
    return (
      <span
        aria-hidden
        data-child-command={mark.state ?? 'unknown'}
        className={cn('grid size-3 shrink-0 place-items-center', commandTone(mark.state))}
      >
        <CommandChildIcon />
      </span>
    )
  }
  return (
    <span
      aria-hidden
      data-child-dot={mark.state ?? 'unknown'}
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        mark.state === null ? 'border-[1.5px] border-fg-subtle' : SESSION_STATE_DOT[mark.state]
      )}
    />
  )
}
