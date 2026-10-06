import { randomUUID } from 'node:crypto'
import type { ToolSession } from '@coledtaylor/helm-plugin-sdk'
import type { NormalizedAgentTool } from '@coledtaylor/helm-plugin-sdk/manifest'
import { PLUGIN_TOOL_ANSWER_MAX_CHARS, type PluginToolCall, type PluginToolOutcome } from '../../shared/ipc'

/**
 * Tools a plugin offers the sessions Helm starts: the calls in flight between
 * a session's MCP request (`browser-mcp.ts`) and the plugin's background page.
 *
 * A call goes to the background host as `plugins:tool` and comes back as
 * `plugins:toolResult`, and nothing about it is left to chance on the way:
 * every call is answered exactly once - by the page, by the host saying there
 * is no page, by a timeout, by the session going away, or by the plugin being
 * turned off - and a cancelled call tells the page so, which aborts the
 * handler's `signal`.
 */

/** A plugin offering tools right now, as the MCP endpoint serves it. */
export interface ToolServer {
  /** The plugin's id. */
  plugin: string
  /** The plugin's name, for the instructions a session reads. */
  name: string
  /** `helm-plugin-<id>`. */
  server: string
  instructions: string | null
  tools: NormalizedAgentTool[]
}

export interface ToolCallRequest {
  plugin: string
  tool: string
  args: Record<string, unknown>
  session: ToolSession
}

/** What the session reads: the page's text, or why there is none. */
export type ToolAnswer = { ok: true; text: string } | { ok: false; message: string }

/** What `browser-mcp.ts` needs of the plugins: who offers tools, and a way to call one. */
export interface PluginToolProvider {
  servers(): ToolServer[]
  call(request: ToolCallRequest, signal: AbortSignal): Promise<ToolAnswer>
}

/**
 * The longest a call waits for its answer. As long as `helm.exec` lets a
 * program run, which is the longest thing a handler can be waiting on; a
 * session that wants it sooner is interrupted, and that cancels the call.
 */
export const TOOL_CALL_TIMEOUT_MS = 600_000

export interface ToolCalls {
  /**
   * Hands one call to the background host and waits for its answer. `owner`
   * is what `end` later names the call by: the plugin's entry.
   */
  call(call: Omit<PluginToolCall, 'id'>, owner: unknown, signal: AbortSignal): Promise<ToolAnswer>
  /** An answer from the background host. One for a call nobody is waiting on is dropped. */
  answer(outcome: PluginToolOutcome): void
  /** Fails every call in flight for `owner`, and tells the page to stop. */
  end(owner: unknown, message: string): void
  /** Fails every call in flight. */
  shutdown(): void
  /** How many calls are waiting. For a test. */
  pending(): number
}

export function createToolCalls(options: {
  /** Sends a call to the background host; false when there is no host to send it to. */
  send: (call: PluginToolCall) => boolean
  /** Tells the background host nobody is waiting on a call any more. */
  cancel: (id: string) => void
  timeoutMs?: number | undefined
}): ToolCalls {
  const timeoutMs = options.timeoutMs ?? TOOL_CALL_TIMEOUT_MS
  const inFlight = new Map<string, { owner: unknown; settle: (answer: ToolAnswer) => void }>()

  /** Ends a call from Helm's side: the page is told to stop, and the session is told why. */
  const abandon = (id: string, message: string): void => {
    const call = inFlight.get(id)
    if (call === undefined) return
    options.cancel(id)
    call.settle({ ok: false, message })
  }

  return {
    call(call, owner, signal) {
      if (signal.aborted) return Promise.resolve({ ok: false, message: 'The call was cancelled.' })
      const id = randomUUID()
      return new Promise<ToolAnswer>((resolve) => {
        const onAbort = (): void => abandon(id, 'The call was cancelled.')
        const timer = setTimeout(
          () => abandon(id, `The plugin did not answer within ${String(Math.round(timeoutMs / 60_000))} minutes.`),
          timeoutMs
        )
        inFlight.set(id, {
          owner,
          settle: (answer) => {
            if (!inFlight.delete(id)) return
            clearTimeout(timer)
            signal.removeEventListener('abort', onAbort)
            resolve(answer)
          }
        })
        signal.addEventListener('abort', onAbort, { once: true })
        if (!options.send({ ...call, id })) {
          inFlight.get(id)?.settle({ ok: false, message: "The plugin's background page is not running." })
        }
      })
    },

    answer(outcome) {
      const call = inFlight.get(outcome.id)
      if (call === undefined) return
      if (!outcome.ok) {
        call.settle({ ok: false, message: typeof outcome.message === 'string' ? outcome.message : 'The tool failed.' })
        return
      }
      // The bridge holds the page to this too; a page is not trusted to have run it.
      if (typeof outcome.text !== 'string' || outcome.text.length > PLUGIN_TOOL_ANSWER_MAX_CHARS) {
        call.settle({
          ok: false,
          message: `The plugin answered with more than ${String(PLUGIN_TOOL_ANSWER_MAX_CHARS)} characters, which is more than a tool may.`
        })
        return
      }
      call.settle({ ok: true, text: outcome.text })
    },

    end(owner, message) {
      for (const [id, call] of [...inFlight]) if (call.owner === owner) abandon(id, message)
    },

    shutdown() {
      for (const id of [...inFlight.keys()]) abandon(id, 'Helm is shutting down.')
    },

    pending: () => inFlight.size
  }
}
