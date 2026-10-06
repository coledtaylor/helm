import type { HelmContext, HelmErrorCode, HelmTheme, ToolSession } from '@coledtaylor/helm-plugin-sdk'

/**
 * The messages between a plugin page's bridge and the Helm page framing it.
 *
 * Two phases. A page announces itself with `HELLO` on `window.parent`, which
 * is the only thing it ever sends that way; Helm checks the message's origin
 * and source against the frames it made, and answers with `CONNECT` and a
 * `MessagePort` of the page's own. Everything after that goes over the port,
 * so no later message has to be told apart from anything else on the window,
 * and a page that is not one Helm framed never gets a port at all.
 */

export const HELLO = 'helm:hello'
export const CONNECT = 'helm:connect'

export interface HelloMessage {
  type: typeof HELLO
}

export interface ConnectMessage {
  type: typeof CONNECT
  context: HelmContext
  /** Null while the relay has not read one yet; the page keeps the one it booted with. */
  theme: HelmTheme | null
  visible: boolean
}

/** A key the page did not handle, for Helm's shortcuts. */
export interface KeyInit {
  key: string
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  repeat: boolean
}

export type FrameMessage =
  | { t: 'call'; id: number; method: string; args: unknown[] }
  | { t: 'cancel'; id: number }
  | { t: 'key'; key: KeyInit }
  | { t: 'title'; title: string | null }
  /** A background page's answer to a `tool` message. */
  | { t: 'tool-result'; id: string; ok: true; text: string }
  | { t: 'tool-result'; id: string; ok: false; message: string }

export type HelmMessage =
  | { t: 'result'; id: number; ok: true; value: unknown }
  | { t: 'result'; id: number; ok: false; code: HelmErrorCode; message: string }
  | { t: 'event'; name: string; data: unknown }
  /** A session called one of the plugin's tools. Background pages only. */
  | { t: 'tool'; id: string; name: string; args: Record<string, unknown>; session: ToolSession }
  /** Nobody is waiting for that answer any more. */
  | { t: 'tool-cancel'; id: string }

/** The frame's `name`: how a page knows where it is before it has said anything. */
export const CONTEXT_PREFIX = 'helm:'

export function contextName(context: HelmContext): string {
  return `${CONTEXT_PREFIX}${JSON.stringify(context)}`
}
