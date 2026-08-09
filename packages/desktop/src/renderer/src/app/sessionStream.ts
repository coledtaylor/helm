import { helm } from './bridge'

/**
 * Output routing for hosted sessions, with a buffer in front of it.
 *
 * The order of events at launch is: the renderer asks main to start a session,
 * main spawns the pty and its first bytes arrive immediately, and only then
 * does the `session:start` promise resolve, React render the tab, and the
 * terminal exist to write to. Everything Claude Code printed in that window -
 * which on a cold start is its banner and often a trust prompt - would go
 * nowhere.
 *
 * So the subscription is installed at import time, before any launch can be
 * issued, and output for a session with no pane yet is held until one attaches.
 * The alternative, buffering in the main process, needs a second channel for
 * "the pane is ready now" and puts renderer lifecycle in main's model.
 */

type Sink = (data: string) => void

const sinks = new Map<number, Sink>()
const pending = new Map<number, string[]>()

helm.on('session:data', ({ id, data }) => {
  const sink = sinks.get(id)
  if (sink) {
    sink(data)
    return
  }
  const buffered = pending.get(id)
  if (buffered) buffered.push(data)
  else pending.set(id, [data])
})

/**
 * Routes a session's output to `sink`, replaying anything that arrived first.
 * Returns the detach function; detaching does not resume buffering, because a
 * pane that has gone away is not coming back.
 */
export function attachSessionSink(id: number, sink: Sink): () => void {
  sinks.set(id, sink)

  const buffered = pending.get(id)
  if (buffered) {
    pending.delete(id)
    for (const chunk of buffered) sink(chunk)
  }

  return () => {
    if (sinks.get(id) === sink) sinks.delete(id)
  }
}

/** Drops anything held for a session that will never get a pane. */
export function forgetSession(id: number): void {
  sinks.delete(id)
  pending.delete(id)
}
