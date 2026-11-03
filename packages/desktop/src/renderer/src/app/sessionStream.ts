import { LOCAL_HOST_KEY } from '@helm/core/types'
import { eachHostBridge } from './bridge'

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
 *
 * A session is its host and its row id there: each host numbers its own, so
 * output is heard on each host's own bridge, from the moment that bridge is
 * made, and kept apart by host. This PC's host is `LOCAL_HOST_KEY`.
 */

type Sink = (data: string) => void

const sinks = new Map<string, Sink>()
const pending = new Map<string, string[]>()

/** One session's key across every host. */
const keyOf = (host: string, id: number): string => `${host}\n${String(id)}`

eachHostBridge((host, bridge) => {
  bridge.on('session:data', ({ id, data }) => {
    const key = keyOf(host, id)
    const sink = sinks.get(key)
    if (sink) {
      sink(data)
      return
    }
    const buffered = pending.get(key)
    if (buffered) buffered.push(data)
    else pending.set(key, [data])
  })
})

/**
 * Routes a session's output to `sink`, replaying anything that arrived first.
 * Returns the detach function; detaching does not resume buffering, because a
 * pane that has gone away is not coming back.
 */
export function attachSessionSink(id: number, sink: Sink, host: string = LOCAL_HOST_KEY): () => void {
  const key = keyOf(host, id)
  sinks.set(key, sink)

  const buffered = pending.get(key)
  if (buffered) {
    pending.delete(key)
    for (const chunk of buffered) sink(chunk)
  }

  return () => {
    if (sinks.get(key) === sink) sinks.delete(key)
  }
}

/** Drops anything held for a session that will never get a pane. */
export function forgetSession(id: number, host: string = LOCAL_HOST_KEY): void {
  const key = keyOf(host, id)
  sinks.delete(key)
  pending.delete(key)
}
