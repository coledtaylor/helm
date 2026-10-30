import type { ToolSession } from '@coledtaylor/helm-plugin-sdk'
import { pluginInstructions, pluginToolResult } from '../browser-mcp'
import type { ToolAnswer, ToolCallRequest, ToolServer } from '../plugins/tools'
import { fitsOneFrame } from './browser-tools'
import type { HostConnection, HostSubscription } from './client'
import type { HostLink } from './link'
import type * as P from './protocol'

/**
 * The plugins' tools for sessions in the local host, answered by Helm's
 * plugins.
 *
 * The host has no plugins of its own for agent tools: on every connect, and
 * whenever a plugin's tools come or go, this side offers it every plugin tool
 * server Helm has now (`agentPlugin:offer`), named, routed and worded exactly
 * as Helm's own listener serves it, and the host serves each to its sessions.
 * Each call a session's agent makes reaches this side on `agentPlugin:call`,
 * naming the host session, runs through the plugin host as a call on Helm's
 * own listener does (`plugins.callTool`), and goes back on
 * `agentPlugin:answer` as the same tool result that listener answers with.
 *
 * Who a plugin is told the session is comes from main (`caller`): an id minted
 * there for the running session, its label and its folder. The host's session
 * id, its token and anything of its conversation never reach a plugin. A call
 * the host withdraws (`agentPlugin:cancel`: the session interrupted it, its
 * request went away, or the session ended) aborts the plugin's handler.
 */

/** What the relay needs from the rest of main. */
export interface PluginToolRelayDeps {
  link: Pick<HostLink, 'onConnected' | 'current'>
  /** The plugin tool servers Helm has now: the plugins that are on, with their tools not switched off. */
  servers: () => ToolServer[]
  /** Runs one call in the plugin host; aborting `signal` withdraws it from the plugin. */
  call: (request: ToolCallRequest, signal: AbortSignal) => Promise<ToolAnswer>
  /** Who a running host session is to a plugin, or null for one that is not running in the host. */
  caller: (session: number) => ToolSession | null
  log: (line: string) => void
}

export interface PluginToolRelay {
  /** Offers the host the servers Helm has now: what a plugin's tools coming or going calls. */
  offer(): void
  /** Stops answering and withdraws every call in flight: what a quit calls before the host stops. */
  stop(): void
}

/** The answer to a call for a session that is not running in the host. */
export const NOT_A_PLUGIN_SESSION =
  "This session is not one Helm's plugins answer for: it is not running in Helm's local host."

/** The answer in place of one too large for a single protocol frame. */
export const PLUGIN_ANSWER_TOO_LARGE =
  "That answer was too large for Helm to send back to this session. Ask the plugin's tool for less at once."

const failed = (message: string): P.AgentPluginOutcome => ({ status: 'failed', message })

/** The servers as the host is offered them: as Helm's own listener serves each. */
export function offerFor(servers: readonly ToolServer[]): P.AgentPluginServers {
  return {
    servers: servers.map((server) => ({
      name: server.server,
      plugin: server.plugin,
      instructions: pluginInstructions(server),
      tools: server.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        readOnly: tool.readOnly
      }))
    }))
  }
}

/**
 * The outcome to send for a plugin's answer: the tool result Helm's listener
 * answers with, or the too-large sentence when it would not fit in one frame.
 */
export function pluginOutcomeFor(callId: number, answer: ToolAnswer): P.AgentPluginOutcome {
  const outcome: P.AgentPluginOutcome = { status: 'done', value: pluginToolResult(answer) }
  return fitsOneFrame('agentPlugin:answer', { callId, outcome }) ? outcome : failed(PLUGIN_ANSWER_TOO_LARGE)
}

const argumentsOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export function createPluginToolRelay(deps: PluginToolRelayDeps): PluginToolRelay {
  let subscriptions: HostSubscription[] = []
  /** The calls being answered on the connection they came in on, by the host's call id. */
  let inFlight = new Map<number, AbortController>()
  let stopped = false

  /** Withdraws every call in flight: their connection has gone, or Helm is quitting. */
  const abandonAll = (): void => {
    for (const controller of inFlight.values()) controller.abort()
    inFlight = new Map()
  }

  const offerTo = (connection: HostConnection): void => {
    connection.request('agentPlugin:offer', offerFor(deps.servers())).catch((error: unknown) => {
      deps.log(`host: the plugins' tools were not offered (${(error as Error).message})`)
    })
  }

  const answer = async (connection: HostConnection, call: P.AgentPluginToolCall): Promise<void> => {
    const calls = inFlight
    const controller = new AbortController()
    calls.set(call.callId, controller)
    let outcome: P.AgentPluginOutcome
    const session = deps.caller(call.session)
    if (session === null) {
      outcome = failed(NOT_A_PLUGIN_SESSION)
    } else {
      try {
        const answered = await deps.call(
          { plugin: call.plugin, tool: call.tool, args: argumentsOf(call.arguments), session },
          controller.signal
        )
        outcome = pluginOutcomeFor(call.callId, answered)
      } catch (error) {
        outcome = failed(`${call.tool} failed inside Helm: ${(error as Error).message}`)
      }
    }
    calls.delete(call.callId)
    // Withdrawn: the host has answered the session itself, and takes nothing more.
    if (stopped || controller.signal.aborted) return
    try {
      await connection.request('agentPlugin:answer', { callId: call.callId, outcome })
    } catch (error) {
      // The connection ended, and the host has failed the call itself.
      deps.log(`host: a plugin tool answer was not taken (${(error as Error).message})`)
    }
  }

  deps.link.onConnected((connection) => {
    for (const subscription of subscriptions) subscription.unsubscribe()
    abandonAll()
    if (stopped) return
    subscriptions = [
      connection.subscribe('agentPlugin:call', {
        event: (call) => void answer(connection, call),
        error: (error) => deps.log(`host: agentPlugin:call ended (${error.message})`)
      }),
      connection.subscribe('agentPlugin:cancel', {
        event: ({ callId }) => {
          inFlight.get(callId)?.abort()
          inFlight.delete(callId)
        },
        error: (error) => deps.log(`host: agentPlugin:cancel ended (${error.message})`)
      })
    ]
    // After the subscriptions: the host serves an offer only while this
    // connection is listening for its calls.
    offerTo(connection)
  })

  return {
    offer() {
      if (stopped) return
      const connection = deps.link.current()
      if (connection !== null) offerTo(connection)
    },
    stop() {
      stopped = true
      for (const subscription of subscriptions) subscription.unsubscribe()
      subscriptions = []
      abandonAll()
    }
  }
}
