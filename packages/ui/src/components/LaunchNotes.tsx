import type { JSX } from 'react'
import type { LiveSession } from '@helm/core/types'
import type { SentencePart } from '../lib/launcher'
import { WarnIcon } from './icons'

/**
 * The launch disclosure (DESIGN.md 5): what pressing Start will run, with the
 * machine parts in mono. Shared by every launcher, so they word it alike.
 *
 * A flag never breaks across a line. Chromium wraps after a hyphen, so in a
 * narrow launcher `--permission-mode` came apart as `--` at the end of one line
 * and `permission-mode` at the start of the next - which reads as two
 * arguments. Each word of a mono part that starts with one is kept whole; the
 * line still breaks at the spaces between them.
 */
export function LaunchSentence({ parts }: { parts: readonly SentencePart[] }): JSX.Element {
  return (
    <p data-launch-sentence className="text-[11.5px] leading-[1.55] text-fg-subtle">
      {parts.map((part, index) =>
        part.mono ? (
          <span key={index} className="font-mono text-fg-muted">
            {part.text.split(/( )/).map((word, at) =>
              word.startsWith('-') ? (
                <span key={at} className="whitespace-nowrap">
                  {word}
                </span>
              ) : (
                word
              )
            )}
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        )
      )}
    </p>
  )
}

/**
 * The sessions already in the folder about to get another one, by name. Said
 * before the start rather than after, because two agents in one working tree is
 * the collision a launcher is in the best place to prevent.
 */
export function RunningHere({ sessions }: { sessions: readonly LiveSession[] }): JSX.Element | null {
  if (sessions.length === 0) return null
  return (
    <p role="note" className="flex items-start gap-1.5 text-[11.5px] leading-[1.55] text-warn">
      <WarnIcon width={12} height={12} className="mt-[3px] shrink-0" />
      <span className="min-w-0">
        Already running here:{' '}
        <span className="text-fg">
          {sessions.map((session) => session.name ?? `pid ${String(session.pid)}`).join(', ')}
        </span>
        . <span className="text-fg-muted">Another one means two agents in one working tree.</span>
      </span>
    </p>
  )
}
