import type { BrowserWindow, WebContents } from 'electron'
import type { HelmTheme } from '@coledtaylor/helm-plugin-sdk'
import type { EventChannel, EventPayload, PluginToolOutcome } from '../../shared/ipc'
import type { BackgroundHost } from './background'
import type { PluginRuntime } from './protocol'
import { createToolCalls, type ToolAnswer, type ToolCallRequest } from './tools'

/**
 * What Helm keeps of plugins for its own pages.
 *
 * The host keeps the plugin registry - the folders, their switches, settings,
 * secrets, services and page files - and answers every bridge call
 * (`host/plugins.ts`). What stays here is what concerns the pages Helm draws:
 * the runtime they are served (`protocol.ts`), the theme they paint in, which
 * web contents may frame them (the window and the hidden window background
 * pages run in), and handing a session's call to a plugin's tool to that
 * plugin's background page, whose answer comes back here.
 *
 * `before-quit` ends the calls in flight and closes the background host.
 */

export interface PluginHostOptions {
  /** The app's window: one of the two pages that frame plugins. */
  window: () => BrowserWindow | null
  /** The theme a page paints first; it is kept current from the window after that. */
  theme: () => HelmTheme
  /** The bridge script and primitives stylesheet, as served under `/__helm/`. */
  bridge: string
  stylesheet: string
  /** The hidden window plugins' background pages run in, which the host's list opens. */
  background: BackgroundHost
}

export interface PluginHost {
  /**
   * A session's call to a tool of a plugin a host keeps, handed to the
   * plugin's background page once the host's list has said the plugin offers
   * the tool and its page is running. Never throws.
   */
  runTool(request: ToolCallRequest, signal: AbortSignal): Promise<ToolAnswer>
  /** The background host's answer to a tool call. Taken from that window only. */
  toolResult(outcome: PluginToolOutcome, sender: number): void
  /** A theme or shape change, for every Helm page that frames plugins. */
  pushTheme(theme: HelmTheme): void
  /** Whether a web contents is one of the Helm pages that frame plugins: the window, or the background host. */
  framesPlugins(contentsId: number): boolean
  runtime: PluginRuntime
  shutdown(): void
}

export function createPluginHost(options: PluginHostOptions): PluginHost {
  const { background } = options
  let stopped = false

  const emitTo = <K extends EventChannel>(contents: WebContents | null | undefined, channel: K, payload: EventPayload<K>): void => {
    if (contents === null || contents === undefined || contents.isDestroyed()) return
    contents.send(channel, payload)
  }
  const windowContents = (): WebContents | null => {
    const win = options.window()
    return win === null || win.isDestroyed() ? null : win.webContents
  }

  /** Sessions' calls to plugins' tools, in flight to the background host and back. */
  const tools = createToolCalls({
    send: (call) => {
      const contents = background.contents()
      if (contents === null || contents.isDestroyed()) return false
      contents.send('plugins:tool', call)
      return true
    },
    cancel: (id) => emitTo(background.contents(), 'plugins:toolCancel', { id })
  })

  return {
    runTool(request, signal) {
      if (stopped) return Promise.resolve({ ok: false, message: 'Helm is shutting down.' })
      return tools.call(
        {
          plugin: request.plugin,
          name: request.tool,
          args: request.args,
          session: request.session,
          // The hidden window hands it to that host's background page only.
          ...(request.host !== undefined ? { host: request.host } : {})
        },
        request.plugin,
        signal
      )
    },

    toolResult(outcome, sender) {
      if (background.contents()?.id !== sender) return
      tools.answer(outcome)
    },

    pushTheme(theme) {
      emitTo(windowContents(), 'plugins:theme', theme)
      emitTo(background.contents(), 'plugins:theme', theme)
    },

    framesPlugins(contentsId) {
      if (windowContents()?.id === contentsId) return true
      return background.contents()?.id === contentsId
    },

    runtime: {
      bridge: () => options.bridge,
      css: () => options.stylesheet,
      boot: () => JSON.stringify({ theme: options.theme() })
    },

    shutdown() {
      stopped = true
      tools.shutdown()
      background.shutdown()
    }
  }
}
