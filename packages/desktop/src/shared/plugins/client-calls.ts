import { PLUGIN_TITLE_MAX, pluginParamsProblem } from '@helm/core/types'
import type { SurfaceKind } from '@coledtaylor/helm-plugin-sdk'
import type { PluginUiRequest } from '../ipc'
import { PluginCallError } from './errors'

/**
 * The bridge calls that concern only the page on screen, answered by the Helm
 * that draws it wherever its plugin's other calls are answered: opening one of
 * the plugin's tabs, and opening an `https` link in the Browser tab.
 *
 * With Helm keeping its plugins (`host.ts`) and with the local host keeping
 * them (`host/plugins.ts`), these are the same checks: a tab the manifest
 * declares with params a tab can carry, and a link that is an `https` address,
 * from a panel or a tab, one a second per plugin. Each is handed to the window
 * as a `plugins:ui` request, which opens the tab or the page the way it opens
 * any, so the reach rule a typed address meets is the one a link meets.
 */

/** The bridge methods answered here, never by whatever keeps the plugin registry. */
export const CLIENT_METHODS: ReadonlySet<string> = new Set(['tabs.open', 'open'])

export const LINK_URL_MAX = 2048
/** How soon a plugin may open another link: one click, one page, and a double click is still one. */
export const LINK_SPACING_MS = 1000

/** Who made a call answered here: the plugin, the tabs its manifest declares, and the page's kind. */
export interface ClientCaller {
  plugin: string
  declaresTab: (tab: string) => boolean
  surface: SurfaceKind
}

export interface ClientCallsDeps {
  /** Hands the window a request; false when there is no window to hand it to. */
  ui: (request: PluginUiRequest) => boolean
}

export interface ClientCalls {
  /** Answers one of `CLIENT_METHODS`; throws a `PluginCallError` saying why not. */
  run(method: string, caller: ClientCaller, args: readonly unknown[]): undefined
}

export function createClientCalls(deps: ClientCallsDeps): ClientCalls {
  /** When each plugin last opened a link, by plugin id. */
  const linkOpened = new Map<string, number>()

  const tabsOpen = (caller: ClientCaller, [tab, params, openOptions]: readonly unknown[]): undefined => {
    if (typeof tab !== 'string' || !caller.declaresTab(tab)) {
      throw new PluginCallError('not-declared', `"${String(tab)}" is not one of the tabs the manifest declares`)
    }
    const given = params ?? {}
    const problem = pluginParamsProblem(given)
    if (problem !== null) throw new PluginCallError('invalid', problem)
    const { title, preview } = readTabOptions(openOptions)
    const shown = deps.ui({
      kind: 'openTab',
      plugin: caller.plugin,
      tab,
      params: given as Record<string, string | number | boolean>,
      title,
      preview
    })
    if (!shown) throw new PluginCallError('unavailable', 'there is no window to open a tab in')
    return undefined
  }

  /*
   * An `https` address, in the Browser tab. The relay lets it through only on
   * a click or key press the user just made. This checks only that it is an
   * address; the window opens it the way it opens any page, so the reach rule
   * a typed address meets is the one this meets, and a refusal is said on the
   * page's own tab.
   */
  const open = (caller: ClientCaller, [url]: readonly unknown[]): undefined => {
    if (caller.surface === 'background') {
      throw new PluginCallError('not-allowed', 'only a panel or a tab can open a link, from a click')
    }
    const href = readLink(url)
    const now = Date.now()
    if (now - (linkOpened.get(caller.plugin) ?? -Infinity) < LINK_SPACING_MS) {
      throw new PluginCallError('busy', 'this plugin opened a link a moment ago')
    }
    if (!deps.ui({ kind: 'link', plugin: caller.plugin, url: href })) {
      throw new PluginCallError('unavailable', 'there is no window to open a link in')
    }
    linkOpened.set(caller.plugin, now)
    return undefined
  }

  return {
    run(method, caller, args) {
      if (method === 'tabs.open') return tabsOpen(caller, args)
      if (method === 'open') return open(caller, args)
      throw new PluginCallError('invalid', `helm.${method} is not part of the bridge`)
    }
  }
}

/** An absolute `https` address with no user name or password in it, as `URL` spells it. */
function readLink(value: unknown): string {
  if (typeof value !== 'string' || value.length > LINK_URL_MAX) {
    throw new PluginCallError('invalid', `open needs an https address of at most ${String(LINK_URL_MAX)} characters`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PluginCallError('invalid', `"${value}" is not an address`)
  }
  if (url.protocol !== 'https:') throw new PluginCallError('invalid', `open takes https addresses only, not ${url.protocol}`)
  // A page reached with a name and password in its address is a sign-in the
  // user never saw being made.
  if (url.username !== '' || url.password !== '') {
    throw new PluginCallError('invalid', 'an address with a user name or password in it cannot be opened')
  }
  return url.href
}

/** `helm.tabs.open`'s options. Absent, a tab has the manifest's title and stays. */
function readTabOptions(value: unknown): { title: string | null; preview: boolean } {
  if (value === undefined || value === null) return { title: null, preview: false }
  if (typeof value !== 'object') throw new PluginCallError('invalid', 'tab options must be an object')
  const { title, preview } = value as Record<string, unknown>
  if (preview !== undefined && typeof preview !== 'boolean') throw new PluginCallError('invalid', 'preview is true or false')
  if (title !== undefined && title !== null) {
    if (typeof title !== 'string' || title.trim() === '' || title.length > PLUGIN_TITLE_MAX) {
      throw new PluginCallError('invalid', `a tab title is 1-${String(PLUGIN_TITLE_MAX)} characters`)
    }
  }
  return { title: typeof title === 'string' ? title.trim() : null, preview: preview === true }
}
