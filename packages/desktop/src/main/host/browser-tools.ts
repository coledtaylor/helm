import type { BrowserOpener } from '../browser'
import type { BrowserToolResult } from '../browser-mcp'
import type { HostConnection, HostSubscription } from './client'
import { encodeFrame, FrameError } from './frame'
import type { HostLink } from './link'
import type * as P from './protocol'

/**
 * The browser tools for sessions in the local host, answered in Helm's window.
 *
 * The host serves `helm-browser` to the sessions it runs, but the browser
 * pane is here, so each call a session's agent makes reaches this side as an
 * event on `agentBrowser:call`, naming the host session it came from, and goes
 * back as the tool's answer on `agentBrowser:answer`. The tools that run are
 * Helm's own (`browser-mcp.ts`, `runBrowserTool`): the same tab rule, the same
 * reach rule with this machine's settings, and the same sentences as for a
 * session Helm runs itself.
 *
 * The session a call names is checked here and turned into the identity the
 * tabs are compared by (`opener`), which only main holds: the host never sees
 * it, and a session that is not running in the host, or has no browser tools,
 * is answered with a sentence and drives nothing.
 */

/** What the relay needs from the rest of main. */
export interface BrowserToolRelayDeps {
  link: Pick<HostLink, 'onConnected'>
  /** A running host session's identity at the browser tools, or null for one with none. */
  opener: (session: number) => BrowserOpener | null
  /** Runs one tool for an identity, or null while Helm's browser tools are not there yet. */
  run: (opener: BrowserOpener, tool: string, args: unknown) => Promise<BrowserToolResult> | null
  log: (line: string) => void
}

export interface BrowserToolRelay {
  /** Stops answering: what a quit calls before the host stops. */
  stop(): void
}

/** The answer to a call for a session that is not running in the host with the browser tools. */
export const NOT_A_BROWSER_SESSION =
  "This session is not one Helm's browser tools answer for: it is not running in Helm's local host, or the browser tools are switched off in Settings > Browser."

/** The answer while Helm is still starting and its browser tools are not ready. */
export const BROWSER_TOOLS_STARTING = "Helm's browser tools are still starting. Try again in a moment."

/** The answer in place of one too large for a single protocol frame. */
export const ANSWER_TOO_LARGE =
  "That answer was too large for Helm to send back to this session. Ask for less of the page: a smaller part of its text, a snapshot with fewer nodes, or a screenshot of a smaller window."

const failed = (message: string): P.AgentBrowserOutcome => ({ status: 'failed', message })

/**
 * The outcome to send for `result`, or the too-large sentence when the answer
 * would not fit in one frame: the host takes nothing larger, and the
 * connection would end over it.
 */
export function outcomeFor(callId: number, result: BrowserToolResult): P.AgentBrowserOutcome {
  const outcome: P.AgentBrowserOutcome = { status: 'done', value: result }
  try {
    // Measured as the request it goes out in, with the widest id one can carry.
    encodeFrame({
      type: 'request',
      id: Number.MAX_SAFE_INTEGER,
      channel: 'agentBrowser:answer',
      payload: { callId, outcome }
    } as P.Message)
  } catch (error) {
    if (error instanceof FrameError) return failed(ANSWER_TOO_LARGE)
    throw error
  }
  return outcome
}

export function createBrowserToolRelay(deps: BrowserToolRelayDeps): BrowserToolRelay {
  let subscription: HostSubscription | null = null
  let stopped = false

  const outcomeOf = async (call: P.AgentBrowserToolCall): Promise<P.AgentBrowserOutcome> => {
    const opener = deps.opener(call.session)
    if (opener === null) return failed(NOT_A_BROWSER_SESSION)
    const running = deps.run(opener, call.tool, call.arguments)
    if (running === null) return failed(BROWSER_TOOLS_STARTING)
    try {
      return outcomeFor(call.callId, await running)
    } catch (error) {
      return failed(`${call.tool} failed inside Helm: ${(error as Error).message}`)
    }
  }

  const answer = async (connection: HostConnection, call: P.AgentBrowserToolCall): Promise<void> => {
    const outcome = await outcomeOf(call)
    if (stopped) return
    try {
      await connection.request('agentBrowser:answer', { callId: call.callId, outcome })
    } catch (error) {
      // The connection ended, and the host has failed the call itself.
      deps.log(`host: a browser tool answer was not taken (${(error as Error).message})`)
    }
  }

  deps.link.onConnected((connection) => {
    subscription?.unsubscribe()
    if (stopped) return
    subscription = connection.subscribe('agentBrowser:call', {
      event: (call) => void answer(connection, call),
      error: (error) => deps.log(`host: agentBrowser:call ended (${error.message})`)
    })
  })

  return {
    stop() {
      stopped = true
      subscription?.unsubscribe()
      subscription = null
    }
  }
}
