import type { SessionActivity } from '@helm/core/types'

/**
 * What a session's state dot looks like, in one place.
 *
 * A class map rather than a component, for the reason `ROW_SELECTED` and
 * `SEGMENT_ON` are: two surfaces legitimately draw this differently - a tab
 * puts it where a kind icon would go, a list row puts it at the head of the row
 * - and what must not differ is the **tone**. It was one map inside `TabBar`
 * while the tab was the only place a session's state was painted; the sessions
 * pane is the second, and a second copy of `bg-warn` is exactly the drift this
 * file exists to stop.
 *
 * The argument for each tone is in DESIGN.md, "The session tab's state dot".
 * The short version of each is at its line here, because this is now the call
 * site both surfaces share.
 */

/**
 * Everything a session's dot can say.
 *
 * Eight and not three. The first three are Helm's own knowledge of the
 * process; the five after them are what the session says about itself, in its
 * backend's own records (Claude Code's live registry) or else in the OSC 7501
 * reports its program writes. `error` only ever comes from a report.
 */
export type SessionState = 'running' | 'ended' | 'failed' | SessionActivity

export const SESSION_STATE_DOT: Record<SessionState, string> = {
  // Alive, saying nothing. Deliberately identical to `idle`: "the registry
  // could not be read" must degrade to what the tab painted before the registry
  // existed, never to a fourth tone nobody can interpret.
  running: 'bg-success',
  // Not border-strong: that token became a 16% alpha hairline, and a dot
  // filled with it disappears into whatever it sits on.
  ended: 'bg-fg-subtle',
  failed: 'bg-danger',
  // The one live state, and the accent is Helm's tone for the thing currently
  // happening. A 6px dot is a
  // mark, not an area fill, so "the accent never floods" is intact.
  busy: 'bg-accent',
  // Blocked on you. `warn` is the system's attention tone and nothing else on
  // a tab was using it; this is the state the whole indicator exists for.
  waiting: 'bg-warn',
  // Handed back with a background task still live. A *ring* rather than a
  // fourth colour, because this is a variant of `idle` and not a peer of it -
  // same tone, hollow, on the checkbox's own outline-versus-fill vocabulary.
  // The one thing it must never read as is "more urgent than waiting".
  shell: 'border-[1.5px] border-success',
  idle: 'bg-success',
  // Alive, and its program reports an error. Filled `danger`, the tone of
  // `failed`, because both are something gone wrong; the crumb and the label
  // tell them apart - `failed` has exited with a code, `error` is still running.
  error: 'bg-danger'
}

/**
 * The tone of a command child's terminal glyph, which takes the tone a dot
 * would: success while it runs, fg-subtle once it exited 0 (or its end was all
 * that was seen), danger for any other exit code. The Sessions tree's row and
 * the family view's header both draw the glyph, and both take it from here.
 */
export function commandTone(state: SessionState | null): string {
  if (state === 'failed') return 'text-danger'
  if (state === null || state === 'ended') return 'text-fg-subtle'
  return 'text-success'
}

/** The same eight, in words, for a label and for anyone not using colour. */
export const SESSION_STATE_LABEL: Record<SessionState, string> = {
  running: 'running',
  ended: 'ended',
  failed: 'exited with an error',
  busy: 'working',
  waiting: 'waiting for you',
  shell: 'finished, background task still running',
  idle: 'ready',
  error: 'reports an error'
}
